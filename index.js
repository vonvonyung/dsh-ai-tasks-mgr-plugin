/**
 * AI 任务台 × DSH 插件 —— 宿主半边（跑在 DSH 进程里）。
 *
 * 职责（M1）：
 *   ① 桥：确保有一个可用的 AI 任务台后端（默认自己 spawn 现有 web 宿主，只绑回环）
 *   ② 工具：三个只读工具给模型用（health / idea_list / feed_today）
 *   ③ 给浏览器半边递地址：注册 /aitm-plugin/config 路由（客户端拿不到 Node 环境变量）
 *
 * M2 会把「桥」换成插件进程内的 L3 服务（core 直接 import），工具与路由的接口不变。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'dsh-plugin-aitm';

/** 需要 tools；webServer 是可选的（没有就只做工具，不递地址） */
export const inject = ['tools'];

const REPO_DEFAULT = process.env.AITM_REPO ?? '/home/user/ai-tasks-mgr';

const DEFAULTS = {
  repo: REPO_DEFAULT,
  url: (process.env.AITM_URL ?? '').replace(/\/+$/, ''),
  spawn: process.env.AITM_SPAWN !== '0',
};

const state = {
  base: null,
  child: null,
  starting: null,
  /** true = 复用的是别人起的后端，退出时不能收（收了会把别人正在用的服务干掉） */
  adopted: false,
  log: [],
  exitHook: false,
};

/**
 * 后端登记表（临时目录）：谁起了后端、pid 多少、监听哪个端口。
 * 作用有两个：① 多个 DSH 会话（面板 + headless）**复用同一个后端**，不叠着起；
 * ② 上次没收干净时（比如进程被 SIGTERM 直接砍掉，'exit' 钩子不会跑）这里还留着 pid —— verify 能按它收尾。
 */
const PIDFILE = path.join(os.tmpdir(), 'aitm-dsh-backend.json');

function readRegistry() {
  try {
    return JSON.parse(fs.readFileSync(PIDFILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeRegistry(entry) {
  try {
    fs.writeFileSync(PIDFILE, JSON.stringify(entry));
  } catch {
    /* 临时目录写不了就算了，不影响功能 */
  }
}

function clearRegistryIf(pid) {
  const cur = readRegistry();
  if (cur?.pid === pid) {
    try {
      fs.unlinkSync(PIDFILE);
    } catch {
      /* 已经被删了也无所谓 */
    }
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 收掉一个进程**组**：只 kill 进程本身的话，它再 spawn 出来的东西（npx/vite/…）会活下来 */
function killGroup(pid, signal = 'SIGTERM') {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* 已经没了 */
    }
  }
}

const note = (line) => {
  state.log.push(line);
  if (state.log.length > 200) state.log.shift();
};

/** 找一个空闲端口（我们自己定端口，省得解析子进程日志） */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function health(base, timeoutMs = 1500) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/api/health`, { signal: ctl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function waitHealth(base, ms) {
  const until = Date.now() + ms;
  for (;;) {
    const h = await health(base);
    if (h?.ok) return h;
    if (Date.now() > until) throw new Error(`后端没起来（${base}/api/health 一直不通）`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

/** 调一个 action：我们的 web 宿主就是 POST /api/<action> 的清一色契约 */
async function call(action, payload = {}) {
  const base = await ensureBase();
  const res = await fetch(`${base}/api/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const env = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!env?.ok) throw new Error(env?.error ?? `HTTP ${res.status}`);
  return env.data;
}

/** 确保有一个可用后端：AITM_URL 优先；否则按需拉起（同一进程内只拉一次） */
export async function ensureBase() {
  if (DEFAULTS.url) {
    if (!state.base) state.base = DEFAULTS.url;
    return state.base;
  }
  if (state.base) return state.base;
  if (state.starting) return state.starting;

  state.starting = (async () => {
    // 先看登记表：上一次会话起的后端还活着就复用（不叠着起第二个）
    const known = readRegistry();
    if (known?.pid && known?.base && pidAlive(known.pid)) {
      const h = await health(known.base);
      if (h?.ok) {
        note(`[host] 复用已有后端 ${known.base}（pid=${known.pid}）`);
        state.adopted = true;
        state.base = known.base;
        return known.base;
      }
    }

    const port = await freePort();
    const vitePort = await freePort();
    const base = `http://127.0.0.1:${port}`;
    if (!DEFAULTS.spawn) throw new Error(`没配 AITM_URL，且 AITM_SPAWN=0：连不上后端（${base}）`);

    const debug = process.env.AITM_DEBUG === '1';
    const child = spawn(process.execPath, ['scripts/dev-web.mjs', '--prod'], {
      cwd: DEFAULTS.repo,
      env: { ...process.env, AITM_PORT: String(port), AITM_VITE_PORT: String(vitePort), AITM_BIND_ALL: '' },
      // stdio 用 ignore + unref：否则这个长驻子进程会把 DSH 的 headless 进程「钉」住不退出
      // （实测过：一次 headless 跑完 turn 也不结束，直到超时）。要看子进程日志就 AITM_DEBUG=1。
      stdio: debug ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'ignore', 'ignore'],
      // detached：让子进程自成进程组，收尾时能整组干掉（npx/vite 这类孙进程不会活下来）
      detached: true,
    });
    state.child = child;
    child.unref?.();
    writeRegistry({ pid: child.pid, base, repo: DEFAULTS.repo, at: Date.now() });
    if (debug) {
      child.stdout?.on('data', (b) => note(`[host] ${String(b).trim()}`));
      child.stderr?.on('data', (b) => note(`[host!] ${String(b).trim()}`));
    }
    child.on('exit', (code) => {
      note(`[host] 退出 code=${code}`);
      if (state.base === base) {
        state.base = null;
        state.starting = null;
      }
    });

    await waitHealth(base, 90_000);
    state.base = base;
    return base;
  })();

  try {
    return await state.starting;
  } catch (err) {
    state.starting = null;
    throw err;
  }
}

function stop() {
  if (state.child?.pid && !state.adopted) {
    const pid = state.child.pid;
    killGroup(pid, 'SIGTERM');
    // 3 秒还不走就强杀（有些环境 SIGTERM 会被忽略）
    setTimeout(() => {
      if (pidAlive(pid)) killGroup(pid, 'SIGKILL');
    }, 3000).unref?.();
    clearRegistryIf(pid);
    note('[host] 已收掉我们拉起的后端（整进程组）');
  }
  state.child = null;
  state.adopted = false;
  state.base = null;
  state.starting = null;
}

const schemaHealth = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean', required: true },
    actions: { type: 'integer' },
    dataDir: { type: 'string' },
    base: { type: 'string' },
    log: { type: 'array', items: { type: 'string' } },
  },
};

export function apply(ctx) {
  /* -------- ③ 给浏览器半边递地址（客户端在浏览器里，看不见 Node 环境变量） -------- */
  ctx.inject?.(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      webCtx.webServer.register({
        kind: 'prefix',
        path: '/aitm-plugin',
        handler: async (req, res) => {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1');
          if (url.pathname === '/aitm-plugin/config') {
            let base = null;
            let error = null;
            try {
              base = await ensureBase();
            } catch (err) {
              error = String(err?.message ?? err);
            }
            const body = JSON.stringify({ base, error, repo: DEFAULTS.repo });
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            res.end(body);
            return true;
          }
          return false;
        },
      });
      return () => {};
    });
  });

  /* -------- ② 三个只读工具 -------- */
  ctx.tools.register(
    defineTool({
      name: 'aitm_health',
      description: 'AI 任务台后端健康检查：是否可用、action 数量、数据目录、后端地址。排查「面板打不开」时先调它。',
      parameters: {},
      output: {
        schema: schemaHealth,
        render: (_a, v) => [
          { type: 'text', text: v.ok ? `AI 任务台可用：${v.base}（${v.actions} 个 action）` : `不可用：${JSON.stringify(v)}` },
        ],
      },
      async execute() {
        try {
          const base = await ensureBase();
          const h = await health(base, 3000);
          if (!h?.ok) return { ok: false, error: 'GET /api/health 不通', base, log: state.log.slice(-10) };
          // 数据目录不在 health 里，顺手问一次 settings
          let dataDir;
          try {
            const st = await call('settings.get');
            dataDir = st?.dataDir ?? st?.paths?.dataDir;
          } catch {
            /* 拿不到就算了 */
          }
          return { ...h, base, ...(dataDir ? { dataDir } : {}), log: state.log.slice(-6) };
        } catch (err) {
          return { ok: false, error: String(err?.message ?? err), log: state.log.slice(-10) };
        }
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'aitm_idea_list',
      description:
        '列出 AI 任务台里的想法（默认 20 条），可按状态（inbox/ready/developing/review…）或关键词过滤；同时返回各状态计数。',
      parameters: {
        status: { type: 'string', description: '按状态过滤，如 inbox / ready / developing / review；省略=全部。' },
        q: { type: 'string', description: '标题/正文/标签关键词。' },
        limit: { type: 'number', description: '最多返回几条，默认 20，上限 100。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            total: { type: 'integer', required: true },
            counts: { type: 'object', additionalProperties: true },
            ideas: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  id: { type: 'string', required: true },
                  title: { type: 'string', required: true },
                  status: { type: 'string', required: true },
                  updatedAt: { type: 'integer' },
                  tags: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
        render: (_a, v) => [
          {
            type: 'text',
            text: `共 ${v.total} 条；各状态 ${JSON.stringify(v.counts)}\n` + v.ideas.map((i) => `- [${i.status}] ${i.title}`).join('\n'),
          },
        ],
      },
      async execute(args) {
        const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
        const ideas = await call('idea.list', {
          ...(args.status ? { status: args.status } : {}),
          ...(args.q ? { q: args.q } : {}),
        });
        const all = args.status || args.q ? await call('idea.list', {}) : ideas;
        const counts = all.reduce((acc, i) => ({ ...acc, [i.status]: (acc[i.status] ?? 0) + 1 }), {});
        return {
          total: ideas.length,
          counts,
          ideas: ideas
            .slice(0, limit)
            .map((i) => ({ id: i.id, title: i.title, status: i.status, updatedAt: i.updatedAt, tags: i.tags ?? [] })),
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'aitm_feed_today',
      description:
        'AI 任务台新闻合集今日概览：GitHub/B站热榜条数与收藏条数（只读快照，不触发抓取；要抓新数据请让用户在面板点刷新）。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            github: { type: 'integer', required: true },
            bilibili: { type: 'integer', required: true },
            favorites: { type: 'integer', required: true },
            top: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: true,
                properties: { title: { type: 'string', required: true }, source: { type: 'string', required: true }, url: { type: 'string' } },
              },
            },
          },
        },
        render: (_a, v) => [
          {
            type: 'text',
            text: `GitHub ${v.github} 条 · B站 ${v.bilibili} 条 · 收藏 ${v.favorites} 条\n` + v.top.map((t) => `- (${t.source}) ${t.title}`).join('\n'),
          },
        ],
      },
      async execute() {
        const snap = await call('feed.get');
        const picks = [...(snap.github?.today ?? []), ...(snap.bilibili?.hot ?? [])]
          .slice(0, 5)
          .map((i) => ({ title: i.title, source: i.source, url: i.url }));
        return {
          github: snap.github?.today?.length ?? 0,
          bilibili: snap.bilibili?.hot?.length ?? 0,
          favorites: snap.favorites?.length ?? 0,
          top: picks,
        };
      },
    }),
  );

  // DSH 卸载插件时收掉我们拉起的后端
  ctx.effect(() => () => stop());
  // headless 跑完就退进程：exit 钩子里收一次，免得留下孤儿后端
  if (!state.exitHook) {
    state.exitHook = true;
    process.once('exit', stop);
  }
  ctx.logger?.info?.(`[aitm] 已加载：repo=${DEFAULTS.repo} url=${DEFAULTS.url || '(自动拉起)'}`);
}
