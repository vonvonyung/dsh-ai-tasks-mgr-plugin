#!/usr/bin/env node
/**
 * 把插件打成**能直接分发的 tarball**（M3 第一半：同事那条路）。
 *
 * 位置：**住在插件里**（`dsh-plugin/scripts/`），母仓库那侧留了一个同名垫片转发过来。
 * 2026-10-07 搬家（插件有了独立仓库）：以前它在母仓库 `scripts/` 里、写死 `PLUGIN = ROOT/dsh-plugin`，
 * 于是插件的 `prepack` 钩子指向 `../scripts/vendor-plugin.mjs` —— 一旦插件被单独 checkout（独立仓库
 * 或同事直接 clone 插件），`npm pack` 就报 MODULE_NOT_FOUND。现在改成：**脚本跟着插件走**，
 * 母仓库的位置靠"向上找"（`AITM_APP_ROOT` → 插件的父目录里有没有 `name: ai-tasks-mgr` 的 package.json）。
 *
 * 为什么要这一步：开发路径下插件「就在仓库里」，内核从仓库现编（`dist-server/l3.mjs`）；
 * 同事机器上没有仓库，所以正式版必须**自带内核与面板产物**：
 *   ① 构建仓库（`npm run build` → `dist-server/l3.mjs` + `dist/`）
 *   ② 把它们拷进 `dsh-plugin/dist-server/` 与 `dsh-plugin/dist/`（都在 .gitignore 里，不进 git）
 *   ③ `npm pack` 出一个 tarball，并**核对 tarball 内容**（自带内核 / 客户端分片 / 面板产物都在）
 *
 * 用法：
 *   node scripts/vendor-plugin.mjs               # 构建 + 拷贝 + 打包
 *   node scripts/vendor-plugin.mjs --skip-build  # 只拷贝 + 打包（刚跑过 build 时省 5 秒）
 *   node scripts/vendor-plugin.mjs --no-pack     # 只拷贝 + 自检（给插件包的 prepack 钩子用，避免递归）
 *
 * 产物：`release/dsh-plugin-aitm-<version>.tgz`
 * 装：  `npx -y @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add <tarball 绝对路径>`
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/**
 * 母仓库（AI 任务台）在哪：**先问环境变量，再往上找**。
 * 找不到就是"独立仓库模式"（插件被单独 checkout）——这时候打不出**带内核**的分发包，
 * 因为内核（`dist-server/l3.mjs`）与面板产物（`dist/`）都是母仓库构建出来的。
 */
const appRoot = (() => {
  if (process.env.AITM_APP_ROOT) return path.resolve(process.env.AITM_APP_ROOT);
  const up = path.resolve(PLUGIN, '..');
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(up, 'package.json'), 'utf8'));
    if (pkg?.name === 'ai-tasks-mgr') return up;
  } catch {
    /* 上面没有母仓库 */
  }
  return null;
})();
const ROOT = appRoot; // 为兼容下面的写法保留这个名字（没有母仓库时是 null）
/* 产物落哪：母仓库模式仍是 `<仓库>/release/`（README/文档都是这个口径，别动）；
   独立仓库模式没有母仓库 → 落在插件自己的 `release/`（在 .gitignore 里）。 */
const OUT_DIR = ROOT ? path.join(ROOT, 'release') : path.join(PLUGIN, 'release');
const skipBuild = process.argv.includes('--skip-build');
// 只拷贝 + 自检，不自己 npm pack —— 插件 package.json 的 `prepack` 钩子走这条（否则递归）
const noPack = process.argv.includes('--no-pack');

const log = (msg) => process.stdout.write(`[vendor] ${msg}\n`);

/**
 * Windows 上 `npm` 是 `npm.cmd` 批处理垫片 —— Node ≥20.12 直接 spawn 会 EINVAL（本项目踩过好几次），
 * 一律走 shell。`tar` 是 System32 里真的 exe，不用 shell。
 */
const WIN = process.platform === 'win32';
const npmRun = (args, opts) => execFileSync('npm', args, { shell: WIN, ...opts });

/** 拷贝一个目录，跳过 sourcemap（自带内核只要 .mjs；面板产物只要真文件） */
function copyTree(from, to, { skipMaps = false } = {}) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(to, { recursive: true });
  let n = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (skipMaps && entry.name.endsWith('.map')) continue;
    if (entry.isDirectory()) {
      n += copyTree(src, dst, { skipMaps });
      continue;
    }
    fs.copyFileSync(src, dst);
    n += 1;
  }
  return n;
}

if (!ROOT) {
  /* 独立仓库模式（插件被单独 checkout，没有 AI 任务台母仓库）：
     若仓库里已经随 git 带了 dist-server/l3.mjs 与 panel/（由 sync-plugin-repo.mjs 同步过来），
     则顺手补一份 dist/（若不存在），直接支持从 GitHub 仓库地址安装或打包！ */
  const selfL3 = path.join(PLUGIN, 'dist-server', 'l3.mjs');
  const selfPanel = path.join(PLUGIN, 'panel', 'index.html');
  const selfDist = path.join(PLUGIN, 'dist', 'index.html');
  if (!fs.existsSync(selfDist) && fs.existsSync(selfPanel)) {
    copyTree(path.join(PLUGIN, 'panel'), path.join(PLUGIN, 'dist'), { skipMaps: true });
  }
  if (fs.existsSync(selfL3) && (fs.existsSync(selfPanel) || fs.existsSync(path.join(PLUGIN, 'dist', 'index.html')))) {
    log('✓ 独立仓库模式：检测到包内已自带 dist-server/l3.mjs 与面板产物（panel/），可直接从 GitHub 安装运行。');
    if (noPack) process.exit(0);
  } else {
    log('⚠ 没找到 AI 任务台仓库（母仓库），且当前独立仓库内还没有 dist-server/l3.mjs。');
    log('  影响：这个 tarball **不含自带内核**（dist-server/l3.mjs）与面板产物，只适合开发/自测；');
    log('        别人装它，插件会让他设 AITM_REPO 指向仓库，否则拉不起后端。');
    log('  正式分发（带内核）：在母仓库里跑 node scripts/vendor-plugin.mjs 并同步到插件仓库');
    if (noPack) {
      log('  --no-pack（prepack 钩子，npm pack 走的这条）：放行，但记住上面这句 —— 这个包不含内核。');
      process.exit(0);
    }
    if (process.argv.includes('--skip-bundle')) {
      log('  --skip-bundle：按你的要求继续（这个包不含内核）。');
      process.exit(0);
    }
    log('  （确实只想打个不含内核的开发包：加 --skip-bundle）');
    process.exit(1);
  }
} else {
  if (!skipBuild) {
    log('构建仓库（npm run build）…');
    npmRun(['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
  } else {
    log('--skip-build：直接用现有的 dist 产物');
  }

  const l3 = path.join(ROOT, 'dist-server', 'l3.mjs');
  const distIndex = path.join(ROOT, 'dist', 'index.html');
  for (const [what, file] of [['自带内核', l3], ['面板产物', distIndex]]) {
    if (!fs.existsSync(file)) {
      log(`✗ 缺${what}：${file} —— 先跑 node scripts/vendor-plugin.mjs（不带 --skip-build）`);
      process.exit(1);
    }
  }

  // 只带 l3.mjs —— 插件要的就是它；web.mjs/seed.mjs 是 CLI 入口，自带内核模式下用不到
  fs.rmSync(path.join(PLUGIN, 'dist-server'), { recursive: true, force: true });
  fs.mkdirSync(path.join(PLUGIN, 'dist-server'), { recursive: true });
  fs.copyFileSync(l3, path.join(PLUGIN, 'dist-server', 'l3.mjs'));
  const nL3 = 1;
  copyTree(path.join(ROOT, 'dist'), path.join(PLUGIN, 'panel'), { skipMaps: true });
  const nDist = copyTree(path.join(ROOT, 'dist'), path.join(PLUGIN, 'dist'), { skipMaps: true });
  log(`拷贝：dist-server ${nL3} 个文件 · panel/dist ${nDist} 个文件 → dsh-plugin/`);
}

// 拷贝完就核对「自带内核 + 面板产物」在不在（prepack 只跑到这就够了：内容检查放在 npm pack 之后）
if (noPack) {
  log('✓ --no-pack：拷贝完成（内核与面板产物都在），不打包');
  process.exit(0);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
log('npm pack …');
const packed = npmRun(['pack', '--pack-destination', OUT_DIR, '--silent'], {
  cwd: PLUGIN,
  encoding: 'utf8',
}).trim();
const tgz = path.join(OUT_DIR, packed.split('\n').pop().trim());
if (!fs.existsSync(tgz)) {
  log(`✗ 没找到 tarball：${tgz}`);
  process.exit(1);
}

// 核对 tarball 内容 —— 「装了却没内核」必须是打包时就报错，而不是同事装机时才报错
const files = execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8' }).split('\n').map((s) => s.trim());
const need = ['package/index.js', 'package/client.js', 'package/package.json', 'package/dist-server/l3.mjs'];
const missing = need.filter((f) => !files.includes(f));
const panelFile = files.find((f) => /^package\/dist\/assets\/.*\.js$/.test(f));
if (missing.length || !panelFile) {
  log(`✗ tarball 内容不对：缺 ${[...missing, ...(panelFile ? [] : ['package/dist/assets/*.js'])].join('、')}`);
  log(`  实际打包了 ${files.length} 个文件：\n${files.slice(0, 20).join('\n')}`);
  process.exit(1);
}

const size = fs.statSync(tgz).size;
const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'package.json'), 'utf8'));
log(`✓ ${path.relative(ROOT, tgz)}（${(size / 1024 / 1024).toFixed(1)} MB，${files.length} 个文件，v${pkg.version}）`);
log(`  面板产物：${panelFile}`);
log('装：');
log(`  npx -y @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add ${tgz}`);
log('  # 然后在同一个 DSH_HOME 起：npx -y @deepseek-ai/dsh@0.2.0-rc.2 web --port 3081');
log('  自检：npx -y @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web list | grep aitm');
