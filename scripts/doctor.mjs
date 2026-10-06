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
  process.exit(1);
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
  info('    或把 dsh-plugin/aitm.patch.yml 的 name: 指到目标仓库里的 dsh-plugin/index.js；');
  info('    ② 或者用分发版（自带内核，机器上不需要仓库）：dsh-plugin/README「同事怎么装」。');
  process.exit(1);
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
  process.exit(1);
}

const h = await (await fetch(`${base}/api/health`)).json();
info(`（这次是 ${cfg.backendMode === 'l3' ? '插件进程内的 L3 服务' : cfg.backendMode === 'vendor' ? '包里自带的进程内内核' : '外部/spawn 的后端'}）`);
ok(`后端可用：${base}`);
info(`actions=${String(h.actions)}  apiRev=${String(h.apiRev ?? '(老后端没有)')}  version=${String(h.version ?? '?')}`);
info(`数据目录 ${String(h.dataDir ?? '?')}`);
if ((h.apiRev ?? 1) < cfg.apiRevRequired) {
  bad(`apiRev 太低（${String(h.apiRev ?? 1)} < ${String(cfg.apiRevRequired)}）：这个后端是旧版，插件不会用它`);
  process.exit(1);
}
ok('版本匹配，插件会用它');

/* ---- 收尾：把自己起的后端收掉，不留孤儿 ---- */
await host.stop?.();
console.log('\n—— 报问题就贴这段 ——');
console.log(
  `插件 v${cfg.pluginVersion} · DSH ${dshVersion ?? '(未知)'} · 后端 ${base} · apiRev=${String(h.apiRev ?? '(老后端没有)')} · ` +
    `actions=${String(h.actions)} · 数据目录 ${String(h.dataDir ?? '?')} · 来法 ${cfg.backendMode}`,
);
console.log('（体检结束；若这次是它自己拉起的后端，已经收掉了）');
process.exit(0);
