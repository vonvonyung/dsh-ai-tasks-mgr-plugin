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
 * 用法：node supervisor.mjs <dshPid> <repoDir> <apiPort> <vitePort> <registryFile> [logFile]
 *
 * 后端日志（logFile）：子进程的 stdout/stderr 全追进去。**必须有** —— 父进程用
 * `stdio:'ignore'` 才不会把 DSH 的 headless 钉住（见 README 第 1 条），代价是失败原因原本
 * 就全丢了（真机踩到：仓库路径不对 → 只看到「后端没起来」）。所以这里落盘，父进程失败时读尾巴。
 * 退出码：0 = 后端自己退了 / 爷进程没了被收掉
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';

const [parentPidRaw, repo, apiPort, vitePort, registryFile, logFile] = process.argv.slice(2);
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

/** 往日志文件追一行（也顺手 echo 到自己的 stderr，AITM_DEBUG=1 时父进程能看到） */
let logFd = null;
if (logFile) {
  try {
    logFd = fs.openSync(logFile, 'a');
  } catch {
    /* 日志开不了不影响功能 */
  }
}
const log = (line) => {
  const text = `${new Date().toISOString()} [supervisor] ${line}\n`;
  if (logFd !== null) {
    try {
      fs.writeSync(logFd, text);
    } catch {
      /* 忽略 */
    }
  }
  if (process.env.AITM_DEBUG === '1') process.stderr.write(text);
};

log(`起后端：node scripts/dev-web.mjs --prod（cwd=${String(repo)}，api=${String(apiPort)}，vite=${String(vitePort)}，node=${process.execPath}）`);

const child = spawn(process.execPath, ['scripts/dev-web.mjs', '--prod'], {
  cwd: repo,
  env: { ...process.env, AITM_PORT: String(apiPort), AITM_VITE_PORT: String(vitePort), AITM_BIND_ALL: '' },
  // 后端自己的输出也追进日志文件（stdio:'ignore' 是为了不钉住 DSH 的 headless 进程）
  stdio: ['ignore', logFd ?? 'ignore', logFd ?? 'ignore'],
  detached: true,
});
if (!child.pid) {
  log('后端起不来：spawn 没返回 pid');
  console.error('[supervisor] 后端起不来');
  process.exit(1);
}
// spawn 失败（cwd 不存在等）是异步的 'error' 事件；不接住的话就成了「静默失败」
child.on('error', (err) => {
  log(`后端起不来：${String(err?.message ?? err)}`);
  console.error(`[supervisor] 后端起不来：${String(err?.message ?? err)}`);
  clearRegistry();
  process.exit(1);
});

// 后端自己退了（构建失败/端口被占）：清登记表、自己也退
child.on('exit', (code, signal) => {
  log(`后端退出 code=${String(code)} signal=${String(signal)}`);
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
