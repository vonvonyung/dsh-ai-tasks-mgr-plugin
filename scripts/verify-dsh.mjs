/**
 * 一条命令验完 M1 的五件事（都能在无浏览器的沙箱里跑）：
 *   ① 客户端半边离线渲染（假 window.__ModuleLoader__ + 假 ctx + react-dom/server）+ 挂点护栏（不占 rightbar）
 *   ⑤ 旧后端护栏（假一个没有 apiRev 的后端 → 必须被拒）⑥ 起前自检（不是仓库的路径 → 当场拦下）
 *   ⑦ 写操作审批闸（离线：写→ask、只读→放行、缺参→deny；端到端：headless 无审批通道 → 写不落地）
 *   ② 插件激活 + 客户端半边进 __DSH_BOOT__ 图
 *   ③ 客户端分片送达（/plugins/??…/client.js → 200 且内容里有我们的挂点）
 *   ④ 端到端：假模型 → 工具 aitm_health → **真后端**（插件自己拉起的 AI 任务台）返回真数据
 *
 * 用法：node scripts/verify-dsh.mjs        （退出码 0 = 全过）
 *      另有体检：node scripts/doctor.mjs   （不起 DSH，直接看「在哪个目录起 / 缺什么」）
 * 环境：AITM_REPO 指向 AI 任务台仓库（默认 /home/user/ai-tasks-mgr）
 * 独立仓库（dsh-ai-tasks-mgr-plugin）里跑：**一条断言都不跑**，直接退出 1 并告诉你怎么跑全（见下面 ①）
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { expectedActions } from './expected-actions.mjs';

/**
 * 退出前把输出刷干净再走。
 *
 * Windows 上写管道是**异步**的，`process.exit(N)` 会把还没写完的数据丢掉（Linux 上要写满管道缓冲
 * 才看得出来 —— 实测 200KB 写进管道后立刻 exit，尾巴直接没了）。这些脚本存在的意义就是
 * 「把这整段贴回来定位」，尾巴丢了等于白跑，所以统一走这里：
 * 抛一个内部哨兵 → 顶层吞掉 → 设 `process.exitCode` → **让 Node 自然退出**（输出刷完才退）。
 * 保留原来的流程语义：抛出去以后，后面的代码不会再跑（和 process.exit 一样）。
 */
class ExitScript extends Error {
  constructor(code) {
    super(`exit(${code})`);
    this.code = code;
  }
}
const exitWith = (code) => {
  throw new ExitScript(code);
};

async function main() {

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = process.env.AITM_REPO ?? path.resolve(ROOT, '..');
const DSH_HOME = process.env.DSH_HOME ?? fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-verify-'));
/**
 * 起 dsh 一律走 `process.execPath <包里的 lib/bin.js>`：
 * Windows 上 `.bin/dsh` 是 sh 脚本、`.bin/dsh.cmd` 是批处理垫片 —— Node ≥20.12 直接 spawn 它们会
 * EINVAL（本项目在面板那边也踩过同一坑）。直跑 JS 入口两条平台都稳。
 */
const DSH_PKG = path.join(ROOT, 'node_modules', '@deepseek-ai', 'dsh');
const DSH_ENTRY = path.join(DSH_PKG, 'lib', 'bin.js');
const dshArgs = (rest) => [DSH_ENTRY, ...rest];
const PATCH = path.join(ROOT, 'aitm.patch.yml');

/*
 * 分发安装（`dsh plugin add` 装进 profile 的那份）里**没有仓库** —— 这个脚本验的是开发路径
 * （插件在仓库里、内核从仓库现编、用 --patch 挂载），没仓库就没对象可验。
 * 直说一句然后退出，别让同事看到一堆「失败」（同事装机自检用 doctor，见 README「同事怎么装」）。
 */
const selfPkgPath = path.join(REPO, 'package.json');
let selfPkg = null;
try {
  selfPkg = JSON.parse(fs.readFileSync(selfPkgPath, 'utf8'));
} catch {
  /* 没有仓库 */
}
if (selfPkg?.name !== 'ai-tasks-mgr') {
  /*
   * 两种"没有仓库"要分开对待（2026-10-07 插件有了独立仓库之后才看得出来）：
   *   ① **独立仓库模式**：插件自己是 git 检出（`dsh-ai-tasks-mgr-plugin`），但旁边没有 AI 任务台仓库
   *      ⇒ 这个脚本会**一条断言都不跑**就结束。以前这里退出码 0，于是 `npm run verify` 看起来是绿的 ——
   *      那是**假的**（我自己在独立 checkout 里第一次跑就被它骗了）。现在明确退出 1 + 告诉你怎么跑全。
   *   ② **装机模式**：同事用 `dsh plugin add` 装的 tarball（没有 .git）
   *      ⇒ 保持友好退出 0，让人去跑 doctor（那边才是装机自检）。
   */
  const standalone = fs.existsSync(path.join(ROOT, '.git'));
  if (standalone) {
    console.log('⚠ 独立仓库模式：这个 checkout 里**没有** AI 任务台仓库（推导出的仓库 = ' + REPO + '）。');
    console.log('  所以这次**一条断言都没跑**（别把退出码 0 当成"通过"—— 现在也**不是** 0）。');
    console.log('  完整自检（要母仓库在场，插件在主仓库里时本来就在）：');
    console.log('    AITM_REPO=<AI 任务台仓库绝对路径> node scripts/verify-dsh.mjs');
    console.log('    —— 或在主仓库里跑：cd dsh-plugin && node scripts/verify-dsh.mjs（163 项）');
    console.log('  只想看这台机器能不能装/起：node scripts/doctor.mjs');
    exitWith(1);
  }
  console.log(`这个安装里没有 AI 任务台仓库（推导出的仓库 = ${REPO}）。`);
  console.log('verify-dsh 是**开发侧**自检（要仓库）；装机自检请跑：node scripts/doctor.mjs');
  exitWith(0);
}

const results = [];
/**
 * 期望的 action 数：**从内核源码推导**（`scripts/expected-actions.mjs`），读不到才退回 63。
 * 别再硬编码 —— 内核加一个 action 就让一串断言集体变红，红得没有信息量（2026-10-06 踩过）。
 */
const EXPECTED_ACTIONS = expectedActions(REPO, 63);
/**
 * client.js 的指纹，算法与 DSH 的 `artifactRevision` **逐字一致**
 * （`dsh-client-modules`：sha1("plugin-artifact"\0) + 各字段带长度前缀，取前 12 位）。
 * ③ 会断言 boot 图里 DSH 算出来的 `ours.rev` 与它相等 —— 也就是说
 * `doctor.mjs` 打印的这个值、DSH 实际加载的那份、用户在网络面板里看到的 `&rev=` 是同一个东西。
 */
const clientFileRev = () => {
  const st = fs.statSync(path.join(ROOT, 'client.js'));
  const hash = createHash('sha1').update('plugin-artifact').update('\0');
  for (const part of [String(st.mtimeMs), String(st.ctimeMs), String(st.size)]) {
    hash.update(`${String(Buffer.byteLength(part))}:`).update(part);
  }
  return hash.digest('hex').slice(0, 12);
};
/** 客户端半边声明的服务依赖（离线渲染那条里读出来，给 boot 图那条做「有没有人提供」用） */
let clientInject = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok, extra });
  console.log(`   ${ok ? '✓' : '✗'} ${name}${extra ? ` — ${extra}` : ''}`);
  return ok;
};

/**
 * 读 DSH 的会话日志，取出全部事件记录。
 *
 * 为什么需要它：`dsh --json`（headless）只吐 type/callId/status/result 五个字段，
 * **不带 meta**；而卡片的数据来源恰恰是 `tool/result` 记录的 `data.meta`（客户端 ToolResultNode.meta）。
 * 所以断言「presentationMeta 真的落盘了」只能读会话日志。
 *
 * 坑：`session.v4.jsonl.zstd` 是**多帧 zstd**（每次 append 一帧），一次
 * `zstdDecompressSync(整文件)` 只解出第一帧（189 字节）——必须按魔数切帧逐帧解。
 */
const readSessionEvents = (home) => {
  const zlib = require('node:zlib');
  if (typeof zlib.zstdDecompressSync !== 'function') return { skipped: true, records: [] };
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const decode = (buf) => {
    const starts = [];
    let i = 0;
    while ((i = buf.indexOf(MAGIC, i)) !== -1) {
      starts.push(i);
      i += MAGIC.length;
    }
    let text = '';
    for (let k = 0; k < starts.length; k++) {
      const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
      try {
        text += zlib.zstdDecompressSync(buf.subarray(starts[k], end)).toString('utf8');
      } catch {
        /* 尾部半截帧（正在写）忽略 */
      }
    }
    return text;
  };
  const records = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl.zstd')) {
        for (const line of decode(fs.readFileSync(p)).split('\n')) {
          if (!line.trim()) continue;
          try {
            records.push(JSON.parse(line));
          } catch {
            /* 半行忽略 */
          }
        }
      }
    }
  };
  const sessions = path.join(home, 'sessions');
  if (fs.existsSync(sessions)) walk(sessions);
  return { skipped: false, records };
};

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

const children = [];
function killAll() {
  for (const c of children) {
    if (process.platform === 'win32' && c.pid) {
      try { spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* 没了 */ }
    } else {
      try { c.kill('SIGTERM'); } catch { /* 忽略 */ }
    }
  }
  children.length = 0;
  // 被 SIGTERM 砍掉的 dsh 不会跑 'exit' 钩子 → 它拉起的后端会留下。
  // 插件把 pid 登记在临时目录里（多个会话复用同一个后端），这里按它整组收尾。
  try {
    const file = path.join(os.tmpdir(), 'aitm-dsh-backend.json');
    const reg = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (reg?.pid) {
      if (process.platform === 'win32') {
        // Windows 没有进程组信号：taskkill /T 连子孙一起收
        spawnSync('taskkill', ['/pid', String(reg.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } else {
        try { process.kill(-reg.pid, 'SIGTERM'); } catch { try { process.kill(reg.pid, 'SIGTERM'); } catch { /* 没了 */ } }
      }
      fs.unlinkSync(file);
    }
  } catch {
    /* 没有登记表 = 没起过后端 */
  }
}

function start(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  child.out = '';
  child.stdout.on('data', (b) => (child.out += String(b)));
  child.stderr.on('data', (b) => (child.out += String(b)));
  children.push(child);
  return child;
}

async function waitFor(fn, ms, label) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`超时：${label}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

/* ---------------- ① 客户端半边：离线渲染 ---------------- */
async function checkRender() {
  console.log('① 客户端半边离线渲染');
  let loaded = null;
  globalThis.window = { __ModuleLoader__: { load({ id, factory }) { loaded = { id, exports: factory(require) }; } } };
  await import(pathToFileURL(path.join(ROOT, 'client.js')).href);
  if (!check('模块加载协议（window.__ModuleLoader__.load）', Boolean(loaded), loaded?.id)) return;

  const regs = [];
  const tabTypes = [];
  const locales = {};
  const ctx = {
    slots: { inject: (n, cb) => { cb(); return () => {}; }, register: (d, C) => { regs.push({ d, C }); return () => {}; } },
    sidebarRightTabs: { register: (d) => { tabTypes.push(d); return () => {}; } },
    sidebarRight: { openTab: () => {}, openTabs: { getSnapshot: () => [] } },
    locale: { register: (ns, dict) => { locales[ns] = dict; return () => {}; } },
    effect: (f) => { const d = f(); return typeof d === 'function' ? d : () => {}; },
  };
  loaded.exports.apply(ctx);
  clientInject = loaded.exports.__clientInject ?? [];

  const type = tabTypes[0];
  check(
    '注册右侧栏页签类型',
    tabTypes.length === 1 && type.id === 'dsh-plugin-aitm' && type.kind === 'aitm',
    type ? `id=${type.id} kind=${type.kind} priority=${type.priority}` : '',
  );
  check(
    '页签 body / title 两个 keyed 槽（key = 类型 id）',
    ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title'].every((n) => regs.some((r) => r.d.name === n && r.d.key === 'dsh-plugin-aitm')),
    regs.filter((r) => String(r.d.name).startsWith('sidebar.right.')).map((r) => r.d.name).join(' / '),
  );
  check('注册 settings.section', regs.some((r) => r.d.name === 'settings.section'));
  // R9 回归护栏：rightbar 是单占位槽，DSH 自己的 sidebar-right 要占它；我们再去注册就会把对方顶掉
  check('不占用单占位槽 rightbar（R9 根因）', !regs.some((r) => r.d.name === 'rightbar'));

  // 假 fetch：让 useAitmConfig 拿到「后端就绪」的答案（用完必须还原，否则后面真请求也会被它接走）
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) =>
    String(url).includes('/aitm-plugin/config')
      ? { ok: true, json: async () => ({ base: 'http://127.0.0.1:1', repo: REPO }) }
      : { ok: true, json: async () => ({ ok: true, actions: EXPECTED_ACTIONS }) };

  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const html = regs.map((r) => renderToStaticMarkup(React.createElement(r.C, {}))).join('\n');
  check('组件能渲染成 HTML', html.includes('aitm-panel') && html.includes('aitm-settings-section'), `${html.length} 字节`);
  check('面板离线态给人话（后端没起来时不是白屏）', /正在拉起后端|后端没起来/.test(html));

  /* ---- 对话里的工具卡（tool.call.toolview）---- */
  const cardTools = loaded.exports.__cardTools ?? [];
  const cardRegs = regs.filter((r) => r.d.name === 'tool.call.toolview');
  check(
    '13 个工具都注册了工具卡（keyed，key = 工具名）',
    cardTools.length === 13 && cardTools.every((t) => cardRegs.some((r) => r.d.key === t)),
    cardRegs.map((r) => r.d.key).join(', '),
  );
  check('工具卡挂在我们自己的文案表上', cardRegs.every((r) => r.d.locale === 'aitm') && Object.keys(locales.aitm?.zh ?? {}).length > 0, `ns=${Object.keys(locales).join(',')}`);

  const Card = loaded.exports.__components.AitmToolCard;
  // 用「真宿主投影会给出的 meta」当输入（与 index.js 的 presentationMeta 同构）
  const fakeT = (k, vars) => String(locales.aitm?.zh?.[k] ?? k).replace(/\{(\w+)\}/g, (m, n) => (vars && n in vars ? String(vars[n]) : m));
  const render = (props) => renderToStaticMarkup(React.createElement(Card, { t: fakeT, toolName: 'aitm_idea_create', ...props }));
  const resultBlock = (meta, text = '') => ({ kind: 'tool-result', callId: 'c1', call: { name: 'aitm_idea_create', argsRaw: '{"title":"给日历加导出"}' }, content: [{ type: 'text', text }], isError: false, meta });

  const ideaHtml = render({ phase: 'result', block: resultBlock({ kind: 'idea', action: 'create', id: 'idea-7', title: '给日历加导出', status: 'inbox' }) });
  check('想法卡：标题 + 状态 + 编号 + 打开面板', ideaHtml.includes('给日历加导出') && ideaHtml.includes('inbox') && ideaHtml.includes('idea-7') && ideaHtml.includes('在面板里看'), `${ideaHtml.length} 字节`);

  const changedHtml = render({ toolName: 'aitm_idea_set_status', phase: 'result', block: { ...resultBlock({ kind: 'idea', action: 'status', id: 'idea-7', title: '给日历加导出', status: 'ready' }), call: { name: 'aitm_idea_set_status', argsRaw: '{"id":"idea-7","status":"ready"}' } } });
  check('状态卡：显示新状态与「状态已改」', changedHtml.includes('ready') && changedHtml.includes('状态已改'));

  const listHtml = render({ toolName: 'aitm_idea_list', phase: 'result', block: resultBlock({ kind: 'idea-list', total: 3, counts: { inbox: 2, ready: 1 }, ideas: [{ id: 'a', title: '甲', status: 'inbox' }, { id: 'b', title: '乙', status: 'ready' }] }) });
  check('列表卡：总数 + 状态计数 + 条目', listHtml.includes('共 3 条') && listHtml.includes('inbox') && listHtml.includes('甲') && listHtml.includes('乙'));

  const feedHtml = render({ toolName: 'aitm_feed_today', phase: 'result', block: resultBlock({ kind: 'feed', github: 13, bilibili: 60, favorites: 2, top: [{ title: 'OpenCardboard', source: 'github' }] }) });
  check('合集卡：三个计数 + 条目', feedHtml.includes('13') && feedHtml.includes('60') && feedHtml.includes('OpenCardboard'));

  const healthHtml = render({ toolName: 'aitm_health', phase: 'result', block: resultBlock({ kind: 'health', ok: true, actions: EXPECTED_ACTIONS, apiRev: 2, version: '0.1.0', dataDir: 'D:\\x\\.aitasks' }) });
  check('健康卡：正常 + action 数 + apiRev', healthHtml.includes('正常') && healthHtml.includes(String(EXPECTED_ACTIONS)) && healthHtml.includes('apiRev=2'));

  const detailHtml = render({ toolName: 'aitm_idea_get', phase: 'result', block: resultBlock({ kind: 'idea-detail', id: 'idea-9', title: '给日历加导出', status: 'ready', tags: ['日历'], priority: 'p1', description: '导出成 .ics', tasks: [{ id: 't_1', status: 'succeeded', turns: 2 }] }) });
  check('详情卡：标题 + 状态 + 标签 + 正文 + 任务', detailHtml.includes('给日历加导出') && detailHtml.includes('日历') && detailHtml.includes('导出成 .ics') && detailHtml.includes('t_1'));

  {
    /* 可读性守门（2026-10-07 用户截图「深色主题下白底白字」之后加的）：
       把面板的**关键配色**按 WCAG 算一遍对比度 —— 两套主题都要 ≥4.5:1（小字 AA）。
       卡片底 = DSH 的 `--dsw-alias-bg-layer-2`（浅 #ffffff / 深 #2c2c2e），徽章底 = 桌面 `.pill.*` 的叠色。 */
    const csrc4 = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
    const grab = (re, src = csrc4) => re.exec(src)?.[1] ?? null;
    const lightPart = csrc4.slice(csrc4.indexOf("'body{--aitm-fg-ok"), csrc4.indexOf("'body[data-ds-dark-theme]"));
    const darkPart = csrc4.slice(csrc4.indexOf("'body[data-ds-dark-theme]"));
    // [tone 表里的键, --aitm-fg-* 变量后缀] —— 全 8 档都查
    const tones = [
      ['ok', 'ok'], ['err', 'err'], ['warn', 'warn'], ['info', 'info'],
      ['grey', 'dim'], ['muted', 'muted'], ['accent', 'purple'], ['cyan', 'cyan'],
    ];
    const bgOf = (name) => {
      const m = new RegExp(`${name}: \\['rgba\\((\\d+),\\s*(\\d+),\\s*(\\d+),\\s*([\\d.]+)\\)`).exec(csrc4);
      return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] : null;
    };
    const cards = { light: [255, 255, 255], dark: [44, 44, 46] }; // DSH layer-2 两套实测值
    const lum = (c) => { const f = c.map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2]; };
    const ratio = (a, b) => { const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x); return (l1 + 0.05) / (l2 + 0.05); };
    const hexOf = (h) => [0, 2, 4].map((i) => parseInt(h.slice(i + 1, i + 3), 16));
    const over = (fg, a, bg) => fg.map((c, i) => c * a + bg[i] * (1 - a));
    const worst = [];
    for (const [name, card, part] of [['浅色', cards.light, lightPart], ['深色', cards.dark, darkPart]]) {
      for (const [tone2, varName] of tones) {
        const fg = grab(new RegExp(`--aitm-fg-${varName}:(#[0-9a-f]{6})`), part);
        const bg = bgOf(tone2);
        if (!fg || !bg) { worst.push(`${name}·${tone2}(取值失败)`); continue; }
        // 次要档（已取消/已归档）刻意弱化：按 4.0 兜底，其余按小字 AA 4.5
        const limit = tone2 === 'muted' ? 4.0 : 4.5;
        const r = ratio(hexOf(fg), over(bg.slice(0, 3), bg[3], card));
        if (r < limit) worst.push(`${name}·${tone2}=${r.toFixed(2)}(<${limit})`);
      }
    }
    check('徽章文字在两套主题下都够读（WCAG，次要档 4.0 / 其余 4.5）', worst.length === 0, worst.join('；') || '全部达标');
  }

  {
    /* 「详情内容要能看全，别让用户在卡片里滚」（2026-10-07 用户报）：
       ① 正文样式里不许有限高/内滚动；② 详情页的任务区+详情卡在**同一个**滚动容器里；
       ③ 离线渲染一张长正文的详情卡 —— 全文都必须在 HTML 里（以前 slice(0,400) + maxHeight:120）。 */
    const Detail = loaded.exports.__components.IdeaDetailCard;
    const long = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 行：想法正文`).join('\n') + '\n结尾行';
    const detailHtml = renderToStaticMarkup(
      React.createElement(Detail, {
        t: fakeT,
        meta: { title: '看全文', status: 'ready', description: long, tags: ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛'], tasks: [] },
      }),
    );
    check(
      '想法详情卡：正文**全文**渲染（不截断、不设高度上限）',
      detailHtml.includes('结尾行') && detailHtml.includes('第 40 行') && !/max-height/i.test(detailHtml),
      `${detailHtml.length} 字节 / 正文 ${long.length} 字`,
    );
    check(
      '想法详情卡：标签**全部**列出（详情页是「看全」的地方，卡片列表才做省略）',
      detailHtml.includes('辛'),
    );
    const csrc5 = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
    const paraBlock = /para: \{[\s\S]*?\n      \},/.exec(csrc5)?.[0] ?? '';
    // 注释里出现这两个词是**故意**的（写着「不许再设」）⇒ 断言只看代码行
    const paraCode = paraBlock
      .split('\n')
      .filter((l) => !/^\s*(\/\*|\*|\/\/)/.test(l))
      .join('\n');
    check(
      '正文样式里没有 maxHeight / overflow（卡片内不再套一层滚动）',
      paraCode.trim() !== '' && !/maxHeight|overflow/i.test(paraCode),
      paraCode.replace(/\s+/g, ' ').trim().slice(0, 90),
    );
    check(
      '三个原生视图的根都能被压缩（flex:1 1 auto + minHeight:0，否则面板里还有页签条时会撑破底部）',
      (csrc5.match(/flex: '1 1 auto', minHeight: 0/g) ?? []).length >= 4,
      `出现 ${(csrc5.match(/flex: '1 1 auto', minHeight: 0/g) ?? []).length} 次（看板/日历/合集/详情内容区）`,
    );
    check(
      '详情页内容区是**一个**滚动容器（任务区 + 详情卡同滚；flex + minHeight:0 才滚得起来）',
      /'data-board-body': '1'/.test(csrc5) &&
        /style: \{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto' \}, 'data-board-body'/.test(csrc5),
    );
    check(
      '正文保护上限放宽到 4000 字，且截断时**明写**「已截断」（不静默吞内容）',
      /full\.length > 4000/.test(csrc5) && /已截断/.test(csrc5),
    );
  }

  const taskHtml = render({ toolName: 'aitm_task_status', phase: 'result', block: resultBlock({ kind: 'task', task: { id: 't_9', title: '加 --json 输出', status: 'running', turns: 3, adapterId: 'cli' } }) });
  check('任务卡：标题 + 状态 + 轮次', taskHtml.includes('加 --json 输出') && taskHtml.includes('running') && taskHtml.includes('3'));
  {
    /* 状态徽章语义色（2026-10-07 用户报「succeeded 是灰的」）：
       ① 任务状态必须**各自有配色**（以前整张表都没有任务状态 ⇒ 成功/取消/排队全是同一坨灰）；
       ② 前景色优先用**宿主的真令牌** `--dsw-alias-state-*`（以前写的是宿主根本没有的 `--dsh-color-*`）；
       ③ 成功=绿、失败=红、跑=蓝、等回复=琥珀、排队/取消=灰。 */
    const chipCss = (st) => {
      const html = renderToStaticMarkup(
        React.createElement(loaded.exports.__components.AitmToolCard, {
          t: fakeT,
          toolName: 'aitm_task_status',
          phase: 'result',
          block: resultBlock({ kind: 'task', task: { id: 't_9', title: 'x', status: st, turns: 1 } }),
        }),
      );
      // 徽章自带 data-task-status，取它这一支的 style（别抓到卡片外层的 background/color）
      return new RegExp(`style="([^"]*)"[^>]*data-task-status="${st}"`).exec(html)?.[1] ?? '';
    };
    const ok = chipCss('succeeded');
    const bad = chipCss('failed');
    const run = chipCss('running');
    const queued = chipCss('queued');
    check(
      '任务状态有语义色：成功=绿、失败=红、跑=蓝、排队=灰（以前全是同一坨灰）',
      ok.includes('--aitm-fg-ok') && bad.includes('--aitm-fg-err') && run.includes('--aitm-fg-info') && queued.includes('--aitm-fg-dim'),
      `succeeded=${ok} / failed=${bad}`,
    );
    check('配色把任务状态和已取消分开（succeeded ≠ cancelled 的样式）', ok !== chipCss('cancelled') && ok !== bad);
    {
      /* 徽章文字色必须是**两套**（浅色主题深、深色主题亮）——宿主的 state-*-primary 在两个主题里
         是同一个亮色，当小字用浅色主题下只有 2.1:1（AA 要 4.5:1）。这两套值**逐字抄桌面端**。 */
      const csrc3 = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
      const varsBlock = /const THEME_VARS_ID[\s\S]*?document\n?/;
      const lightM = /'body\{--aitm-fg-ok:(#[0-9a-f]{6});/.exec(csrc3);
      const darkM = /'body\[data-ds-dark-theme\]\{--aitm-fg-ok:(#[0-9a-f]{6});/.exec(csrc3);
      check(
        '语义文字色有**两套**（浅色主题一套 + body[data-ds-dark-theme] 深色主题一套）',
        Boolean(lightM && darkM) && lightM[1] !== darkM[1],
        `浅=${lightM?.[1]} 深=${darkM?.[1]}`,
      );
      check('两套色在 apply() 里装上（浏览器侧注入，离线渲染不受影响）', /ensureThemeVars\(\);/.test(csrc3));
      /* 与桌面端逐字一致（分发场景没有主仓源码 ⇒ 缺文件就跳过） */
      const cssPath = path.join(ROOT, '..', 'src', 'renderer', 'src', 'styles.css');
      if (fs.existsSync(cssPath)) {
        const css = fs.readFileSync(cssPath, 'utf8');
        const table = { ok: '--tint-ok', err: '--tint-err', warn: '--tint-warn', info: '--tint-blue', dim: '--tint-gray', muted: '--tint-gray-dim', cyan: '--tint-cyan', purple: '--tint-purple' };
        const lightIdx = css.indexOf(":root[data-theme='light']");
        const pick = (v, light) => {
          const re = new RegExp('\\' + v + ':\\s*(#[0-9a-f]{6})', 'g');
          let m, out = [];
          while ((m = re.exec(css))) out.push({ pos: m.index, v: m[1] });
          const f = out.filter((x) => (x.pos > lightIdx) === light);
          return (f[0] ?? out[0])?.v ?? null;
        };
        const mismatch = Object.entries(table).filter(([k, v]) => {
          const l = new RegExp(`--aitm-fg-${k}:(#[0-9a-f]{6})`).exec(lightM ? csrc3.slice(csrc3.indexOf("'body{--aitm-fg-ok"), csrc3.indexOf("'body[data-ds-dark-theme]")) : '')?.[1];
          const d = new RegExp(`--aitm-fg-${k}:(#[0-9a-f]{6})`).exec(csrc3.slice(csrc3.indexOf("'body[data-ds-dark-theme]")))?.[1];
          return l !== pick(v, true) || d !== pick(v, false);
        });
        check(
          '两套语义文字色与桌面端 styles.css 的 --tint-* **逐字一致**（面板颜色＝桌面颜色）',
          mismatch.length === 0,
          mismatch.map(([k]) => k).join('/'),
        );
      }
    }
    {
      /* 守门：面板配色必须挂在**宿主真令牌**上。
         2026-10-07 用户截图：深色主题下想法卡片是**白底白字** —— 根因是底色写 `--dsh-color-bg-elevated`
         （宿主没有这个前缀）⇒ 永远吃兜底 `#fff`，而文字色是从宿主继承的浅色。 */
      const csrc2 = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
      check(
        '面板不再引用宿主没有的 --dsh-color-*（写它＝永远吃兜底、不跟深浅主题）',
        !/var\(--dsh-color-/.test(csrc2),
        (csrc2.match(/var\(--dsh-color-[a-z-]*/g) ?? []).slice(0, 3).join(' / '),
      );
      check(
        '卡片/弹窗底色用宿主层级令牌（深浅主题各一套）',
        /var\(--dsw-alias-bg-layer-[123],/.test(csrc2) && /--dsw-alias-bg-layer-2/.test(csrc2),
      );
      check(
        '描边用 --dsw-alias-border-l*（三档都在用）',
        ['l1', 'l2', 'l3'].every((k) => csrc2.includes(`var(--dsw-alias-border-${k},`)),
      );
      /* 离线渲染出的样式里，**不许出现任何写死的浅色底**（#fff / #ffffff / white）：
         深色主题下那会变成一块白板。兜底值必须也是"能跟主题走"的表达。 */
      const lightOnly = ['#fff;', '#ffffff;', '#fff)', '#ffffff)', ':white', ': #fff', 'rgba(255,255,255', 'rgba(255, 255, 255'];
      const html = render({
        toolName: 'aitm_task_status',
        phase: 'result',
        block: resultBlock({ kind: 'task', task: { id: 't_1', title: 'x', status: 'succeeded', turns: 1 } }),
      });
      const hit = lightOnly.filter((v) => new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(html));
      check('渲染结果里没有写死的浅色底（深色主题下会变白板）', hit.length === 0, hit.join(' / '));
    }
    {
      /* 守门：加新状态时忘了补配色 ⇒ 静默落灰（2026-10-07 那条 bug 的根因正是这个）。
         直接从源码抠两张配色表的键，跟内核的状态清单对表。 */
      const csrc = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
      const keysOf = (name) => {
        const m = new RegExp('const ' + name + ' = \\{([\\s\\S]*?)\\n    \\};').exec(csrc);
        return m ? [...m[1].matchAll(/(\w+):\s*(?:tone\(|\[)/g)].map((x) => x[1]) : [];
      };
      const ideaKeys = keysOf('STATUS_COLOR');
      const taskKeys = keysOf('TASK_STATUS_COLOR');
      // 内核的想法状态清单直接从 `src/shared/labels.ts` 对表（分发场景只有插件包 ⇒ 退回固定清单）
      const labelsPath = path.join(ROOT, '..', 'src', 'shared', 'labels.ts');
      const wantIdea = (() => {
        if (!fs.existsSync(labelsPath)) return ['inbox', 'scoping', 'ready', 'developing', 'review', 'blocked', 'done', 'archived'];
        const mm = /export const IDEA_LABEL[^{]*{([\s\S]*?)\n};/.exec(fs.readFileSync(labelsPath, 'utf8'));
        return mm ? [...mm[1].matchAll(/(\w+):\s*'/g)].map((x) => x[1]) : [];
      })();
      const wantTask = ['queued', 'running', 'waiting_input', 'succeeded', 'failed', 'cancelled'];
      check(
        `想法状态配色表覆盖内核全部 ${wantIdea.length} 档（少一档就静默落灰）`,
        wantIdea.every((k) => ideaKeys.includes(k)),
        `表里 ${ideaKeys.length} 档：${ideaKeys.join('/')}｜内核要 ${wantIdea.length} 档`,
      );
      check(
        '任务状态配色表覆盖内核全部 6 档（succeeded 在列）',
        wantTask.every((k) => taskKeys.includes(k)),
        `表里 ${taskKeys.length} 档：${taskKeys.join('/')}`,
      );
    }
    check(
      '状态徽章写本地化文案（succeeded → 已完成），原始状态名留在 title 里',
      taskHtml.includes(locales.aitm.zh['card.task.st.running']) && /data-task-status="running"/.test(taskHtml),
      taskHtml.match(/data-task-status="[a-z_]+"/)?.[0] ?? '(没找到)',
    );
  }

  const taskListHtml = render({ toolName: 'aitm_task_status', phase: 'result', block: resultBlock({ kind: 'task-list', items: [{ id: 't_1', title: '甲任务', status: 'succeeded', turns: 1 }, { id: 't_2', title: '乙任务', status: 'failed', turns: 2 }] }) });
  {
    // 同一张列表卡里，成功那条要绿、失败那条要红（离线 HTML 里直接查这两支的 style）
    const styleOf = (st) => new RegExp(`style="([^"]*)"[^>]*data-task-status="${st}"`).exec(taskListHtml)?.[1] ?? '';
    check(
      '任务列表卡：同屏里成功=绿、失败=红（不再是同一坨灰）',
      styleOf('succeeded').includes('--aitm-fg-ok') && styleOf('failed').includes('--aitm-fg-err'),
      `succeeded=${styleOf('succeeded').slice(0, 40)}…`,
    );
  }
  check('任务列表卡：两条都在', taskListHtml.includes('甲任务') && taskListHtml.includes('乙任务') && taskListHtml.includes('failed'));

  const calHtml = render({ toolName: 'aitm_calendar_day', phase: 'result', block: resultBlock({ kind: 'calendar', day: '2026-10-06', monthIdeas: 4, monthFavorites: 2, ideas: [{ id: 'a', title: '记一条想法', status: 'inbox' }], favorites: [{ title: '某条新闻', source: 'github' }] }) });
  check('日历卡：日期 + 月计数 + 想法与收藏', calHtml.includes('2026-10-06') && calHtml.includes('记一条想法') && calHtml.includes('某条新闻'));

  const repoHtml = render({ toolName: 'aitm_repo_status', phase: 'result', block: resultBlock({ kind: 'repos', repos: [{ id: 'r1', name: 'demo-app', worktrees: 3, sizeKb: 2048, active: 1 }], worktrees: 3, totalKb: 2048, reclaimable: 1 }) });
  check('仓库卡：名字 + worktree 数 + 在跑数', repoHtml.includes('demo-app') && repoHtml.includes('3') && repoHtml.includes('在跑'));

  const backupHtml = render({ toolName: 'aitm_backup_now', phase: 'result', block: resultBlock({ kind: 'backup', mode: 'lean', files: 12, bytes: 4096, label: 'L4 验证' }) });
  check('备份卡：模式 + 文件数 + 名字', backupHtml.includes('轻量') && backupHtml.includes('12') && backupHtml.includes('L4 验证'));

  const failureHtml = render({ phase: 'result', block: { ...resultBlock({ kind: 'idea', action: 'create', ok: false, error: '标题不能为空' }, '没写成：标题不能为空'), isError: false } });
  check('失败态：把原因原样给出', failureHtml.includes('标题不能为空'));

  const runningHtml = render({ phase: 'start', block: { phase: 'start', argsRaw: '{"title":"写一半"}' } });
  check('运行态：说清这次要干什么', runningHtml.includes('记一条想法') && runningHtml.includes('写一半'));

  const noMetaHtml = render({ phase: 'result', block: resultBlock(undefined, '已记进想法箱：X（idea-1，状态 inbox）') });
  check('兜底：没有 meta 时收原始文本，不是空白', noMetaHtml.includes('idea-1') && noMetaHtml.includes('原始返回'));

  /* ---- 原生看板（M3：看板也搬进插件了）---- */
  const B = loaded.exports.__boardHelpers;
  check(
    '看板列序与内核一致（7 列，归档不进看板）',
    JSON.stringify(B.IDEA_ORDER) === JSON.stringify(['inbox', 'scoping', 'ready', 'developing', 'review', 'blocked', 'done']),
    B.IDEA_ORDER.join(', '),
  );
  const bucketed = B.groupByStatus([
    { id: 'a', status: 'ready' },
    { id: 'b', status: 'inbox' },
    { id: 'c', status: 'ready' },
    { id: 'd', status: 'archived' }, // 不在列序里 → 不出现（与桌面的 IDEA_ORDER 口径一致）
  ]);
  check(
    '看板分桶：按状态归位，未在列序里的状态被丢掉',
    bucketed.ready.length === 2 && bucketed.inbox.length === 1 && Object.keys(bucketed).length === 7 && !Object.keys(bucketed).includes('archived'),
    `ready=${String(bucketed.ready.length)} inbox=${String(bucketed.inbox.length)} keys=${Object.keys(bucketed).length}`,
  );
  check('相对时间与桌面同口径', B.relTime(Date.now() - 30_000) === '刚刚' && /分钟前$/.test(B.relTime(Date.now() - 5 * 60_000)) && B.relTime(null) === '—');

  const BoardCol = loaded.exports.__components.BoardColumn;
  const colHtml = renderToStaticMarkup(React.createElement(BoardCol, {
    status: 'ready',
    ideas: [
      { id: 'i_1', title: '给日历加导出', description: '导出成 .ics 订阅', status: 'ready', priority: 'p1', tags: ['日历', '导出'], repoId: 'r1', starred: true, updatedAt: Date.now() - 3_600_000 },
      { id: 'i_2', title: '看板原生', status: 'ready', priority: 'p2', tags: [], repoId: null, starred: false, updatedAt: Date.now() },
    ],
    repos: [{ id: 'r1', name: 'demo-app' }],
    tasks: [{ id: 't1', ideaId: 'i_1', status: 'running' }, { id: 't2', ideaId: 'i_1', status: 'succeeded' }],
    selected: null,
    onOpen: () => {},
    onStar: () => {},
    onDrop: () => {},
    t: (k) => k,
  }));
  check(
    '看板列：列头 + 两张卡（标题/优先级/标签/任务数/仓库/相对时间都在）',
    colHtml.includes('data-col="ready"') &&
      (colHtml.match(/data-idea=/g) ?? []).length === 2 &&
      colHtml.includes('给日历加导出') &&
      colHtml.includes('P1') &&
      colHtml.includes('#日历') &&
      colHtml.includes('demo-app') &&
      colHtml.includes('1 小时前'),
  );
  const emptyColHtml = renderToStaticMarkup(React.createElement(BoardCol, {
    status: 'done', ideas: [], repos: [], tasks: [], selected: null, onOpen: () => {}, onStar: () => {}, onDrop: () => {}, t: (k) => k,
  }));
  check('空列给「拖想法到这里」（不是一片空白）', emptyColHtml.includes('board.dropHere'));
  /* 手机端（M3 最后一项）：窄屏不溢出 + 触摸能改状态 */
  /* 列宽必须是**定宽**（width），不能是 flex-basis —— 2026-10-07 用户真机报过「卡片宽度太大」：
     没有 width 时列上的 `min-width: auto` 取内容最小值，卡片里那行 nowrap 的「…原文：https://…」
     约 500px 宽 ⇒ 整列被撑到 500px。这条断言就是防它回来。 */
  check(
    '看板列是定宽 172px（不是 flex-basis —— 那会让长文本把列撑宽）',
    /width:172px/.test(colHtml) && colHtml.includes('min-width:0') && !colHtml.includes('flex-basis'),
    colHtml.match(/width:[^;"]+/)?.[0] ?? '(没找到 width)',
  );
  {
    // clientSrc 在后面才读，这里就近读一份（只 grep 源码字面量，不依赖加载顺序）
    const src = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
    const ns = src.match(/name:\s*'(aitm[a-z0-9._-]*)'/)?.[1] ?? src.match(/'([a-z0-9._-]+)':\s*\{\s*'board\.back'/)?.[1] ?? null;
    check(
      '详情里有「改状态」一排（手机上 HTML5 拖拽不响应触摸，改状态得有别的路）',
      src.includes("'data-board-move': '1'") && src.includes("'data-move': st") && (src.match(/'board\.moveTo'/g) ?? []).length >= 2,
      `data-board-move + ${String((src.match(/'board\.moveTo'/g) ?? []).length)} 处文案键引用（中/英 + 组件）${ns ? ` · 命名空间 ${ns}` : ''}`,
    );
    // 合集网格：离线 HTML 只渲染空态（网格要数据面到了才出来），所以就地 grep 那行 CSS
    check('合集网格列宽防溢出（窄屏 min(232px, 100%) → 卡片铺满整行）', src.includes('minmax(min(232px, 100%), 1fr)'));
  }

  /* ---- 看板的口径钉在内核上：插件是独立包、不能 import 仓库源码，所以那几份副本
     （列序 / 列名）必须与 `src/shared/labels.ts` **逐字**一致 —— 内核改了这里就得跟着改。 ---- */
  const labelsSrc = fs.readFileSync(path.join(REPO, 'src', 'shared', 'labels.ts'), 'utf8');
  const kernelOrder = [...(labelsSrc.match(/IDEA_ORDER[^=]*=\s*\[([^\]]*)\]/)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const labelBlock = labelsSrc.slice(labelsSrc.indexOf('IDEA_LABEL'));
  const kernelLabels = Object.fromEntries(
    [...labelBlock.slice(0, labelBlock.indexOf('};')).matchAll(/(\w+)\s*:\s*'([^']+)'/g)].map((m) => [m[1], m[2]]),
  );
  check(
    '看板列序＝内核 IDEA_ORDER（7 列，副本没跑偏）',
    kernelOrder.length === 7 && JSON.stringify(kernelOrder) === JSON.stringify(B.IDEA_ORDER),
    `内核 ${kernelOrder.join(',')}`,
  );
  const dictNs = Object.keys(locales)[0];
  check('词典注册在 aitm 命名空间', dictNs === 'aitm', String(dictNs ?? '(没注册)'));
  const dict = locales[dictNs] ?? {};
  const zhCols = B.IDEA_ORDER.map((st) => dict.zh?.[`board.col.${st}`]);
  const enCols = B.IDEA_ORDER.map((st) => dict.en?.[`board.col.${st}`]);
  check(
    '列名＝内核 IDEA_LABEL（逐字，7 列）',
    zhCols.join('/') === B.IDEA_ORDER.map((st) => kernelLabels[st]).join('/'),
    zhCols.join(' / '),
  );
  check(
    '英文列名不缺（en 里是英文，不是掉回中文）',
    B.IDEA_ORDER.every((st) => typeof dict.en?.[`board.col.${st}`] === 'string' && dict.en[`board.col.${st}`] !== dict.zh[`board.col.${st}`]),
    enCols.join(' / '),
  );
  const zhKeys = Object.keys(dict.zh ?? {}).sort();
  const enKeys = Object.keys(dict.en ?? {}).sort();
  check(
    '两份词典键完全一致（缺英文 → 英文界面掉回中文/键名，踩过一次）',
    zhKeys.length > 0 && JSON.stringify(zhKeys) === JSON.stringify(enKeys),
    `zh ${String(zhKeys.length)} / en ${String(enKeys.length)}`,
  );
  check(
    'IDEA_LABEL 副本与词典同源（插件内部不打架）',
    B.IDEA_ORDER.every((st) => B.IDEA_LABEL.zh[st] === dict.zh?.[`board.col.${st}`]),
  );

  const acceptHtml = render({ toolName: 'aitm_task_accept', phase: 'result', block: { ...resultBlock({ kind: 'accept', accepted: true, merged: true, taskId: 't_9', ideaTitle: '给日历加导出', baseRef: 'arena/x', detail: 'Fast-forward', verify: { ok: true, note: '通过：npm run verify' } }), call: { name: 'aitm_task_accept', argsRaw: '{"taskId":"t_9"}' } } });
  check(
    '验收卡：标题 + 已合并 + 基线 + 验证通过',
    acceptHtml.includes('给日历加导出') && acceptHtml.includes('已合并') && acceptHtml.includes('arena/x') && acceptHtml.includes('验证通过'),
    `${acceptHtml.length} 字节`,
  );
  const acceptOnlyHtml = render({ toolName: 'aitm_task_accept', phase: 'result', block: { ...resultBlock({ kind: 'accept', accepted: true, merged: false, taskId: 't_9', ideaTitle: '给日历加导出', detail: '已标记验收（未合并）' }), call: { name: 'aitm_task_accept', argsRaw: '{}' } } });
  check('验收卡：只记验收写明「未合并」', acceptOnlyHtml.includes('已记验收（未合并）'));
  const acceptFailHtml = render({ toolName: 'aitm_task_accept', phase: 'result', block: { ...resultBlock({ kind: 'accept', ok: false, error: '验证没过，没有合并：未通过：npm test。勾上「验证没过也要合」再点一次。', needsAcknowledge: true, taskId: 't_9' }), call: { name: 'aitm_task_accept', argsRaw: '{}' }, isError: false, error: undefined } });
  check('验收卡：验证没过被拦下时把原因原样显示', acceptFailHtml.includes('验证没过') || acceptFailHtml.includes('没有合并'), `${acceptFailHtml.length} 字节`);

  const BoardPanel = loaded.exports.__components.AitmBoard;
  const boardHtml = renderToStaticMarkup(React.createElement(BoardPanel, { base: null, onOpenFull: () => {} }));
  check(
    '看板离线渲染：7 个列骨架都在（服务端渲染不跑 effect，但结构要在）',
    (boardHtml.match(/data-col=/g) ?? []).length === 7 && boardHtml.includes('data-board="board"'),
    `${boardHtml.length} 字节`,
  );
  // 详情里的验收条要有**结构**（服务端渲染没有数据时是空的，所以只断言组件认识 accept 这条通道）
  check('原生看板认识验收通道（组件导出 + 文案在词典里）', Boolean(loaded.exports.__components.AitmBoard) && typeof dict.zh?.['board.accept'] === 'string' && typeof dict.zh?.['board.acceptOnly'] === 'string');
  {
    /* 任务行（详情里）：被中断/失败 → 「继续」「重试」+ 原因原话；正在跑 → 只写「进行中」，不给按钮 */
    const Row = loaded.exports.__components.BoardTaskRow;
    const B3 = loaded.exports.__boardHelpers;
    check('导出任务行组件（verify 能离线断言它）', typeof Row === 'function' && !!B3);
    const rowHtml = (x, extra = {}) =>
      renderToStaticMarkup(
        React.createElement(Row, { x, t: fakeT, editing: false, text: '', onToggleEditor: () => {}, onText: () => {}, onSend: () => {}, onRetry: () => {}, ...extra }),
      );
    const interrupted = rowHtml({ id: 't_7', status: 'failed', turns: 3, error: '应用重启导致中断；worktree 仍在，可直接继续对话' });
    check(
      '被中断的任务：给「继续」+「重试」，并把中断原因原样写出来',
      interrupted.includes('data-task-follow="1"') && interrupted.includes('data-task-retry="1"') && interrupted.includes('t_7') && interrupted.includes('worktree 仍在'),
      `${interrupted.length} 字节`,
    );
    const runningRow = rowHtml({ id: 't_8', status: 'running', turns: 1 });
    check('正在跑的任务：不给这两个按钮，只写「进行中」（内核也会拒）', !runningRow.includes('data-task-follow') && !runningRow.includes('data-task-retry') && runningRow.includes(dict.zh['board.taskActive']));
    const editingRow = rowHtml({ id: 't_7', status: 'failed' }, { editing: true, text: '把测试补上' });
    check('点「继续」展开输入框（指令 + 发送），发送按钮带 data 锚点', editingRow.includes('data-task-input="1"') && editingRow.includes('data-task-send="1"') && editingRow.includes('把测试补上'));
    check(
      '「继续/重试」走的是内核那两条（followUp 复用 worktree；retry 新起一条）—— 源码里点名',
      fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8').includes("'task.followUp'") &&
        fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8').includes("'task.retry'") &&
        typeof dict.zh?.['board.taskQueued'] === 'string' &&
        typeof dict.zh?.['board.taskQueuedRetry'] === 'string',
    );
  }

  /* ---- 原生日历（不走 iframe 的那块）---- */
  const H = loaded.exports.__calendarHelpers;
  const gridDays = H.monthGridDays(2026, 9, new Date(2026, 9, 6).getTime()); // 2026-10（月份从 0 数）
  check('日历网格：固定 42 格、周一起排、含今天', gridDays.length === 42 && gridDays.some((d) => d.isToday && d.key === '2026-10-06'), `${gridDays[0].key} → ${gridDays[41].key}`);
  const ideasByDay = H.groupByDayLocal([{ createdAt: new Date(2026, 9, 6, 10).getTime(), title: '甲' }, { createdAt: new Date(2026, 9, 6, 20).getTime(), title: '乙' }, { createdAt: new Date(2026, 9, 8).getTime(), title: '丙' }], (x) => x.createdAt);
  const favsByDay = H.groupByDayLocal([{ savedAt: new Date(2026, 9, 6).getTime(), title: '新闻' }], (x) => x.savedAt);
  const Grid = loaded.exports.__components.CalendarGrid;
  const calGridHtml = renderToStaticMarkup(React.createElement(Grid, {
    days: gridDays,
    ideasByDay,
    favsByDay,
    selected: '2026-10-06',
    onPick: () => {},
    t: (k) => k,
  }));
  check(
    '原生日历网格：42 个格子 + 当天有想法/收藏的圆点',
    (calGridHtml.match(/data-day=/g) ?? []).length === 42 && calGridHtml.includes('data-day="2026-10-06"'),
    `${calGridHtml.length} 字节`,
  );

  /* ---- 原生合集（M3 逐页搬家第三页；此前一直是 iframe）---- */
  const F = loaded.exports.__feedHelpers;
  const clientSrc = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
  check(
    '面板里「合集」走原生（不再套 iframe，只有「在完整面板里打开」才用）',
    /view === 'feed' && !embedIdea[\s\S]{0,400}?jsx\.jsx\(AitmFeed/.test(clientSrc) && Boolean(loaded.exports.__components.AitmFeed),
  );
  check(
    '合集三块顺序＝桌面 FeedView 的 BLOCKS（GitHub / B站 / 收藏）',
    JSON.stringify(F.FEED_BLOCKS.map((b) => b.id)) === JSON.stringify(['github', 'bilibili', 'favorites']),
    F.FEED_BLOCKS.map((b) => `${b.short}=${b.label}`).join(' / '),
  );

  /* ---- 合集的口径钉在内核：插件不能 import 仓库源码，副本必须与内核**逐字**一致 ---- */
  const feedFmtSrc = fs.readFileSync(path.join(REPO, 'src', 'shared', 'feed-format.ts'), 'utf8');
  const feedViewSrc = fs.readFileSync(path.join(REPO, 'src', 'renderer', 'src', 'components', 'FeedView.tsx'), 'utf8');
  const kernelKindBlock = feedFmtSrc.match(/FEED_KIND_LABEL[^=]*=\s*\{([^}]*)\}/)?.[1] ?? '';
  const kernelKind = Object.fromEntries([...kernelKindBlock.matchAll(/(\w+)\s*:\s*'([^']+)'/g)].map((m) => [m[1], m[2]]));
  check(
    '合集的「类别」名＝内核 FEED_KIND_LABEL（逐字，5 类）',
    Object.keys(kernelKind).length === 5 && JSON.stringify(F.FEED_KIND_LABEL) === JSON.stringify(kernelKind),
    Object.entries(kernelKind).map(([k, v]) => `${k}=${v}`).join(' '),
  );
  const kernelBlocksArr = feedViewSrc.match(/const BLOCKS[^=]*=\s*\[([\s\S]*?)\];/)?.[1] ?? '';
  const kernelBlocks = [...kernelBlocksArr.matchAll(/id:\s*'(\w+)',\s*label:\s*'([^']+)',\s*short:\s*'([^']+)'/g)].map((m) => ({ id: m[1], label: m[2], short: m[3] }));
  check(
    '合集三块的 id/名字＝桌面 FeedView 的 BLOCKS（逐字）',
    kernelBlocks.length === 3 && JSON.stringify(kernelBlocks) === JSON.stringify(F.FEED_BLOCKS),
    kernelBlocks.map((b) => b.short).join(' / '),
  );
  check(
    '指标/趋势口径与内核同源（万·亿阈值 + ★/⑂/播放/赞/弹幕/上榜 都在内核那份里）',
    /100_000_000/.test(feedFmtSrc) &&
      /10_000/.test(feedFmtSrc) &&
      ['★ ', '⑂ ', '播放 ', '赞 ', '弹幕 ', '上榜 ', '均名 #'].every((marker) => feedFmtSrc.includes(marker)),
  );
  check(
    '数字缩写：默认千分位、中文侧 1.2 万 / 1.2 亿',
    F.compactNumber(12345) === '12,345' && F.compactNumber(12345, { wan: true }) === '1.2 万' && F.compactNumber(123456789, { wan: true }) === '1.2 亿' && F.compactNumber(NaN) === '—',
    `${F.compactNumber(12345)} / ${F.compactNumber(12345, { wan: true })} / ${F.compactNumber(123456789, { wan: true })}`,
  );

  const ghItem = {
    key: 'gh:o/r',
    source: 'github',
    kind: 'repo',
    title: 'OpenCardboard',
    subtitle: 'TypeScript',
    url: 'https://github.com/Sahiii-i/OpenCardboard',
    rank: 3,
    metrics: { stars: 12345, starsToday: 234 },
    summary: '本地优先的 chat-to-edit 视频编辑器',
    tags: ['视频'],
    fetchedAt: Date.now(),
  };
  check('指标行：有就显示、缺就不写 0', F.metricText(ghItem) === '★ 12,345 · +234/日', F.metricText(ghItem));
  const biliItem = { ...ghItem, source: 'bilibili', kind: 'video', metrics: { views: 123456, likes: 12000 } };
  check('指标行：B站侧用「万」', F.metricText(biliItem) === '播放 12.3 万 · 赞 1.2 万', F.metricText(biliItem));
  const trendItem = { ...ghItem, trend: { ready: true, appearRatio: 0.83, avgRank: 4, starVelocity: 120.4 } };
  check(
    '趋势行：没 ready 就不显示；ready 时给「上榜 % · 均名 · 增速」',
    F.trendText(ghItem) === null && F.trendText(trendItem) === '上榜 83% · 均名 #4 · +120/日',
    String(F.trendText(trendItem)),
  );
  const draft0 = F.feedPrefill(ghItem);
  check(
    '「改一改再记」的预填：标题 + 来源行 + 数据 + 简介 + 资讯标签',
    draft0.title === 'OpenCardboard' &&
      draft0.description.includes('来源：[OpenCardboard](https://github.com/Sahiii-i/OpenCardboard)') &&
      draft0.description.includes('数据：★ 12,345 · +234/日') &&
      draft0.description.includes('本地优先') &&
      JSON.stringify(draft0.tags) === JSON.stringify(['资讯', 'GitHub']),
    draft0.description.split('\n')[0],
  );
  const miniSnap = { github: { today: [{ key: 'gh:o/r' }, { key: 'gh:x/y' }], week: [], month: [], newRepos: [] }, bilibili: { hot: [{ key: 'bl:a' }], ai: [], zones: [{ tid: 1, items: [{ key: 'gh:o/r' }] }], ups: [] } };
  const marked = F.markFeedRecorded(miniSnap, 'gh:o/r', 'idea-9');
  check(
    '记录成功后就地标记：命中条目带上 ideaId，其它不动（与桌面 store 同一做法）',
    marked.github.today[0].ideaId === 'idea-9' &&
      marked.github.today[1].ideaId === undefined &&
      marked.bilibili.hot[0].ideaId === undefined &&
      marked.bilibili.zones[0].items[0].ideaId === 'idea-9' &&
      miniSnap.github.today[0].ideaId === undefined,
    `today[0]=${String(marked.github.today[0].ideaId)} hot[0]=${String(marked.bilibili.hot[0].ideaId)}`,
  );

  const FeedCardC = loaded.exports.__components.FeedItemCard;
  const cardHtml = renderToStaticMarkup(
    React.createElement(FeedCardC, { item: ghItem, onRecord: () => {}, onStar: () => {}, onHide: () => {}, onPrefill: () => {}, onOpenIdea: () => {}, t: fakeT }),
  );
  check(
    '合集卡片：名次 + 标题外链 + 类别 + 来源 + 副标题 + 指标 + 简介 + 图标动作（★/⊘/✎/✨）',
    cardHtml.includes('data-feed-card="gh:o/r"') &&
      cardHtml.includes('#3') &&
      cardHtml.includes('OpenCardboard') &&
      cardHtml.includes('github.com/Sahiii-i/OpenCardboard') &&
      cardHtml.includes('项目') &&
      cardHtml.includes('TypeScript') &&
      cardHtml.includes('★ 12,345') &&
      cardHtml.includes('本地优先') &&
      ['☆', '⊘', '✎', '✨'].every((g) => cardHtml.includes(g)),
    `${cardHtml.length} 字节`,
  );
  const cardDoneHtml = renderToStaticMarkup(
    React.createElement(FeedCardC, { item: { ...ghItem, starred: true, ideaId: 'idea-9' }, onRecord: () => {}, onStar: () => {}, onHide: () => {}, onPrefill: () => {}, onOpenIdea: () => {}, t: fakeT }),
  );
  check('合集卡片：收藏过是实心 ★；已记录只留「✓ 打开想法」（不再重复给记录按钮）', cardDoneHtml.includes('★') && cardDoneHtml.includes('✓') && !cardDoneHtml.includes('✨') && !cardDoneHtml.includes('✎'));
  {
    /* 动作条一律黑白（用户口径 2026-10-07）：
       旧版 primary = 蓝底白字（✨ 记想法 / ✓ 已记录）、已收藏 = 蓝星 —— 现在都不上色，
       状态只由字形表达（☆/★、✓）。断言上「整张卡里不出现强调色/白字」最稳。 */
    const noColor = (h) => !h.includes('--dsh-color-accent') && !h.includes('rgba(80,140,255') && !h.includes('#fff');
    const transparents = (h) => (h.match(/background:transparent/g) ?? []).length;
    check(
      '合集卡片动作条一律黑白：普通卡（☆/✎/✨）与已收藏卡（★/✓）里都没有强调色或白字',
      noColor(cardHtml) && noColor(cardDoneHtml),
      `透明底按钮 普通 ${transparents(cardHtml)} 个 / 已收藏 ${transparents(cardDoneHtml)} 个`,
    );
    check(
      '「记想法」「已记录」「已收藏」都不再有底色（透明底，与打开/隐藏/预填同风格）',
      transparents(cardHtml) >= 5 && transparents(cardDoneHtml) >= 4,
      `普通 ${transparents(cardHtml)} / 已收藏 ${transparents(cardDoneHtml)}（分别应为 5 / 4）`,
    );
  }

  const favCardHtml = renderToStaticMarkup(
    React.createElement(FeedCardC, { item: ghItem, savedAt: Date.now() - 3600_000, onRecord: () => {}, onStar: () => {}, onHide: () => {}, onPrefill: () => {}, onOpenIdea: () => {}, t: fakeT }),
  );
  const B2 = loaded.exports.__boardHelpers;
  check('收藏视图显示「收藏于 X」（与桌面同一条相对时间口径）', favCardHtml.includes(`收藏于 ${B2.relTime(Date.now() - 3600_000)}`), `收藏于 ${B2.relTime(Date.now() - 3600_000)}`);
  {
    // 「本页加载的是哪一版 client.js」——设置节里拿它跟服务端文件的值对（用户真机踩过「改了没生效」）
    const single = [{ name: 'https://x/plugins/??dsh-plugin-aitm/client.js&rev=abc123def456' }];
    const combo = [{ name: 'https://x/plugins/??dsh-plugin-aitm/client.js,other/client.js&rev=999999zzz' }];
    const other = [{ name: 'https://x/api/events?rev=abc123def456' }, { name: 'https://x/plugins/??dsh-plugin-aitm/client.js.map&rev=abc123' }];
    check(
      '本页 rev 能从 resource timing 里认出来（只认单插件 URL；合并 combo / 别的资源都返回 null，不误报）',
      B2.loadedClientRev(single) === 'abc123def456' && B2.loadedClientRev(combo) === null && B2.loadedClientRev(other) === null && B2.loadedClientRev([]) === null,
      `单插件→${String(B2.loadedClientRev(single))} / combo→${String(B2.loadedClientRev(combo))}`,
    );
    // 用户真机报过「面板是新代码，rev 却显示不一致」：DSH 热更新换过模块之后资源表里有多条记录，
    // 必须先加载的那条是旧的 —— 取**最后**一条才是本页现在跑的这份。
    const hmr = [
      { name: 'https://x/plugins/??dsh-plugin-aitm/client.js&rev=old0000000000' },
      { name: 'https://x/plugins/??dsh-plugin-aitm/client.js&rev=new1111111111' },
    ];
    check(
      '热更新换过模块时取**最后一次**加载的（资源表里旧记录在前，不能拿第一条）',
      B2.loadedClientRev(hmr) === 'new1111111111' && B2.loadedClientScriptUrl(hmr) === hmr[1].name,
      `多条→${String(B2.loadedClientRev(hmr))}`,
    );
    check(
      '定论优先用内容 sha1（只看字节）：rev 对不上但内容一致 ⇒ ok；内容不一致 ⇒ stale；都缺 ⇒ unknown',
      B2.clientVerdict({ serverRev: 'a', pageRev: 'b', serverSha: 'shaX', pageSha: 'shaX' }) === 'ok' &&
        B2.clientVerdict({ serverRev: 'a', pageRev: 'b', serverSha: 'shaX', pageSha: 'shaY' }) === 'stale' &&
        B2.clientVerdict({ serverRev: 'a', pageRev: 'a', serverSha: null, pageSha: null }) === 'ok' &&
        B2.clientVerdict({ serverRev: null, pageRev: null, serverSha: null, pageSha: null }) === 'unknown',
    );
    check(
      '设置节里会给出三种人话（一致 / 一致·内容已校验 / ⚠ 不一致），且服务端会带上 clientSha',
      clientSrc.includes('（本页一致）') && clientSrc.includes('（本页一致 · 内容已校验）') && clientSrc.includes('（⚠ 本页加载的是') && fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8').includes('clientSha: clientSha()'),
    );
  }

  const FeedPanel = loaded.exports.__components.AitmFeed;
  const feedPanelHtml = renderToStaticMarkup(React.createElement(FeedPanel, { base: null, onOpenIdea: () => {} }));
  check(
    '合集离线渲染：目录条三块 + 三个块骨架都在（服务端渲染不跑 effect，但结构要在）',
    feedPanelHtml.includes('data-feed="feed"') &&
      (feedPanelHtml.match(/data-feed-block=/g) ?? []).length === 3 &&
      feedPanelHtml.includes('data-feed-block="favorites"') &&
      feedPanelHtml.includes('全部收起'),
    `${feedPanelHtml.length} 字节`,
  );
  check(
    '合集词典：三块标题 + 收起/刷新/记想法这些文案都在（中英键一一对应，上面已整体比过）',
    ['feed.block.github', 'feed.block.bilibili', 'feed.block.favorites', 'feed.collapseAll', 'feed.refresh', 'feed.record', 'feed.hideTitle'].every((k) => typeof dict.zh?.[k] === 'string' && typeof dict.en?.[k] === 'string') &&
      Object.keys(dict.zh ?? {}).filter((k) => k.startsWith('feed.')).length >= 60,
    `feed.* 键 ${String(Object.keys(dict.zh ?? {}).filter((k) => k.startsWith('feed.')).length)} 个`,
  );

  /* ---- 触屏（手机 / 平板）：点按目标变大，桌面端一字不变 ---- */
  {
    let touchLoaded = null;
    globalThis.window = { __ModuleLoader__: { load({ id, factory }) { touchLoaded = { id, exports: factory(require) }; } } };
    // 一台「手机」：触屏 + 窄视口（DSH 移动版式），两个判定都要匹配上
    globalThis.matchMedia = (q) => ({ matches: /pointer: coarse|max-width: 520px/.test(String(q)), addEventListener: () => {}, removeEventListener: () => {} });
    await import(`${pathToFileURL(path.join(ROOT, 'client.js')).href}?touch=${String(Date.now())}`);
    const touchCtx = {
      slots: { inject: (n, cb) => { cb(); return () => {}; }, register: () => () => {} },
      sidebarRightTabs: { register: () => () => {} },
      sidebarRight: { openTab: () => {}, openTabs: { getSnapshot: () => [] } },
      locale: { register: () => () => {} },
      effect: (f) => { const d = f(); return typeof d === 'function' ? d : () => {}; },
    };
    touchLoaded.exports.apply(touchCtx);
    const TouchCol = touchLoaded.exports.__components.BoardColumn;
    const touchColHtml = renderToStaticMarkup(React.createElement(TouchCol, {
      status: 'ready', ideas: [{ id: 'i_1', title: '触屏', status: 'ready', tags: [], updatedAt: Date.now() }], repos: [], tasks: [], selected: null, onOpen: () => {}, onStar: () => {}, onDrop: () => {}, t: (k) => k,
    }));
    check('手机（触屏 + 窄视口）：列宽 82%（一列占满大半、露下一列）+ 点按目标抬到 30px', touchColHtml.includes('width:82%') && touchColHtml.includes('min-height:30px'), touchColHtml.match(/width:[^;"]+/)?.[0] ?? '(没找到 width)');
    check('手机列宽也是定宽（同一份代码两种取值：窄屏 82% / 桌面 172px），且都带 min-width:0 兜底', touchColHtml.includes('min-width:0') && touchColHtml.includes('width:82%') && colHtml.includes('width:172px'));
    check(
      '触屏上卡片不给 draggable（触摸拖不起来，开着只会吃掉长按/滚动）—— 桌面仍是 true',
      touchColHtml.includes('draggable="false"') && colHtml.includes('draggable="true"'),
      `触屏 ${/draggable="(true|false)"/.exec(touchColHtml)?.[1] ?? '无'} / 桌面 ${/draggable="(true|false)"/.exec(colHtml)?.[1] ?? '无'}`,
    );
    check('非触屏（桌面）：点按目标**不被**放大（样式逐字没变）', !colHtml.includes('min-height:30px'));
    globalThis.matchMedia = undefined;
    // 还原 window（后面的卡片断言还要用原来那份 loaded）
    globalThis.window = { __ModuleLoader__: { load() {} } };
  }

  const brokenHtml = render({ phase: 'result', block: { kind: 'tool-result', callId: 'c1', call: null, content: [], isError: true, error: { name: 'RemoteError', code: 'E_BOOM' } } });
  check('异常块：不炸（渲染成失败卡）', /E_BOOM|失败|没写成/.test(brokenHtml), brokenHtml.slice(0, 80));
  globalThis.fetch = realFetch;
}

/* ---------------- ⑦ 审批闸（离线：直接调 tools/pre-execute 的处理器）---------------- */
async function checkWriteGate() {
  console.log('⑦ 写操作审批闸（tools/pre-execute）');
  let loaded = null;
  globalThis.window = { __ModuleLoader__: { load({ id, factory }) { loaded = { id, exports: factory(require) }; } } };
  await import(`${pathToFileURL(path.join(ROOT, 'client.js')).href}?client=${String(Date.now())}`); // 只为了拿 require 的 react 环境

  // 重新加载宿主半边，抓它注册的钩子与工具
  const regs = { hooks: [], tools: [] };
  const ctx = {
    tools: { register: (t) => regs.tools.push(t), on: (name, fn, opts) => { regs.hooks.push({ name, fn, opts }); return () => {}; } },
    on: (name, fn, opts) => { regs.hooks.push({ name, fn, opts }); return () => {}; },
    slots: { inject: () => () => {}, register: () => () => {} },
    effect: (f) => { const d = f(); return typeof d === 'function' ? d : () => {}; },
    inject: () => {},
    logger: { info: () => {}, warn: () => {} },
    webServer: undefined,
  };
  const host = await import(`${pathToFileURL(path.join(ROOT, 'index.js')).href}?gate=${String(Date.now())}`);
  host.apply(ctx);

  const names = regs.tools.map((t) => t.name ?? t.definition?.name).filter(Boolean);
  const writeTools = ['aitm_idea_create', 'aitm_idea_set_status', 'aitm_task_start', 'aitm_task_follow_up', 'aitm_backup_now', 'aitm_task_accept'];
  check('五个写工具都注册了', writeTools.every((n) => names.includes(n)), names.join(', '));

  const gate = regs.hooks.find((h) => h.name === 'tools/pre-execute')?.fn;
  if (!check('注册了 tools/pre-execute 闸门', Boolean(gate))) return;
  const allow = async () => ({ kind: 'allow' });
  const okCreate = await gate({ name: 'aitm_idea_create', arguments: { title: '测试想法' }, signal: { aborted: false } }, allow);
  check('写操作 → ask（必须用户点头）', okCreate?.kind === 'ask', `${okCreate?.kind ?? '?'} / ${okCreate?.displayReason?.zh ?? ''}`);
  const readTool = await gate({ name: 'aitm_idea_list', arguments: {}, signal: { aborted: false } }, allow);
  check('只读工具 → 放行', readTool?.kind === 'allow');
  const badCreate = await gate({ name: 'aitm_idea_create', arguments: { title: '  ' }, signal: { aborted: false } }, allow);
  check('缺标题 → deny（不浪费用户点击）', badCreate?.kind === 'deny');
  let downstreamCalled = false;
  const downstreamDeny = await gate({ name: 'aitm_idea_create', arguments: { title: 'x' }, signal: { aborted: false } }, async () => {
    downstreamCalled = true;
    return { kind: 'deny', reason: '沙箱不允许' };
  });
  check('下游拒绝时以它为准', downstreamCalled && downstreamDeny?.kind === 'deny');
  const aborted = await gate({ name: 'aitm_idea_create', arguments: { title: 'x' }, signal: { aborted: true } }, allow);
  check('已取消的调用 → cancel', aborted?.kind === 'cancel');

  // L4 新增的两个写工具：开工与备份都必须弹审批（它们动的是仓库与磁盘）
  const startAsk = await gate(
    { name: 'aitm_task_start', arguments: { ideaId: 'i_x', instruction: '加个 --json' }, signal: { aborted: false } },
    allow,
  );
  check('开工（aitm_task_start）→ ask', startAsk?.kind === 'ask', startAsk?.displayReason?.zh ?? '');
  const followAsk = await gate({ name: 'aitm_task_follow_up', arguments: { taskId: 't_1', instruction: '把测试补上' }, signal: { aborted: false } }, allow);
  check('继续任务（aitm_task_follow_up）→ ask', followAsk?.kind === 'ask', followAsk?.displayReason?.zh ?? '');
  const followNoArg = await gate({ name: 'aitm_task_follow_up', arguments: { taskId: 't_1' }, signal: { aborted: false } }, allow);
  check('继续任务缺 instruction → deny（原话里点名哪个工具）', followNoArg?.kind === 'deny' && /aitm_task_follow_up/.test(String(followNoArg?.reason ?? '')), String(followNoArg?.reason ?? ''));
  const backupAsk = await gate({ name: 'aitm_backup_now', arguments: { mode: 'full' }, signal: { aborted: false } }, allow);
  check('备份（aitm_backup_now）→ ask', backupAsk?.kind === 'ask', backupAsk?.displayReason?.zh ?? '');
  const noIdea = await gate({ name: 'aitm_task_start', arguments: { instruction: 'x' }, signal: { aborted: false } }, allow);
  check('开工缺 ideaId → deny', noIdea?.kind === 'deny');
  const badMode = await gate({ name: 'aitm_backup_now', arguments: { mode: '全部' }, signal: { aborted: false } }, allow);
  check('备份 mode 写错 → deny（并说清只能是 lean/full）', badMode?.kind === 'deny' && /lean/.test(String(badMode.reason)));

  /* 验收（aitm_task_accept）：合并是不可逆动作 —— 审批卡上必须写清「哪条想法、合到哪」，缺参直接 deny */
  const acceptAsk = await gate({ name: 'aitm_task_accept', arguments: { taskId: 't_nope' }, signal: { aborted: false } }, allow);
  check('验收（aitm_task_accept）→ ask', acceptAsk?.kind === 'ask', String(acceptAsk?.displayReason?.zh ?? '').slice(0, 80));
  check(
    '验收的审批卡写明「只记验收（不碰 git）」与「验证没过也要合」',
    /只记验收（不碰 git）/.test(String((await gate({ name: 'aitm_task_accept', arguments: { taskId: 't_x', merge: false }, signal: { aborted: false } }, allow))?.displayReason?.zh ?? '')) &&
      /验证没过也要合/.test(String((await gate({ name: 'aitm_task_accept', arguments: { taskId: 't_x', acknowledgeVerifyFailure: true }, signal: { aborted: false } }, allow))?.displayReason?.zh ?? '')),
  );
  const noTask = await gate({ name: 'aitm_task_accept', arguments: {}, signal: { aborted: false } }, allow);
  check('验收缺 taskId → deny', noTask?.kind === 'deny');
}

/* ---------------- ⑤ 旧后端护栏（不用起 DSH：假一个老版本的后端）---------------- */
async function checkStaleBackend() {
  console.log('⑤ 旧后端护栏（复用/连上时必须拒绝）');
  // 老后端（0.1.0-m1 那种）：health 通，但没有 apiRev、接口还叫 news.get
  const old = http.createServer((req, res) => {
    if (req.url === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, mode: 'web', actions: 51 }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: '未知接口' }));
  });
  await new Promise((resolve) => old.listen(0, '127.0.0.1', resolve));
  const port = old.address().port;

  const savedUrl = process.env.AITM_URL;
  const savedSpawn = process.env.AITM_SPAWN;
  process.env.AITM_URL = `http://127.0.0.1:${port}`;
  process.env.AITM_SPAWN = '0';
  let msg = '';
  try {
    // DEFAULTS 在模块加载时读环境变量 → 必须在这之前设好；用 query 绕开模块缓存
    const host = await import(`${pathToFileURL(path.join(ROOT, 'index.js')).href}?stale=${Date.now()}`);
    await host.ensureBase();
    msg = '(居然连上了，没有拒绝)';
  } catch (err) {
    msg = String(err?.message ?? err);
  } finally {
    if (savedUrl === undefined) delete process.env.AITM_URL;
    else process.env.AITM_URL = savedUrl;
    if (savedSpawn === undefined) delete process.env.AITM_SPAWN;
    else process.env.AITM_SPAWN = savedSpawn;
    old.close();
  }
  check('旧后端被拒 + 给人话（含版本/处理步骤）', /旧版/.test(msg) && /apiRev/.test(msg) && /git pull/.test(msg), msg.slice(0, 150));
}

/* ---------------- ⑥ 起前自检（仓库路径不对 = 「不能拉起后端」最常见的原因） ---------------- */
/**
 * ⑩ 后端来法：默认**进程内 L3**、两条逃生通道（AITM_URL / AITM_L3=0）。
 * 纯离线断言（只 import 插件模块看 diagnose()，不起 DSH、不起后端）。
 * DEFAULTS 在模块加载时读 env ⇒ 每个 case 换 query 参数绕模块缓存，跑完还原 env。
 */
async function checkBackendModes() {
  console.log('⑩ 后端来法（进程内 L3 / 逃生通道）');
  const saved = { url: process.env.AITM_URL, l3: process.env.AITM_L3 };
  const load = async (tag) => {
    const mod = await import(`${pathToFileURL(path.join(ROOT, 'index.js')).href}?mode=${tag}-${String(Date.now())}`);
    return mod.diagnose();
  };
  try {
    delete process.env.AITM_URL;
    delete process.env.AITM_L3;
    const byDefault = await load('default');
    check('默认：进程内 L3（不 spawn 常驻后端）', byDefault.backendMode === 'l3' && String(byDefault.l3Bundle).endsWith('l3.mjs'), `backendMode=${byDefault.backendMode}`);

    process.env.AITM_L3 = '0';
    const legacy = await load('legacy');
    check('逃生通道：AITM_L3=0 → 退回旧的 spawn 桥', legacy.backendMode === 'spawn');

    delete process.env.AITM_L3;
    process.env.AITM_URL = 'http://127.0.0.1:9';
    const external = await load('external');
    check('逃生通道：AITM_URL → 连外部实例（保留旧后端护栏）', external.backendMode === 'external');
  } finally {
    if (saved.url === undefined) delete process.env.AITM_URL;
    else process.env.AITM_URL = saved.url;
    if (saved.l3 === undefined) delete process.env.AITM_L3;
    else process.env.AITM_L3 = saved.l3;
  }
}

/** ⑪ 不留常驻后端进程：进程表里不该再有 scripts/dev-web.mjs（L3 之后这条是「结构上不可能」的回归哨） */
function checkNoResidentBackend() {
  console.log('⑪ 不留常驻后端进程');
  if (process.platform === 'win32') {
    check('Windows 上跳过进程表检查（真机手工看任务管理器）', true, 'skip');
    return;
  }
  const r = spawnSync('ps', ['-A', '-o', 'command'], { encoding: 'utf8' });
  const lines = (r.stdout ?? '').split('\n').filter((l) => /scripts\/dev-web\.mjs/.test(l));
  check(
    '进程表里没有遗留的 dev-web.mjs 常驻后端',
    lines.length === 0,
    lines.length ? `${lines.slice(0, 2).join(' | ')}（若是你自己开的 npm run dev:web，先收掉再跑本项）` : '',
  );
}

/**
 * ⑫ L4 工具（12 个）：拿真 L3 数据把每个工具的 execute() 跑一遍。
 *
 * 为什么能不起 DSH 也测：插件默认走**进程内 L3**，所以在 Node 里 import 插件 + 调
 * ensureBase() 就能拿到真内核；工具本体是纯函数式的（`execute(args)` → 值）。
 * 校验用 DSH 自己的 `valueSchemaSpecToJsonSchema` + `validateJsonSchemaValue`（与宿主同一套），
 * 这能抓住「schema 声明与返回值不一致」这类只有真跑才暴露的问题（实测抓到过两次）。
 */
async function checkTools() {
  console.log('⑫ L4 工具（真数据 + 宿主同款输出校验）');
  const savedHome = process.env.AI_TASKS_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aitm-tools-'));
  process.env.AI_TASKS_HOME = home;
  process.env.AITM_REPO = REPO;
  let host = null;
  try {
    const tools = new Map();
    const effect = (f) => { const d = f(); return typeof d === 'function' ? d : () => {}; };
    /* 假 subprocess 服务：形状照 `@deepseek-ai/dsh-subprocess` 的 SubprocessRuntime（handle.done / stdout / terminate）。
       它的存在有两个用途：① 离线把插件那层适配器（makeSubprocessSpawner）过一遍；
       ② 让 ⑫ 后面那条**真任务**的 CLI 进程从这条假缝里出去（证明插件确实把 ctx.subprocess 递给了内核）。 */
    const fakeSubprocess = {
      calls: [],
      terminates: 0,
      script: { lines: [], code: 0 },
      spawn(spec) {
        fakeSubprocess.calls.push(spec);
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const stdin = new PassThrough();
        const written = { text: '' };
        stdin.on('data', (d) => { written.text += d.toString('utf8'); });
        const done = new Promise((resolve) => {
          setTimeout(() => {
            for (const line of fakeSubprocess.script.lines) stdout.write(`${line}\n`);
            stderr.end();
            stdout.end(() => setTimeout(() => resolve({ exitCode: fakeSubprocess.script.code, signal: null }), 5));
          }, 10);
        });
        return {
          stdin,
          stdout,
          stderr,
          control: undefined,
          collected: {},
          get pid() { return undefined; }, // 宿主不保证给 pid（内核的 killTree 会因此走 child.kill()）
          done,
          terminate() { fakeSubprocess.terminates += 1; },
          waitForExit: async () => true,
          written,
        };
      },
    };
    const fakeCtx = {
      tools: { register: (t) => { tools.set(t.name, t); } },
      effect,
      on: () => () => {},
      inject: () => {},
      logger: { info: () => {} },
      subprocess: fakeSubprocess, // ← 子进程接缝：插件应该把它递给内核
    };
    host = await import(`${pathToFileURL(path.join(ROOT, 'index.js')).href}?tools=${String(Date.now())}`);
    host.apply(fakeCtx);

    const names = [...tools.keys()].sort();
    check('13 个工具全部注册', names.length === 13, names.join(', '));

    // 注意：`defineTool` 在注册时已经把 spec 转成 JSON Schema 存在 `tool.output.schema` 上，
    // 这里必须**直接用**它 —— 再调一次 valueSchemaSpecToJsonSchema 会报
    // 「schema.required is not supported by the value schema DSL」（实测踩到）。
    const { validateJsonSchemaValue } = require('@deepseek-ai/dsh-tools');
    const lossless = (v) => JSON.stringify(JSON.parse(JSON.stringify(v ?? null))) === JSON.stringify(v ?? null);

    // 先在干净数据目录里造两条想法（用真 action，不碰磁盘上的开发数据）
    await host.ensureBase();
    const today = new Date();
    const dayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const a = await tools.get('aitm_idea_create').execute({ title: 'L4 工具验收：把日历导出成 ICS', tags: ['测试'] });
    await tools.get('aitm_idea_create').execute({ title: 'L4 工具验收：给任务卡片加用时', tags: ['测试'] });

    const cases = [
      ['aitm_health', {}, (v) => v.ok === true && v.actions === EXPECTED_ACTIONS && v.apiRev === 2],
      ['aitm_idea_list', { q: 'L4 工具验收' }, (v) => v.total === 2],
      ['aitm_idea_get', { id: a.id }, (v) => v.title === 'L4 工具验收：把日历导出成 ICS' && Array.isArray(v.tasks)],
      ['aitm_calendar_day', { day: dayKey }, (v) => v.ideas.length === 2 && v.monthIdeas >= 2],
      ['aitm_calendar_day', { day: '2020-01-01' }, (v) => v.ideas.length === 0],
      ['aitm_task_status', {}, (v) => Array.isArray(v.items)],
      ['aitm_repo_status', {}, (v) => Array.isArray(v.repos)],
      // 验收：没有这条任务 → 干净的错误（不是抛栈），且要带 taskId 好让模型自己纠
      ['aitm_task_accept', { taskId: 't_not_exist' }, (v) => v.ok === false && typeof v.error === 'string' && v.error.length > 0],
      // 写工具本体也能单独跑（审批闸是**另一层**，⑦ 单独验）：这里只证明它写得出东西
      ['aitm_backup_now', { mode: 'lean', label: 'L4 验证' }, (v) => v.ok === true && v.files >= 1 && v.mode === 'lean'],
      // 负例：不存在的想法要**优雅报错**（不抛到宿主）
      ['aitm_idea_get', { id: 'i_不存在' }, (v) => v.ok === false && /不存在/.test(String(v.error))],
      ['aitm_task_start', { ideaId: 'i_不存在', instruction: 'x' }, (v) => v.ok === false && /不存在/.test(String(v.error))],
    ];
    let allOk = true;
    const detail = [];
    for (const [name, args, expect] of cases) {
      const tool = tools.get(name);
      let bad = null;
      try {
        const value = await tool.execute(args);
        // ① 宿主同款 schema 校验（与 createSuccessResult 里那步一致）
        const violations = validateJsonSchemaValue(tool.output.schema, JSON.parse(JSON.stringify(value)), 'value');
        if (violations.length) bad = `schema: ${violations.slice(0, 2).join('; ')}`;
        // ② presentationMeta 必须是无损 JSON（undefined/函数会炸）
        else if (tool.output.presentationMeta) {
          const meta = tool.output.presentationMeta(args, value);
          if (!lossless(meta)) bad = 'presentationMeta 不是无损 JSON';
          else if (!meta || typeof meta.kind !== 'string') bad = 'presentationMeta 缺 kind（客户端卡片按它分发）';
        }
        // ③ 业务断言
        if (!bad && !expect(value)) bad = `结果不符预期：${JSON.stringify(value).slice(0, 120)}`;
      } catch (err) {
        bad = `抛异常：${String(err?.message ?? err)}`;
      }
      if (bad) {
        allOk = false;
        detail.push(`${name}: ${bad}`);
      }
    }
    check('每个工具：输出过宿主 schema、meta 无损、业务结果对', allOk, detail.slice(0, 3).join(' | '));

    // 备份确实落了盘（不是只回了个对象）
    const backups = fs.existsSync(path.join(home, 'backups')) || fs.existsSync(path.join(home, 'data'));
    check('aitm_backup_now 的产物在数据目录里', backups, home);

    /* ---- 原生日历的取数通道：把 client.js 里的 postAction 拿到**真 L3** 上跑一遍 ----
       日历在 DSH 的浏览器环境里是**跨源**（DSH 页面 127.0.0.1:3081 → 插件的回环端口），
       走的是 POST + JSON ⇒ 浏览器会先发 OPTIONS 预检。这条断言把「预检有没有、CORS 头、
       信封形状」一次钉住（离线渲染测不到网络这半段）。 */
    let clientLoaded = null;
    globalThis.window = { __ModuleLoader__: { load({ id, factory }) { clientLoaded = { id, exports: factory(require) }; } } };
    await import(`${pathToFileURL(path.join(ROOT, 'client.js')).href}?calendar=${String(Date.now())}`);
    const post = clientLoaded?.exports?.__calendarHelpers?.postAction;
    check('原生日历的取数通道（client.js 的 postAction）在', typeof post === 'function');
    if (typeof post === 'function') {
      const base = await host.ensureBase();
      const list = await post(base, 'idea.list', { q: 'L4 工具验收' });
      const feed = await post(base, 'feed.get', { refresh: false });
      const ideas = Array.isArray(list) ? list : list?.ideas;
      check(
        '日历取数：idea.list 拿到两条 + feed.get 拿到快照',
        (ideas?.length ?? -1) === 2 && Boolean(feed) && typeof feed === 'object',
        `ideas=${String(ideas?.length)} feed=${Object.keys(feed ?? {}).join(',') || '(空)'}`,
      );
      let threw = null;
      try {
        await post(base, 'no.such.action', {});
      } catch (err) {
        threw = err;
      }
      check(
        '日历取数：后端报错时**抛出来**（面板写红字，不是一直转圈）',
        Boolean(threw) && !/undefined/.test(String(threw?.message ?? threw)),
        String(threw?.message ?? threw).slice(0, 60),
      );
      // 浏览器跨源 POST（JSON）会先发 OPTIONS 预检：没有 CORS 头，真机上就只会转圈
      const pre = await new Promise((resolve) => {
        const req = http.request(`${base}/api/idea.list`, { method: 'OPTIONS' }, (res) => {
          resolve({ code: res.statusCode ?? 0, headers: res.headers });
          res.resume();
        });
        req.on('error', (err) => resolve({ code: 0, headers: {}, error: String(err?.message ?? err) }));
        req.end();
      });
      check(
        '原生日历的跨源预检（OPTIONS）带 CORS 头',
        pre.code === 204 && pre.headers['access-control-allow-origin'] === '*' && String(pre.headers['access-control-allow-headers'] ?? '').includes('content-type'),
        `HTTP ${String(pre.code)} · allow-headers=${String(pre.headers['access-control-allow-headers'] ?? '(无)')}`,
      );
    }

    /* ---- 看板的数据面：走**面板同款通道**（插件自己的 /api + postAction）----
       看板不经过工具层，是浏览器直接打 `/api/<action>`；所以这里也照那条路验一遍，
       顺带证明这几个 action 在插件自己的端口上都存在（旧后端会在这里 404「未知接口」）。 */
    const boardBase = await host.ensureBase();
    const boardCalls = ['idea.list', 'overview.get', 'repo.list', 'task.list'];
    let boardMissing = null;
    for (const action of boardCalls) {
      try {
        await post(boardBase, action, action === 'idea.list' ? {} : {});
      } catch (err) {
        boardMissing = `${action}: ${String(err?.message ?? err)}`;
        break;
      }
    }
    check('看板的取数通道都在（idea.list / overview.get / repo.list / task.list）', !boardMissing, boardMissing ?? '');

    const readyOne = await tools.get('aitm_idea_create').execute({ title: '看板验收：准备开工的一条', tags: ['看板'] });
    await post(boardBase, 'idea.setStatus', { id: readyOne.id, status: 'ready' });
    // ① 服务端按状态查（不是前端过滤）
    const onlyReady = await post(boardBase, 'idea.list', { status: 'ready' });
    check('看板筛选：idea.list{status} 只回那一档', Array.isArray(onlyReady) && onlyReady.length === 1 && onlyReady[0].id === readyOne.id, `返回 ${String(onlyReady?.length)} 条`);
    // ② 关键词查
    const byQ = await post(boardBase, 'idea.list', { q: '看板验收' });
    check('看板筛选：idea.list{q} 按关键词查', Array.isArray(byQ) && byQ.length === 1 && /看板验收/.test(byQ[0].title), `返回 ${String(byQ?.length)} 条`);
    // ③ 计数是全量（R7：筛选下生命周期计数不变）
    const ov = await post(boardBase, 'overview.get', {});
    check(
      '看板计数：overview 不受筛选影响（全量 3 条 = 2 灵感箱 + 1 可开发）',
      ov?.counts?.inbox === 2 && ov?.counts?.ready === 1 && ov?.totalIdeas === 3,
      JSON.stringify(ov?.counts),
    );
    // ④ 星标（卡片右上角那颗）
    const starred = await post(boardBase, 'idea.toggleStar', readyOne.id);
    check('看板星标：toggleStar 真的改了', starred?.starred === true, `starred=${String(starred?.starred)}`);
    // ⑤ 非法流转要带原因（看板把它原样显示给用户）
    let illegal = null;
    try {
      await post(boardBase, 'idea.setStatus', { id: readyOne.id, status: 'inbox' });
    } catch (err) {
      illegal = String(err?.message ?? err);
    }
    check('看板拖拽：非法流转被内核拒绝并给出原因', Boolean(illegal) && /流转|状态/.test(illegal), String(illegal).slice(0, 80));

    /* ---- 合集的数据面：同样走面板同款通道（feed.* / settings.get / idea.create）----
       合集页在浏览器里直接打 `/api/<action>`，所以这里也照那条路验一遍：
       既证明这些 action 在插件自己的端口上都存在（旧后端会 404「未知接口」），
       也证明负例（收藏/隐藏一个不在榜上的条目）给的是人话而不是 500。 */
    const feedCalls = ['feed.get', 'settings.get'];
    let feedMissing = null;
    for (const action of feedCalls) {
      try {
        await post(boardBase, action, {});
      } catch (err) {
        feedMissing = `${action}: ${String(err?.message ?? err)}`;
        break;
      }
    }
    check('合集的取数通道都在（feed.get / settings.get）', !feedMissing, feedMissing ?? '');
    const snap0 = await post(boardBase, 'feed.get', { refresh: false });
    check(
      '合集快照形状：两源 + 收藏 + 已隐藏 + sources 状态 + updatedAt',
      Boolean(snap0 && snap0.github && snap0.bilibili && Array.isArray(snap0.favorites) && Array.isArray(snap0.hidden) && snap0.sources && typeof snap0.updatedAt === 'number'),
      `updatedAt=${String(snap0?.updatedAt)} favorites=${String(snap0?.favorites?.length)}`,
    );
    const st0 = await post(boardBase, 'settings.get', {});
    check(
      '合集徽标读的设置项都在（feed.enabled / biliZones / upMids）',
      Boolean(st0?.feed) && typeof st0.feed.enabled === 'boolean' && Array.isArray(st0.feed.biliZones) && Array.isArray(st0.feed.upMids),
      `enabled=${String(st0?.feed?.enabled)} zones=${String(st0?.feed?.biliZones?.length)} ups=${String(st0?.feed?.upMids?.length)}`,
    );
    let starErr = null;
    try {
      await post(boardBase, 'feed.star', { key: 'not-a-real-key' });
    } catch (err) {
      starErr = String(err?.message ?? err);
    }
    check('合集收藏：不在榜上的条目给的是人话（不是 HTTP 500）', Boolean(starErr) && !/HTTP 500/.test(starErr) && /热榜/.test(starErr), String(starErr).slice(0, 60));
    let hideErr = null;
    try {
      await post(boardBase, 'feed.hide', { key: 'not-a-real-key' });
    } catch (err) {
      hideErr = String(err?.message ?? err);
    }
    check('合集隐藏：同上（隐藏前界面还要弹一次确认）', Boolean(hideErr) && !/HTTP 500/.test(hideErr), String(hideErr).slice(0, 60));
    // 「改一改再记」走的是 idea.create —— 面板那颗铅笔按钮的通道
    const draftIdea = await post(boardBase, 'idea.create', { title: '合集预填验收：改一改再记', tags: ['资讯', 'GitHub'] });
    check(
      '合集预填：idea.create 走得通（标题 + 标签都落库）',
      Boolean(draftIdea?.id) && draftIdea.title === '合集预填验收：改一改再记' && JSON.stringify(draftIdea.tags) === JSON.stringify(['资讯', 'GitHub']),
      String(draftIdea?.id),
    );

    /* ---- 子进程接缝：插件把 ctx.subprocess 适配成内核要的那几面（src/core/exec.ts 的 SpawnSeam）----
       两半都验：① 适配层本身（offline，用假 subprocess 服务）② 真开一个任务，看 CLI 进程是不是从
       **这条假缝**出去的 —— 后者才是「runner 子进程改走 ctx.subprocess」这句话的证据。 */
    const HH = host.__hostHelpers;
    check('宿主半边导出自检钩子（__hostHelpers）', Boolean(HH?.makeSubprocessSpawner && HH?.pickHostSpawn));

    const noSvc = HH.pickHostSpawn({});
    check('没有 ctx.subprocess 时退回内核自带 spawn（说得出为什么）', noSvc.spawn === null && /没提供/.test(String(noSvc.why)), String(noSvc.why));
    const offSvc = HH.pickHostSpawn({ subprocess: fakeSubprocess });
    check('有 ctx.subprocess 时选宿主那条缝', typeof offSvc.spawn === 'function' && offSvc.why === null);
    process.env.AITM_SUBPROCESS = '0';
    const offSwitch = HH.pickHostSpawn({ subprocess: fakeSubprocess });
    check('逃生开关 AITM_SUBPROCESS=0 → 仍走内核自带 spawn', offSwitch.spawn === null && /AITM_SUBPROCESS/.test(String(offSwitch.why)), String(offSwitch.why));
    delete process.env.AITM_SUBPROCESS;

    /* 适配层离线过一遍：spec 形状 / env 剥离 DSH_* / error·close / 晚注册补发 / kill→terminate */
    fakeSubprocess.calls.length = 0;
    fakeSubprocess.script = { lines: ['{"type":"system","subtype":"init","session_id":"s-seam"}', '{"type":"result","subtype":"success","result":"接缝里跑起来了","session_id":"s-seam"}'], code: 0 };
    const seamSpawn = HH.makeSubprocessSpawner(fakeSubprocess);
    const seamChild = seamSpawn({
      file: '/usr/bin/node',
      args: ['/tmp/fake-agent.mjs', '--x'],
      cwd: '/tmp',
      env: { PATH: '/usr/bin', DSH_PERMISSION_MODE: 'workspace-write', DSH_SECRET: 'x', KEEP: 'y' },
      windowsVerbatimArguments: false,
    });
    const spec0 = fakeSubprocess.calls[0] ?? {};
    check(
      '接缝适配：argv / cwd / stdio 全给全（DSH 的接缝不打默认值）',
      JSON.stringify(spec0.argv) === JSON.stringify(['/usr/bin/node', '/tmp/fake-agent.mjs', '--x']) &&
        spec0.cwd === '/tmp' &&
        spec0.stdio?.stdin === 'pipe' && spec0.stdio?.stdout === 'pipe' && spec0.stdio?.stderr === 'pipe' &&
        typeof spec0.graceMs === 'number' && spec0.graceMs > 0,
      `argv=${JSON.stringify(spec0.argv)} graceMs=${String(spec0.graceMs)}`,
    );
    check(
      '接缝适配：env 原样传，但剥掉宿主的 DSH_*（harness 身份不隐式下发给子进程）',
      spec0.env?.PATH === '/usr/bin' && spec0.env?.KEEP === 'y' && spec0.env?.DSH_PERMISSION_MODE === undefined && spec0.env?.DSH_SECRET === undefined,
      JSON.stringify(spec0.env),
    );
    check(
      '接缝适配：内核要的那几面都在（stdout/stderr/stdin 是流、on/kill 是函数）',
      typeof seamChild.stdout?.on === 'function' && typeof seamChild.stderr?.on === 'function' && typeof seamChild.stdin?.write === 'function' && typeof seamChild.on === 'function' && typeof seamChild.kill === 'function',
    );
    let seamExit = null;
    seamChild.on('close', (code) => { seamExit = code; });
    await new Promise((r) => setTimeout(r, 80));
    check('接缝适配：handle.done 结算 → 内核收到 close(exitCode)', seamExit === 0, `close=${String(seamExit)}`);
    let lateExit = 'x';
    seamChild.on('close', (code) => { lateExit = code; }); // 晚注册的也要补发（真实 'close' 语义）
    check('接缝适配：事件已经发生后再 on 也要补发（内核可能在 done 之后才挂监听）', lateExit === 0, `late=${String(lateExit)}`);
    seamChild.kill();
    check('接缝适配：kill() → handle.terminate()（端掉宿主托管的整棵进程范围）', fakeSubprocess.terminates === 1, `terminate=${String(fakeSubprocess.terminates)}`);
    const errSeam = HH.makeSubprocessSpawner({ spawn: () => ({ stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), collected: {}, control: undefined, done: Promise.reject(new Error('起不来：ENOENT')), terminate: () => {}, waitForExit: async () => true }) });
    const errChild = errSeam({ file: 'x', args: [], cwd: '/tmp', env: {} });
    const errSeen = await new Promise((resolve) => { errChild.on('error', (e) => resolve(String(e?.message ?? e))); setTimeout(() => resolve(null), 100); });
    check('接缝适配：handle.done 拒绝 → 内核收到 error（不是永远挂着）', /ENOENT/.test(String(errSeen)), String(errSeen));

    /* 真任务：把 CLI 引擎指到一个夹具上，任务跑完 → 它的进程必须从上面那条假缝出去 */
    const seamRepo = path.join(home, 'seam-repo');
    fs.mkdirSync(seamRepo, { recursive: true });
    const git = (...args) => spawnSync('git', args, { cwd: seamRepo, stdio: 'pipe' });
    git('init', '-b', 'main');
    git('config', 'user.email', 'verify@example.com');
    git('config', 'user.name', 'Verify');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'core.autocrlf', 'false');
    fs.writeFileSync(path.join(seamRepo, 'index.ts'), 'export const answer = 41;\n');
    git('add', '.');
    git('commit', '-m', 'chore: init');
    const seamBin = path.join(home, 'claude');
    fs.copyFileSync(path.join(REPO, 'tests', 'fixtures', 'fake-agent.mjs'), seamBin);
    fs.chmodSync(seamBin, 0o755);
    fakeSubprocess.calls.length = 0;
    fakeSubprocess.script = {
      lines: [
        '{"type":"system","subtype":"init","session_id":"s-plugin"}',
        '{"type":"assistant","message":{"content":[{"type":"text","text":"从宿主接缝里跑起来了"}]}}',
        '{"type":"result","subtype":"success","result":"从宿主接缝里跑起来了","session_id":"s-plugin"}',
      ],
      code: 0,
    };
    await post(boardBase, 'settings.set', { activeAdapter: 'cli', concurrency: 1, autoCommit: true, cli: { command: seamBin } });
    const seamRepoRow = await post(boardBase, 'repo.upsert', { path: seamRepo, name: 'seam-demo' });
    const seamIdea = await post(boardBase, 'idea.create', { title: '子进程接缝验收：跑一轮', repoId: seamRepoRow.id });
    const seamTask = await post(boardBase, 'task.start', { ideaId: seamIdea.id, instruction: '把答案改成 42' });
    const seamDone = await (async () => {
      const until = Date.now() + 20_000;
      for (;;) {
        const got = await post(boardBase, 'task.get', seamTask.id); // 返回 {task, idea, repo}
        const t = got?.task;
        if (t && ['succeeded', 'failed', 'cancelled'].includes(t.status)) return t;
        if (Date.now() > until) return t;
        await new Promise((r) => setTimeout(r, 120));
      }
    })();
    check('真任务：CLI 引擎跑完（任务状态 succeeded）', seamDone?.status === 'succeeded', `status=${String(seamDone?.status)}`);
    check(
      '真任务：它的进程确实从 ctx.subprocess 出去（宿主托管，不是内核自己 spawn）',
      fakeSubprocess.calls.length === 1 && String(fakeSubprocess.calls[0]?.cwd ?? '') !== '' && JSON.stringify(fakeSubprocess.calls[0]?.stdio) === JSON.stringify({ stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }),
      `spawn 次数=${String(fakeSubprocess.calls.length)} cwd=${String(fakeSubprocess.calls[0]?.cwd ?? '')}`,
    );
    check(
      '真任务：argv 是「引擎 + 流式旗标」，cwd 是 worktree（不是主仓库）',
      Array.isArray(fakeSubprocess.calls[0]?.argv) && fakeSubprocess.calls[0].argv.join(' ').includes('stream-json') && !String(fakeSubprocess.calls[0]?.cwd ?? '').startsWith(seamRepo + path.sep) && fs.existsSync(String(fakeSubprocess.calls[0]?.cwd ?? '')),
      `argv=${JSON.stringify(fakeSubprocess.calls[0]?.argv ?? [])}`,
    );

  } finally {
    await host?.stop?.().catch?.(() => undefined);
    if (savedHome === undefined) delete process.env.AI_TASKS_HOME;
    else process.env.AI_TASKS_HOME = savedHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

async function checkRepoPreflight() {
  console.log('⑥ 起前自检（仓库路径 / 依赖）');
  const bogus = path.join(os.tmpdir(), `aitm-not-a-repo-${String(Date.now())}`);
  fs.mkdirSync(bogus, { recursive: true });
  const savedRepo = process.env.AITM_REPO;
  const savedSpawn = process.env.AITM_SPAWN;
  process.env.AITM_REPO = bogus; // 存在，但不是我们的仓库（没有 package.json）
  process.env.AITM_SPAWN = '1';
  let msg = '';
  let d = null;
  try {
    const host = await import(`${pathToFileURL(path.join(ROOT, 'index.js')).href}?preflight=${String(Date.now())}`);
    d = host.diagnose();
    await host.ensureBase();
    msg = '(居然起来了，没有拦住)';
  } catch (err) {
    msg = String(err?.message ?? err);
  } finally {
    if (savedRepo === undefined) delete process.env.AITM_REPO;
    else process.env.AITM_REPO = savedRepo;
    if (savedSpawn === undefined) delete process.env.AITM_SPAWN;
    else process.env.AITM_SPAWN = savedSpawn;
    fs.rmSync(bogus, { recursive: true, force: true });
  }
  check('不是仓库的路径会被当场拦下', Boolean(d?.repoProblem) && msg !== '' && !/居然/.test(msg), (d?.repoProblem ?? msg).slice(0, 120));
  check('拦截理由带「怎么办」', /AITM_REPO/.test(msg) && /npm install|git pull|patch/.test(msg), msg.slice(0, 150));
}

/* ---------------- ②③④ 需要真的 DSH ---------------- */
async function checkDsh() {
  if (!fs.existsSync(DSH_ENTRY)) {
    check('DSH 已安装（node_modules/@deepseek-ai/dsh）', false, '先 npm install');
    return;
  }
  // patch 里的 name 必须是本机绝对路径（换机器/Windows 要改）
  fs.writeFileSync(
    PATCH,
    ['# 由 verify-dsh.mjs 生成；手工用也可以改这里的路径', '- insert:', `    - id: aitm-plugin`, `      name: ${JSON.stringify(path.join(ROOT, 'index.js'))}`, ''].join('\n'),
  );

  const port = await freePort();
  const web = start(process.execPath, dshArgs(['--profile', 'web', '--patch', PATCH, '--no-open', '--port', String(port)]), {
    env: { ...process.env, DSH_HOME, AITM_REPO: REPO },
  });
  const url = await waitFor(() => /http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/.exec(web.out)?.[0], 60_000, 'dsh web 起不来');
  check('② 插件激活（无 "did not activate"）', !/did not activate/.test(web.out), (web.out.match(/warning:.*/) ?? [''])[0].slice(0, 120));

  const token = new URL(url).searchParams.get('token');
  const res1 = await fetch(`http://127.0.0.1:${port}/?token=${token}`, { redirect: 'manual' });
  const cookie = (res1.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const res2 = await fetch(`http://127.0.0.1:${port}/`, { headers: { cookie } });
  const html = await res2.text();
  const boot = JSON.parse(/globalThis\["__DSH_BOOT__"\] = (\{.*?\})<\/script>/s.exec(html)?.[1] ?? '{}');
  const ours = (boot.entries ?? []).find((e) => e.id === 'dsh-plugin-aitm');
  check('③ 客户端半边进 boot 图', Boolean(ours), ours ? `${boot.entries.length} 条，rev=${ours.rev}` : '');
  // 面板指纹：DSH 认的 rev 必须与我们在 doctor 里打印的那个一致（对不上，用户照 doctor 去核对就等于白查）
  const fileRev = clientFileRev();
  check(
    '③\' boot 图里 client.js 的 rev 与 doctor 打印的指纹一致',
    ours?.rev === fileRev,
    `boot=${String(ours?.rev)} file=${fileRev}`,
  );

  if (ours) {
    const chunk = await fetch(`http://127.0.0.1:${port}/plugins/${ours.url.replace('plugins/', '')}`, { headers: { cookie } });
    const text = await chunk.text();
    check('③ 客户端分片送达', chunk.status === 200 && text.includes('aitm-panel'), `HTTP ${chunk.status} / ${text.length} 字节`);
  }

  /*
   * ③' 我们 inject 的每个服务都必须真的有人提供。
   * 这条是给 R9 白屏上保险：客户端插件 `inject` 里写了一个**永远不会到的服务名**，DSH 不会报错，
   * 只是把这一条 entry 永久留在 pending → `web boot: N entries did not activate` → 整页失败。
   * 静态追踪法（不跑浏览器，沙箱里也没有 Chrome）：从**真实 boot 列表**里取包名，
   * 在它们的 client 分片里找服务提供点 —— `provide("x")` 或 `super(ctx, "x")`（slots 就是后者）。
   */
  const injectNames = clientInject;
  const entryIds = new Set((boot.entries ?? []).map((e) => e.id));
  const providerOf = (name) => {
    const patterns = [`provide("${name}"`, `super(ctx, "${name}")`, `super(ctx,"${name}")`];
    for (const dir of [path.join(ROOT, 'node_modules', '@deepseek-ai'), path.join(REPO, 'node_modules', '@deepseek-ai')]) {
      if (!fs.existsSync(dir)) continue;
      for (const pkg of fs.readdirSync(dir)) {
        const id = `@deepseek-ai/${pkg}`;
        if (!entryIds.has(id)) continue;
        const file = path.join(dir, pkg, 'lib', 'client.js');
        if (!fs.existsSync(file)) continue;
        const src = fs.readFileSync(file, 'utf8');
        if (patterns.some((p) => src.includes(p))) return id;
      }
    }
    return null;
  };
  const providers = injectNames.map((n) => `${n}←${providerOf(n) ?? '（没人提供！）'}`);
  check(
    "③' 客户端 inject 的服务都有提供者（防 R9 式 pending 白屏）",
    injectNames.length > 0 && providers.every((p) => !p.includes('没人提供')),
    providers.join(' / '),
  );

  // ④ 端到端：假模型 → aitm_health → 真后端
  const stubPort = await freePort();
  const stubLog = path.join(DSH_HOME, 'stub.jsonl');
  start(process.execPath, [path.join(ROOT, 'test', 'stub-llm.mjs')], {
    env: { ...process.env, STUB_PORT: String(stubPort), STUB_LOG: stubLog, STUB_TOOL: 'aitm_health', STUB_ARGS: '{}' },
  });
  await waitFor(
    () =>
      new Promise((resolve) => {
        const sock = net.connect(stubPort, '127.0.0.1');
        sock.on('connect', () => { sock.destroy(); resolve(true); });
        sock.on('error', () => { sock.destroy(); resolve(false); });
      }),
    10_000,
    '假模型没起来',
  );

  const patchStub = path.join(DSH_HOME, 'stub.patch.yml');
  fs.writeFileSync(
    patchStub,
    [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      stub:',
      '        apiKeyEnv: STUB_API_KEY',
      '        displayName: Stub',
      '        api: openai-completions',
      `        baseURL: http://127.0.0.1:${stubPort}/v1`,
      '        models:',
      '          - id: stub-model',
      '            name: Stub',
      '            contextWindow: 32000',
      '            maxTokens: 2048',
      '            input: [text]',
      '            reasoningEfforts: false',
      '- id: agent-default-model',
      '  config:',
      '    provider: stub',
      '    model: stub-model',
      '',
    ].join('\n'),
  );

  const headless = spawn(process.execPath, dshArgs(['--profile', 'headless', '--patch', patchStub, '--patch', PATCH, '--json', '健康检查']), {
    cwd: ROOT,
    env: { ...process.env, DSH_HOME, AITM_REPO: REPO, STUB_API_KEY: 'stub' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(headless);
  let out = '';
  headless.stdout.on('data', (b) => (out += String(b)));
  headless.stderr.on('data', (b) => (out += String(b)));
  const code = await new Promise((resolve) => headless.on('exit', resolve));

  const toolResult = /"type":"tool_result"[^\n]*/.exec(out)?.[0] ?? '';
  // 判据：① headless 正常退出（0）② 工具返回的是**真后端**的 health（action 数取自 core 源码）
  //       ③ 没有因为我们拉起的长驻子进程而卡住不退出
  const hasRealData = toolResult.includes(`${String(EXPECTED_ACTIONS)} 个 action`);
  check('④ 端到端：工具拿到真后端数据', code === 0 && hasRealData, `${toolResult.slice(0, 160)}（exit=${code}）`);

  // ④' 卡片的数据通道：工具侧 presentationMeta 必须**原样落到会话日志的 tool/result.meta**（卡片读它）
  const metaScan = readSessionEvents(DSH_HOME);
  const healthMeta = metaScan.records.find((r) => r.type === 'tool/result' && r.data?.meta?.kind === 'health')?.data?.meta ?? null;
  check(
    "④' presentationMeta 落进 tool/result.meta（卡片的数据来源）",
    metaScan.skipped || (Boolean(healthMeta) && healthMeta.actions === EXPECTED_ACTIONS && healthMeta.apiRev === 2),
    metaScan.skipped ? '当前 Node 没有内置 zstd 解压 → 本项跳过（⑨ 有同通道断言）' : JSON.stringify(healthMeta),
  );

  // ⑧⑨ 写操作：无审批通道必须**不落地**（fail-closed）；显式放行后必须**真写得进去**
  //     用独立 AI_TASKS_HOME + 临时挪走登记表 → 逼出一个只服务这次运行的后端，然后看磁盘。
  /** 跑一次「让假模型调 aitm_idea_create」的独立 headless 会话，返回它对磁盘做了什么 */
  const soloWriteRun = async ({ approve, title }) => {
    const soloHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aitm-solo-'));
    const regPath = path.join(os.tmpdir(), 'aitm-dsh-backend.json');
    const savedReg = fs.existsSync(regPath) ? fs.readFileSync(regPath, 'utf8') : null;
    if (savedReg !== null) fs.rmSync(regPath); // 别复用别的实例（那样数据目录就不是 soloHome）
    const stubPort = await freePort();
    start(process.execPath, [path.join(ROOT, 'test', 'stub-llm.mjs')], {
      env: {
        ...process.env,
        STUB_PORT: String(stubPort),
        STUB_LOG: path.join(DSH_HOME, `stub-${String(stubPort)}.jsonl`),
        STUB_TOOL: 'aitm_idea_create',
        STUB_ARGS: JSON.stringify({ title }),
      },
    });
    await waitFor(
      () =>
        new Promise((resolve) => {
          const sock = net.connect(stubPort, '127.0.0.1');
          sock.on('connect', () => { sock.destroy(); resolve(true); });
          sock.on('error', () => { sock.destroy(); resolve(false); });
        }),
      10_000,
      '假模型没起来',
    );
    const patchStub = path.join(DSH_HOME, `stub-${String(stubPort)}.patch.yml`);
    fs.writeFileSync(
      patchStub,
      [ // 与 ④ 的假模型 patch 同构，只换端口
        '- id: llm-pi-ai',
        '  config:',
        '    providers:',
        '      stub:',
        '        apiKeyEnv: STUB_API_KEY',
        '        displayName: Stub',
        '        api: openai-completions',
        `        baseURL: http://127.0.0.1:${String(stubPort)}/v1`,
        '        models:',
        '          - id: stub-model',
        '            name: Stub',
        '            contextWindow: 32000',
        '            maxTokens: 2048',
        '            input: [text]',
        '            reasoningEfforts: false',
        '- id: agent-default-model',
        '  config:',
        '    provider: stub',
        '    model: stub-model',
        '',
      ].join('\n'),
    );
    const child = spawn(process.execPath, dshArgs(['--profile', 'headless', '--patch', patchStub, '--patch', PATCH, '--json', '写一条想法']), {
      cwd: ROOT,
      env: { ...process.env, DSH_HOME, AITM_REPO: REPO, STUB_API_KEY: 'stub', AI_TASKS_HOME: soloHome, ...(approve ? { AITM_APPROVE: approve } : {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let out = '';
    child.stdout.on('data', (b) => (out += String(b)));
    child.stderr.on('data', (b) => (out += String(b)));
    const code = await new Promise((resolve) => child.on('exit', resolve));
    if (savedReg !== null) fs.writeFileSync(regPath, savedReg); // 还原，收尾还要按它清后端

    const found = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(abs);
        else if (entry.isFile() && fs.readFileSync(abs, 'utf8').includes(title)) found.push(abs);
      }
    };
    try {
      walk(soloHome);
    } catch {
      /* 目录没了也算没写 */
    }
    fs.rmSync(soloHome, { recursive: true, force: true });
    return { found, out, code };
  };

  const negative = await soloWriteRun({ approve: null, title: 'verify 不应该写进去的想法' });
  if (process.env.SHOW_HEADLESS === '1') console.log('[headless 原文]', negative.out.slice(-1500));
  const blocked = /requires approval|no approval channel|deny|拒绝/i.test(negative.out);
  check(
    '⑧ fail-closed：headless 无审批通道 → 写操作不落地',
    negative.found.length === 0 && blocked,
    `磁盘命中 ${String(negative.found.length)} 处；输出${blocked ? '说了「需要审批」' : '**没说**需要审批'}（exit=${String(negative.code)}）`,
  );

  const positive = await soloWriteRun({ approve: 'allow', title: 'verify 放行后应该写进去的想法' });
  check(
    '⑨ 显式放行（AITM_APPROVE=allow）→ 写操作真的落盘',
    positive.found.length > 0,
    `磁盘命中 ${String(positive.found.length)} 处（exit=${String(positive.code)}）`,
  );

  // ⑨' 写工具的 presentationMeta 同样要落进会话日志（客户端就是靠它画想法卡的，而不是解析文本）
  const ideaRecords = readSessionEvents(DSH_HOME).records.filter((r) => r.type === 'tool/result' && r.data?.meta?.kind === 'idea');
  const ideaMeta = ideaRecords.find((r) => /放行/.test(String(r.data.meta.title ?? '')))?.data.meta ?? null;
  check(
    "⑨' 写操作的 meta（想法卡数据）落进 tool/result.meta",
    Boolean(ideaMeta) && ideaMeta.action === 'create' && ideaMeta.status === 'inbox' && Boolean(ideaMeta.id),
    JSON.stringify(ideaMeta),
  );
  // ⑧' 反面：被审批拦下的那次调用绝不能带「成功」meta（客户端只会画失败卡）
  check(
    "⑧' 被审批拦下的写操作不产生成功 meta",
    !ideaRecords.some((r) => /不应该/.test(String(r.data.meta.title ?? ''))),
    `会话日志里 idea meta 共 ${String(ideaRecords.length)} 条`,
  );
}

/* ---------------- 收尾 ---------------- */
try {
  await checkRender();
  await checkStaleBackend();
  await checkRepoPreflight();
  await checkBackendModes();
  await checkTools();
  await checkWriteGate();
  await checkDsh();
  checkNoResidentBackend();
} catch (err) {
  check('验证过程未抛异常', false, String(err?.message ?? err));
} finally {
  killAll();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过${failed.length ? ` —— 失败：${failed.map((f) => f.name).join('、')}` : ''}`);
exitWith(failed.length ? 1 : 0);

}

try {
  await main();
} catch (err) {
  if (err instanceof ExitScript) process.exitCode = err.code;
  else throw err;
}

/*
 * 收尾：把输出刷干净，再带着退出码走。
 *
 * 为什么不直接 `process.exit(code)`：Windows 上写管道是异步的，进程一退还没写完的数据就丢了
 * （这个脚本的输出正是要贴回来定位的东西）。这里的空写回调 = 「前面排队的输出都已经落到管道里」。
 * 为什么不等它自然退出：有的脚本还挂着句柄（后端、子进程），自然退出会一直吊着不结束。
 */
const flushThenExit = (code) => {
  let left = 2;
  const done = () => {
    if (--left <= 0) process.exit(code);
  };
  const fallback = setTimeout(() => process.exit(code), 2_000);
  fallback.unref?.();
  for (const s of [process.stdout, process.stderr]) {
    try {
      s.write('', done);
    } catch {
      done();
    }
  }
};
flushThenExit(process.exitCode ?? 0);
