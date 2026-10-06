/**
 * 生成开发装法用的 `dsh-plugin/aitm.patch.yml`（**本机绝对路径**，不进 git）。
 *
 * 为什么要有这个脚本：补丁里的 `name:` 必须是本机 `dsh-plugin/index.js` 的绝对路径，
 * 而仓库里存的只能是占位——把这个文件 tracked 起来，就等于要求「每台机器都往一个共享文件里
 * 写自己的路径」：一跑自检主工作区就变脏，配上「合并要求主区干净」直接把验收门挡死
 * （2026-10-06 实测踩到）。所以改成：模板进 git（`aitm.patch.yml.example`），
 * 这个脚本按需生成真正的补丁文件，`.gitignore` 收掉它。
 *
 * 用法（两种都对）：
 *   cd dsh-plugin && node scripts/make-patch.mjs
 *   node dsh-plugin/scripts/make-patch.mjs <仓库路径>
 *
 * 生成后起 DSH：
 *   npx -y @deepseek-ai/dsh@0.2.0-rc.2 web --patch <仓库>\\dsh-plugin\\aitm.patch.yml --no-open --port 3081
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(HERE, '..');

/** 目标仓库：参数 → 从插件位置推导（插件就在 <repo>/dsh-plugin/） */
const REPO = path.resolve(process.argv[2] ?? path.join(PLUGIN_DIR, '..'));
const ENTRY = path.join(PLUGIN_DIR, 'index.js');
const OUT = path.join(PLUGIN_DIR, 'aitm.patch.yml');

if (!fs.existsSync(ENTRY)) {
  console.error(`找不到插件入口：${ENTRY}`);
  exitWith(1);
}
if (!fs.existsSync(path.join(REPO, 'package.json'))) {
  console.error(`这个路径不像 AI 任务台仓库（没有 package.json）：${REPO}`);
  console.error('用法：node scripts/make-patch.mjs [仓库绝对路径]');
  exitWith(1);
}

const body = [
  '# 由 scripts/make-patch.mjs 生成（本机绝对路径；模板见 aitm.patch.yml.example）',
  '# 这个文件在 .gitignore 里：换机器/换路径就重新跑一次脚本，别提交它。',
  '- insert:',
  '    - id: aitm-plugin',
  `      name: ${JSON.stringify(ENTRY)}`,
  '',
].join('\n');

fs.writeFileSync(OUT, body, 'utf8');
console.log(`✓ 已生成 ${OUT}`);
console.log(`  插件入口 ${ENTRY}`);
console.log('');
console.log('起 DSH（开发装法）：');
console.log(
  `  npx -y @deepseek-ai/dsh@0.2.0-rc.2 web --patch ${OUT} --no-open --port 3081`,
);

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
