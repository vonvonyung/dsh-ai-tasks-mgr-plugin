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
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

const results = [];
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
      : { ok: true, json: async () => ({ ok: true, actions: 63 }) };

  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const html = regs.map((r) => renderToStaticMarkup(React.createElement(r.C, {}))).join('\n');
  check('组件能渲染成 HTML', html.includes('aitm-panel') && html.includes('aitm-settings-section'), `${html.length} 字节`);
  check('面板离线态给人话（后端没起来时不是白屏）', /正在拉起后端|后端没起来/.test(html));

  /* ---- 对话里的工具卡（tool.call.toolview）---- */
  const cardTools = loaded.exports.__cardTools ?? [];
  const cardRegs = regs.filter((r) => r.d.name === 'tool.call.toolview');
  check(
    '五个工具都注册了工具卡（keyed，key = 工具名）',
    cardTools.length === 5 && cardTools.every((t) => cardRegs.some((r) => r.d.key === t)),
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

  const healthHtml = render({ toolName: 'aitm_health', phase: 'result', block: resultBlock({ kind: 'health', ok: true, actions: 63, apiRev: 2, version: '0.1.0', dataDir: 'D:\\x\\.aitasks' }) });
  check('健康卡：正常 + action 数 + apiRev', healthHtml.includes('正常') && healthHtml.includes('63') && healthHtml.includes('apiRev=2'));

  const failureHtml = render({ phase: 'result', block: { ...resultBlock({ kind: 'idea', action: 'create', ok: false, error: '标题不能为空' }, '没写成：标题不能为空'), isError: false } });
  check('失败态：把原因原样给出', failureHtml.includes('标题不能为空'));

  const runningHtml = render({ phase: 'start', block: { phase: 'start', argsRaw: '{"title":"写一半"}' } });
  check('运行态：说清这次要干什么', runningHtml.includes('记一条想法') && runningHtml.includes('写一半'));

  const noMetaHtml = render({ phase: 'result', block: resultBlock(undefined, '已记进想法箱：X（idea-1，状态 inbox）') });
  check('兜底：没有 meta 时收原始文本，不是空白', noMetaHtml.includes('idea-1') && noMetaHtml.includes('原始返回'));

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
  check('两个写工具都注册了', names.includes('aitm_idea_create') && names.includes('aitm_idea_set_status'), names.join(', '));

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
  // 判据：① headless 正常退出（0）② 工具返回的是**真后端**的 health（63 个 action 是我们 core 的 action 数）
  //       ③ 没有因为我们拉起的长驻子进程而卡住不退出
  const hasRealData = /63 个 action/.test(toolResult);
  check('④ 端到端：工具拿到真后端数据', code === 0 && hasRealData, `${toolResult.slice(0, 160)}（exit=${code}）`);

  // ④' 卡片的数据通道：工具侧 presentationMeta 必须**原样落到会话日志的 tool/result.meta**（卡片读它）
  const metaScan = readSessionEvents(DSH_HOME);
  const healthMeta = metaScan.records.find((r) => r.type === 'tool/result' && r.data?.meta?.kind === 'health')?.data?.meta ?? null;
  check(
    "④' presentationMeta 落进 tool/result.meta（卡片的数据来源）",
    metaScan.skipped || (Boolean(healthMeta) && healthMeta.actions === 63 && healthMeta.apiRev === 2),
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
  await checkWriteGate();
  await checkDsh();
} catch (err) {
  check('验证过程未抛异常', false, String(err?.message ?? err));
} finally {
  killAll();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过${failed.length ? ` —— 失败：${failed.map((f) => f.name).join('、')}` : ''}`);
process.exit(failed.length ? 1 : 0);
