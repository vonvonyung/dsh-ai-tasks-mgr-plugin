#!/usr/bin/env node
/**
 * 体检（doctor）—— 不用起 DSH，就能看清「插件在哪个目录起后端、缺什么、为什么起不来」。
 *
 * 为什么要有它：DSH 里报错只有面板那一行，而插件为了不把 DSH 钉住用了 `stdio:'ignore'`，
 * 失败原因原本会丢。这个脚本跑的是**同一套启动代码**（`index.js` 的 `ensureBase`），
 * 但把每一步都打印出来，失败时连后端日志尾巴一起给。
 *
 * 用法（在 dsh-plugin 目录里）：
 *   node scripts/doctor.mjs
 *   AITM_REPO=D:\...\ai-tasks-mgr node scripts/doctor.mjs     # 试别的仓库
 *   AITM_URL=http://127.0.0.1:8731 node scripts/doctor.mjs    # 试连已在跑的实例
 *
 * 两种装法都覆盖：① 开发（插件在仓库里，用仓库的内核）② 分发（同事从 npm 装的，
 * 插件自带内核、机器上没有仓库）。报问题给同事时，把这一段输出整个贴过来就够定位了。
 *
 * 退出码：0 = 后端可用；1 = 起不来（原因都打印了）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

const ok = (s) => console.log(`  ✓ ${s}`);
const bad = (s) => console.log(`  ✗ ${s}`);
const info = (s) => console.log(`    ${s}`);

console.log('AI 任务台 · DSH 插件体检\n');

let host;
try {
  host = await import('../index.js');
} catch (err) {
  bad(`插件加载失败：${String(err?.message ?? err)}`);
  info('多半是 dsh-plugin 的依赖没装：在本目录跑一次 npm install');
  exitWith(1);
}

/** DSH 自己的版本（从依赖里读；读不到就说不知道） */
const dshVersion = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('../node_modules/@deepseek-ai/dsh/package.json', import.meta.url), 'utf8')).version;
  } catch {
    return null;
  }
})();

/* ---- ① 插件眼里的配置 ---- */
const cfg = host.diagnose();
// 报问题时**整段复制**这一行 + 下面第 ③ 节：版本三元组 / 产物状态 / 后端来法，一眼定位
console.log(
  `插件 v${cfg.pluginVersion} · DSH ${dshVersion ?? '(未知)'} · 要求后端 apiRev ≥ ${cfg.apiRevRequired} · ` +
    `后端来法 ${cfg.backendMode} · 仓库 ${cfg.repoProblem ? '有问题' : '正常'} · 自带内核 ${cfg.vendorL3Present ? '有' : '无'}`,
);
console.log('（有 DSH 问题：把这一行连同第 ③ 节整段贴回来就够定位）\n');
console.log('① 配置（插件会用的值）');
info(`插件目录   ${cfg.pluginDir}`);
info(`插件版本   ${cfg.pluginVersion}`);
info(`仓库       ${cfg.repo}${cfg.repoFromEnv ? '（来自 AITM_REPO）' : '（按插件位置推导）'}`);
info(`AITM_URL   ${cfg.url ?? '(未设 → 用进程内内核)'}`);
info(`自带内核   ${cfg.vendorL3}${cfg.vendorL3Present ? '（有）' : '（无）'}`);
const MODE_TEXT = {
  l3: '（仓库内进程内 L3，不起常驻子进程）',
  vendor: '（包里自带内核，机器上不需要仓库）',
  external: '（AITM_URL：连外部实例）',
  spawn: '（AITM_L3=0：旧的 spawn 桥，保命通道）',
  error: '（自检没过 —— 见下面第 ② 节）',
};
info(`后端来法   ${cfg.backendMode}${MODE_TEXT[cfg.backendMode] ?? ''}`);
info(`AITM_SPAWN ${cfg.spawn ? '开' : '关（0）'}${cfg.backendMode === 'l3' ? '（L3 模式下用不到）' : ''}`);
info(`L3 产物    ${cfg.l3Bundle}${cfg.l3BundlePresent ? '（有）' : '（缺 → 跑一次 npm run build）'}`);
// 子进程缝：宿主（DSH）提供 ctx.subprocess 时，内核起的 CLI 任务由**宿主托管**（关 DSH 一起收掉）；
// doctor 不起 DSH，看不到宿主到底提没提供，所以这里只报环境开关的当前值。
info(`子进程缝   ${process.env.AITM_SUBPROCESS === '0' ? '关（AITM_SUBPROCESS=0 → 内核自己 spawn）' : '开（有 ctx.subprocess 就交给宿主托管；.cmd 垫片仍走内核自己 spawn）'}`);
info(`面板产物   dist/index.html ${cfg.rendererDistPresent ? '有' : '缺 → 跑一次 npm run build'}`);
// 客户端半边指纹：DSH 网络面板里 `/plugins/??…/client.js&rev=xxxx` 的 xxxx 应该与它一致；
// 不一致就说明浏览器/宿主用的还是另一份 client.js（缓存、装的是旧包、或者根本没更新仓库）
info(`面板代码   client.js rev ${cfg.clientRev ?? '(读不到)'} —— 对比 DSH 网络面板里 client.js 的 &rev=`);
info(`要求 apiRev ≥ ${cfg.apiRevRequired}`);
info(`登记表     ${cfg.registry}${fs.existsSync(cfg.registry) ? '（存在）' : '（无）'}`);
info(`后端日志   ${cfg.backendLog}${fs.existsSync(cfg.backendLog) ? '（存在）' : '（无）'}`);
info(`node       ${cfg.node}`);
info(`DSH        ${dshVersion ?? '(没装在同目录，不影响插件运行)'}`);

/* ---- ② 仓库 / 自带内核 自检 ---- */
console.log('\n② 仓库自检（分发模式可以没有仓库）');
if (cfg.backendMode === 'vendor') {
  info(`没有仓库，用包里的自带内核：${cfg.repoProblem ?? '(仓库路径没推导出来)'}`);
  ok('自带内核在（dist-server/l3.mjs）');
  if (cfg.vendorDistPresent) ok('面板产物在（包里的 dist/index.html）');
  else bad('面板产物不在包里（dist/index.html）—— 面板会打不开，重装正式版');
} else if (cfg.repoProblem) {
  bad(cfg.repoProblem);
  info('这就是「不能拉起后端」最常见的原因：仓库模式要 import 仓库里的 dist-server/l3.mjs。');
  info('修：① 设 AITM_REPO=<仓库绝对路径>（Windows: setx AITM_REPO D:\\...\\ai-tasks-mgr，重开终端），');
  info('    或让补丁指向目标仓库：node dsh-plugin/scripts/make-patch.mjs <仓库路径>（生成 aitm.patch.yml，不进 git）；');
  info('    ② 或者用分发版（自带内核，机器上不需要仓库）：dsh-plugin/README「同事怎么装」。');
  exitWith(1);
} else {
  ok('仓库路径、package.json、scripts/dev-web.mjs、node_modules/vite 都在');
  if (cfg.backendMode === 'l3') {
    if (!cfg.l3BundlePresent) bad('进程内 L3 产物不在（dist-server/l3.mjs）—— 在仓库跑一次 npm run build');
    else ok('进程内 L3 产物在（dist-server/l3.mjs）');
    if (!cfg.rendererDistPresent) bad('面板产物不在（dist/index.html）—— 在仓库跑一次 npm run build');
    else ok('面板产物在（dist/index.html）');
  }
}

/* ---- ③ 连/起 ---- */
console.log('\n③ 起后端（或连已有实例）');
let base = null;
let failure = null;
try {
  base = await host.ensureBase();
} catch (err) {
  failure = String(err?.message ?? err);
}

if (failure) {
  bad(failure.split('\n')[0]);
  for (const line of failure.split('\n').slice(1)) info(line);
  console.log('\n后端日志尾部：');
  try {
    const tail = fs.readFileSync(cfg.backendLog, 'utf8').trimEnd().split('\n').slice(-20);
    for (const line of tail) info(line);
  } catch {
    info('(还没有日志文件 —— 进程可能连启动都没到)');
  }
  exitWith(1);
}

const h = await (await fetch(`${base}/api/health`)).json();
info(`（这次是 ${cfg.backendMode === 'l3' ? '插件进程内的 L3 服务' : cfg.backendMode === 'vendor' ? '包里自带的进程内内核' : '外部/spawn 的后端'}）`);
ok(`后端可用：${base}`);
info(`actions=${String(h.actions)}  apiRev=${String(h.apiRev ?? '(老后端没有)')}  version=${String(h.version ?? '?')}`);
info(`数据目录 ${String(h.dataDir ?? '?')}`);
if ((h.apiRev ?? 1) < cfg.apiRevRequired) {
  bad(`apiRev 太低（${String(h.apiRev ?? 1)} < ${String(cfg.apiRevRequired)}）：这个后端是旧版，插件不会用它`);
  exitWith(1);
}
ok('版本匹配，插件会用它');

/* ---- ④ DSH profile 体检（「装不上插件」时最常见的其实不是我们的包） ---- */
// 场景（2026-10-06 同事机实测）：profile 里早先装过另一个插件，那条依赖是**本机某个 tarball 的绝对路径**
//（`file:D:/Hugo/Documents/…/postpilot-….tgz`）。文件一旦不在（换机器 / 那个项目被清掉），
// 之后在这个 profile 里跑**任何** `pnpm add`（包括装我们的插件）都会先解析整张锁文件 → ENOENT → 整次安装失败。
// 这不是我们的包的问题，但报错里只有别人家的 tgz 名字，很容易看成一团乱麻 —— 所以在这里点名。
const dshHome = process.env.DSH_HOME?.trim() ? path.resolve(process.env.DSH_HOME.trim()) : path.join(os.homedir(), '.dsh');
const profilesDir = path.join(dshHome, 'profiles');
const isLocalDep = (v) => /^(file:|link:|portal:)/.test(v) || /\.(tgz|tar\.gz)$/i.test(v) || /^[A-Za-z]:[\\/]/.test(v) || v.startsWith('/');
const profileBroken = [];
try {
  for (const name of fs.readdirSync(profilesDir)) {
    const pj = path.join(profilesDir, name, 'package.json');
    let deps;
    try {
      deps = { ...JSON.parse(fs.readFileSync(pj, 'utf8')).dependencies };
    } catch {
      continue; // 没装过东西 / 文件坏了，跳过
    }
    for (const [dep, ver] of Object.entries(deps)) {
      if (typeof ver !== 'string' || !isLocalDep(ver)) continue;
      const raw = ver.replace(/^(file:|link:|portal:)/, '');
      // 盘符路径也要按绝对路径认（`D:/…` 在 WSL/Linux 上 path.isAbsolute 会说不绝对，那是我们看别人机器时）
      const abs = path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw) ? raw : path.resolve(path.dirname(pj), raw);
      if (!fs.existsSync(abs)) profileBroken.push({ profile: name, dep, ver, abs });
    }
  }
} catch {
  /* 没有 profiles 目录：DSH 还没装过插件 */
}
if (profileBroken.length) {
  bad(`profile 里有 ${profileBroken.length} 条坏依赖（本地 tarball 已经不在了）——装任何插件都会失败，与我们的包无关`);
  for (const b of profileBroken) info(`profile ${b.profile}：${b.dep} → ${b.abs}（文件不存在）`);
  info('修法（挑一条）：');
  info('  ① 把那个 tarball 放回上面的路径（在造它的那台机器/项目里重新 bundle 一份）；');
  info('  ② 不需要它了就从 profile 里删掉：cd <上面那个 profile 目录> && pnpm remove <包名>');
  info('     （若 pnpm remove 也报同一个 ENOENT：手工删 package.json 里那一行 + pnpm-lock.yaml 里同名段落，再 pnpm install）；');
  info('  ③ 或者换一个干净 profile 装我们：npx -y @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile <新名字> add <tarball>。');
} else {
  info(`DSH profile 体检：${profilesDir} 下没有坏依赖（装插件不会被别人的残留挡住）`);
}

/* ---- 收尾：把自己起的后端收掉，不留孤儿 ---- */
await host.stop?.();
console.log('\n—— 报问题就贴这段 ——');
console.log(
  `插件 v${cfg.pluginVersion} · DSH ${dshVersion ?? '(未知)'} · 后端 ${base} · apiRev=${String(h.apiRev ?? '(老后端没有)')} · ` +
    `actions=${String(h.actions)} · 数据目录 ${String(h.dataDir ?? '?')} · 来法 ${cfg.backendMode}`,
);
console.log('（体检结束；若这次是它自己拉起的后端，已经收掉了）');
exitWith(0);

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
