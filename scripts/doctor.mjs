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

/* ---- ① 插件眼里的配置 ---- */
const cfg = host.diagnose();
console.log('① 配置（插件会用的值）');
info(`插件目录   ${cfg.pluginDir}`);
info(`仓库       ${cfg.repo}${cfg.repoFromEnv ? '（来自 AITM_REPO）' : '（按插件位置推导）'}`);
info(`AITM_URL   ${cfg.url ?? '(未设 → 自己拉起后端)'}`);
info(`AITM_SPAWN ${cfg.spawn ? '开' : '关（0）'}`);
info(`要求 apiRev ≥ ${cfg.apiRevRequired}`);
info(`登记表     ${cfg.registry}${fs.existsSync(cfg.registry) ? '（存在）' : '（无）'}`);
info(`后端日志   ${cfg.backendLog}${fs.existsSync(cfg.backendLog) ? '（存在）' : '（无）'}`);
info(`node       ${cfg.node}`);

/* ---- ② 仓库自检 ---- */
console.log('\n② 仓库自检');
if (cfg.repoProblem) {
  bad(cfg.repoProblem);
  info('这就是「不能拉起后端」最常见的原因：起后端要去仓库里跑 scripts/dev-web.mjs。');
  info('修：设 AITM_REPO=<仓库绝对路径>（Windows: setx AITM_REPO D:\\...\\ai-tasks-mgr，重开终端），');
  info('    或把 dsh-plugin/aitm.patch.yml 的 name: 指到目标仓库里的 dsh-plugin/index.js。');
  process.exit(1);
}
ok('仓库路径、package.json、scripts/dev-web.mjs、node_modules/vite 都在');

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
ok(`后端可用：${base}`);
info(`actions=${String(h.actions)}  apiRev=${String(h.apiRev ?? '(老后端没有)')}  version=${String(h.version ?? '?')}`);
info(`数据目录 ${String(h.dataDir ?? '?')}`);
if ((h.apiRev ?? 1) < cfg.apiRevRequired) {
  bad(`apiRev 太低（${String(h.apiRev ?? 1)} < ${String(cfg.apiRevRequired)}）：这个后端是旧版，插件不会用它`);
  process.exit(1);
}
ok('版本匹配，插件会用它');

/* ---- 收尾：把自己起的后端收掉，不留孤儿 ---- */
host.stop?.();
console.log('\n（体检结束；若这次是它自己拉起的后端，已经收掉了）');
process.exit(0);
