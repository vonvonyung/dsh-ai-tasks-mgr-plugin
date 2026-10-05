/**
 * 一条命令验完 M1 的五件事（都能在无浏览器的沙箱里跑）：
 *   ① 客户端半边离线渲染（假 window.__ModuleLoader__ + 假 ctx + react-dom/server）+ 挂点护栏（不占 rightbar）
 *   ② 插件激活 + 客户端半边进 __DSH_BOOT__ 图
 *   ③ 客户端分片送达（/plugins/??…/client.js → 200 且内容里有我们的挂点）
 *   ④ 端到端：假模型 → 工具 aitm_health → **真后端**（插件自己拉起的 AI 任务台）返回真数据
 *
 * 用法：node scripts/verify-dsh.mjs        （退出码 0 = 全过）
 * 环境：AITM_REPO 指向 AI 任务台仓库（默认 /home/user/ai-tasks-mgr）
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
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
const check = (name, ok, extra = '') => {
  results.push({ name, ok, extra });
  console.log(`   ${ok ? '✓' : '✗'} ${name}${extra ? ` — ${extra}` : ''}`);
  return ok;
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
  const ctx = {
    slots: { inject: (n, cb) => { cb(); return () => {}; }, register: (d, C) => { regs.push({ d, C }); return () => {}; } },
    sidebarRightTabs: { register: (d) => { tabTypes.push(d); return () => {}; } },
    sidebarRight: { openTab: () => {}, openTabs: { getSnapshot: () => [] } },
    effect: (f) => { const d = f(); return typeof d === 'function' ? d : () => {}; },
  };
  loaded.exports.apply(ctx);

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
  globalThis.fetch = realFetch;
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
}

/* ---------------- 收尾 ---------------- */
try {
  await checkRender();
  await checkDsh();
} catch (err) {
  check('验证过程未抛异常', false, String(err?.message ?? err));
} finally {
  killAll();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过${failed.length ? ` —— 失败：${failed.map((f) => f.name).join('、')}` : ''}`);
process.exit(failed.length ? 1 : 0);
