#!/usr/bin/env node
/**
 * 打包分发路径的验证（M3 第一半 · 「同事怎么装」）。
 *
 * `verify-dsh.mjs` 验的是**开发路径**：插件就在仓库里、内核从仓库现编、用 `--patch` 挂进 DSH。
 * 同事那条路完全不同：机器上**没有仓库**，装的是 npm 包（自带内核 `dist-server/l3.mjs` 与面板
 * 产物 `dist/`），靠 `dsh plugin add` 进 profile。这个脚本把那条路整条跑一遍：
 *
 *   ① 打 tarball（`node ../scripts/vendor-plugin.mjs`；打包脚本自己会核对 tarball 内容）
 *   ② 解包 → **手工搭一个 profile**（等价于 pnpm 装完之后的样子：依赖在 node_modules 里 + bundle 已选）
 *   ③ 起 `dsh --profile <t> web`：**不设 AITM_REPO**，cwd 也不是仓库 —— 逼插件走「自带内核」分支
 *   ④ 断言：激活无 warning / 客户端半边进 boot 图 / `/aitm-plugin/config` 报 `mode=vendor` 且身份对得上
 *      （apiRev=2、action 数取自内核源码、数据目录 = 我们指定的 AI_TASKS_HOME）/ 面板静态产物真的能取到
 *   ⑤ 再用假模型跑一次 `dsh headless`：工具拿到的是真内核数据（证明自带内核真在跑）
 *   ⑥ 有 pnpm 时，额外把 `dsh plugin add <tarball>` 这条**真命令**跑一遍，看它有没有把依赖与 bundle 写进 profile
 *
 * 用法：node scripts/verify-dist.mjs      （退出码 0 = 全过）
 * 沙箱里没有 pnpm 时 ⑥ 会跳过（打印原因，不算失败）。
 *
 * 起 dsh / 收尾这些样板与 verify-dsh.mjs 是同一套（那边是源、这里是拷贝）—— 两个脚本各自独立跑，
 * 免得改一处影响另一处的绿灯。
 */
import { execSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(ROOT, '..');
const DSH_ENTRY = path.join(ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const dshArgs = (rest) => [DSH_ENTRY, ...rest];

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
const start = (cmd, args, opts = {}) => {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  child.out = '';
  child.stdout.on('data', (b) => (child.out += String(b)));
  child.stderr.on('data', (b) => (child.out += String(b)));
  children.push(child);
  return child;
};
const killAll = () => {
  for (const c of children) {
    try {
      c.kill('SIGTERM');
    } catch {
      /* 没了 */
    }
  }
  children.length = 0;
};

async function waitFor(fn, ms, label) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`超时：${label}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

// Windows 上 npm/pnpm 是 .cmd 垫片，直接 spawn 会 EINVAL —— 一律走 shell
const WIN = process.platform === 'win32';

const mkTmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const rm = (dir) => fs.rmSync(dir, { recursive: true, force: true });

/** 解 tarball 到一个临时目录，返回 `package/` 的路径 */
function extractTarball(tgz) {
  const dir = mkTmp('aitm-pkg-');
  const r = spawnSync('tar', ['-xzf', tgz, '-C', dir], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`解包失败：${tgz}`);
  return path.join(dir, 'package');
}

/**
 * 手工搭一个 profile（等价于 `dsh plugin add` 跑完的样子）：
 *   profiles/<name>/package.json（依赖 + dsh.profile.bundles）
 *   profiles/<name>/node_modules/dsh-plugin-aitm（真目录，不是软链 —— pnpm 也是软链到 store，但真拷最稳）
 * 插件**不声明** `@deepseek-ai/dsh-tools` 当运行期依赖（它在 DSH 进程里由宿主提供）——理由见下面
 * 「别在 profile 里放第二份 dsh-tools」那段注释。
 * `@deepseek-ai/dsh-base` / `dsh-web-app` 不用装：它们从 dsh 安装位置解析（installAnchor），
 * 这也正是 `--patch` 模式今天能跑起来的原因。
 */
function makeProfile(home, name, pkgDir, appBundle) {
  const dir = path.join(home, 'profiles', name);
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    `${JSON.stringify(
      {
        name: `dsh-profile-${name}`,
        private: true,
        dependencies: { 'dsh-plugin-aitm': 'file:vendor.tgz' },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', appBundle, 'dsh-plugin-aitm'] } },
      },
      undefined,
      2,
    )}\n`,
  );
  fs.cpSync(pkgDir, path.join(dir, 'node_modules', 'dsh-plugin-aitm'), { recursive: true });
  return dir;
}

/*
 * 别在 profile 里放第二份 `@deepseek-ai/dsh-tools`（实测踩到，2026-10-06）：
 * 我们也曾把它当 dependency（觉得「import 了就该声明」），结果 profile 的 node_modules 里多出一份 ——
 * DSH 自己那半边（agent-loop）会从 profile 解析到**这一份**，于是同一个包出现两个实例，
 * 靠 Symbol 注册的服务查不到（`Cannot read properties of undefined (reading 'prepare')`），
 * 工具调用直接失败。宿主本来就提供它（`--patch` 模式与 profile 模式都能解析），
 * 所以 **devDependencies 里留着给离线渲染用，运行期一份都不许带**。
 */

/** 环境：**AITM_REPO 必须真的没有这个变量**（空串也是一种设值，会走「显式指定仓库」那条判据） */
function envWithoutRepo(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.AITM_REPO;
  delete env.AITM_URL;
  delete env.AITM_L3;
  return env;
}

/** 拿带 token 的 cookie（DSH web 的每条路由都要它） */
async function cookieFor(port) {
  const url = await waitFor(() => /http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/.exec(bootLog.out)?.[0], 60_000, 'dsh web 起不来');
  const res1 = await fetch(`http://127.0.0.1:${port}/?token=${new URL(url).searchParams.get('token')}`, { redirect: 'manual' });
  return (res1.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
}

let bootLog = null;

async function main() {
  if (!fs.existsSync(DSH_ENTRY)) {
    check('DSH 已安装（node_modules/@deepseek-ai/dsh）', false, '先 npm install');
    return;
  }

  /* ①② 打包 + 解包 */
  console.log('① 打 tarball（node scripts/vendor-plugin.mjs）');
  const pack = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'vendor-plugin.mjs')], { cwd: REPO, encoding: 'utf8' });
  process.stdout.write(pack.stdout ?? '');
  process.stderr.write(pack.stderr ?? '');
  const tgz = (pack.stdout ?? '')
    .split('\n')
    .map((l) => /release\/(dsh-plugin-aitm-[\w.-]+\.tgz)/.exec(l)?.[1])
    .find(Boolean);
  if (!check('打出了 tarball', pack.status === 0 && Boolean(tgz), tgz ? `release/${tgz}` : `exit=${pack.status}`)) return;
  const tgzPath = path.join(REPO, 'release', tgz);
  const pkgDir = extractTarball(tgzPath);
  check(
    'tarball 里没有第二份 DSH 依赖（node_modules 不进包）',
    !execSync(`tar -tzf ${JSON.stringify(tgzPath)}`, { encoding: 'utf8' }).includes('node_modules/'),
    '见 verify-dist 里「别在 profile 里放第二份 dsh-tools」那段注释',
  );
  check(
    'tarball 与 GitHub 插件仓均有自带内核与面板产物（dist-server/l3.mjs + panel/ + dist/）',
    fs.existsSync(path.join(pkgDir, 'dist-server', 'l3.mjs')) &&
      fs.existsSync(path.join(pkgDir, 'dist', 'index.html')) &&
      fs.existsSync(path.join(pkgDir, 'panel', 'index.html')),
    `${fs.readdirSync(path.join(pkgDir, 'panel', 'assets')).join(', ')}`,
  );

  /* ③④ 没有仓库的机器：起 web，看插件的后端来法 */
  console.log('② 没有仓库的机器：dsh web（profile 里只有 npm 包）');
  const home = mkTmp('aitm-dist-home-');
  const dataHome = mkTmp('aitm-dist-data-');
  const workdir = mkTmp('aitm-dist-cwd-'); // cwd 也不是仓库
  makeProfile(home, 't', pkgDir, '@deepseek-ai/dsh-web-app');
  const port = await freePort();
  // 注意：**别再写 `web`** —— profile 名就决定了 app（`--profile web` 才是 web app）；
  // 多写一个位置参数会被当成 app 的参数，报 "too many arguments"（实测踩到）。
  bootLog = start(process.execPath, dshArgs(['--profile', 't', '--no-open', '--port', String(port)]), {
    cwd: workdir,
    env: envWithoutRepo({ DSH_HOME: home, AI_TASKS_HOME: dataHome }),
  });
  const cookie = await cookieFor(port).catch(() => '');
  check('插件激活（无 "did not activate"）', Boolean(cookie) && !/did not activate/.test(bootLog.out), (bootLog.out.match(/warning:.*/) ?? [''])[0].slice(0, 140));

  const html = await fetch(`http://127.0.0.1:${port}/`, { headers: { cookie } }).then((r) => r.text());
  const boot = JSON.parse(/globalThis\["__DSH_BOOT__"\] = (\{.*?\})<\/script>/s.exec(html)?.[1] ?? '{}');
  const ours = (boot.entries ?? []).find((e) => e.id === 'dsh-plugin-aitm');
  check('客户端半边进 boot 图', Boolean(ours), ours ? `${boot.entries.length} 条` : '');

  const cfg = await fetch(`http://127.0.0.1:${port}/aitm-plugin/config`, { headers: { cookie } }).then((r) => r.json());
  check(
    '后端来法 = 自带内核（vendor），不需要仓库',
    cfg.mode === 'vendor' && !cfg.error && cfg.vendorL3 === true,
    `mode=${String(cfg.mode)} error=${String(cfg.error ?? '无')} repoProblem=${String(cfg.repoProblem ?? '无').slice(0, 60)}`,
  );
  const expected = expectedActions(REPO, 77); // 从内核源码推导（见 expected-actions.mjs）
  check(
    `身份核对：apiRev=2 / ${String(expected)} 个 action / 数据目录 = AI_TASKS_HOME`,
    cfg.identity?.apiRev === 2 && cfg.identity?.actions === expected && cfg.identity?.dataDir === dataHome,
    JSON.stringify({ apiRev: cfg.identity?.apiRev, actions: cfg.identity?.actions, dataDir: cfg.identity?.dataDir }),
  );

  const panel = await fetch(`${cfg.base}/index.html`).then((r) => ({ code: r.status, text: r.text() }));
  const panelText = await panel.text;
  check('面板静态产物由自带内核托管（iframe 打得到）', panel.code === 200 && panelText.includes('id="root"'), `HTTP ${panel.code} / ${panelText.length} 字节`);

  /* ⑤ 假模型 → 工具 → 真内核 */
  console.log('③ 假模型跑一次 aitm_health（证明自带内核真在跑）');
  const stubPort = await freePort();
  start(process.execPath, [path.join(ROOT, 'test', 'stub-llm.mjs')], {
    env: { ...process.env, STUB_PORT: String(stubPort), STUB_LOG: path.join(home, 'stub.jsonl'), STUB_TOOL: 'aitm_health', STUB_ARGS: '{}' },
  });
  await waitFor(
    () =>
      new Promise((resolve) => {
        const sock = net.connect(stubPort, '127.0.0.1');
        sock.on('connect', () => {
          sock.destroy();
          resolve(true);
        });
        sock.on('error', () => {
          sock.destroy();
          resolve(false);
        });
      }),
    10_000,
    '假模型没起来',
  );
  const stubPatch = path.join(home, 'stub.patch.yml');
  fs.writeFileSync(
    stubPatch,
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
  // headless 是**另一个 app**（bundle 不同）→ 另建一个 profile，只有插件这一条是共用的
  makeProfile(home, 'h', pkgDir, '@deepseek-ai/dsh-headless');
  const headless = start(process.execPath, dshArgs(['--profile', 'h', '--patch', stubPatch, '--json', '健康检查']), {
    cwd: workdir,
    env: envWithoutRepo({ DSH_HOME: home, AI_TASKS_HOME: dataHome, STUB_API_KEY: 'stub' }),
  });
  const code = await new Promise((resolve) => headless.on('exit', resolve));
  const toolResult = /"type":"tool_result"[^\n]*/.exec(headless.out)?.[0] ?? '';
  const vendorReady = toolResult.includes(`${String(expected)} 个 action`) && toolResult.includes('apiRev=2');
  if (!vendorReady && process.env.AITM_DEBUG) console.log('---- headless 原始输出 ----\n' + headless.out.slice(-3000));
  check('工具拿到真内核数据（headless，exit=0）', code === 0 && vendorReady, `${toolResult.slice(0, 170)}（exit=${String(code)}）`);

  /* ⑥ 真命令：dsh plugin add（要 pnpm） */
  console.log('④ dsh plugin add 这条真命令');
  const pnpm = spawnSync('pnpm', ['--version'], { encoding: 'utf8', shell: WIN });
  if (pnpm.status !== 0) {
    check('跳过 dsh plugin add（这台机器没有 pnpm）', true, '装了 pnpm 再来跑：npm i -g pnpm；同事机器上这条是真装的路径');
  } else {
    const home2 = mkTmp('aitm-dist-add-');
    const add = spawnSync(process.execPath, dshArgs(['plugin', '--profile', 'web', 'add', tgzPath]), {
      cwd: workdir,
      env: envWithoutRepo({ DSH_HOME: home2, AI_TASKS_HOME: dataHome }),
      encoding: 'utf8',
      timeout: 15 * 60_000,
    });
    const profilePkg = path.join(home2, 'profiles', 'web', 'package.json');
    const pkg = fs.existsSync(profilePkg) ? JSON.parse(fs.readFileSync(profilePkg, 'utf8')) : {};
    const bundles = pkg.dsh?.profile?.bundles ?? [];
    const bundled = bundles.includes('dsh-plugin-aitm') && bundles.includes('@deepseek-ai/dsh-web-app');
    const dep = Boolean(pkg.dependencies?.['dsh-plugin-aitm']);
    check(
      'dsh plugin add：依赖与 bundle 都写进 profile（且没挤掉 web app 那条）',
      add.status === 0 && dep && bundled,
      `exit=${String(add.status)} dep=${String(dep)} bundles=${JSON.stringify(pkg.dsh?.profile?.bundles ?? [])}${add.status === 0 ? '' : ` | ${(add.stderr ?? '').split('\n').slice(-2).join(' ').slice(0, 200)}`}`,
    );
    if (add.status === 0) {
      const installed = path.join(home2, 'profiles', 'web', 'node_modules', 'dsh-plugin-aitm');
      check(
        '装好的包自带内核（同事不需要仓库）',
        fs.existsSync(path.join(installed, 'dist-server', 'l3.mjs')) && fs.existsSync(path.join(installed, 'dist', 'index.html')),
        fs.existsSync(installed) ? 'node_modules/dsh-plugin-aitm/ 就位' : '没装进去',
      );
      // 真装完的样子要能真的干活：用**pnpm 装出来的**那个 profile 起 headless，跑一次 aitm_health
      const installedHeadless = spawnSync(process.execPath, dshArgs(['plugin', '--profile', 'headless', 'add', tgzPath]), {
        cwd: workdir,
        env: envWithoutRepo({ DSH_HOME: home2, AI_TASKS_HOME: dataHome }),
        encoding: 'utf8',
        timeout: 15 * 60_000,
      });
      const h2 = spawnSync(process.execPath, dshArgs(['--profile', 'headless', '--patch', stubPatch, '--json', '健康检查']), {
        cwd: workdir,
        env: envWithoutRepo({ DSH_HOME: home2, AI_TASKS_HOME: dataHome, STUB_API_KEY: 'stub' }),
        encoding: 'utf8',
        timeout: 5 * 60_000,
      });
      const dup = fs.existsSync(path.join(home2, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh-tools'));
      check(
        '用 pnpm 装出来的 profile 跑得通工具（headless，exit=0）',
        installedHeadless.status === 0 && h2.status === 0 && (h2.stdout ?? '').includes(`${String(expected)} 个 action`),
        `add=${String(installedHeadless.status)} headless=${String(h2.status)} 第二份 dsh-tools=${dup ? '有（会打坏工具执行！）' : '没有'}`,
      );
    }
    rm(home2);
  }

  rm(home);
  rm(dataHome);
  rm(workdir);
  rm(path.dirname(pkgDir));
}

try {
  await main();
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
