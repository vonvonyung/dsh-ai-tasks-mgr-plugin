/**
 * 后端看门狗（supervisor）。
 *
 * 为什么需要它：DSH 被**强杀**时（终端 Ctrl+C、任务管理器结束进程、`timeout` 到点用 SIGTERM 砍）
 * Node 的 `process.on('exit')` 钩子**不会跑** —— 插件直接 spawn 出来的后端就成了孤儿。
 *
 * 所以后端不直接由插件起，而是交给这一层小壳：
 *   DSH 进程 ──spawn(detached)──> supervisor ──spawn(detached)──> dev-web.mjs（真后端）
 * supervisor 每 2 秒看一眼 DSH 还活着没；不在了就把后端整棵树收掉、自己也退出。
 * 就算 DSH 是被 SIGKILL 砍死的，这一条也成立。
 *
 * 用法：node supervisor.mjs <dshPid> <repoDir> <apiPort> <vitePort> <registryFile>
 * 退出码：0 = 后端自己退了 / 爷进程没了被收掉
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';

const [parentPidRaw, repo, apiPort, vitePort, registryFile] = process.argv.slice(2);
const parentPid = Number(parentPidRaw);

const alive = (pid) => {
  if (!pid || Number.isNaN(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** 收掉整棵树：POSIX 用负 pid（进程组），Windows 用 taskkill /T */
function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      /* 已经没了 */
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* 已经没了 */
    }
  }
}

function clearRegistry() {
  try {
    if (registryFile) fs.unlinkSync(registryFile);
  } catch {
    /* 不在了就算了 */
  }
}

const child = spawn(process.execPath, ['scripts/dev-web.mjs', '--prod'], {
  cwd: repo,
  env: { ...process.env, AITM_PORT: String(apiPort), AITM_VITE_PORT: String(vitePort), AITM_BIND_ALL: '' },
  stdio: 'ignore',
  detached: true,
});
if (!child.pid) {
  console.error('[supervisor] 后端起不来');
  process.exit(1);
}

// 后端自己退了（构建失败/端口被占）：清登记表、自己也退
child.on('exit', (code) => {
  clearRegistry();
  process.exit(code ?? 0);
});

// 我们自己被收（插件正常退出时会整组收我们）：顺手把后端也带上
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    killTree(child.pid);
    clearRegistry();
    process.exit(0);
  });
}

// 关键：定时器**不 unref**（unref 了 supervisor 会立刻自己退），它是这条命的主循环
setInterval(() => {
  if (!alive(parentPid)) {
    killTree(child.pid);
    clearRegistry();
    process.exit(0);
  }
}, 2000);
