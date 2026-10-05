/**
 * AI 任务台 × DSH 插件 —— 宿主半边（跑在 DSH 进程里）。
 *
 * 职责（M1）：
 *   ① 桥：确保有一个可用的 AI 任务台后端（默认自己 spawn 现有 web 宿主，只绑回环）
 *   ② 工具：三个只读工具给模型用（health / idea_list / feed_today）
 *   ③ 给浏览器半边递地址：注册 /aitm-plugin/config 路由（客户端拿不到 Node 环境变量）
 *
 * M2 会把「桥」换成插件进程内的 L3 服务（core 直接 import），工具与路由的接口不变。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
const REPO_DEFAULT = process.env.AITM_REPO ?? path.resolve(PLUGIN_DIR, '..');

const DEFAULTS = {
  repo: REPO_DEFAULT,
  url: (process.env.AITM_URL ?? '').replace(/\/+$/, ''),
  spawn: process.env.AITM_SPAWN !== '0',
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
    return `仓库目录不存在：${repo}（AITM_REPO=${process.env.AITM_REPO ?? '(未设，用插件位置推导)'}）`;
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

/** 起前自检失败时抛的错（附上「怎么办」三步） */
function repoError(detail) {
  return new Error(
    `${detail}。处理：① 在 DSH 启动前设 AITM_REPO=<AI 任务台仓库的绝对路径>（Windows 例如 setx AITM_REPO D:\\...\\ai-tasks-mgr，然后重开终端）；` +
      `② 或把 `+'`dsh-plugin/aitm.patch.yml` 的 `name:` 指到**那个仓库**里的 `dsh-plugin/index.js`（插件默认就按自己的位置推导仓库）；' +
      `③ 确认那个仓库已 git pull 且 npm install 过。当前推导出的仓库：${DEFAULTS.repo}`,
  );
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

/** 调一个 action：我们的 web 宿主就是 POST /api/<action> 的清一色契约 */
async function call(action, payload = {}) {
  const base = await ensureBase();
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
  if (state.base) return state.base;
  if (state.starting) return state.starting;

  state.starting = (async () => {
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

/** 诊断用：把「插件眼里的世界」原样抖出来（scripts/doctor.mjs 用；也让 verify 能断言自检逻辑） */
export function diagnose() {
  return {
    pluginDir: PLUGIN_DIR,
    repo: DEFAULTS.repo,
    repoFromEnv: process.env.AITM_REPO ?? null,
    repoProblem: preflightRepo(DEFAULTS.repo),
    url: DEFAULTS.url || null,
    spawn: DEFAULTS.spawn,
    apiRevRequired: REQUIRED_API_REV,
    registry: PIDFILE,
    backendLog: BACKEND_LOG,
    node: process.version,
  };
}

function stop() {
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
  },
};

export function apply(ctx) {
  /* -------- ③ 给浏览器半边递地址（客户端在浏览器里，看不见 Node 环境变量） -------- */
  ctx.inject?.(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      webCtx.webServer.register({
        kind: 'prefix',
        path: '/aitm-plugin',
        handler: async (req, res) => {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1');
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
              repo: DEFAULTS.repo,
              repoProblem: preflightRepo(DEFAULTS.repo),
              apiRevRequired: REQUIRED_API_REV,
              identity: state.identity,
              log: state.log.slice(-8),
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
      output: {
        schema: schemaHealth,
        render: (_a, v) => [
          {
            type: 'text',
            text: v.ok
              ? `AI 任务台可用：${v.base}（${v.actions} 个 action，apiRev=${v.apiRev ?? '?'}，版本 ${v.version ?? '未知'}${v.dataDir ? `，数据目录 ${v.dataDir}` : ''}）`
              : `不可用：${JSON.stringify(v)}`,
          },
        ],
      },
      async execute() {
        try {
          const base = await ensureBase();
          const h = await health(base, 3000);
          if (!h?.ok) return { ok: false, error: 'GET /api/health 不通', base, log: state.log.slice(-10) };
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
            log: state.log.slice(-6),
          };
        } catch (err) {
          return { ok: false, error: String(err?.message ?? err), log: state.log.slice(-10) };
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

  // DSH 卸载插件时收掉我们拉起的后端
  ctx.effect(() => () => stop());
  // headless 跑完就退进程：exit 钩子里收一次，免得留下孤儿后端
  if (!state.exitHook) {
    state.exitHook = true;
    process.once('exit', stop);
  }
  ctx.logger?.info?.(`[aitm] 已加载：repo=${DEFAULTS.repo} url=${DEFAULTS.url || '(自动拉起)'}`);
}
