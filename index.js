/**
 * AI 任务台 × DSH 插件 —— 宿主半边（跑在 DSH 进程里）。
 *
 * 职责（M1）：
 *   ① 桥：确保有一个可用的 AI 任务台后端（默认自己 spawn 现有 web 宿主，只绑回环）
 *   ② 工具：三个只读（health / idea_list / feed_today）+ 两个写（idea_create / idea_set_status，
 *      写操作一律过 `tools/pre-execute` 审批闸：用户点了「同意」才落地）
 *   ③ 给浏览器半边递地址：注册 /aitm-plugin/config 路由（客户端拿不到 Node 环境变量）
 *
 * M2 第三步：桥换成了**进程内 L3 服务**（默认）——不再 spawn 常驻后端进程，也不再有
 * 「复用旧实例」这一整类问题（R10）。逃生通道：`AITM_URL`（连外部后端）/ `AITM_L3=0`（退回旧 spawn 桥）。
 */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'dsh-plugin-aitm';

/** 需要 tools；webServer 是可选的（没有就只做工具，不递地址） */
export const inject = ['tools'];

/**
 * 仓库位置：默认**从插件自身位置推导** —— 插件就在仓库的 `dsh-plugin/` 里。
 *
 * 别写死路径（早期版本写死了开发机的 `/home/user/ai-tasks-mgr`）：换台机器/换成 Windows
 * 就变成「去一个不存在的目录起后端」，而且报错还被 stdio:'ignore' 吞掉，只看到「后端没起来」。
 * 显式设了 AITM_REPO 就用它。
 */
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
/** AITM_REPO 归一化：空串/纯空白当**没设**（Windows 上 `set AITM_REPO=` 就是空串，别让它变成「仓库是空路径」） */
const REPO_ENV = (process.env.AITM_REPO ?? '').trim() || null;
const REPO_DEFAULT = REPO_ENV ?? path.resolve(PLUGIN_DIR, '..');

const DEFAULTS = {
  repo: REPO_DEFAULT,
  url: (process.env.AITM_URL ?? '').replace(/\/+$/, ''),
  spawn: process.env.AITM_SPAWN !== '0',
  /**
   * 写操作的审批策略（`tools/pre-execute` 里那道闸）：
   *   ask（默认）—— 每次写都弹审批卡，用户点了才落地
   *   allow      —— 不弹，直接写（自用/自动化；`AITM_APPROVE=allow`，风险自负）
   * 只读工具不受影响。
   */
  approve: (process.env.AITM_APPROVE ?? 'ask').toLowerCase(),
  /**
   * 默认走**进程内 L3**（core 直接 import，不起常驻子进程）。
   * `AITM_L3=0` 退回旧的 spawn 桥（保留一个版本，方便对照/回滚）。
   */
  l3: process.env.AITM_L3 !== '0',
};

/** L3 产物（npm run build 出的小包；插件 import 它拿到 createL3） */
const L3_BUNDLE = () => path.join(DEFAULTS.repo, 'dist-server', 'l3.mjs');
const L3_SOURCE = () => path.join(DEFAULTS.repo, 'src', 'web', 'l3.ts');
/** 面板 iframe 要的静态目录（vite build 的产物） */
const RENDERER_DIST = () => path.join(DEFAULTS.repo, 'dist');

/**
 * 分发模式（同事从 npm 装的那条路）：**包里自带内核**，不需要机器上有仓库。
 * `node scripts/vendor-plugin.mjs` 把仓库的 `dist-server/l3.mjs` 与 `dist/` 拷进插件目录，
 * `npm pack` 会一起打进 tarball（见 package.json 的 `files`）。
 */
const VENDOR_L3 = () => path.join(PLUGIN_DIR, 'dist-server', 'l3.mjs');
const VENDOR_DIST = () => path.join(PLUGIN_DIR, 'dist');
const vendorPresent = () => exists(VENDOR_L3());

/** 插件自己的版本（agent 装机时要一个「插件 ↔ 内核 apiRev」的版本三元组） */
function pluginVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'package.json'), 'utf8'))?.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * 客户端半边（client.js）的指纹 —— 与 DSH 内核算 `&rev=` 的算法**逐字一致**
 * （`dsh-client-modules` 的 `artifactRevision`：sha1("plugin-artifact"\0) + 各字段带长度前缀，取前 12 位）。
 * 用途只有一个：界面上显示出来，好回答「我看到的这个面板，到底是哪一版 client.js？」
 * —— 改了 client.js 却没生效时（浏览器缓存 / DSH 加载的是另一份安装 / 根本没 pull），
 * 拿 DSH 网络面板里 `/plugins/??…/client.js&rev=xxxx` 的 xxxx 和这里比一下即可定位。
 */
/**
 * client.js **内容**的 sha1 前 12 位。
 *
 * 与 `clientRevision()`（文件元数据的哈希）互补：元数据哈希会因「换个机器 pull」「被 touch 一下」
 * 「DSH 登记时刻不同」而变，**内容哈希只认字节**。面板拿它做定论：
 * 本页把自己那份代码取回来算同样的 sha1，两边一致 ⇒ 页面上就是磁盘上这份（rev 对不上也不怕）。
 */
function clientSha() {
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(path.join(PLUGIN_DIR, 'client.js'))).digest('hex').slice(0, 12);
  } catch {
    return null;
  }
}

function clientRevision() {
  try {
    const st = fs.statSync(path.join(PLUGIN_DIR, 'client.js'));
    const hash = crypto.createHash('sha1').update('plugin-artifact').update('\0');
    for (const part of [String(st.mtimeMs), String(st.ctimeMs), String(st.size)]) {
      hash.update(`${String(Buffer.byteLength(part))}:`).update(part);
    }
    return hash.digest('hex').slice(0, 12);
  } catch {
    return null;
  }
}

/**
 * 审批卡上的「哪条想法」：查得到就用《标题》，查不到（或已删）退回 id。
 * 这是**展示**用的辅助，绝不因为查不到标题就把审批卡住 —— 用户拍板不需要我们先把数据查全。
 */
async function ideaTitle(id) {
  try {
    const d = await call('idea.get', id);
    return d?.idea?.title ?? null;
  } catch {
    return null;
  }
}

function titleOf(title, id) {
  return title ? `想法《${String(title)}》` : `想法 ${id}`;
}

/** 写工具（要过审批闸）与它们的人话描述 —— 审批卡上必须一眼看出「这次会改什么」 */
const WRITE_TOOLS = {
  aitm_idea_create: (a) => `在想法箱新建一条：「${String(a?.title ?? '(缺标题)')}」`,
  aitm_idea_set_status: (a) => `把想法 ${String(a?.id ?? '(缺 id)')} 的状态改成 ${String(a?.status ?? '(缺状态)')}`,
  aitm_task_start: (a) => `开工：${String(a?.ideaId ?? '(缺想法)')} → 起一个 AI 任务（建 worktree、跑 CLI）`,
  aitm_task_follow_up: (a) => `继续任务 ${String(a?.taskId ?? '(缺任务)')}：${String(a?.instruction ?? '').slice(0, 60)}${String(a?.instruction ?? '').length > 60 ? '…' : ''}（在同一 worktree 上接着干）`,
  aitm_backup_now: (a) => `立即备份（${a?.mode === 'full' ? '全量' : '轻量'}）`,
  // 这两条也是异步的：改的是**想法正文/规格**，审批卡上必须写出「哪条想法、改什么、多少字」——
  // 光给个 id 用户无从判断（查不到标题就退回 id，绝不因为查不到而卡住审批）
  aitm_idea_update: async (a) => {
    const id = String(a?.id ?? '(缺 id)');
    const what = [];
    if (a?.title !== undefined) what.push(`标题 → 「${String(a.title).slice(0, 40)}」`);
    if (a?.description !== undefined) what.push(`正文${a?.mode === 'append' ? '追加' : '替换'} ${String(a.description).length} 字`);
    return `${titleOf(await ideaTitle(id), id)}：${what.length ? what.join('，') : '(没有可改的字段)'}`;
  },
  aitm_idea_set_spec: async (a) => {
    const id = String(a?.id ?? '(缺 id)');
    const chars = String(a?.spec ?? '').length;
    const wantStatus = a?.status ? `，状态 → ${String(a.status)}` : '';
    return `${titleOf(await ideaTitle(id), id)} 写回规格（${chars} 字${wantStatus}）`;
  },
  // 这条是异步的：合并是不可逆动作，审批卡上必须写清「哪条想法、合到哪个基线」，
  // 光给个 taskId 人没法确认（查不到标题就退回 id，绝不因为查不到而卡住审批）
  aitm_task_accept: async (a) => {
    const id = String(a?.taskId ?? '(缺任务)');
    let title = null;
    let baseRef = null;
    try {
      const d = await call('task.get', id);
      title = d?.idea?.title ?? d?.task?.title ?? null;
      baseRef = d?.task?.workspace?.baseRef ?? null;
    } catch {
      /* 查不到就用 id */
    }
    const what = a?.merge === false ? '只记验收（不碰 git）' : `验收并合并到 ${baseRef ? `\`${baseRef}\`` : '基线'}`;
    return `${what}：${title ? `《${title}》` : ''}任务 ${id}${a?.acknowledgeVerifyFailure ? '（**验证没过也要合**）' : ''}`;
  },
};

/**
 * 我们要的后端线协议版本。后端在 `GET /api/health` 里报 `apiRev`（核心 `src/shared/api-rev.ts`）。
 *
 * 为什么必须核这个：插件与后端**各自构建、各自升级**，而现在的复用逻辑只要 health 通就会
 * 接过别人留下的后端 —— 实测踩到过：DSH 复用了一个旧版实例（0.1.0-m1，接口还叫 `news.get`），
 * 面板显示 51 个 action，`aitm_feed_today` 直接报「未知接口：feed.get」。
 * 老后端没有 `apiRev` 字段 → 按 1 算 → 判为不兼容。
 */
const REQUIRED_API_REV = 2;
/** health 里没有 apiRev 的老后端按 1 算 */
const LEGACY_API_REV = 1;

const state = {
  base: null,
  child: null,
  starting: null,
  /** true = 复用的是别人起的后端，退出时不能收（收了会把别人正在用的服务干掉） */
  adopted: false,
  /** 连上/起好的后端身份（health 里那几项），给 /aitm-plugin/config 与工具用 */
  identity: null,
  /** spawn 本身失败的描述（cwd 不存在之类）—— 有它就别再空等 health 超时 */
  spawnError: null,
  /** 后端的来法：'l3'（进程内）/ 'external'（AITM_URL）/ 'spawn'（旧桥） */
  mode: null,
  /** 进程内 L3 句柄（有它就是直连内核，call() 不走 HTTP） */
  l3: null,
  /** 当前已加载的 dist-server/l3.mjs 的 mtimeMs（用于检测重新构建后自动热重载） */
  l3Mtime: 0,
  /** 进程内 L3 当前绑定的回环端口（热重载时优先复用同一端口，避免已打开的面板 iframe 断连） */
  l3Port: 0,
  /** 正在热重载时的互斥 Promise */
  reloading: null,
  /** cordis 的 ctx（apply 时记下）：起内核时用它现取子进程接缝 */
  ctx: null,
  /** 子进程接缝的说明（给日志/自检看：是宿主托管还是内核自己 spawn） */
  spawnSeam: null,
  log: [],
  exitHook: false,
};

/**
 * 后端登记表（临时目录）：谁起了后端、pid 多少、监听哪个端口。
 * 作用有两个：① 多个 DSH 会话（面板 + headless）**复用同一个后端**，不叠着起；
 * ② 上次没收干净时（比如进程被 SIGTERM 直接砍掉，'exit' 钩子不会跑）这里还留着 pid —— verify 能按它收尾。
 */
const PIDFILE = path.join(os.tmpdir(), 'aitm-dsh-backend.json');

/**
 * 后端日志：看门狗把子进程的 stdout/stderr 都追进这里（`stdio:'ignore'` 是为了不把 DSH 钉住，
 * 但那样失败原因就全丢了）。起不来时把尾部几行原样给用户看 —— 报错必须具体到能动手。
 */
const BACKEND_LOG = path.join(os.tmpdir(), 'aitm-dsh-backend.log');

const LOG_TAIL = 40;
function logTail(n = 20) {
  // 注意 slice(-0) === slice(0)（返回全部）—— n 必须 ≥ 1，全量读用 readBackendLog()
  const limit = Math.max(1, n);
  try {
    return readBackendLog().slice(-limit);
  } catch {
    return [];
  }
}

function readBackendLog() {
  return fs.readFileSync(BACKEND_LOG, 'utf8').trimEnd().split('\n');
}

/**
 * 起后端之前的自检。**每次失败都给出「哪个路径、缺什么、怎么修」**，而不是等 90 秒超时后
 * 只说一句「后端没起来」。
 * @returns 错误描述；null = 可以起
 */
function preflightRepo(repo) {
  if (!repo || typeof repo !== 'string') return 'AITM_REPO 没配（也不是从插件位置能推导出的路径）';
  if (!fs.existsSync(repo)) {
    return `仓库目录不存在：${repo}（AITM_REPO=${REPO_ENV ?? '(未设，用插件位置推导)'}）`;
  }
  let pkg = null;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  } catch {
    return `${repo} 里没有可读的 package.json —— 这不像 AI 任务台仓库（AITM_REPO 指错了？）`;
  }
  if (pkg?.name !== 'ai-tasks-mgr') return `${repo} 的 package.json 是「${pkg?.name ?? '?'}」，不是 ai-tasks-mgr`;
  const devWeb = path.join(repo, 'scripts', 'dev-web.mjs');
  if (!fs.existsSync(devWeb)) return `缺少启动脚本：${devWeb}（仓库不完整？git pull 一下）`;
  if (!fs.existsSync(path.join(repo, 'node_modules', 'vite'))) {
    return `仓库依赖没装：${path.join(repo, 'node_modules', 'vite')} 不存在 —— 在 ${repo} 跑一次 npm install`;
  }
  return null;
}

/** 起前自检失败时抛的错（附上「怎么办」几步） */
function repoError(detail, plan = {}) {
  const hint = plan.explicitRepo
    ? `处理：① 你显式设了 AITM_REPO，它必须指向 AI 任务台仓库 —— 改对，或者在 DSH 启动前去掉它（去掉就用自带内核/自动推导）；` +
      `② 确认那个仓库已 git pull 且 npm install 过；` +
      `③ 不想要仓库：清掉 AITM_REPO，装正式版插件（自带内核，见 dsh-plugin/README「同事怎么装」）。`
    : plan.noVendor
      ? `处理：① 这个插件包里**没有自带内核**（缺 ${path.relative(PLUGIN_DIR, VENDOR_L3())}）—— 重装正式版（npm/pnpm 会带上），或拉仓库后跑 node scripts/vendor-plugin.mjs 生成；` +
        `② 或者给仓库路径：DSH 启动前设 AITM_REPO=<AI 任务台仓库绝对路径>（Windows 例如 setx AITM_REPO D:\\...\\ai-tasks-mgr，然后重开终端）；` +
        `③ 仓库记得 git pull + npm install（首次还要 npm run build）。`
      : `处理：① 在 DSH 启动前设 AITM_REPO=<AI 任务台仓库的绝对路径>（Windows 例如 setx AITM_REPO D:\\...\\ai-tasks-mgr，然后重开终端）；` +
        `② 或把 `+'`dsh-plugin/aitm.patch.yml` 的 `name:` 指到**那个仓库**里的 `dsh-plugin/index.js`（插件默认就按自己的位置推导仓库）；' +
        `③ 确认那个仓库已 git pull 且 npm install 过。`;
  return new Error(`${detail}。${hint}当前推导出的仓库：${DEFAULTS.repo}`);
}

/**
 * 进程内 L3 的产物准备。
 *
 * 为什么要有这一步：L3 是 TS 源码（`src/web/l3.ts`），要 import 就得先有 esbuild 产物。
 * 不把产物提交进仓库（生成物不进 git 的老规矩），所以这里用**仓库自己的 esbuild** 现编：
 *   - 产物比源码旧（或没有）→ 编一次（几百毫秒）
 *   - 仓库/node_modules 里没有 esbuild → 给人话，让他跑 `npm run build`
 *
 * 面板 iframe 还需要渲染层 `dist/`：没有或比 src 旧就用 `npx vite build` 补一次（一次性进程，
 * 不是常驻后端）。
 */
function newestMtime(dir, exts) {
  let newest = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        walk(p);
      } else if (exts.some((x) => e.name.endsWith(x))) {
        try {
          newest = Math.max(newest, fs.statSync(p).mtimeMs);
        } catch {
          /* 刚被删掉的文件 */
        }
      }
    }
  };
  walk(dir);
  return newest;
}

const exists = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

/** 编 dist-server/l3.mjs（源码新了才编）；返回错误描述或 null */
async function ensureL3Bundle(repo) {
  const out = L3_BUNDLE();
  const srcDir = path.join(repo, 'src');
  const srcNewest = newestMtime(srcDir, ['.ts', '.tsx']);
  const outMtime = exists(out) ? fs.statSync(out).mtimeMs : 0;
  if (outMtime && outMtime >= srcNewest) return null;

  let esbuild;
  try {
    const { createRequire } = await import('node:module');
    esbuild = createRequire(path.join(repo, 'package.json'))('esbuild');
  } catch {
    return `要现编 ${path.relative(repo, out)}，但 ${repo} 里没有可用的 esbuild（依赖没装？）`;
  }
  try {
    await esbuild.build({
      bundle: true,
      platform: 'node',
      target: 'node20',
      format: 'esm',
      absWorkingDir: repo,
      entryPoints: [L3_SOURCE()],
      outfile: out,
      logLevel: 'silent',
      define: { __AITM_BUILD_AT__: JSON.stringify(new Date().toISOString()) },
    });
    note(`[host] 现编了进程内 L3：${path.relative(repo, out)}`);
    return null;
  } catch (err) {
    return `编 ${path.relative(repo, out)} 失败：${String(err?.message ?? err)}`;
  }
}

/** 面板 iframe 的静态产物；没有或旧了就 vite build 一次（一次性，不留常驻进程） */
function ensureRendererDist(repo) {
  const index = path.join(RENDERER_DIST(), 'index.html');
  const srcNewest = newestMtime(path.join(repo, 'src', 'renderer'), ['.ts', '.tsx', '.css', '.html']);
  const indexMtime = exists(index) ? fs.statSync(index).mtimeMs : 0;
  if (indexMtime && indexMtime >= srcNewest) return null;
  note(`[host] 面板产物${indexMtime ? '过期' : '不存在'}，跑一次 vite build（一次性，不常驻）`);
  const r = spawnSync('npx', ['vite', 'build'], {
    cwd: repo,
    stdio: 'ignore',
    env: process.env,
    shell: process.platform === 'win32', // Windows 上 npx 是 .cmd 垫片，不 shell 会 EINVAL
  });
  if (r.status !== 0 || !exists(index)) {
    return `渲染层没构建出来（在 ${repo} 手动跑一次 npm run build 看报错）`;
  }
  return null;
}

function readRegistry() {
  try {
    return JSON.parse(fs.readFileSync(PIDFILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeRegistry(entry) {
  try {
    fs.writeFileSync(PIDFILE, JSON.stringify(entry));
  } catch {
    /* 临时目录写不了就算了，不影响功能 */
  }
}

function clearRegistryIf(pid) {
  const cur = readRegistry();
  if (cur?.pid === pid) {
    try {
      fs.unlinkSync(PIDFILE);
    } catch {
      /* 已经被删了也无所谓 */
    }
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 收掉一个进程**组**：只 kill 进程本身的话，它再 spawn 出来的东西（npx/vite/…）会活下来。
 * POSIX：负 pid 收整组；Windows 没有「进程组信号」，得用 `taskkill /T /F` 连子孙一起收。
 */
function killGroup(pid, signal = 'SIGTERM') {
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      /* 已经没了 */
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* 已经没了 */
    }
  }
}

/** `YYYY-MM-DD`，按**本机时区**切（与 src/shared/calendar.ts 的 dayKey 同口径） */
const dayKeyLocal = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const note = (line) => {
  state.log.push(line);
  if (state.log.length > 200) state.log.shift();
};

/** 往**后端日志文件**里写一行（看门狗与后端都写这里，失败时原样给用户看） */
function logLine(line) {
  try {
    fs.appendFileSync(BACKEND_LOG, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* 日志写不了不影响功能 */
  }
}

/** 找一个空闲端口（我们自己定端口，省得解析子进程日志） */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function health(base, timeoutMs = 1500) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/api/health`, { signal: ctl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** 后端身份（health 里那几项），旧后端缺字段时为 undefined */
function backendId(h) {
  return {
    apiRev: typeof h?.apiRev === 'number' ? h.apiRev : LEGACY_API_REV,
    version: h?.version ?? null,
    dataDir: h?.dataDir ?? null,
    buildAt: h?.buildAt ?? null,
    actions: h?.actions ?? null,
  };
}

const compatible = (h) => backendId(h).apiRev >= REQUIRED_API_REV;

/** 不兼容时给的**可处置**错误：说清「连的是谁 / 差在哪 / 怎么办」 */
function incompatibleError(base, h, how) {
  const id = backendId(h);
  const what = `你连上的后端是旧版：version=${id.version ?? '(未知)'}、apiRev=${id.apiRev}（需要 ≥ ${REQUIRED_API_REV}）、${id.actions ?? '?'} 个 action`;
  const where = id.dataDir ? `，数据目录 ${id.dataDir}` : '';
  return new Error(
    `${what}${where}（${how}：${base}）。` +
      `这一版后端没有 feed.* 接口（旧版叫 news.*），插件用不了。` +
      `处理：① 别让插件复用旧实例 —— 关掉 DSH 后清掉 %TEMP%/aitm-dsh-backend.json，并确认没有遗留的 node scripts/dev-web.mjs 进程；` +
      `② 确认 AITM_REPO（当前 ${DEFAULTS.repo}）指向**最新**仓库、且已 git pull；` +
      `③ 若设了 AITM_URL，重启那个实例或去掉它。`,
  );
}

/**
 * 这个插件要的后端从哪来 —— **只在这一处决策**（别在多个分支里各判一次，R10 就是那么来的）：
 *   external  `AITM_URL` 显式指向已有实例（最高优先级，保留 apiRev 护栏）
 *   l3        仓库齐全（`AITM_REPO`，或插件上一级就是 AI 任务台仓库）→ 用仓库的内核（今天的开发路径）
 *   vendor    没有仓库，但**包里自带** `dist-server/l3.mjs`（同事从 npm 装的这条）→ 用自带内核
 *   spawn     `AITM_L3=0` 的旧 spawn 桥（保命通道，仍然要仓库）
 * 兜底是 error：显式设了 `AITM_REPO` 却没通过自检 → 报错而不是悄悄换成自带内核（用户要的是那个仓库）。
 */
function backendPlan() {
  if (DEFAULTS.url) return { mode: 'external' };
  if (DEFAULTS.l3) {
    const problem = preflightRepo(DEFAULTS.repo);
    if (!problem) return { mode: 'l3' };
    if (REPO_ENV) return { mode: 'error', why: problem, explicitRepo: true };
    if (vendorPresent()) return { mode: 'vendor', why: problem };
    return { mode: 'error', why: problem, noVendor: true };
  }
  return { mode: 'spawn' };
}

async function waitHealth(base, ms, opts = {}) {
  const until = Date.now() + ms;
  for (;;) {
    const h = await health(base);
    if (h?.ok) return h;
    // 子进程已经明确失败（比如仓库路径不对）就别再空等超时了
    if (opts.failed?.()) {
      throw new Error(`${opts.failed()}（后端日志：${BACKEND_LOG}）\n${logTail(20).join('\n')}`);
    }
    if (Date.now() > until) {
      const tail = logTail(20);
      throw new Error(
        `后端没起来（${base}/api/health 一直不通）` + (tail.length ? `\n后端日志（${BACKEND_LOG}）尾部：\n${tail.join('\n')}` : `\n（后端日志 ${BACKEND_LOG} 是空的：进程可能根本没起来）`),
      );
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

/* ───────────────────────── 子进程接缝（把内核起的 CLI 交给宿主托管） ───────────────────────── */

/**
 * 把 DSH 的 `ctx.subprocess` 适配成**内核要的那几面**（形状见 `src/core/exec.ts` 的 `SpawnSeam`）。
 *
 * 为什么要有这一层：内核（L3）在**我们的进程里**跑，runner 起的 CLI 引擎（claude / codex / …）
 * 默认由内核自己 spawn —— 那条进程 DSH 看不见：面板退出/DSH 被强杀时，正在干活的 CLI 可能活下来
 * 继续改文件。走 `ctx.subprocess` 之后它是**宿主管托的进程范围**（会话结束统一收掉），
 * 将来沙箱执行器也挂在这条缝上（见 docs/PROPOSAL-DSH-INTEGRATION.md 的 L3 一行）。
 *
 * 形状上的取舍：
 *   · 只包内核真用到的那几面（stdout/stderr/stdin + error/close + kill），**不假装成 ChildProcess**
 *     —— DSH 的 handle 没有 pid、没有 `killed` 位，硬套只会把这些真差异藏起来（内核的 killTree
 *     认「没有 pid 就调 kill()」，而 kill() 在这里就是 `terminate()`＝端掉整棵托管范围，反而更准）。
 *   · env 里**去掉 `DSH_*`**：那是宿主自己的身份变量（DSH 自己的接缝也刻意不下发给子进程），
 *     我们透传 process.env 时会捎带上，这里按同一口径剥掉；其余原样传（CLI 要的 API Key/PATH 都在）。
 *   · `windowsVerbatimArguments` 这一路**内核不会给我们**（`cli.ts` 里遇到 cmd.exe 垫片会自己回落到
 *     node spawn）：DSH 的接缝是把 argv 交给 node 的 `spawn`，没有「原样交给系统」这个开关，
 *     再被 node 引号一遍就成 `\"…\"`，cmd 不认。
 */
export function makeSubprocessSpawner(subprocess) {
  return (req) => {
    const env = {};
    for (const [k, v] of Object.entries(req.env ?? {})) {
      if (/^DSH_/i.test(k)) continue;
      if (v !== undefined) env[k] = v;
    }
    const handle = subprocess.spawn({
      argv: [req.file, ...(req.args ?? [])],
      cwd: req.cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      // SIGTERM→SIGKILL 的宽限期；内核自己也有超时/看门狗，这里给宿主留 3 秒收尾
      graceMs: 3000,
      env,
    });

    /** 极简事件面：内核只监听 error / close 两个（晚注册的也补一次，别让它等一个已经发生的事件） */
    let settled = null;
    const listeners = { error: [], close: [] };
    const emit = (kind, payload) => {
      settled = { kind, payload };
      for (const cb of listeners[kind].splice(0)) {
        try {
          cb(payload);
        } catch {
          /* 监听器自己炸了不该传染给进程管理 */
        }
      }
    };
    handle.done.then(
      (o) => emit('close', o && typeof o.exitCode === 'number' ? o.exitCode : 0),
      (err) => emit('error', err instanceof Error ? err : new Error(String(err?.message ?? err))),
    );

    const child = {
      stdout: handle.stdout,
      stderr: handle.stderr,
      stdin: handle.stdin,
      pid: handle.pid,
      killed: false,
      on(event, cb) {
        if (event !== 'error' && event !== 'close') return child;
        if (settled && settled.kind === event) {
          try {
            cb(settled.payload);
          } catch {
            /* 见上 */
          }
          return child;
        }
        listeners[event].push(cb);
        return child;
      },
      /** 内核的 killTree 会调它：这里等于「端掉宿主托管的整棵进程范围」 */
      kill() {
        child.killed = true;
        try {
          handle.terminate();
        } catch {
          /* 已经收掉了 */
        }
        return true;
      },
    };
    return child;
  };
}

/** 每个宿主服务**最后一次**取用的结果（取到了就清成 null）。给诊断说清「缝为什么是空的」。 */
const hostServiceNotes = new Map();

/**
 * 取一个宿主服务。**必须走 `ctx.get()`，不能写 `ctx.sessionQuery` 这种属性访问**。
 *
 * 为什么：cordis 里每个加载条目各起一个 fiber（`cordis-plugin-loader` 对每行配置调一次
 * `registry.plugin`），服务只存在「提供它的那个条目的 fiber」里，与本插件是**兄弟**关系；
 * 本插件只 `inject = ['tools']`，于是属性访问会抛
 * `cannot get property "X" without inject`。而 `ctx.get(name)` 走 reflect 的**共享 store**，
 * 不受兄弟关系限制 —— 这正是 DSH 自己的写法（base 清单里的 `ctx.get('profileContext')`、
 * `dsh-session-log-export` 里的 `ctx.get("sessionQuery")`）。
 *
 * 真机事故（0.3.0）：`ctx.subprocess` / `ctx.agents` / `ctx.sessionQuery` 全用属性访问取，
 * 一律拿到 null —— 插件自检行如实写着「宿主没提供 ctx.subprocess」，P1 只读镜像与 P2
 * 进程内借道在真机上**全程静默失效**（复盘见 docs/DESIGN-NOTES.md §7.10）。
 * 也别改成往 `inject` 里加：任一服务缺失会让插件一直 pending（白屏那类故障）。
 */
export function hostService(ctx, name) {
  if (!ctx) {
    hostServiceNotes.set(name, '没有宿主 ctx');
    return null;
  }
  if (typeof ctx.get !== 'function') {
    hostServiceNotes.set(name, '宿主 ctx 上没有 get()（不像 cordis 的 ctx）');
    return null;
  }
  try {
    const svc = ctx.get(name);
    if (svc === undefined || svc === null) {
      hostServiceNotes.set(name, `ctx.get('${name}') 是空的：服务没提供，或提供它的插件还没激活`);
      return null;
    }
    hostServiceNotes.set(name, null);
    return svc;
  } catch (err) {
    hostServiceNotes.set(name, `ctx.get('${name}') 抛异常：${String(err?.message ?? err)}`);
    return null;
  }
}

/**
 * 「宿主缝到底通没通」——**按需现探**，别把结论钉死在启动那一刻（服务可能是后提供的）。
 * 四个服务各有用途：`subprocess`＝CLI 进程交宿主托管；`agents` + `sessionQuery`＝P1 只读镜像与
 * P2 进程内借道；`sessions`＝借道收尾 flush。
 *
 * 为什么值得专门摊出来：2026-10-09 真机上这四个全取不到、被 `try/catch` 吞成 null，
 * 表现却是「面板看着一切正常，只是 DSH 里的对话永远不同步」——**静默失效**。
 * 现在 `aitm_health` / 设置节 / `/aitm-plugin/config` / `doctor` 都读它，不用再翻插件内存日志。
 */
export function hostSeamDiagnosis(ctx) {
  const names = ['subprocess', 'agents', 'sessionQuery', 'sessions'];
  const services = names
    .map((n) => `${n}=${hostService(ctx, n) ? '有' : `无（${hostServiceNotes.get(n) ?? '未探'}）`}`)
    .join('；');
  if (!ctx) {
    return { ok: false, verdict: '用不上宿主缝：这次不是进程内模式（外部后端 AITM_URL，或 AITM_L3=0 的旧桥）', services };
  }
  if (hostService(ctx, 'sessionQuery') && hostService(ctx, 'agents')) {
    return { ok: true, verdict: '宿主缝是通的：P1 只读镜像与 P2 进程内借道都该生效', services };
  }
  return { ok: false, verdict: '宿主缝不完整：P1 只读镜像 / P2 进程内借道会静默失效（看下面哪个是「无」）', services };
}

/**
 * 选一条子进程缝（内核启动时用）。
 * 退回内核自带 spawn 的两种情况：`AITM_SUBPROCESS=0`（逃生开关）、宿主没提供 ctx.subprocess
 * （老 DSH / 精简 profile）。**退回不是错误**：内核照旧自己起进程，只是不由宿主托管。
 */
export function pickHostSpawn(ctx) {
  if (process.env.AITM_SUBPROCESS === '0') return { spawn: null, why: 'AITM_SUBPROCESS=0' };
  const svc = hostService(ctx, 'subprocess');
  if (!svc || typeof svc.spawn !== 'function') return { spawn: null, why: '宿主没提供 ctx.subprocess' };
  return { spawn: makeSubprocessSpawner(svc), why: null };
}

/**
 * 把 DSH 宿主的 `ctx.agents` + `ctx.sessionQuery` + `ctx.on('session/event')` 适配成内核的 `HostSessionSeam`
 * （见 `src/core/exec.ts`）：
 *   ① P1 只读镜像：用 `ctx.sessionQuery.observeSession(id, { projectionMode: 'none' })` 读会话事件，
 *      **绝不**调 `follow` / `promote` / `agents.resume`，因此绝不会激活冷会话或抢走单写者锁；
 *   ② P2 进程内借道投递：当 `sessionId` 已在 `ctx.agents` 存活（左栏打开过而持有写锁）时，
 *      直接在进程内调 `agent.followup(prompt, { rpcId })` 并把 `session/event` 实时转成与
 *      `dsh headless --json` 同构的 NDJSON 行喂给 CLI 解析器，避免子进程 `SessionAlreadyOwnedError`。
 */
export function repairDshSessionLogFile(logPath) {
  try {
    if (!logPath || !fs.existsSync(logPath)) return { repaired: false, fixedCount: 0 };
    const raw = fs.readFileSync(logPath);
    if (!raw || raw.length === 0) return { repaired: false, fixedCount: 0 };

    const isValidUserMsg = (val) => {
      if (typeof val !== 'object' || val === null || Array.isArray(val)) return false;
      if (typeof val.id !== 'string' || !val.id.trim()) return false;
      if (val.role !== 'user' || !Array.isArray(val.content)) return false;
      if (typeof val.source !== 'object' || val.source === null || Array.isArray(val.source)) return false;
      if (typeof val.source.kind !== 'string' || !val.source.kind.trim() || val.source.kind === 'plugin') return false;
      return true;
    };
    const coerceUserMsg = (val) => {
      if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
        const next = { ...val };
        if (typeof next.id !== 'string' || !next.id.trim()) next.id = crypto.randomUUID();
        next.role = 'user';
        if (!Array.isArray(next.content)) {
          const text = typeof next.text === 'string' ? next.text : typeof next.content === 'string' ? next.content : '';
          next.content = [{ type: 'text', text }];
        }
        if (
          typeof next.source !== 'object' ||
          next.source === null ||
          Array.isArray(next.source) ||
          typeof next.source.kind !== 'string' ||
          !next.source.kind.trim() ||
          next.source.kind === 'plugin'
        ) {
          next.source = { kind: 'user' };
        }
        return next;
      }
      return {
        id: crypto.randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: String(val ?? '') }],
        source: { kind: 'user' },
      };
    };
    const repairText = (text) => {
      let changed = false;
      let fixedCount = 0;
      const lines = text.split('\n').map((line) => {
        const trimmed = line.trim();
        if (!trimmed) return line;
        let parsed;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          return line;
        }
        if (!parsed || typeof parsed !== 'object') return line;
        if (parsed.type === 'agent/inbox/spliced' && parsed.data && Array.isArray(parsed.data.inserted)) {
          if (parsed.data.inserted.some((item) => !isValidUserMsg(item))) {
            changed = true;
            parsed.data.inserted = parsed.data.inserted.map((item) => {
              if (isValidUserMsg(item)) return item;
              fixedCount += 1;
              return coerceUserMsg(item);
            });
            return JSON.stringify(parsed);
          }
        }
        if (parsed.type === 'user/message' && !isValidUserMsg(parsed.data)) {
          changed = true;
          fixedCount += 1;
          parsed.data = coerceUserMsg(parsed.data);
          return JSON.stringify(parsed);
        }
        return line;
      });
      return { changed, fixedCount, text: lines.join('\n') };
    };

    if (!logPath.endsWith('.zstd')) {
      const { changed, fixedCount, text } = repairText(raw.toString('utf8'));
      if (!changed) return { repaired: false, fixedCount: 0 };
      fs.writeFileSync(logPath, Buffer.from(text, 'utf8'));
      return { repaired: true, fixedCount };
    }

    if (typeof zlib.zstdDecompressSync !== 'function' || typeof zlib.zstdCompressSync !== 'function') {
      return { repaired: false, fixedCount: 0 };
    }
    const ZSTD_MAGIC = 0xfd2fb528;
    const frames = [];
    let offset = 0;
    while (offset < raw.length) {
      const start = offset;
      if (raw.length - offset < 4) break;
      if (raw.readUInt32LE(offset) !== ZSTD_MAGIC) break;
      offset += 4;
      if (offset === raw.length) break;
      const desc = raw.readUInt8(offset);
      offset += 1;
      const fcsFlag = desc >>> 6;
      const singleSeg = (desc & 0x20) !== 0;
      const checksum = (desc & 0x04) !== 0;
      const dictFlag = desc & 0x03;
      const dictBytes = dictFlag === 3 ? 4 : dictFlag;
      const fcsBytes = fcsFlag === 0 ? (singleSeg ? 1 : 0) : 1 << fcsFlag;
      const remHeader = (singleSeg ? 0 : 1) + dictBytes + fcsBytes;
      if (raw.length - offset < remHeader) break;
      offset += remHeader;
      let broken = false;
      for (;;) {
        if (raw.length - offset < 3) {
          broken = true;
          break;
        }
        const bh = raw.readUIntLE(offset, 3);
        offset += 3;
        const lastBlock = (bh & 1) !== 0;
        const blockType = (bh >>> 1) & 3;
        const blockSize = bh >>> 3;
        const payload = blockType === 1 ? 1 : blockSize;
        if (raw.length - offset < payload) {
          broken = true;
          break;
        }
        offset += payload;
        if (lastBlock) break;
      }
      if (broken) break;
      if (checksum) {
        if (raw.length - offset < 4) break;
        offset += 4;
      }
      frames.push({ start, end: offset });
    }
    if (frames.length === 0) return { repaired: false, fixedCount: 0 };
    let anyChanged = false;
    let totalFixed = 0;
    const checksumFlag = zlib.constants?.ZSTD_c_checksumFlag;
    const compressOpts = typeof checksumFlag === 'number' ? { params: { [checksumFlag]: 1 } } : undefined;
    const outFrames = frames.map((f) => {
      const slice = raw.subarray(f.start, f.end);
      const decoded = zlib.zstdDecompressSync(slice).toString('utf8');
      const { changed, fixedCount, text } = repairText(decoded);
      if (!changed) return slice;
      anyChanged = true;
      totalFixed += fixedCount;
      return compressOpts
        ? zlib.zstdCompressSync(Buffer.from(text, 'utf8'), compressOpts)
        : zlib.zstdCompressSync(Buffer.from(text, 'utf8'));
    });
    if (!anyChanged) return { repaired: false, fixedCount: 0 };
    fs.writeFileSync(logPath, Buffer.concat(outFrames));
    return { repaired: true, fixedCount: totalFixed };
  } catch {
    return { repaired: false, fixedCount: 0 };
  }
}

export function makeHostSessionSeam(ctx) {
  const getAgents = () => hostService(ctx, 'agents');
  const getSessionQuery = () => hostService(ctx, 'sessionQuery');
  const getAttachments = () => hostService(ctx, 'attachments');
  const extractText = (raw) => {
    if (typeof raw === 'string') return raw;
    if (Array.isArray(raw)) {
      return raw
        .map((p) => (typeof p === 'string' ? p : p && typeof p.text === 'string' ? p.text : ''))
        .filter(Boolean)
        .join('\n');
    }
    if (raw && typeof raw === 'object') {
      if (typeof raw.content === 'string' || Array.isArray(raw.content)) return extractText(raw.content);
      if (typeof raw.text === 'string') return raw.text;
    }
    return '';
  };
  const enrichEventImages = async (events, afterSeq) => {
    const attachments = getAttachments();
    if (!attachments || !Array.isArray(events)) return events;
    const out = [];
    for (const ev of events) {
      if (!ev || typeof ev !== 'object' || (typeof ev.seq === 'number' && ev.seq <= afterSeq)) {
        out.push(ev);
        continue;
      }
      const data = ev.data;
      const content =
        ev.type === 'user/message' && Array.isArray(data?.content)
          ? data.content
          : (ev.type === 'assistant/message' || ev.type === 'tool/result') && Array.isArray(data?.message?.content)
            ? data.message.content
            : null;
      if (!content || !content.some((b) => b && b.type === 'image' && b.attachment?.attachmentId && !b.attachment.filePath && !b.attachment.data)) {
        out.push(ev);
        continue;
      }
      const enrichedBlocks = [];
      for (const b of content) {
        if (!b || b.type !== 'image' || !b.attachment?.attachmentId || b.attachment.filePath || b.attachment.data) {
          enrichedBlocks.push(b);
          continue;
        }
        let nextAtt = { ...b.attachment };
        try {
          if (typeof attachments.imageHostPath === 'function') {
            const hp = attachments.imageHostPath(b.attachment);
            if (typeof hp === 'string' && hp.trim()) nextAtt.filePath = hp.trim();
          }
          if (!nextAtt.filePath && typeof attachments.readImage === 'function') {
            const stored = await attachments.readImage(b.attachment);
            if (stored?.data) nextAtt.data = Buffer.from(stored.data).toString('base64');
          }
        } catch {
          /* ignore */
        }
        enrichedBlocks.push({ ...b, attachment: nextAtt });
      }
      if (ev.type === 'user/message') {
        out.push({ ...ev, data: { ...data, content: enrichedBlocks } });
      } else {
        out.push({ ...ev, data: { ...data, message: { ...data.message, content: enrichedBlocks } } });
      }
    }
    return out;
  };
  const inFlightSessions = new Set();

  return {
    hasLiveAgent(sessionId) {
      if (!sessionId) return false;
      const agents = getAgents();
      if (!agents || typeof agents.get !== 'function') return false;
      return Boolean(agents.get(sessionId));
    },
    agentStatus(sessionId) {
      if (!sessionId) return null;
      if (inFlightSessions.has(sessionId)) return 'running';
      const agents = getAgents();
      const agent = agents?.get?.(sessionId);
      if (!agent) return null;
      return agent.status === 'running' ? 'running' : 'idle';
    },
    async observeSession(sessionId, afterSeq = -1) {
      if (!sessionId) return null;
      const sq = getSessionQuery();
      if (!sq || typeof sq.observeSession !== 'function') return null;
      const seqNum = typeof afterSeq === 'number' ? afterSeq : -1;
      let obs = null;
      try {
        try {
          obs = await sq.observeSession(sessionId, {
            afterSeq: seqNum,
            projectionMode: 'none',
          });
        } catch (err) {
          const msg = String(err?.message ?? err);
          const m = msg.match(/\(raw log:\s*([^)\r\n]+)\)/i);
          if (m?.[1] && repairDshSessionLogFile(m[1].trim()).repaired) {
            obs = await sq.observeSession(sessionId, {
              afterSeq: seqNum,
              projectionMode: 'none',
            });
          } else {
            throw err;
          }
        }
        if (!obs) return null;
        if (Array.isArray(obs.events)) {
          const enriched = await enrichEventImages([...obs.events], seqNum);
          return {
            sessionId: obs.header?.id ?? obs.sessionId ?? sessionId,
            cwd: obs.header?.cwd ?? obs.cwd,
            cursor: typeof obs.cursor === 'number' ? obs.cursor : (enriched.at(-1)?.seq ?? -1),
            source: obs.source,
            events: enriched,
          };
        }
        return obs;
      } finally {
        try {
          obs?.[Symbol.dispose]?.();
        } catch {
          /* ignore */
        }
      }
    },
    onSessionEvent(listener) {
      if (typeof ctx?.on !== 'function') return () => {};
      return ctx.on('session/event', (sidOrSession, ev) => {
        try {
          const sid = typeof sidOrSession === 'string' ? sidOrSession : sidOrSession?.id;
          if (sid) listener(sid, ev);
        } catch {
          /* 监听器异常不外溢到宿主事件总线 */
        }
      });
    },
    async runLiveTurn({ sessionId, prompt, images, cwd, signal, rpcId, onLine }) {
      const agents = getAgents();
      const agent = agents?.get?.(sessionId);
      if (!agent) {
        return { ok: false, text: '', error: `session "${sessionId}" is not live in host` };
      }
      if (agent.status === 'running' || inFlightSessions.has(sessionId)) {
        return {
          ok: false,
          text: '',
          errorCode: 'writer-held',
          error: `session "${sessionId}" is already owned by an active write handle (running in DSH GUI)`,
        };
      }
      inFlightSessions.add(sessionId);

      const emitLine = (obj) => {
        try {
          onLine?.(JSON.stringify(obj));
        } catch {
          /* ignore */
        }
      };
      emitLine({ type: 'session', sessionId, cwd: agent.session?.cwd ?? cwd });

      let turnText = '';
      let finalMsgText = '';
      let turnErr = null;
      let turnDoneResolve = null;
      const turnDone = new Promise((resolve) => {
        turnDoneResolve = resolve;
      });

      const unsub =
        typeof ctx?.on === 'function'
          ? ctx.on('session/event', (sidOrSession, ev) => {
              const sid = typeof sidOrSession === 'string' ? sidOrSession : sidOrSession?.id;
              if ((sid !== sessionId && sidOrSession !== agent.session) || !ev) return;
              const d = ev.data ?? {};
              switch (ev.type) {
                case 'turn/start':
                  emitLine({ type: 'status', phase: 'turn_start', turn: d.turn ?? 1 });
                  break;
                case 'step/start':
                  emitLine({ type: 'status', phase: 'step_start', turn: d.turn ?? 1, step: d.step ?? 1 });
                  break;
                case 'step/end':
                  emitLine({
                    type: 'status',
                    phase: 'step_end',
                    turn: d.turn ?? 1,
                    step: d.step ?? 1,
                    ...(d.usage ? { usage: d.usage } : {}),
                  });
                  break;
                case 'assistant/thinking':
                case 'thinking': {
                  const t = extractText(d.text ?? d.content ?? d);
                  if (t) emitLine({ type: 'thinking', text: t });
                  break;
                }
                case 'assistant/text':
                case 'assistant/delta':
                case 'text': {
                  const t = extractText(d.text ?? d.delta ?? d.content ?? d);
                  if (t) {
                    turnText += t;
                    emitLine({ type: 'text', text: t });
                  }
                  break;
                }
                case 'assistant/message': {
                  const blocks = Array.isArray(d.message?.content) ? d.message.content : null;
                  if (blocks) {
                    for (const b of blocks) {
                      if (b?.type === 'reasoning' && typeof b.text === 'string' && b.text) {
                        emitLine({ type: 'thinking', text: b.text });
                      } else if (b?.type === 'text' && typeof b.text === 'string' && b.text && !turnText) {
                        emitLine({ type: 'text', text: b.text });
                      }
                    }
                  }
                  const t = extractText(d.content ?? d.message ?? d.text ?? d);
                  if (t) finalMsgText = t;
                  break;
                }
                case 'tool/call':
                case 'tool_call': {
                  let parsedInput = d.input ?? d.args;
                  if (parsedInput === undefined && typeof d.arguments === 'string') {
                    try {
                      parsedInput = JSON.parse(d.arguments);
                    } catch {
                      parsedInput = { raw: d.arguments };
                    }
                  }
                  emitLine({
                    type: 'tool_call',
                    callId: d.callId ?? d.id ?? 'call',
                    tool: d.tool ?? d.name ?? 'tool',
                    input: parsedInput ?? {},
                  });
                  break;
                }
                case 'tool/result':
                case 'tool_result': {
                  const msg = d.message && typeof d.message === 'object' ? d.message : null;
                  emitLine({
                    type: 'tool_result',
                    callId: msg?.toolCallId ?? d.callId ?? d.id ?? 'call',
                    status: msg?.isError === true || d.status === 'error' || d.isError ? 'error' : 'completed',
                    result: extractText(msg?.content ?? d.result ?? d.content ?? ''),
                  });
                  break;
                }
                case 'turn/end':
                  if (d.status === 'failed' || d.status === 'error') {
                    turnErr = String(d.error ?? d.message ?? 'turn failed');
                  } else if (d.reason?.kind === 'error') {
                    turnErr = String(d.reason?.error?.message ?? d.reason?.message ?? 'turn failed');
                  }
                  emitLine({ type: 'status', phase: 'turn_end', turn: d.turn ?? 1 });
                  turnDoneResolve?.();
                  break;
              }
            })
          : () => {};

      const onAbort = () => {
        try {
          if (typeof agent.abort === 'function') agent.abort();
          else if (typeof agent.cancel === 'function') agent.cancel('user');
        } catch {
          /* ignore */
        }
        turnDoneResolve?.();
      };
      signal?.addEventListener?.('abort', onAbort, { once: true });

      try {
        const tagRpcId = rpcId || `aitm:${Date.now()}`;
        let contentBlocks = [{ type: 'text', text: String(prompt ?? '') }];
        const attachments = getAttachments();
        if (Array.isArray(images) && images.length > 0 && typeof attachments?.admitPromptContent === 'function') {
          try {
            const rawParts = [
              ...images
                .filter((im) => im && typeof im.dataBase64 === 'string' && im.dataBase64.trim())
                .map((im) => ({
                  type: 'image',
                  mediaType: im.mime || 'image/png',
                  data: im.dataBase64.replace(/\s+/g, ''),
                  ...(im.name ? { name: im.name } : {}),
                })),
              { type: 'text', text: String(prompt ?? '') },
            ];
            const admitted = await attachments.admitPromptContent(rawParts);
            if (Array.isArray(admitted) && admitted.length > 0) {
              contentBlocks = admitted;
            }
          } catch {
            /* admitPromptContent 失败时平稳退回纯文本块 */
          }
        }
        // DSH ReactLoopAgent.followup(input) 要求传入合法的 V4 UserMessage 对象：
        // 若直接传字符串，ReactLoopInbox.splice 会把字符串写进 `agent/inbox/spliced.data.inserted`，
        // 导致持久化日志 session.v4.jsonl.zstd 在下次读取时抛 `SessionFormatError: agent/inbox/spliced requires message objects`。
        const userMessage = Object.freeze({
          id: crypto.randomUUID(),
          role: 'user',
          content: contentBlocks,
          source: { kind: 'user', rpcId: tagRpcId },
        });
        let followupRet = null;
        if (typeof agent.followup === 'function') {
          followupRet = await agent.followup(userMessage, { rpcId: tagRpcId });
        } else if (agent.inbox && typeof agent.inbox.enqueue === 'function') {
          followupRet = await agent.inbox.enqueue({
            kind: 'followup',
            content: prompt,
            message: userMessage,
            source: { kind: 'user', rpcId: tagRpcId },
          });
        } else {
          return { ok: false, text: '', error: `live agent for "${sessionId}" does not support followup/inbox` };
        }
        if (typeof ctx?.on === 'function') {
          await Promise.race([turnDone, new Promise((r) => setTimeout(r, 50))]);
          while (agent.status === 'running' && !signal?.aborted) {
            await Promise.race([turnDone, new Promise((r) => setTimeout(r, 100))]);
          }
        }
        if (followupRet && typeof followupRet === 'object' && typeof followupRet.text === 'string' && !finalMsgText) {
          finalMsgText = followupRet.text;
        }
        const finalOut = (finalMsgText || turnText).trim();
        if (finalOut) emitLine({ type: 'final', text: finalOut });
        if (turnErr) return { ok: false, text: finalOut, error: turnErr };
        return { ok: true, text: finalOut };
      } catch (err) {
        return { ok: false, text: (finalMsgText || turnText).trim(), error: String(err?.message ?? err) };
      } finally {
        inFlightSessions.delete(sessionId);
        try {
          const sessions = hostService(ctx, 'sessions');
          if (agent.session && typeof sessions?.flush === 'function') {
            await sessions.flush(agent.session);
          }
        } catch {
          /* ignore */
        }
        try {
          unsub?.();
        } catch {
          /* ignore */
        }
        signal?.removeEventListener?.('abort', onAbort);
      }
    },
  };
}

export function pickHostSession(ctx) {
  if (process.env.AITM_HOST_SESSION === '0') return { hostSession: null, why: 'AITM_HOST_SESSION=0' };
  if (!ctx) return { hostSession: null, why: 'no ctx' };
  return { hostSession: makeHostSessionSeam(ctx), why: null };
}

/**
 * 进程内 L3 热重载（#9）：
 * - 当用户在 Windows 上 `git pull && npm run build`（或修改 `src/`）后，无需退出 DSH，
 *   通过 query 参数绕过 Node ESM 模块缓存重新 import 最新 `dist-server/l3.mjs`，
 *   并优先复用同一回环端口，彻底消除“半新半旧”的内存旧实例问题。
 */
export async function reloadL3(opts = {}) {
  if (state.reloading) return state.reloading;
  state.reloading = (async () => {
    try {
      if (state.mode !== 'l3' && state.mode !== 'vendor') {
        return {
          reloaded: false,
          version: state.identity?.version ?? pluginVersion(),
          buildAt: state.identity?.buildAt ?? null,
          base: state.base,
        };
      }
      const vendored = state.mode === 'vendor';
      if (!vendored && opts.rebuild !== false) {
        await ensureL3Bundle(DEFAULTS.repo);
      }
      const bundlePath = vendored ? VENDOR_L3() : L3_BUNDLE();
      const diskMtime = exists(bundlePath) ? fs.statSync(bundlePath).mtimeMs : 0;
      if (!opts.force && state.l3 && diskMtime > 0 && diskMtime <= state.l3Mtime) {
        return {
          reloaded: false,
          version: state.identity?.version ?? pluginVersion(),
          buildAt: state.identity?.buildAt ?? null,
          base: state.base,
        };
      }

      // 若当前有在跑的 AI 任务且未显式 force，暂缓自动替换（等任务结束再换）
      const activeStats = state.l3?.app?.runner?.stats;
      if (!opts.force && activeStats && (activeStats.running > 0 || activeStats.queued > 0)) {
        return {
          reloaded: false,
          version: state.identity?.version ?? pluginVersion(),
          buildAt: state.identity?.buildAt ?? null,
          base: state.base,
        };
      }

      const prevL3 = state.l3;
      const prevPort = state.l3Port || prevL3?.port || 0;
      if (prevL3) {
        try {
          prevL3.server?.closeAllConnections?.();
        } catch {
          /* ignore */
        }
        await prevL3.stop().catch(() => undefined);
      }

      const staticDir = vendored
        ? exists(path.join(VENDOR_DIST(), 'index.html'))
          ? VENDOR_DIST()
          : null
        : RENDERER_DIST();
      const cacheBustUrl = `${pathToFileURL(bundlePath).href}?v=${diskMtime || Date.now()}_${Date.now()}`;
      const mod = await import(cacheBustUrl);
      if (typeof mod?.createL3 !== 'function') {
        throw new Error(`L3 产物缺少 createL3（${bundlePath}）`);
      }

      const seam = pickHostSpawn(state.ctx);
      const sessionSeam = pickHostSession(state.ctx);
      const makeOpts = (port) => ({
        home: vendored
          ? process.env.AI_TASKS_HOME ?? path.join(os.homedir(), '.ai-tasks-mgr')
          : process.env.AI_TASKS_HOME ?? path.join(DEFAULTS.repo, '.aitasks'),
        port,
        host: '127.0.0.1',
        staticDir,
        version: pluginVersion(),
        spawn: seam.spawn,
        hostSession: sessionSeam.hostSession,
        reloadL3: async () => {
          setTimeout(() => {
            void reloadL3({ force: true }).catch(() => undefined);
          }, 25);
          return {
            reloaded: true,
            version: pluginVersion(),
            buildAt: state.identity?.buildAt ?? null,
          };
        },
      });

      let nextL3;
      try {
        nextL3 = await mod.createL3(makeOpts(prevPort));
      } catch {
        nextL3 = await mod.createL3(makeOpts(0));
      }
      const h = await nextL3.health();
      state.l3 = nextL3;
      state.l3Mtime = diskMtime || Date.now();
      state.l3Port = nextL3.port || prevPort;
      state.base = nextL3.base;
      state.identity = backendId(h);
      note(`[host] 进程内 L3 已热重载：${nextL3.base}（v${state.identity.version ?? '?'}，共 ${h.actions} 个 action）`);
      logLine(`[host] hot-reloaded in-process L3 at ${nextL3.base} (version=${state.identity.version}, actions=${h.actions})`);
      return {
        reloaded: true,
        version: state.identity.version ?? pluginVersion(),
        buildAt: state.identity.buildAt ?? null,
        base: nextL3.base,
      };
    } finally {
      state.reloading = null;
    }
  })();
  return state.reloading;
}

/** 若磁盘上的 dist-server/l3.mjs 已更新，自动触发一次进程内 L3 热重载 */
async function maybeHotReloadL3() {
  if (state.mode !== 'l3' || !state.l3) return;
  const bundlePath = L3_BUNDLE();
  if (!exists(bundlePath)) return;
  try {
    const diskMtime = fs.statSync(bundlePath).mtimeMs;
    if (diskMtime > state.l3Mtime) {
      await reloadL3({ force: false, rebuild: false });
    }
  } catch {
    /* ignore */
  }
}

/** 调一个 action：进程内 L3 直连内核；外部后端（AITM_URL）/旧桥走 POST /api/<action> */
async function call(action, payload = {}) {
  const base = await ensureBase();
  await maybeHotReloadL3();
  // 进程内（l3 / vendor）直连内核；external / 旧桥走 HTTP
  if (state.l3) return state.l3.invoke(action, payload);
  return httpCall(base, action, payload);
}

async function httpCall(base, action, payload = {}) {
  const res = await fetch(`${base}/api/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const env = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!env?.ok) throw new Error(env?.error ?? `HTTP ${res.status}`);
  return env.data;
}

/** 确保有一个可用后端：AITM_URL 优先；否则按需拉起（同一进程内只拉一次） */
export async function ensureBase() {
  if (DEFAULTS.url) {
    if (!state.base) {
      const h = await health(DEFAULTS.url, 3000);
      if (h?.ok && !compatible(h)) throw incompatibleError(DEFAULTS.url, h, 'AITM_URL');
      state.base = DEFAULTS.url;
      state.identity = backendId(h);
    }
    return state.base;
  }
  if (state.base) {
    await maybeHotReloadL3();
    return state.base;
  }
  if (state.starting) return state.starting;

  state.starting = (async () => {
    // ── 默认：进程内 L3（M2 第三步）──
    // 不起常驻子进程、不走 HTTP（call() 直连内核）；只留一个回环端口给面板 iframe。
    // 没有「复用旧实例」这一步 ⇒ R10 那类「连上 51 个 action 的旧后端」从根上不存在了。
    const plan = backendPlan();
    if (plan.mode === 'error') throw repoError(plan.why, plan);

    if (plan.mode === 'l3' || plan.mode === 'vendor') {
      const vendored = plan.mode === 'vendor';
      if (!vendored) {
        const bundleProblem = await ensureL3Bundle(DEFAULTS.repo);
        if (bundleProblem) throw new Error(`${bundleProblem}。处理：在 ${DEFAULTS.repo} 跑一次 npm run build（或 npm install 补依赖）`);
        const distProblem = ensureRendererDist(DEFAULTS.repo);
        if (distProblem) throw new Error(`${distProblem}。处理：在 ${DEFAULTS.repo} 跑一次 npm run build`);
      }

      const bundlePath = vendored ? VENDOR_L3() : L3_BUNDLE();
      const staticDir = vendored ? (exists(path.join(VENDOR_DIST(), 'index.html')) ? VENDOR_DIST() : null) : RENDERER_DIST();
      const diskMtime = exists(bundlePath) ? fs.statSync(bundlePath).mtimeMs : Date.now();
      let mod;
      try {
        mod = await import(`${pathToFileURL(bundlePath).href}?v=${diskMtime}`);
      } catch (err) {
        throw new Error(
          vendored
            ? `自带内核加载失败（${bundlePath}）：${String(err?.message ?? err)}。处理：重装插件（npm/pnpm 会带上 dist-server/l3.mjs）`
            : `进程内 L3 加载失败（${bundlePath}）：${String(err?.message ?? err)}。处理：在 ${DEFAULTS.repo} 跑一次 npm run build`,
        );
      }
      if (typeof mod?.createL3 !== 'function') {
        throw new Error(
          vendored
            ? `自带内核不完整（${bundlePath} 里没有 createL3）。处理：重装插件；或拉仓库后跑 node scripts/vendor-plugin.mjs 重新生成`
            : `进程内 L3 产物不完整（${bundlePath} 里没有 createL3）。处理：删掉它，再到 ${DEFAULTS.repo} 跑一次 npm run build`,
        );
      }

      // 子进程接缝与宿主会话接缝：**每次起内核时现选**（服务可能是后提供的，别在 apply 时把结论钉死）
      const seam = pickHostSpawn(state.ctx);
      const sessionSeam = pickHostSession(state.ctx);
      const l3 = await mod.createL3({
        // 数据目录：AI_TASKS_HOME 优先；仓库模式下用仓库里的 .aitasks（Windows 真机上那份数据就在仓库内，
        // 用户不用多设任何变量），自带内核模式没有仓库可言 → 用 ~/.ai-tasks-mgr（和 Electron 回退口径一致）
        home: vendored
          ? process.env.AI_TASKS_HOME ?? path.join(os.homedir(), '.ai-tasks-mgr')
          : process.env.AI_TASKS_HOME ?? path.join(DEFAULTS.repo, '.aitasks'),
        port: 0,
        host: '127.0.0.1',
        staticDir,
        version: pluginVersion(),
        // 有 ctx.subprocess 就把 CLI 引擎起的进程交给宿主托管；没有就 null（内核自己 spawn）
        spawn: seam.spawn,
        // 有 ctx.agents / ctx.sessionQuery 就打通 P1 只读镜像 + P2 进程内借道投递
        hostSession: sessionSeam.hostSession,
        reloadL3: async () => {
          setTimeout(() => {
            void reloadL3({ force: true }).catch(() => undefined);
          }, 25);
          return {
            reloaded: true,
            version: pluginVersion(),
            buildAt: state.identity?.buildAt ?? null,
          };
        },
      });
      const h = await l3.health();
      if (!compatible(h)) throw incompatibleError(l3.base, h, vendored ? '自带内核' : '进程内 L3');
      state.l3 = l3;
      state.l3Mtime = diskMtime;
      state.l3Port = l3.port || 0;
      state.mode = vendored ? 'vendor' : 'l3';
      state.base = l3.base;
      state.identity = backendId(h);
      note(`[host] ${vendored ? '自带内核（分发模式）' : '进程内 L3'}就绪：${l3.base}（数据目录 ${l3.home}，共 ${h.actions} 个 action）`);
      logLine(`[host] in-process L3 ready at ${l3.base} (home=${l3.home}, actions=${h.actions}, vendored=${String(vendored)})`);
      return state.base;
    }

    // ── 逃生通道：旧的 spawn 桥（AITM_L3=0）──
    // 先看登记表：上一次会话起的后端还活着就复用（不叠着起第二个）
    const known = readRegistry();
    if (known?.pid && known?.base && pidAlive(known.pid)) {
      const h = await health(known.base);
      if (h?.ok && compatible(h)) {
        note(`[host] 复用已有后端 ${known.base}（pid=${known.pid}，v${backendId(h).version ?? '?'}）`);
        state.adopted = true;
        state.base = known.base;
        state.identity = backendId(h);
        return known.base;
      }
      if (h?.ok) {
        // 不兼容：**不动**那个进程（可能是别人的会话在用），只拒绝复用，自己起一个
        note(`[host] 拒绝复用旧后端 ${known.base}：apiRev=${backendId(h).apiRev} < ${REQUIRED_API_REV}（v${backendId(h).version ?? '?'}）`);
      }
    }

    const problem = preflightRepo(DEFAULTS.repo);
    if (problem) throw repoError(problem);

    const port = await freePort();
    const vitePort = await freePort();
    const base = `http://127.0.0.1:${port}`;
    if (!DEFAULTS.spawn) throw new Error(`没配 AITM_URL，且 AITM_SPAWN=0：连不上后端（${base}）`);

    const debug = process.env.AITM_DEBUG === '1';
    const supervisor = path.join(PLUGIN_DIR, 'supervisor.mjs');
    // 后端交给看门狗起（见 supervisor.mjs）：DSH 被强杀时收尾钩子不跑，
    // 由看门狗盯着本进程的 pid 来收后端 —— 这样「关掉 DSH 不留后端」在 Ctrl+C / 强杀下也成立。
    let child;
    try {
      child = spawn(process.execPath, [supervisor, String(process.pid), DEFAULTS.repo, String(port), String(vitePort), PIDFILE, BACKEND_LOG], {
        // stdio 用 ignore + unref：否则这个长驻子进程会把 DSH 的 headless 进程「钉」住不退出
        // （实测过：一次 headless 跑完 turn 也不结束，直到超时）。要看子进程日志就 AITM_DEBUG=1。
        // 后端自己的输出由看门狗追进 BACKEND_LOG，失败时我们能读到（见 supervisor.mjs）。
        stdio: debug ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'ignore', 'ignore'],
        // detached：自成进程组，收尾时能整组干掉（看门狗 + 后端 + vite 一起走）
        detached: true,
      });
    } catch (err) {
      throw repoError(`起后端的进程失败：${String(err?.message ?? err)}（cwd=${DEFAULTS.repo}，node=${process.execPath}）`);
    }
    state.child = child;
    child.unref?.();
    // spawn 本身失败（cwd 不存在 / node 不允许）：立刻记下来，让 waitHealth 别空等 90 秒
    child.on('error', (err) => {
      state.spawnError = `起后端的进程失败：${String(err?.message ?? err)}（cwd=${DEFAULTS.repo}，node=${process.execPath}）`;
      note(`[host!] ${state.spawnError}`);
      logLine(`[host!] ${state.spawnError}`);
    });
    // 登记的是**看门狗**的 pid（收它 = 连后端整棵树一起收）
    writeRegistry({ pid: child.pid, base, repo: DEFAULTS.repo, at: Date.now() });
    if (debug) {
      child.stdout?.on('data', (b) => note(`[host] ${String(b).trim()}`));
      child.stderr?.on('data', (b) => note(`[host!] ${String(b).trim()}`));
    }
    child.on('exit', (code) => {
      note(`[host] 退出 code=${code}`);
      if (state.base === base) {
        state.base = null;
        state.starting = null;
      }
    });

    const h = await waitHealth(base, 90_000, { failed: () => state.spawnError });
    if (!compatible(h)) {
      // 插件是从哪个仓库加载的，它就会起哪个仓库的后端 —— 这两个都会在错误里说清
      throw incompatibleError(base, h, '插件自己拉起的后端');
    }
    state.identity = backendId(h);
    state.base = base;
    return base;
  })();

  try {
    return await state.starting;
  } catch (err) {
    state.starting = null;
    throw err;
  }
}

export { stop };

/** 离线自检用的钩子（verify-dsh 拿假 subprocess / session 服务把适配层过一遍） */
export const __hostHelpers = { makeSubprocessSpawner, pickHostSpawn, makeHostSessionSeam, pickHostSession, hostService, hostSeamDiagnosis, reloadL3 };

/** 诊断用：把「插件眼里的世界」原样抖出来（scripts/doctor.mjs 用；也让 verify 能断言自检逻辑） */
export function diagnose() {
  return {
    pluginDir: PLUGIN_DIR,
    repo: DEFAULTS.repo,
    repoFromEnv: REPO_ENV,
    repoProblem: preflightRepo(DEFAULTS.repo),
    url: DEFAULTS.url || null,
    spawn: DEFAULTS.spawn,
    apiRevRequired: REQUIRED_API_REV,
    approve: DEFAULTS.approve,
    pluginVersion: pluginVersion(),
    /** 客户端半边（client.js）指纹 —— 和 DSH 的 `&rev=` 同算法，用来回答「面板是哪一版」 */
    clientRev: clientRevision(),
    /** 同一份文件的**内容** sha1（定论用：面板自己取回代码算一遍，字节一致才算「本页就是这份」） */
    clientSha: clientSha(),
    /**
     * 后端来法（**实际会走哪条**，不只是配置）：l3（仓库内进程内 L3）/ vendor（包里自带内核）/
     * external（AITM_URL）/ spawn（AITM_L3=0 的旧桥）/ error（自检没过，起不来）。
     */
    backendMode: backendPlan().mode,
    backendWhy: backendPlan().why ?? null,
    dataHome: process.env.AI_TASKS_HOME ?? null,
    l3Bundle: L3_BUNDLE(),
    l3BundlePresent: exists(L3_BUNDLE()),
    vendorL3: VENDOR_L3(),
    vendorL3Present: vendorPresent(),
    vendorDistPresent: exists(path.join(VENDOR_DIST(), 'index.html')),
    rendererDistPresent: exists(path.join(RENDERER_DIST(), 'index.html')),
    runningMode: state.mode,
    registry: PIDFILE,
    /** 宿主缝现探（四个服务逐个探一遍）+ 启动时那次子进程缝结论 */
    hostSeam: hostSeamDiagnosis(state.ctx),
    spawnSeam: state.spawnSeam,
    backendLog: BACKEND_LOG,
    node: process.version,
  };
}

async function stop() {
  if (state.l3) {
    try {
      await state.l3.stop();
      note('[host] 已收掉进程内 L3（端口与内核）');
    } catch (err) {
      note(`[host] 收 L3 时报错（忽略）：${String(err?.message ?? err)}`);
    }
    state.l3 = null;
    state.l3Mtime = 0;
    state.l3Port = 0;
    state.mode = null;
  }
  if (state.child?.pid && !state.adopted) {
    const pid = state.child.pid;
    killGroup(pid, 'SIGTERM');
    // 3 秒还不走就强杀（有些环境 SIGTERM 会被忽略）
    setTimeout(() => {
      if (pidAlive(pid)) killGroup(pid, 'SIGKILL');
    }, 3000).unref?.();
    clearRegistryIf(pid);
    note('[host] 已收掉我们拉起的后端（整进程组）');
  }
  state.child = null;
  state.adopted = false;
  state.base = null;
  state.starting = null;
  state.identity = null;
}

const schemaHealth = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean', required: true },
    actions: { type: 'integer' },
    dataDir: { type: 'string' },
    base: { type: 'string' },
    version: { type: 'string' },
    apiRev: { type: 'integer' },
    apiRevRequired: { type: 'integer' },
    log: { type: 'array', items: { type: 'string' } },
    /** 宿主缝结论（一句话）+ 逐个服务的探活明细（P1 镜像 / P2 借道见 docs/DESIGN-NOTES.md §7.10） */
    hostSeam: { type: 'string' },
    hostSeamServices: { type: 'string' },
  },
};

/** 想法详情（aitm_idea_get） */
const schemaIdeaDetail = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean' },
    error: { type: 'string' },
    id: { type: 'string' },
    title: { type: 'string' },
    status: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    description: { type: 'string' },
    // 注意：spec / priority / repo 可空，**不要**在这里声明成 string/object ——
    // DSH 会严格校验（实测报「value.spec must be a string」），可空字段交给 additionalProperties 放行，
    // 由 execute() 只在有值时带上（见下面的写法）。
    repo: { type: 'object', additionalProperties: true },
    tasks: { type: 'array', items: { type: 'object', additionalProperties: true } },
  },
};

/** 写回想法（aitm_idea_set_spec / aitm_idea_update 共用） */
const schemaIdeaWrite = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean', required: true },
    error: { type: 'string' },
    id: { type: 'string' },
    title: { type: 'string' },
    status: { type: 'string' },
    specChars: { type: 'integer' },
    changed: { type: 'array', items: { type: 'string' } },
  },
};

/** 任务进度 / 开（aitm_task_status、aitm_task_start 共用：一个给 task、一个给 items） */
const schemaTaskStatus = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean' },
    error: { type: 'string' },
    task: { type: 'object', additionalProperties: true },
    items: { type: 'array', items: { type: 'object', additionalProperties: true } },
  },
};

/** 某天的日历（aitm_calendar_day） */
const schemaCalendar = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean' },
    error: { type: 'string' },
    day: { type: 'string' },
    monthIdeas: { type: 'integer' },
    monthFavorites: { type: 'integer' },
    ideas: { type: 'array', items: { type: 'object', additionalProperties: true } },
    favorites: { type: 'array', items: { type: 'object', additionalProperties: true } },
  },
};

/** 仓库与工作区占用（aitm_repo_status） */
const schemaRepos = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean' },
    error: { type: 'string' },
    repos: { type: 'array', items: { type: 'object', additionalProperties: true } },
    worktrees: { type: 'integer' },
    totalKb: { type: 'number' },
    reclaimable: { type: 'integer' },
  },
};

/** 验收 / 合并（aitm_task_accept） */
const schemaAccept = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean' },
    error: { type: 'string' },
    accepted: { type: 'boolean' },
    merged: { type: 'boolean' },
    needsAcknowledge: { type: 'boolean' },
    taskId: { type: 'string' },
    ideaTitle: { type: 'string' },
    baseRef: { type: 'string' },
    detail: { type: 'string' },
    verify: { type: 'object', additionalProperties: true },
  },
};

/** 验证记录压成卡片能显示的几项（null 一律不写：宿主 schema 过不了 null） */
const pickVerify = (v) =>
  v && typeof v === 'object'
    ? {
        ok: v.ok === true,
        ...(typeof v.note === 'string' ? { note: v.note } : {}),
        ...(typeof v.at === 'number' ? { at: v.at } : {}),
      }
    : null;

/** 备份（aitm_backup_now） */
const schemaBackup = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean' },
    error: { type: 'string' },
    id: { type: 'string' },
    mode: { type: 'string' },
    files: { type: 'integer' },
    bytes: { type: 'number' },
    label: { type: 'string' },
    deduped: { type: 'boolean' },
  },
};

export function apply(ctx) {
  // 子进程缝要**懒取**（ctx.subprocess 可能是后提供的），这里只留个引用给 ensureBase
  state.ctx = ctx;

  /* -------- ③ 给浏览器半边递地址（客户端在浏览器里，看不见 Node 环境变量） -------- */
  ctx.inject?.(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      webCtx.webServer.register({
        kind: 'prefix',
        path: '/aitm-plugin',
        handler: async (req, res) => {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1');
          if (url.pathname === '/aitm-plugin/reload') {
            try {
              await ensureBase();
              const r = await reloadL3({ force: true });
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
              res.end(JSON.stringify({ ok: true, ...r }));
            } catch (err) {
              res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
              res.end(JSON.stringify({ ok: false, error: String(err?.message ?? err) }));
            }
            return true;
          }
          if (url.pathname === '/aitm-plugin/config') {
            let base = null;
            let error = null;
            try {
              base = await ensureBase();
            } catch (err) {
              error = String(err?.message ?? err);
            }
            // identity：客户端面板与设置节要把「连的是哪个后端」显示出来
            // （踩过：复用了一个旧实例，界面上 51 个 action、工具报「未知接口：feed.get」）
            // repo / repoProblem / log：起不来时面板要直接能看出「在哪个目录起、为什么没起来」
            const body = JSON.stringify({
              base,
              error,
              mode: state.mode,
              repo: DEFAULTS.repo,
              repoProblem: preflightRepo(DEFAULTS.repo),
              vendorL3: vendorPresent(),
              pluginVersion: pluginVersion(),
              clientRev: clientRevision(),
              clientSha: clientSha(),
              apiRevRequired: REQUIRED_API_REV,
              identity: state.identity,
              log: state.log.slice(-8),
              // 宿主缝现探 + 启动时那次子进程缝自检（state.spawnSeam 以前写了没人读，这里摊给面板）
              hostSeam: hostSeamDiagnosis(state.ctx),
              spawnSeam: state.spawnSeam,
              // 后端日志尾部（面板直接显示）；整份日志在 BACKEND_LOG 文件里
              tail: (() => {
                try {
                  return readBackendLog().slice(-LOG_TAIL);
                } catch {
                  return [];
                }
              })(),
            });
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            res.end(body);
            return true;
          }
          return false;
        },
      });
      return () => {};
    });
  });

  /* -------- ② 三个只读工具 -------- */
  ctx.tools.register(
    defineTool({
      name: 'aitm_health',
      description: 'AI 任务台后端健康检查：是否可用、action 数量、数据目录、后端地址。排查「面板打不开」时先调它。',
      parameters: {},
      presentCall: () => ({ card: 'generic', title: 'AI 任务台 · 健康检查', kind: 'read' }),
      output: {
        schema: schemaHealth,
        // 客户端工具卡读的**结构化摘要**（meta 会原样落到 tool/result 上）
        presentationMeta: (_a, v) => ({
          kind: 'health',
          ok: Boolean(v?.ok),
          actions: typeof v?.actions === 'number' ? v.actions : null,
          apiRev: typeof v?.apiRev === 'number' ? v.apiRev : null,
          version: typeof v?.version === 'string' ? v.version : null,
          dataDir: typeof v?.dataDir === 'string' ? v.dataDir : null,
          error: typeof v?.error === 'string' ? v.error : null,
          hostSeam: typeof v?.hostSeam === 'string' ? v.hostSeam : null,
          hostSeamServices: typeof v?.hostSeamServices === 'string' ? v.hostSeamServices : null,
        }),
        render: (_a, v) => [
          {
            type: 'text',
            text: v.ok
              ? `AI 任务台可用：${v.base}（${v.actions} 个 action，apiRev=${v.apiRev ?? '?'}，版本 ${v.version ?? '未知'}${v.dataDir ? `，数据目录 ${v.dataDir}` : ''}）`
              : `不可用：${JSON.stringify(v)}`,
          },
          ...(v.hostSeam
            ? [{ type: 'text', text: `宿主缝：${v.hostSeam}${v.hostSeamServices ? `\n${v.hostSeamServices}` : ''}` }]
            : []),
        ],
      },
      async execute() {
        const seam = hostSeamDiagnosis(state.ctx);
        const seamFields = { hostSeam: seam.verdict, hostSeamServices: seam.services };
        try {
          const base = await ensureBase();
          const h = state.l3 ? await state.l3.health() : await health(base, 3000);
          if (!h?.ok) return { ok: false, error: 'GET /api/health 不通', base, ...seamFields, log: state.log.slice(-10) };
          // 数据目录：新后端在 health 里给；老后端没有，才回落到 settings.get
          let dataDir = h.dataDir;
          if (!dataDir) {
            try {
              const st = await call('settings.get');
              dataDir = st?.dataDir ?? st?.paths?.dataDir;
            } catch {
              /* 拿不到就算了 */
            }
          }
          const id = backendId(h);
          return {
            ...h,
            base,
            ...(dataDir ? { dataDir } : {}),
            apiRev: id.apiRev,
            apiRevRequired: REQUIRED_API_REV,
            ...seamFields,
            log: state.log.slice(-6),
          };
        } catch (err) {
          return { ok: false, error: String(err?.message ?? err), ...seamFields, log: state.log.slice(-10) };
        }
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'aitm_idea_list',
      description:
        '列出 AI 任务台里的想法（默认 20 条），可按状态（inbox/ready/developing/review…）或关键词过滤；同时返回各状态计数。',
      parameters: {
        status: { type: 'string', description: '按状态过滤，如 inbox / ready / developing / review；省略=全部。' },
        q: { type: 'string', description: '标题/正文/标签关键词。' },
        limit: { type: 'number', description: '最多返回几条，默认 20，上限 100。' },
      },
      presentCall: (a) => ({ card: 'generic', title: `AI 任务台 · 查想法${a?.status ? `（${String(a.status)}）` : ''}${a?.q ? `「${String(a.q)}」` : ''}`, kind: 'search', rawInput: a?.q ?? a?.status ?? undefined }),
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            total: { type: 'integer', required: true },
            counts: { type: 'object', additionalProperties: true },
            ideas: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  id: { type: 'string', required: true },
                  title: { type: 'string', required: true },
                  status: { type: 'string', required: true },
                  updatedAt: { type: 'integer' },
                  tags: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
        presentationMeta: (_a, v) => ({
          kind: 'idea-list',
          total: v?.total ?? 0,
          counts: v?.counts ?? {},
          ideas: (v?.ideas ?? []).slice(0, 8).map((i) => ({ id: i.id, title: i.title, status: i.status })),
        }),
        render: (_a, v) => [
          {
            type: 'text',
            text: `共 ${v.total} 条；各状态 ${JSON.stringify(v.counts)}\n` + v.ideas.map((i) => `- [${i.status}] ${i.title}`).join('\n'),
          },
        ],
      },
      async execute(args) {
        const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
        const ideas = await call('idea.list', {
          ...(args.status ? { status: args.status } : {}),
          ...(args.q ? { q: args.q } : {}),
        });
        const all = args.status || args.q ? await call('idea.list', {}) : ideas;
        const counts = all.reduce((acc, i) => ({ ...acc, [i.status]: (acc[i.status] ?? 0) + 1 }), {});
        return {
          total: ideas.length,
          counts,
          ideas: ideas
            .slice(0, limit)
            .map((i) => ({ id: i.id, title: i.title, status: i.status, updatedAt: i.updatedAt, tags: i.tags ?? [] })),
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'aitm_feed_today',
      description:
        'AI 任务台新闻合集今日概览：GitHub/B站热榜条数与收藏条数（只读快照，不触发抓取；要抓新数据请让用户在面板点刷新）。',
      parameters: {},
      presentCall: () => ({ card: 'generic', title: 'AI 任务台 · 今日新闻合集', kind: 'read' }),
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            github: { type: 'integer', required: true },
            bilibili: { type: 'integer', required: true },
            favorites: { type: 'integer', required: true },
            top: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: true,
                properties: { title: { type: 'string', required: true }, source: { type: 'string', required: true }, url: { type: 'string' } },
              },
            },
          },
        },
        presentationMeta: (_a, v) => ({
          kind: 'feed',
          github: v?.github ?? 0,
          bilibili: v?.bilibili ?? 0,
          favorites: v?.favorites ?? 0,
          top: (v?.top ?? []).slice(0, 6).map((t) => ({ title: t.title, source: t.source, url: t.url ?? null })),
        }),
        render: (_a, v) => [
          {
            type: 'text',
            text: `GitHub ${v.github} 条 · B站 ${v.bilibili} 条 · 收藏 ${v.favorites} 条\n` + v.top.map((t) => `- (${t.source}) ${t.title}`).join('\n'),
          },
        ],
      },
      async execute() {
        const snap = await call('feed.get');
        const picks = [...(snap.github?.today ?? []), ...(snap.bilibili?.hot ?? [])]
          .slice(0, 5)
          .map((i) => ({ title: i.title, source: i.source, url: i.url }));
        return {
          github: snap.github?.today?.length ?? 0,
          bilibili: snap.bilibili?.hot?.length ?? 0,
          favorites: snap.favorites?.length ?? 0,
          top: picks,
        };
      },
    }),
  );

  /* -------- ③ 写工具（要过下面的审批闸；只在用户点了「同意」后才会真正落地） -------- */
  ctx.tools.register(
    defineTool({
      name: 'aitm_idea_create',
      description:
        '在 AI 任务台的灵感箱里新建一条想法（写操作，需要用户审批）。标题一句话；描述里带上来源链接/上下文。',
      parameters: {
        title: { type: 'string', description: '一句话标题（必填）。', required: true },
        description: { type: 'string', description: '正文：为什么、来源、期望结果。' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签，如 ["新闻灵感"]。' },
        priority: { type: 'string', description: '优先级 p0/p1/p2/p3，默认 p2。' },
        repoId: { type: 'string', description: '关到哪个仓库（省略 = 不关仓库）。' },
      },
      presentCall: (a) => ({ card: 'generic', title: `AI 任务台 · 记一条想法：${String(a?.title ?? '(待定)')}`, kind: 'edit' }),
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean', required: true },
            id: { type: 'string' },
            title: { type: 'string' },
            status: { type: 'string' },
            error: { type: 'string' },
          },
        },
        presentationMeta: (_a, v) =>
          v?.ok
            ? { kind: 'idea', action: 'create', id: v.id ?? null, title: v.title ?? null, status: v.status ?? null }
            : { kind: 'idea', action: 'create', ok: false, error: v?.error ?? '未知错误' },
        render: (_a, v) => [{ type: 'text', text: v.ok ? `已记进想法箱：${v.title}（${v.id}，状态 ${v.status}）` : `没写成：${v.error}` }],
      },
      async execute(args) {
        const title = String(args.title ?? '').trim();
        if (!title) return { ok: false, error: '标题不能为空' };
        try {
          const idea = await call('idea.create', {
            title,
            ...(args.description ? { description: String(args.description) } : {}),
            ...(Array.isArray(args.tags) && args.tags.length ? { tags: args.tags.map(String) } : {}),
            ...(args.priority ? { priority: String(args.priority) } : {}),
            ...(args.repoId ? { repoId: String(args.repoId) } : {}),
          });
          return { ok: true, id: idea?.id, title: idea?.title ?? title, status: idea?.status ?? 'inbox' };
        } catch (err) {
          return { ok: false, error: String(err?.message ?? err) };
        }
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'aitm_idea_set_status',
      description:
        '改一条想法的状态（写操作，需要用户审批）。合法流转：inbox→scoping/ready/archived；scoping→ready；ready→developing；developing→review；review→done。',
      parameters: {
        id: { type: 'string', description: '想法 id（可先用 aitm_idea_list 查）。', required: true },
        status: { type: 'string', description: '目标状态：scoping/ready/developing/review/done/archived。', required: true },
      },
      presentCall: (a) => ({ card: 'generic', title: `AI 任务台 · 改想法状态：${String(a?.id ?? '?')} → ${String(a?.status ?? '?')}`, kind: 'edit' }),
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean', required: true },
            id: { type: 'string' },
            title: { type: 'string' },
            status: { type: 'string' },
            error: { type: 'string' },
          },
        },
        presentationMeta: (_a, v) =>
          v?.ok
            ? { kind: 'idea', action: 'status', id: v.id ?? null, title: v.title ?? null, status: v.status ?? null }
            : { kind: 'idea', action: 'status', ok: false, error: v?.error ?? '未知错误' },
        render: (_a, v) => [
          { type: 'text', text: v.ok ? `已改：${v.title ?? v.id} → ${v.status}` : `没改成：${v.error}` },
        ],
      },
      async execute(args) {
        const id = String(args.id ?? '').trim();
        const status = String(args.status ?? '').trim();
        if (!id || !status) return { ok: false, error: 'id 与 status 都必填' };
        try {
          const idea = await call('idea.setStatus', { id, status });
          return { ok: true, id: idea?.id ?? id, title: idea?.title, status: idea?.status ?? status };
        } catch (err) {
          return { ok: false, error: String(err?.message ?? err) };
        }
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'aitm_idea_get',
      description: '看一条想法的详情：正文、状态、标签、规格（spec）与它下面的任务。想深入了解某条想法时用（列表只给标题）。',
      parameters: {
        id: { type: 'string', description: '想法 id（可先用 aitm_idea_list 查）。', required: true },
      },
      presentCall: (a) => ({ card: 'generic', title: `AI 任务台 · 看想法 ${String(a?.id ?? '?')}`, kind: 'read' }),
      output: {
        schema: schemaIdeaDetail,
        presentationMeta: (_a, v) =>
          v?.ok === false
            ? { kind: 'idea-detail', ok: false, error: v?.error ?? '未知错误' }
            : {
                kind: 'idea-detail',
                id: v.id,
                title: v.title,
                status: v.status,
                tags: v.tags ?? [],
                priority: v.priority ?? null,
                description: v.description ?? '',
                spec: v.spec ? String(v.spec).slice(0, 4000) : null,
                repo: v.repo?.name ?? null,
                tasks: (v.tasks ?? []).slice(0, 8).map((t) => ({ id: t.id, status: t.status, turns: t.turns ?? 0 })),
              },
        render: (_a, v) =>
          v.ok === false
            ? [{ type: 'text', text: `看不了：${v.error}` }]
            : [
                { type: 'text', text: `【${v.status}】${v.title}${v.tags?.length ? `（标签：${v.tags.join(' / ')}）` : ''}\n${v.description || '(没有正文)'}${v.spec ? `\n\n规格：\n${v.spec}` : ''}${v.tasks?.length ? `\n\n任务：${v.tasks.map((t) => `${t.id}(${t.status})`).join('、')}` : ''}` },
              ],
      },
      async execute(args) {
        const id = String(args.id ?? '').trim();
        if (!id) return { ok: false, error: 'id 必填' };
        try {
          const d = await call('idea.get', id);
          const idea = d?.idea;
          if (!idea) return { ok: false, error: `想法不存在：${id}` };
          return {
            ok: true,
            id: idea.id,
            title: idea.title,
            status: idea.status,
            tags: idea.tags ?? [],
            description: idea.description ?? '',
            // 可空字段：**有值才带**（null 过不了声明成 string/object 的输出校验）
            ...(idea.priority ? { priority: idea.priority } : {}),
            ...(idea.spec ? { spec: idea.spec } : {}),
            ...(d.repo ? { repo: { id: d.repo.id, name: d.repo.name, path: d.repo.path } } : {}),
            tasks: (d.tasks ?? []).map((t) => ({ id: t.id, status: t.status, turns: t.turns ?? 0, error: t.error ?? null })),
          };
        } catch (err) {
          return { ok: false, error: String(err?.message ?? err) };
        }
      },
    }),
  );

  /* -------- ② 写回工具：把 DSH 这边生成的正文/规格落进想法（同样过审批闸） -------- */
  ctx.tools.register(
    defineTool({
      name: 'aitm_idea_set_spec',
      description:
        '把一份规格（Markdown）写回想法，落在面板详情页的「规格」栏（写操作，需要用户审批）。' +
        '典型用法：你在对话里把某条想法梳理成了规格，落库让面板后续开工时用得上。' +
        '只写规格本身，不要带「以下是规格」这类开场白；原本是「灵感箱」的想法会顺势推到「梳理中」（与面板的「AI 梳理」一致）。',
      parameters: {
        id: { type: 'string', description: '想法 id（可先用 aitm_idea_list 查）。', required: true },
        spec: { type: 'string', description: '规格正文，Markdown（必填）。', required: true },
        status: { type: 'string', description: '可选的落地状态（scoping/ready）；省略时：灵感箱 → 梳理中，其余不动。' },
      },
      presentCall: (a) => ({
        card: 'generic',
        title: `AI 任务台 · 写回规格：${String(a?.id ?? '?')}（${String(a?.spec ?? '').length} 字）`,
        kind: 'edit',
      }),
      output: {
        schema: schemaIdeaWrite,
        presentationMeta: (_a, v) =>
          v?.ok
            ? { kind: 'idea', action: 'spec', id: v.id ?? null, title: v.title ?? null, status: v.status ?? null, specChars: v.specChars ?? 0 }
            : { kind: 'idea', action: 'spec', ok: false, error: v?.error ?? '未知错误' },
        render: (_a, v) =>
          v.ok
            ? [{ type: 'text', text: `规格已写回想法 ${v.title ?? v.id}（${String(v.specChars ?? 0)} 字，状态 ${v.status}）` }]
            : [{ type: 'text', text: `没写回：${v.error}` }],
      },
      async execute(args) {
        const id = String(args.id ?? '').trim();
        const spec = String(args.spec ?? '').trim();
        if (!id) return { ok: false, error: 'id 必填' };
        if (!spec) return { ok: false, error: 'spec 不能为空' };
        try {
          const cur = (await call('idea.get', id))?.idea;
          if (!cur) return { ok: false, error: `想法不存在：${id}` };
          // 状态：显式给了就用给的；没给就照面板「AI 梳理」的口径（灵感箱 → 梳理中），其余保持不动
          const status = args.status ? String(args.status) : cur.status === 'inbox' ? 'scoping' : cur.status;
          const idea = await call('idea.update', { id, spec, status });
          return { ok: true, id: idea?.id ?? id, title: idea?.title ?? cur.title, status: idea?.status ?? status, specChars: spec.length };
        } catch (err) {
          return { ok: false, error: String(err?.message ?? err) };
        }
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'aitm_idea_update',
      description:
        '改一条想法的标题或正文（写操作，需要用户审批）。只传要改的字段，没传的保持原样；' +
        '正文默认整段替换，`mode: "append"` 表示追加到原文末尾（适合补一段调研结论，不覆盖用户原话）。',
      parameters: {
        id: { type: 'string', description: '想法 id（可先用 aitm_idea_list 查）。', required: true },
        title: { type: 'string', description: '新标题（省略 = 不改）。' },
        description: { type: 'string', description: '新正文；mode=replace 时整段替换，append 时追加。' },
        mode: { type: 'string', description: '正文写入方式：replace（默认）或 append。' },
      },
      presentCall: (a) => ({ card: 'generic', title: `AI 任务台 · 改写想法：${String(a?.id ?? '?')}`, kind: 'edit' }),
      output: {
        schema: schemaIdeaWrite,
        presentationMeta: (_a, v) =>
          v?.ok
            ? {
                kind: 'idea',
                action: 'update',
                id: v.id ?? null,
                title: v.title ?? null,
                status: v.status ?? null,
                changed: Array.isArray(v.changed) ? v.changed : [],
              }
            : { kind: 'idea', action: 'update', ok: false, error: v?.error ?? '未知错误' },
        render: (_a, v) =>
          v.ok
            ? [{ type: 'text', text: `已改写想法 ${v.title ?? v.id}（改了：${(v.changed ?? []).join('、')}）` }]
            : [{ type: 'text', text: `没改成：${v.error}` }],
      },
      async execute(args) {
        const id = String(args.id ?? '').trim();
        if (!id) return { ok: false, error: 'id 必填' };
        const hasTitle = args.title !== undefined;
        const hasDesc = args.description !== undefined;
        if (!hasTitle && !hasDesc) return { ok: false, error: '至少给一个要改的字段：title 或 description' };
        try {
          const cur = (await call('idea.get', id))?.idea;
          if (!cur) return { ok: false, error: `想法不存在：${id}` };
          const changed = [];
          const patch = { id };
          if (hasTitle) {
            patch.title = String(args.title);
            changed.push('标题');
          }
          if (hasDesc) {
            const add = String(args.description);
            // append：读到的原文 + 空行 + 新内容；原文为空就等同替换
            patch.description = String(args.mode ?? 'replace') === 'append' && String(cur.description ?? '').trim()
              ? `${String(cur.description).trimEnd()}\n\n${add}`
              : add;
            changed.push('正文');
          }
          const idea = await call('idea.update', patch);
          return { ok: true, id: idea?.id ?? id, title: idea?.title ?? cur.title, status: idea?.status ?? cur.status, changed };
        } catch (err) {
          return { ok: false, error: String(err?.message ?? err) };
        }
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'aitm_task_status',
      description:
        '看任务进度：给 taskId 看单个（状态/轮次/用量/改动摘要/报错/验证结果），不给就列出任务（可按 ideaId 或 status 过滤）。',
      parameters: {
        taskId: { type: 'string', description: '任务 id（省略则列任务）。' },
        ideaId: { type: 'string', description: '只看某条想法的任务。' },
        status: { type: 'string', description: '按任务状态过滤（queued/running/awaiting-review/failed/cancelled/done…）。' },
      },
      presentCall: () => ({ card: 'generic', title: 'AI 任务台 · 看任务进度', kind: 'read' }),
      output: {
        schema: schemaTaskStatus,
        presentationMeta: (_a, v) =>
          v?.ok === false
            ? { kind: 'task', ok: false, error: v?.error ?? '未知错误' }
            : v.items
              ? { kind: 'task-list', items: v.items.slice(0, 10) }
              : { kind: 'task', task: v.task },
        render: (_a, v) => {
          if (v.ok === false) return [{ type: 'text', text: `查不到：${v.error}` }];
          if (!v.items) {
            const t = v.task ?? {};
            const vd = t.verify;
            const verifyNote = vd ? `｜验证${vd.ok ? '通过' : `没过（${String(vd.note ?? '').slice(0, 60)}）`}` : '';
            return [{ type: 'text', text: `${t.title ?? t.id}｜状态 ${t.status}｜第 ${t.turns ?? 0} 轮${t.diffStat ? `｜改动 ${t.diffStat.files ?? '?'} 个文件` : ''}${verifyNote}${t.error ? `｜错误：${t.error}` : ''}` }];
          }
          return [{ type: 'text', text: v.items.length ? v.items.map((t) => `- [${t.status}] ${t.title ?? t.id}${t.ideaTitle ? `（想法：${t.ideaTitle}）` : ''}`).join('\n') : '（没有任务）' }];
        },
      },
      async execute(args) {
        try {
          const taskId = String(args.taskId ?? '').trim();
          if (taskId) {
            const d = await call('task.get', taskId);
            if (!d?.task) return { ok: false, error: `任务不存在：${taskId}` };
            const t = d.task;
            return {
              ok: true,
              task: {
                id: t.id,
                ideaId: t.ideaId,
                ideaTitle: d.idea?.title ?? null,
                title: t.title,
                status: t.status,
                turns: t.turns ?? 0,
                adapterId: t.adapterId ?? null,
                diffStat: t.diffStat ?? null,
                commits: (t.commits ?? []).length,
                usage: t.usage ?? null,
                // 验收门的依据：跑完那一刻的验证结果（含当时的 HEAD / 基线提交）
                verify: t.verify ?? null,
                mergedAt: t.workspace?.mergedAt ?? null,
                error: t.error ?? null,
              },
            };
          }
          const list = await call('task.list', {
            ...(args.ideaId ? { ideaId: String(args.ideaId) } : {}),
            ...(args.status ? { status: String(args.status) } : {}),
          });
          const tasks = Array.isArray(list) ? list : [];
          return {
            ok: true,
            items: tasks.slice(-20).map((t) => ({
              id: t.id,
              title: t.title,
              status: t.status,
              turns: t.turns ?? 0,
              ideaId: t.ideaId,
            })),
          };
        } catch (err) {
          return { ok: false, error: String(err?.message ?? err) };
        }
      },
    }),
  );

  /*
   * 验收 / 合并（12 号工具）。
   *
   * 为什么也要做成工具：桌面面板要开 iframe 才能验收，而主壳是 DSH ——
   * 但「合并」是人拍板的动作，所以它走 `tools/pre-execute` 审批闸（审批卡上写清
   * 「把《标题》合并到 <基线>」），并且**验证没过时默认拒绝**，要人显式勾
   * acknowledgeVerifyFailure 才放行（与完整面板那个勾选框同一口径）。
   */
  ctx.tools.register(
    defineTool({
      name: 'aitm_task_accept',
      description:
        '验收一个任务：默认把它的分支合并回基线（写操作，需要用户审批；合并前按基线/HEAD 是否变化决定复用还是重跑验证命令）。merge=false 只记验收、不碰 git。验证没过会被拒绝，除非显式 acknowledgeVerifyFailure=true。',
      parameters: {
        taskId: { type: 'string', description: '任务 id（可先用 aitm_task_status 查）。', required: true },
        merge: { type: 'boolean', description: '默认 true = 合并到基线；false = 只记验收（不改 git）。' },
        acknowledgeVerifyFailure: { type: 'boolean', description: '验证没过时是否仍要合并（默认 false = 拒绝，让用户先去处理）。' },
        cleanup: { type: 'boolean', description: '合并后顺手清理 worktree 与已合并的分支（默认 false = 留着现场）。' },
      },
      presentCall: (a) => ({
        card: 'generic',
        title: `AI 任务台 · 验收：${String(a?.taskId ?? '?')}${a?.merge === false ? '（只记验收）' : ''}`,
        kind: 'edit',
      }),
      output: {
        schema: schemaAccept,
        presentationMeta: (_a, v) =>
          v?.ok === false
            ? { kind: 'accept', ok: false, error: v?.error ?? '未知错误', needsAcknowledge: v?.needsAcknowledge === true, taskId: v?.taskId ?? null, ideaTitle: v?.ideaTitle ?? null }
            : {
                kind: 'accept',
                accepted: true,
                merged: v?.merged !== false,
                taskId: v?.taskId ?? null,
                ideaTitle: v?.ideaTitle ?? null,
                baseRef: v?.baseRef ?? null,
                detail: v?.detail ?? null,
                verify: pickVerify(v?.verify),
              },
        render: (_a, v) => [
          {
            type: 'text',
            text:
              v?.ok === false
                ? `没验收：${v?.error ?? '未知错误'}`
                : v?.merged === false
                  ? `已标记验收（未合并）：${v?.detail ?? ''}`
                  : `已合并到 ${v?.baseRef ?? '基线'}：${v?.detail ?? ''}`,
          },
        ],
      },
      async execute(args) {
        const taskId = String(args.taskId ?? '').trim();
        if (!taskId) return { ok: false, error: 'taskId 必填', taskId: '(缺)' };
        const merge = args.merge !== false;
        // 只为卡片/审批卡多带一个标题；查不到不影响动作本身
        let info = null;
        try {
          info = await call('task.get', taskId);
        } catch {
          /* 任务不存在时下面的 accept 会给出干净的错误 */
        }
        const ideaTitle = info?.idea?.title ?? null;
        const baseRef = info?.task?.workspace?.baseRef ?? null;
        try {
          const r = await call('task.accept', {
            taskId,
            merge,
            ...(args.acknowledgeVerifyFailure === true ? { acknowledgeVerifyFailure: true } : {}),
            ...(args.cleanup === true ? { cleanup: true } : {}),
          });
          if (r?.ok === false) {
            // 门（验证没过 / 主区脏 / 冲突）—— 把内核原话给出去，并告诉模型「该让人勾一下」
            const detail = String(r.detail ?? '');
            return {
              ok: false,
              error: detail || '验收没成功',
              needsAcknowledge: /验证没过|acknowledge|勾上/.test(detail),
              taskId,
              ...(ideaTitle ? { ideaTitle } : {}),
            };
          }
          return {
            ok: true,
            accepted: true,
            merged: merge,
            taskId,
            ...(ideaTitle ? { ideaTitle } : {}),
            ...(baseRef ? { baseRef } : {}),
            detail: String(r?.detail ?? ''),
            ...(pickVerify(info?.task?.verify) ? { verify: pickVerify(info.task.verify) } : {}),
          };
        } catch (err) {
          return { ok: false, error: String(err?.message ?? err), taskId, ...(ideaTitle ? { ideaTitle } : {}) };
        }
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'aitm_calendar_day',
      description:
        '看某一天记了什么想法、存了什么新闻（默认今天）。给 day（YYYY-MM-DD）可指定日期；顺带给当月的计数。',
      parameters: {
        day: { type: 'string', description: 'YYYY-MM-DD（省略 = 今天）。' },
      },
      presentCall: (a) => ({ card: 'generic', title: `AI 任务台 · ${String(a?.day ?? '今天')} 的日历`, kind: 'read' }),
      output: {
        schema: schemaCalendar,
        // meta 必须是无 undefined 的纯 JSON（DSH 会做 lossless 校验，undefined 直接报
        // 「output.presentationMeta returned non-lossless JSON」）——所以逐字段显式构造
        presentationMeta: (_a, v) =>
          v?.ok === false
            ? { kind: 'calendar', ok: false, error: v?.error ?? '未知错误' }
            : {
                kind: 'calendar',
                day: v.day,
                monthIdeas: v.monthIdeas ?? 0,
                monthFavorites: v.monthFavorites ?? 0,
                ideas: (v.ideas ?? []).slice(0, 10),
                favorites: (v.favorites ?? []).slice(0, 10),
              },
        render: (_a, v) =>
          v.ok === false
            ? [{ type: 'text', text: `看不了：${v.error}` }]
            : [
                {
                  type: 'text',
                  text:
                    `${v.day}：想法 ${v.ideas.length} 条、收藏 ${v.favorites.length} 条（本月共 ${v.monthIdeas} 条想法、${v.monthFavorites} 条收藏）\n` +
                    [...v.ideas.map((i) => `- [${i.status}] ${i.title}`), ...v.favorites.map((f) => `- （收藏/${f.source}）${f.title}`)].join('\n'),
                },
              ],
      },
      async execute(args) {
        try {
          const day = String(args.day ?? '').trim() || dayKeyLocal(Date.now());
          if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { ok: false, error: `day 格式应为 YYYY-MM-DD，收到「${day}」` };
          const prefix = day.slice(0, 7);
          const ideas = (await call('idea.list', {})) ?? [];
          let favorites = [];
          try {
            const snap = await call('feed.get', {});
            favorites = Array.isArray(snap?.favorites) ? snap.favorites : [];
          } catch {
            /* 没抓过新闻就没有收藏这一半，不该让日历整个失败 */
          }
          const pick = (list, ts) => list.filter((x) => dayKeyLocal(ts(x)) === day);
          return {
            ok: true,
            day,
            monthIdeas: ideas.filter((i) => dayKeyLocal(i.createdAt ?? 0).startsWith(prefix)).length,
            monthFavorites: favorites.filter((f) => dayKeyLocal(f.savedAt ?? 0).startsWith(prefix)).length,
            ideas: pick(ideas, (i) => i.createdAt ?? 0).map((i) => ({ id: i.id, title: i.title, status: i.status })),
            favorites: pick(favorites, (f) => f.savedAt ?? 0).map((f) => ({ title: f.title, source: f.source ?? null, url: f.url ?? null })),
          };
        } catch (err) {
          return { ok: false, error: String(err?.message ?? err) };
        }
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'aitm_task_start',
      description:
        '把一条想法**开工**（写操作，需要用户审批）：在它的仓库里建 worktree、起 AI 引擎跑这轮指令。指令要具体、可验收。',
      parameters: {
        ideaId: { type: 'string', description: '想法 id（可先用 aitm_idea_list / aitm_idea_get 查）。', required: true },
        instruction: { type: 'string', description: '这轮要让 AI 干什么（越具体越好；会原样作为任务指令）。', required: true },
      },
      presentCall: (a) => ({ card: 'generic', title: `AI 任务台 · 开工：${String(a?.ideaId ?? '?')}`, kind: 'execute' }),
      output: {
        schema: schemaTaskStatus,
        presentationMeta: (_a, v) =>
          v?.ok === false ? { kind: 'task', ok: false, error: v?.error ?? '未知错误' } : { kind: 'task', task: v.task },
        render: (_a, v) => [{ type: 'text', text: v.ok === false ? `没能开工：${v.error}` : `已开工：${v.task?.title ?? v.task?.id}（状态 ${v.task?.status}，引擎 ${v.task?.adapterId}）` }],
      },
      async execute(args) {
        const ideaId = String(args.ideaId ?? '').trim();
        const instruction = String(args.instruction ?? '').trim();
        if (!ideaId) return { ok: false, error: 'ideaId 必填' };
        if (!instruction) return { ok: false, error: 'instruction 必填（这轮要让 AI 干什么）' };
        try {
          const t = await call('task.start', { ideaId, instruction });
          return {
            ok: true,
            task: { id: t.id, title: t.title, status: t.status, ideaId: t.ideaId, adapterId: t.adapterId ?? null, turns: t.turns ?? 0 },
          };
        } catch (err) {
          return { ok: false, error: String(err?.message ?? err) };
        }
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'aitm_task_follow_up',
      description:
        '在一个**已有任务**上追加一条指令接着干（写操作，需要用户审批）：复用同一 worktree 与引擎会话，' +
        '半成品不丢。任务被中断（宿主重启/关掉）、失败、或跑完还没过验收时用它；' +
        '想「从头再来」不要用这个 —— 那会开新 worktree，旧现场留在那儿。',
      parameters: {
        taskId: { type: 'string', description: '任务 id（可先用 aitm_task_status 查；状态 failed/cancelled 的那种）。', required: true },
        instruction: { type: 'string', description: '这轮要接着干什么（越具体越好；会原样作为追加指令）。', required: true },
      },
      presentCall: (a) => ({ card: 'generic', title: `AI 任务台 · 继续任务：${String(a?.taskId ?? '?')}`, kind: 'execute' }),
      output: {
        schema: schemaTaskStatus,
        presentationMeta: (_a, v) =>
          v?.ok === false ? { kind: 'task', ok: false, error: v?.error ?? '未知错误' } : { kind: 'task', task: v.task },
        render: (_a, v) => [{ type: 'text', text: v.ok === false ? `没能继续：${v.error}` : `已接着干：${v.task?.title ?? v.task?.id}（状态 ${v.task?.status}）` }],
      },
      async execute(args) {
        const taskId = String(args.taskId ?? '').trim();
        const instruction = String(args.instruction ?? '').trim();
        if (!taskId) return { ok: false, error: 'taskId 必填' };
        if (!instruction) return { ok: false, error: 'instruction 必填（这轮接着干什么）' };
        try {
          const t = await call('task.followUp', { taskId, instruction });
          return {
            ok: true,
            task: { id: t.id, title: t.title, status: t.status, ideaId: t.ideaId, adapterId: t.adapterId ?? null, turns: t.turns ?? 0 },
          };
        } catch (err) {
          return { ok: false, error: String(err?.message ?? err) };
        }
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'aitm_repo_status',
      description: '仓库与工作区占用：有哪些仓库、各自多少个 task worktree、占多少空间、有多少可回收（只读，不删东西）。',
      parameters: {},
      presentCall: () => ({ card: 'generic', title: 'AI 任务台 · 仓库与工作区占用', kind: 'read' }),
      output: {
        schema: schemaRepos,
        presentationMeta: (_a, v) => (v?.ok === false ? { kind: 'repos', ok: false, error: v?.error } : { kind: 'repos', repos: (v.repos ?? []).slice(0, 8), totalKb: v.totalKb, reclaimable: v.reclaimable }),
        render: (_a, v) =>
          v.ok === false
            ? [{ type: 'text', text: `看不了：${v.error}` }]
            : [
                {
                  type: 'text',
                  text:
                    `共 ${v.repos.length} 个仓库，worktree ${v.worktrees} 个 · ${Math.round((v.totalKb ?? 0) / 1024)} MB${v.reclaimable ? ` · 可回收 ${v.reclaimable}` : ''}\n` +
                    v.repos.map((r) => `- ${r.name}（${r.path}）：${r.worktrees} 个 · ${Math.round(r.sizeKb / 1024)} MB${r.active ? ` · ${r.active} 个在跑` : ''}`).join('\n'),
                },
              ],
      },
      async execute() {
        try {
          const repos = (await call('repo.list', {})) ?? [];
          const gc = await call('workspace.gc', { apply: false });
          const items = Array.isArray(gc?.items) ? gc.items : [];
          const byRepo = repos.map((r) => {
            const mine = items.filter((i) => i.repoId === r.id);
            return {
              id: r.id,
              name: r.name,
              path: r.path,
              worktrees: mine.length,
              sizeKb: mine.reduce((sum, i) => sum + (i.sizeKb ?? 0), 0),
              active: mine.filter((i) => i.active).length,
              orphan: mine.filter((i) => i.orphan).length,
            };
          });
          return {
            ok: true,
            repos: byRepo,
            worktrees: items.length,
            totalKb: items.reduce((sum, i) => sum + (i.sizeKb ?? 0), 0),
            reclaimable: items.filter((i) => !i.active).length,
          };
        } catch (err) {
          return { ok: false, error: String(err?.message ?? err) };
        }
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'aitm_backup_now',
      description:
        '立即做一次备份（写操作，需要用户审批）。默认轻量（只备数据文件）；mode=full 走全量（含附件等大文件）。',
      parameters: {
        mode: { type: 'string', description: 'lean（默认，轻量）或 full（全量）。' },
        label: { type: 'string', description: '给这次备份起个名字（可省）。' },
      },
      presentCall: (a) => ({ card: 'generic', title: `AI 任务台 · 立即备份（${a?.mode === 'full' ? '全量' : '轻量'}）`, kind: 'edit' }),
      output: {
        schema: schemaBackup,
        presentationMeta: (_a, v) =>
          v?.ok === false
            ? { kind: 'backup', ok: false, error: v?.error ?? '未知错误' }
            : { kind: 'backup', id: v.id, mode: v.mode, files: v.files, bytes: v.bytes, label: v.label ?? null, deduped: Boolean(v.deduped) },
        render: (_a, v) =>
          v.ok === false
            ? [{ type: 'text', text: `没备成：${v.error}` }]
            : [{ type: 'text', text: `已备份（${v.mode === 'full' ? '全量' : '轻量'}）：${v.files} 个文件 · ${Math.round((v.bytes ?? 0) / 1024)} KB${v.deduped ? '（和上一份一样，没重复落）' : ''}` }],
      },
      async execute(args) {
        try {
          const mode = String(args.mode ?? 'lean').trim() === 'full' ? 'full' : 'lean';
          const entry = await call('backup.create', {
            mode,
            reason: 'manual',
            ...(args.label ? { label: String(args.label) } : {}),
          });
          return {
            ok: true,
            id: entry?.id ?? null,
            mode: entry?.mode ?? mode,
            files: entry?.files ?? 0,
            bytes: entry?.bytes ?? 0,
            label: entry?.label ?? null,
            deduped: Boolean(entry?.deduped),
          };
        } catch (err) {
          return { ok: false, error: String(err?.message ?? err) };
        }
      },
    }),
  );

  /* -------- ④ 审批闸：写操作一律先过 `tools/pre-execute` -------- */
  ctx.effect(
    () =>
      ctx.on('tools/pre-execute', async (exec, next) => {
        const describe = WRITE_TOOLS[exec?.name];
        if (!describe) return next(); // 只读工具：放行（下游的沙箱/权限策略照旧生效）
        if (exec.signal?.aborted) return { kind: 'cancel' };
        // 明显不合法的入参：直接拒，别浪费用户的点击（模型看到原因会自己修）
        const a = exec.arguments ?? {};
        if (exec.name === 'aitm_idea_create' && !String(a.title ?? '').trim()) {
          return { kind: 'deny', reason: 'aitm: aitm_idea_create 缺 title' };
        }
        if (exec.name === 'aitm_idea_set_status' && (!String(a.id ?? '').trim() || !String(a.status ?? '').trim())) {
          return { kind: 'deny', reason: 'aitm: aitm_idea_set_status 缺 id 或 status' };
        }
        if (exec.name === 'aitm_task_start' && (!String(a.ideaId ?? '').trim() || !String(a.instruction ?? '').trim())) {
          return { kind: 'deny', reason: 'aitm: aitm_task_start 缺 ideaId 或 instruction' };
        }
        if (exec.name === 'aitm_task_follow_up' && (!String(a.taskId ?? '').trim() || !String(a.instruction ?? '').trim())) {
          return { kind: 'deny', reason: 'aitm: aitm_task_follow_up 缺 taskId 或 instruction' };
        }
        if (exec.name === 'aitm_task_accept' && !String(a.taskId ?? '').trim()) {
          return { kind: 'deny', reason: 'aitm: aitm_task_accept 缺 taskId' };
        }
        if (exec.name === 'aitm_idea_update') {
          if (!String(a.id ?? '').trim()) return { kind: 'deny', reason: 'aitm: aitm_idea_update 缺 id' };
          if (a.title === undefined && a.description === undefined) {
            return { kind: 'deny', reason: 'aitm: aitm_idea_update 没给 title 也没给 description（没有可改的字段）' };
          }
          if (a.mode !== undefined && !['replace', 'append'].includes(String(a.mode))) {
            return { kind: 'deny', reason: `aitm: aitm_idea_update 的 mode 只能是 replace 或 append（收到「${String(a.mode)}」）` };
          }
        }
        if (exec.name === 'aitm_idea_set_spec') {
          if (!String(a.id ?? '').trim()) return { kind: 'deny', reason: 'aitm: aitm_idea_set_spec 缺 id' };
          if (!String(a.spec ?? '').trim()) return { kind: 'deny', reason: 'aitm: aitm_idea_set_spec 的 spec 不能为空' };
        }
        if (exec.name === 'aitm_backup_now' && a.mode !== undefined && !['lean', 'full'].includes(String(a.mode))) {
          return { kind: 'deny', reason: `aitm: aitm_backup_now 的 mode 只能是 lean 或 full（收到「${String(a.mode)}」）` };
        }
        // 先让下游（沙箱 / 权限档 / 别的插件）表态：它要是拒了就以它为准
        const downstream = await next();
        if (downstream.kind !== 'allow') return downstream;
        if (DEFAULTS.approve === 'allow') return downstream; // 显式关掉审批（AITM_APPROVE=allow）
        const detail = await describe(a); // 允许异步（accept 要查标题）
        return {
          kind: 'ask',
          reason: `AI 任务台写操作：${detail}（仓库 ${DEFAULTS.repo}）`,
          displayReason: {
            en: `AI Tasks write: ${detail}`,
            zh: `AI 任务台写操作：${detail}`,
          },
        };
      }),
    'aitm.write-gate',
  );

  // DSH 卸载插件时收掉我们拉起的后端
  ctx.effect(() => () => void stop());
  // headless 跑完就退进程：exit 钩子里收一次，免得留下孤儿后端
  if (!state.exitHook) {
    state.exitHook = true;
    process.once('exit', stop);
  }
  const seamInfo = pickHostSpawn(ctx);
  state.spawnSeam = seamInfo.spawn ? 'host' : seamInfo.why;
  note(`[host] 子进程接缝：${seamInfo.spawn ? 'ctx.subprocess（内核起的 CLI 由宿主托管）' : `内核自己的 spawn（${seamInfo.why}）`}`);
  ctx.logger?.info?.(
    `[aitm] 已加载：v${pluginVersion()} 后端来法=${backendPlan().mode}` +
      `（repo=${DEFAULTS.repo} url=${DEFAULTS.url || '(无)'} 自带内核=${vendorPresent() ? '有' : '无'}` +
      ` 子进程缝=${seamInfo.spawn ? 'host' : seamInfo.why}）`,
  );
}
