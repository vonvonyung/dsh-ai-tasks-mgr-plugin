// src/web/l3.ts
import path18 from "node:path";

// src/core/paths.ts
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
var overrideRoot = null;
function setDataRoot(dir) {
  overrideRoot = dir;
}
function dataRoot() {
  if (overrideRoot) return overrideRoot;
  if (process.env.AI_TASKS_HOME) return process.env.AI_TASKS_HOME;
  return path.join(os.homedir(), ".ai-tasks-mgr");
}
var paths = {
  root: () => dataRoot(),
  data: () => path.join(dataRoot(), "data"),
  worktrees: () => path.join(dataRoot(), "worktrees"),
  events: () => path.join(dataRoot(), "events"),
  logs: () => path.join(dataRoot(), "logs"),
  /** 想法附件的 blob 存放处：attachments/<ideaId>/<attachmentId> */
  attachments: () => path.join(dataRoot(), "attachments"),
  attachmentBlobDir: (ideaId) => path.join(dataRoot(), "attachments", ideaId),
  attachmentBlob: (ideaId, id) => path.join(dataRoot(), "attachments", ideaId, id),
  /** 新闻合集：按天存抓取结果 + 每次抓取的快照流（趋势原料） */
  feed: () => path.join(dataRoot(), "data", "feed"),
  feedItemsDir: () => path.join(dataRoot(), "data", "feed", "items"),
  feedItemsFile: (source, date) => path.join(dataRoot(), "data", "feed", "items", `${source}-${date}.json`),
  feedSnapshots: () => path.join(dataRoot(), "data", "feed", "snapshots.jsonl"),
  feedState: () => path.join(dataRoot(), "data", "feed", "state.json"),
  /** 收藏（条目全文快照，不跟热榜的按天缓存一起清理） */
  feedFavorites: () => path.join(dataRoot(), "data", "feed", "favorites.json"),
  /** 「不看它」的隐藏条目（永久保留，直到手动恢复） */
  feedHidden: () => path.join(dataRoot(), "data", "feed", "hidden.json"),
  /* ---- 备份：内容寻址对象库 + 快照清单 + 索引（都在 backups/ 下，不进快照自身） ---- */
  backups: () => path.join(dataRoot(), "backups"),
  backupObjects: () => path.join(dataRoot(), "backups", "objects"),
  backupSnapshots: () => path.join(dataRoot(), "backups", "snapshots"),
  backupIndex: () => path.join(dataRoot(), "backups", "index.json"),
  backupManifest: (id) => path.join(dataRoot(), "backups", "snapshots", `${id}.json`),
  backupExports: () => path.join(dataRoot(), "backups", "exports"),
  backupTmp: () => path.join(dataRoot(), "backups", "tmp"),
  /** 飞书同步映射（想法ID → record_id/哈希），本地文件、不进快照范围的判断之外 */
  feishuMap: () => path.join(dataRoot(), "data", "feishu-map.json"),
  /** 日历导出（.ics / CSV） */
  exports: () => path.join(dataRoot(), "exports"),
  file: (name) => path.join(dataRoot(), "data", name),
  eventLog: (taskId) => path.join(dataRoot(), "events", `${taskId}.jsonl`),
  /** 人读的进度流水（tail 友好），与结构化事件流分开存放 */
  rawLog: (taskId) => path.join(dataRoot(), "logs", `${taskId}.log`),
  ensure: () => {
    for (const d of [
      paths.root(),
      paths.data(),
      paths.worktrees(),
      paths.events(),
      paths.logs(),
      paths.attachments(),
      paths.feedItemsDir(),
      paths.exports()
    ]) {
      fs.mkdirSync(d, { recursive: true });
    }
  }
};

// src/core/api.ts
import fs12 from "node:fs";
import path16 from "node:path";

// src/shared/labels.ts
var IDEA_LABEL = {
  inbox: "\u7075\u611F\u7BB1",
  scoping: "\u68B3\u7406\u4E2D",
  ready: "\u53EF\u5F00\u53D1",
  developing: "\u5F00\u53D1\u4E2D",
  review: "\u5F85\u9A8C\u6536",
  blocked: "\u53D7\u963B",
  done: "\u5DF2\u5B8C\u6210",
  archived: "\u5DF2\u5F52\u6863",
  trash: "\u56DE\u6536\u7AD9"
};
var PRIORITY_LABEL = { p0: "P0 \u7D27\u6025", p1: "P1 \u9AD8", p2: "P2 \u4E2D", p3: "P3 \u4F4E" };

// src/shared/usage.ts
var USAGE_KEYS = ["inputTokens", "outputTokens", "totalTokens", "costUsd"];
function addUsage(a, b) {
  if (!b || !Object.keys(b).length) return a;
  const out = { ...a ?? {} };
  const allow = [...USAGE_KEYS, "approximate"];
  for (const [k, v] of Object.entries(b)) {
    if (!allow.includes(k)) continue;
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    out[k] = k === "approximate" ? 1 : (out[k] ?? 0) + v;
  }
  return out;
}
function viewUsage(usage) {
  if (!usage) return null;
  const n = (k) => typeof usage[k] === "number" && Number.isFinite(usage[k]) ? usage[k] : void 0;
  const input = n("inputTokens") ?? 0;
  const output = n("outputTokens") ?? 0;
  const total = n("totalTokens") ?? (input || output ? input + output : void 0);
  const cost = n("costUsd");
  if (!total && !cost) return null;
  return { input, output, total: total ?? 0, cost, approximate: n("approximate") === 1 };
}
function fmtTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1e3) return String(Math.round(n));
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 2 : 1)}k`;
  return `${(n / 1e6).toFixed(2)}M`;
}
function diagnoseTaskBudgetAndSpin(task, opts) {
  const totalTokens = viewUsage(task?.usage)?.total ?? 0;
  const budgetTokens = Math.max(0, Number(opts?.taskTokenBudget) || 0);
  const overBudget = budgetTokens > 0 && totalTokens > budgetTokens;
  const warnings = [];
  if (overBudget) {
    warnings.push(`\u672C\u4EFB\u52A1\u7D2F\u8BA1\u6D88\u8017 ${fmtTokens(totalTokens)} tok\uFF0C\u5DF2\u8D85\u51FA\u5355\u4EFB\u52A1\u9884\u7B97\u8F6F\u4E0A\u9650\uFF08${fmtTokens(budgetTokens)} tok\uFF09`);
  }
  let spinning = false;
  let spinReason = null;
  const stats = task?.turnStats ?? [];
  if (stats.length >= 2) {
    const tail2 = stats.slice(-2);
    if (tail2.every((s) => !s.ok)) {
      spinning = true;
      spinReason = `\u8FDE\u7EED ${tail2.length} \u8F6E\u6267\u884C\u5931\u8D25\uFF08\u7B2C ${tail2[0].round}\u2013${tail2[1].round} \u8F6E\uFF09\uFF0C\u5EFA\u8BAE\u5148\u6392\u67E5\u62A5\u9519\u539F\u56E0\u6216\u8C03\u6574\u6307\u4EE4\u540E\u518D\u8BD5`;
    } else if (tail2.every((s) => (s.filesChanged ?? 0) === 0 && (viewUsage(s.usage)?.total ?? 0) > 0)) {
      spinning = true;
      spinReason = `\u8FDE\u7EED ${tail2.length} \u8F6E\u6D88\u8017 Token \u4F46\u672A\u4EA7\u751F\u4EFB\u4F55\u6587\u4EF6\u6539\u52A8\uFF08\u7B2C ${tail2[0].round}\u2013${tail2[1].round} \u8F6E\uFF09\uFF0C\u53EF\u80FD\u9677\u5165\u7A7A\u8F6C\u6216\u6743\u9650\u53D7\u963B`;
    }
  }
  if (spinning && spinReason) {
    warnings.push(spinReason);
  }
  return { overBudget, totalTokens, budgetTokens, spinning, spinReason, warnings };
}

// src/core/webhook.ts
var EVENT_LABELS = {
  review: "\u2705 \u5F85\u9A8C\u6536\uFF08AI \u5DF2\u5B8C\u6210\u5F00\u53D1\uFF09",
  blocked: "\u26A0\uFE0F \u53D7\u963B\uFF08\u4EFB\u52A1\u6267\u884C\u6216\u6821\u9A8C\u5931\u8D25\uFF09",
  done: "\u{1F389} \u5DF2\u9A8C\u6536\u5408\u5E76",
  budget: "\u26A1 Token \u9884\u7B97\u9884\u8B66",
  test: "\u{1F514} \u8FDE\u901A\u6027\u6D4B\u8BD5"
};
function formatWebhookText(p) {
  const lines = [
    `\u3010AI \u4EFB\u52A1\u53F0\u3011${EVENT_LABELS[p.event] ?? p.event}`,
    `\u60F3\u6CD5\uFF1A${p.ideaTitle}${p.ideaId ? ` (${p.ideaId})` : ""}`
  ];
  if (p.taskId) lines.push(`\u4EFB\u52A1\uFF1A${p.taskId}`);
  if (p.summary) lines.push(`\u6458\u8981\uFF1A${p.summary}`);
  if (p.detail) lines.push(`\u8BE6\u60C5\uFF1A${p.detail}`);
  return lines.join("\n");
}
function buildWebhookBody(p) {
  const text = formatWebhookText(p);
  const u = p.url.toLowerCase();
  if (u.includes("feishu.cn/open-apis/bot") || u.includes("larksuite.com/open-apis/bot")) {
    return { msg_type: "text", content: { text } };
  }
  if (u.includes("qyapi.weixin.qq.com") || u.includes("oapi.dingtalk.com")) {
    return { msgtype: "text", text: { content: text } };
  }
  return {
    event: p.event,
    ideaId: p.ideaId ?? null,
    taskId: p.taskId ?? null,
    ideaTitle: p.ideaTitle,
    summary: p.summary ?? null,
    detail: p.detail ?? null,
    text,
    content: text,
    at: Date.now()
  };
}
async function sendWebhookNotification(payload, fetchImpl = globalThis.fetch) {
  const url = String(payload.url ?? "").trim();
  if (!url) {
    return { ok: false, status: 0, detail: "\u672A\u914D\u7F6E Webhook URL" };
  }
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, status: 0, detail: "Webhook URL \u5FC5\u987B\u4EE5 http:// \u6216 https:// \u5F00\u5934" };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8e3);
  try {
    const body = buildWebhookBody({ ...payload, url });
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    const raw = (await res.text().catch(() => "")).trim().slice(0, 240);
    if (!res.ok) {
      return { ok: false, status: res.status, detail: `HTTP ${res.status}${raw ? `\uFF1A${raw}` : ""}` };
    }
    return { ok: true, status: res.status, detail: raw ? `HTTP ${res.status} \xB7 ${raw.slice(0, 120)}` : `HTTP ${res.status} \u5DF2\u9001\u8FBE` };
  } catch (err) {
    const msg = err?.name === "AbortError" ? "\u8BF7\u6C42\u8D85\u65F6\uFF088s\uFF09" : err?.message || String(err);
    return { ok: false, status: 0, detail: `\u53D1\u9001\u5931\u8D25\uFF1A${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

// src/core/store/json-store.ts
import fsp from "node:fs/promises";
import path2 from "node:path";

// src/shared/slug.ts
function slug(text, max = 32) {
  const s = text.toLowerCase().replace(/[^a-z0-9一-龥]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max);
  return s || "idea";
}
function sanitizeSegment(text) {
  return text.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 60) || "x";
}

// src/core/store/json-store.ts
var RENAME_RETRY_CODES = /* @__PURE__ */ new Set(["EPERM", "EBUSY", "EACCES"]);
async function renameWithRetry(tmp, file, opts = {}) {
  const tries = Math.max(1, opts.tries ?? 4);
  const delayMs = Math.max(0, opts.delayMs ?? 25);
  const rename = opts.rename ?? ((from, to) => fsp.rename(from, to));
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(tmp, file);
      return;
    } catch (err) {
      const code = err?.code ?? "";
      if (attempt >= tries || !RENAME_RETRY_CODES.has(code)) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
}
async function writeJsonAtomic(file, value, mode) {
  await fsp.mkdir(path2.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), mode ? { mode } : "utf8");
  if (mode) await fsp.chmod(tmp, mode).catch(() => void 0);
  try {
    await renameWithRetry(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => void 0);
    throw err;
  }
}
async function readJson(file, fallback) {
  try {
    const raw = await fsp.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    const code = err?.code;
    if (code === "ENOENT") return fallback;
    try {
      await fsp.copyFile(file, `${file}.corrupt.${Date.now()}`);
    } catch {
    }
    return fallback;
  }
}
async function appendJsonl(file, records) {
  if (!records.length) return;
  await fsp.mkdir(path2.dirname(file), { recursive: true });
  await fsp.appendFile(
    file,
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
    "utf8"
  );
}
async function readJsonl(file, opts = {}) {
  let raw;
  try {
    raw = await fsp.readFile(file, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n");
  const sliced = opts.tail ? lines.slice(-(opts.tail + 1)) : lines;
  const out = [];
  for (const line of sliced) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
    }
  }
  return opts.tail ? out.slice(-opts.tail) : out;
}
function safeId(prefix) {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 7);
  return `${prefix}_${t}${r}`;
}

// src/shared/idea-dir.ts
function cleanSegment(seg) {
  return seg.replace(/[\\:*?"<>|\0]/g, "").replace(/^\.+/, "").replace(/\s+/g, "-").trim().slice(0, 48);
}
function normalizeWorkDir(raw) {
  if (raw === null) return null;
  const t = String(raw ?? "").trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!t) return null;
  if (t.startsWith("/") || /^[a-zA-Z]:/.test(t) || t.startsWith("~")) {
    throw new Error("\u60F3\u6CD5\u76EE\u5F55\u5F97\u662F\u4ED3\u5E93\u5185\u7684\u76F8\u5BF9\u8DEF\u5F84\uFF08\u522B\u7528 / \u3001~ \u6216\u76D8\u7B26\u5F00\u5934\uFF09");
  }
  const segs = t.split("/").filter(Boolean);
  if (segs.some((s) => s === ".." || s === ".")) throw new Error("\u60F3\u6CD5\u76EE\u5F55\u4E0D\u80FD\u7528 .. \u8DF3\u5230\u4ED3\u5E93\u5916\u9762");
  if (segs.some((s) => s === ".git" || s.startsWith(".git/"))) throw new Error("\u60F3\u6CD5\u76EE\u5F55\u4E0D\u80FD\u843D\u5728 .git \u91CC");
  if (segs.length > 3) throw new Error("\u60F3\u6CD5\u76EE\u5F55\u6700\u591A\u4E09\u5C42\uFF0C\u518D\u6DF1\u5C31\u6CA1\u6CD5\u770B\u4E86");
  const cleaned = segs.map(cleanSegment).filter(Boolean);
  if (!cleaned.length) throw new Error("\u60F3\u6CD5\u76EE\u5F55\u91CC\u81F3\u5C11\u5F97\u7559\u4E0B\u4E00\u4E2A\u53EF\u7528\u7684\u5B57\u7B26");
  return cleaned.join("/");
}

// src/core/store/store.ts
import fs2 from "node:fs";
import fsp2 from "node:fs/promises";
import path3 from "node:path";

// src/shared/feed-presets.ts
var BILI_ZONES = [
  { tid: 0, name: "\u5168\u7AD9" },
  { tid: 1, name: "\u52A8\u753B" },
  { tid: 13, name: "\u756A\u5267" },
  { tid: 167, name: "\u56FD\u521B" },
  { tid: 3, name: "\u97F3\u4E50" },
  { tid: 129, name: "\u821E\u8E48" },
  { tid: 4, name: "\u6E38\u620F" },
  { tid: 36, name: "\u77E5\u8BC6" },
  { tid: 188, name: "\u79D1\u6280" },
  { tid: 234, name: "\u8FD0\u52A8" },
  { tid: 223, name: "\u6C7D\u8F66" },
  { tid: 160, name: "\u751F\u6D3B" },
  { tid: 211, name: "\u7F8E\u98DF" },
  { tid: 217, name: "\u52A8\u7269\u5708" },
  { tid: 119, name: "\u9B3C\u755C" },
  { tid: 155, name: "\u65F6\u5C1A" },
  { tid: 5, name: "\u5A31\u4E50" },
  { tid: 181, name: "\u5F71\u89C6" },
  { tid: 177, name: "\u7EAA\u5F55\u7247" },
  { tid: 23, name: "\u7535\u5F71" },
  { tid: 11, name: "\u7535\u89C6\u5267" }
];
var BILI_ZONE_NAME = new Map(BILI_ZONES.map((z) => [z.tid, z.name]));
var BILI_AI_KEYWORDS = [
  "ai",
  "\u4EBA\u5DE5\u667A\u80FD",
  "\u5927\u6A21\u578B",
  "llm",
  "gpt",
  "claude",
  "deepseek",
  "qwen",
  "\u901A\u4E49",
  "\u8C46\u5305",
  "\u6587\u5FC3",
  "kimi",
  "\u667A\u80FD\u4F53",
  "agent",
  "mcp",
  "rag",
  "\u63D0\u793A\u8BCD",
  "prompt",
  "\u751F\u6210\u5F0F",
  "\u6570\u5B57\u4EBA",
  "aigc",
  "\u673A\u5668\u5B66\u4E60",
  "\u6DF1\u5EA6\u5B66\u4E60",
  "\u795E\u7ECF\u7F51\u7EDC",
  "stable diffusion",
  "comfyui",
  "midjourney",
  "sora",
  "diffusion"
];
var DEFAULT_FEED_KEYWORDS = {
  model: [
    "llm",
    "gpt",
    "claude",
    "gemini",
    "qwen",
    "llama",
    "deepseek",
    "mistral",
    "moonshot",
    "kimi",
    "diffusion",
    "stable-diffusion",
    "whisper",
    "vlm",
    "multimodal",
    "embedding",
    "transformer",
    "text-to-image",
    "text-to-video",
    "tts",
    "asr",
    "\u5927\u6A21\u578B",
    "\u6A21\u578B",
    "\u63A8\u7406"
  ],
  tool: [
    "agent",
    "agents",
    "mcp",
    "rag",
    "cli",
    "copilot",
    "coder",
    "coding",
    "cursor",
    "ide",
    "workflow",
    "automation",
    "assistant",
    "chatbot",
    "gateway",
    "orchestrat",
    "browser-use",
    "computer-use",
    "\u81EA\u52A8\u5316",
    "\u667A\u80FD\u4F53",
    "\u52A9\u624B",
    "\u5DE5\u4F5C\u6D41"
  ],
  skill: [
    "skill",
    "skills",
    "agent-skill",
    "subagent",
    "prompt",
    "prompts",
    "plugin",
    "rules",
    "\u6280\u80FD",
    "\u63D0\u793A\u8BCD"
  ],
  exclude: ["awesome", "tutorial", "\u6559\u7A0B", "interview", "\u9762\u8BD5", "cheatsheet"]
};
function matchKeywords(text, keywords) {
  const t = (text ?? "").toLowerCase();
  if (!t) return [];
  const hits = [];
  for (const raw of keywords) {
    const k = raw.trim().toLowerCase();
    if (!k) continue;
    if (/^[a-z0-9][a-z0-9+#.\- ]*$/.test(k) && k.length <= 3) {
      const re = new RegExp(`(^|[^a-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i");
      if (re.test(t)) hits.push(raw.trim());
    } else if (t.includes(k)) {
      hits.push(raw.trim());
    }
  }
  return hits;
}

// src/shared/types.ts
var IDEA_STATUSES = [
  "inbox",
  "scoping",
  "ready",
  "developing",
  "review",
  "done",
  "blocked",
  "archived",
  "trash"
];
var IDEA_PRIORITIES = ["p0", "p1", "p2", "p3"];
var WEBHOOK_EVENT_KINDS = ["review", "blocked", "done", "budget"];
var ACCENT_IDS = ["blue", "green", "azure", "wine", "ochre", "paper"];
var DEFAULT_SETTINGS = {
  activeAdapter: "mock",
  concurrency: 2,
  cli: { profile: "auto", command: "claude", argsTemplate: "", env: {}, model: "", timeoutSec: 1800 },
  api: {
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5",
    apiKey: "",
    temperature: 0.2,
    maxTurns: 30
  },
  mock: { writeFiles: true, stepDelayMs: 420 },
  prompt: { forbidQuestions: true, carryOverChars: 1200, contextChars: 6e3, specifyTemplates: [], specifyTemplateId: "builtin" },
  autoCommit: true,
  autoArchiveDone: true,
  autoArchiveDays: 15,
  autoPurgeTrash: false,
  autoPurgeTrashDays: 30,
  dailyTokenBudget: 0,
  taskTokenBudget: 0,
  autoCleanMergedWorktrees: false,
  worktreeKeepRecent: 3,
  autoStartUnblocked: true,
  webhookUrl: "",
  webhookEvents: ["review", "blocked"],
  prCommand: "gh",
  theme: "dark",
  accent: "blue",
  // 新闻合集：默认只开「全站热门 + 科技分区 + AI 相关」，其余分区由用户在设置里自己勾
  feed: {
    enabled: true,
    autoRefresh: true,
    githubTtlMin: 60,
    biliTtlMin: 30,
    githubToken: "",
    githubNewRepos: true,
    keywords: DEFAULT_FEED_KEYWORDS,
    biliZones: [188],
    biliIncludePopular: true,
    biliAiVirtual: true,
    biliCookie: "",
    perZoneLimit: 20,
    trendTopN: 5,
    upMids: []
  },
  // 备份：默认开启本地快照，范围轻量（结构+线程+feed，不含附件/事件）
  backup: {
    enabled: true,
    autoOnChange: true,
    captureOnExit: true,
    minIntervalMin: 10,
    keepRecent: 24,
    keepDaily: 12,
    keepWeekly: 8,
    keepMonthly: 12,
    maxBytesMb: 2048,
    includeAttachments: false,
    includeEvents: false,
    defaultMode: "lean"
  },
  // 飞书：默认关（要用户自己按向导填 App ID / Secret / app_token / table_id）
  feishu: {
    enabled: false,
    site: "feishu",
    appId: "",
    appSecret: "",
    appToken: "",
    tableId: "",
    autoSync: false,
    minIntervalMin: 15,
    tombstone: true
  }
};
var BRIDGE_PROTOCOL_VERSION = 1;
var BRIDGE_SERVICE_ID = "ai-tasks-mgr";
var BRIDGE_CAPABILITIES = ["idea.create", "idea.start-preview", "idea.start"];

// src/shared/cli-presets.ts
var CLI_PRESET_LIST = [
  {
    id: "claude",
    label: "Claude Code",
    command: "claude",
    versionArgs: ["--version"],
    firstArgs: ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits"],
    resumeArgs: ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits", "--resume", "{resume}"],
    prompt: "stdin",
    format: "claude-stream-json",
    provides: { tools: true, usage: true, sessionId: true },
    note: "`acceptEdits` \u53EA\u81EA\u52A8\u63A5\u53D7\u6539\u6587\u4EF6\uFF0C\u8DD1\u547D\u4EE4\u4ECD\u8D70\u5B83\u81EA\u5DF1\u7684\u5141\u8BB8\u6E05\u5355\uFF1B\u8981\u5168\u81EA\u52A8\u5C31\u5728\u6A21\u677F\u91CC\u6362 `--dangerously-skip-permissions`\uFF08\u81EA\u5DF1\u627F\u62C5\u98CE\u9669\uFF09\u3002",
    install: "npm i -g @anthropic-ai/claude-code",
    modelFlag: ["--model", "{model}"]
  },
  {
    id: "codebuddy",
    label: "CodeBuddy Code\uFF08\u817E\u8BAF\uFF09",
    command: "codebuddy",
    aliases: ["cbc"],
    versionArgs: ["--version"],
    firstArgs: ["-p", "{prompt}", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits"],
    resumeArgs: ["-p", "{prompt}", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits", "--resume", "{resume}"],
    prompt: "argv",
    format: "claude-stream-json",
    provides: { tools: true, usage: true, sessionId: true },
    env: { CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS: "1" },
    note: "\u4E0E Claude Code \u540C\u4E00\u5957\u7EA6\u5B9A\uFF08`-p` \u6536\u4F4D\u7F6E\u53C2\u6570\u3001stream-json \u7684 init/assistant/result\u3001`--resume <id>` \u7EED\u4F1A\u8BDD\u3001`result` \u884C\u5E26 token \u4E0E\u8D39\u7528\uFF09\uFF0C\u6240\u4EE5\u65F6\u95F4\u7EBF\u548C\u7528\u91CF\u7EDF\u8BA1\u90FD\u662F\u5168\u7684\u3002\u6743\u9650\u8981\u5355\u72EC\u8BF4\uFF1A`-p` \u4E0B\u6CA1\u6709\u660E\u786E\u653E\u884C\u7B56\u7565\u65F6\uFF0C\u6539\u6587\u4EF6/\u8DD1\u547D\u4EE4/\u8054\u7F51\u4F1A\u88AB**\u76F4\u63A5\u963B\u6B62**\uFF08\u4E0D\u662F\u5F39\u7A97\u7B49\u4F60\uFF09\uFF0C\u9884\u8BBE\u7ED9\u4E86 `--permission-mode acceptEdits` \u53EA\u653E\u5F00\u6539\u6587\u4EF6\uFF1B\u8981\u5B83\u81EA\u5DF1\u8DD1\u547D\u4EE4\u5C31\u6362 `bypassPermissions` \u6216\u52A0 `-y`\uFF0C\u800C `-y` \u4E5F\u4E0D\u662F full pass \u2014\u2014 HIGH/CRITICAL \u547D\u4EE4\u4ECD\u8981\u786E\u8BA4\uFF0C\u65E0 TTY \u65F6\u90A3\u79CD\u786E\u8BA4\u7B49\u4E8E\u4EFB\u52A1\u5361\u6B7B\uFF08\u771F\u8981\u5728\u9694\u79BB\u6C99\u7BB1\u91CC\u5168\u653E\u884C\u662F\u73AF\u5883\u53D8\u91CF `CODEBUDDY_IS_SANDBOX=1`\uFF0C\u81EA\u5DF1\u8BC4\u4F30\uFF09\u3002\u5B83\u652F\u6301 `--model`\uFF08\u522B\u540D\u6216\u5168\u540D\uFF09\u4E0E `--autocompact 400k`\uFF08\u81EA\u52A8\u538B\u7F29\u7A97\u53E3\uFF09\u3002\u9884\u8BBE\u53E6\u5916\u6CE8\u5165\u4E86 `CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS=1`\uFF1A\u7EAF `-p` \u5355\u53D1\u6A21\u5F0F\u4E0D\u652F\u6301\u540E\u53F0\u4EFB\u52A1\uFF0C\u6A21\u578B\u4E00\u65E6 `run_in_background` \u4F1A\u76F4\u63A5\u62A5\u9519\uFF0C\u8FD9\u4E2A\u53D8\u91CF\u628A\u8BE5\u9009\u9879\u4ECE\u5DE5\u5177\u8868\u91CC\u85CF\u6389\u3002",
    install: "npm i -g @tencent-ai/codebuddy-code",
    modelFlag: ["--model", "{model}"]
  },
  {
    id: "codex",
    label: "OpenAI Codex CLI",
    command: "codex",
    versionArgs: ["--version"],
    firstArgs: ["exec", "--json", "--skip-git-repo-check", "-"],
    resumeArgs: ["exec", "resume", "{resume}", "--json", "--skip-git-repo-check", "-"],
    prompt: "stdin",
    format: "jsonl",
    provides: { tools: true, usage: true, sessionId: true },
    note: "\u6C99\u7BB1\u4E0E\u6279\u51C6\u7B56\u7565\u7531 codex \u81EA\u5DF1\u7684\u914D\u7F6E\u51B3\u5B9A\uFF1B\u9762\u677F\u5DF2\u7ECF\u628A cwd \u9650\u5B9A\u5728\u8BE5\u4EFB\u52A1\u7684 worktree \u91CC\u3002",
    install: "npm i -g @openai/codex",
    modelFlag: ["--model", "{model}"]
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    command: "gemini",
    versionArgs: ["--version"],
    firstArgs: ["-p", "{prompt}", "--output-format", "json", "--approval-mode=yolo", "--skip-trust"],
    resumeArgs: ["-p", "{prompt}", "--output-format", "json", "--approval-mode=yolo", "--skip-trust", "--resume", "{resume}"],
    prompt: "argv",
    format: "final-json",
    provides: { tools: false, usage: true, sessionId: true },
    note: "`-p` \u662F**\u53D6\u503C**\u800C\u4E0D\u662F\u5F00\u5173\uFF0C\u6240\u4EE5\u6307\u4EE4\u8D70 argv\uFF1B\u60F3\u9010\u5B57\u770B\u8F93\u51FA\u628A\u6A21\u677F\u91CC `json` \u6362\u6210 `stream-json`\uFF08\u9762\u677F\u4E24\u79CD\u90FD\u8BA4\uFF09\u3002",
    install: "npm i -g @google/gemini-cli",
    modelFlag: ["--model", "{model}"]
  },
  {
    id: "qwen",
    label: "Qwen Code",
    command: "qwen",
    versionArgs: ["--version"],
    firstArgs: ["-p", "{prompt}", "--output-format", "json", "--yolo"],
    resumeArgs: ["-p", "{prompt}", "--output-format", "json", "--yolo", "--resume", "{resume}"],
    prompt: "argv",
    format: "final-json",
    provides: { tools: false, usage: true, sessionId: true },
    note: "Gemini CLI \u7684\u5206\u652F\uFF0C\u65D7\u6807\u57FA\u672C\u4E00\u81F4\uFF1B\u7248\u672C\u5BF9\u4E0D\u4E0A\u5C31 `qwen --help` \u540E\u6539\u53C2\u6570\u6A21\u677F\u3002",
    install: "npm i -g @qwen-code/qwen-code",
    modelFlag: ["--model", "{model}"]
  },
  {
    id: "cursor",
    label: "Cursor CLI\uFF08cursor-agent\uFF09",
    command: "cursor-agent",
    versionArgs: ["--version"],
    firstArgs: ["-p", "{prompt}", "--output-format", "stream-json", "--stream-partial-output", "--force"],
    resumeArgs: ["-p", "{prompt}", "--output-format", "stream-json", "--stream-partial-output", "--force", "--resume", "{resume}"],
    prompt: "argv",
    format: "claude-stream-json",
    provides: { tools: true, usage: true, sessionId: true },
    note: "print \u6A21\u5F0F\u9ED8\u8BA4**\u53EA\u63D0\u8BAE\u4E0D\u843D\u5730**\uFF0C\u5FC5\u987B\u5E26 `--force`\uFF08\u672C\u9884\u8BBE\u5DF2\u542B\uFF09\u3002\u5B83\u7684 stream-json \u4E0E Claude \u540C\u5F62\uFF0C\u6240\u4EE5\u65F6\u95F4\u7EBF\u662F\u7ED3\u6784\u5316\u7684\u3002",
    install: "curl https://cursor.com/install -fsS | bash",
    modelFlag: ["--model", "{model}"]
  },
  {
    id: "opencode",
    label: "OpenCode",
    command: "opencode",
    versionArgs: ["--version"],
    firstArgs: ["run", "--format", "json", "--auto", "{prompt}"],
    resumeArgs: ["run", "--format", "json", "--auto", "-s", "{resume}", "{prompt}"],
    prompt: "argv",
    format: "jsonl",
    provides: { tools: true, usage: true, sessionId: true },
    note: "`--auto` \u653E\u884C\u672A\u88AB\u62D2\u7EDD\u7684\u8BF7\u6C42\uFF1B\u4F1A\u8BDD id \u4ECE\u4E8B\u4EF6\u91CC\u7684 `sessionID` \u6293\uFF0C\u7EED\u8F6E\u7528 `-s`\u3002",
    install: "curl -fsSL https://opencode.ai/install | bash",
    modelFlag: ["-m", "{model}"]
  },
  {
    id: "pi",
    label: "Pi\uFF08pi.dev\uFF09",
    command: "pi",
    strictMatch: true,
    versionArgs: ["--version"],
    // --mode json = 「JSONL 事件流 + 非交互」，第一行是 session 头（带 id），所以能续会话
    firstArgs: ["--mode", "json", "{prompt}"],
    resumeArgs: ["--mode", "json", "--session", "{resume}", "{prompt}"],
    prompt: "argv",
    format: "pi-jsonl",
    provides: { tools: true, usage: true, sessionId: true },
    note: "\u4E8B\u4EF6\u5F62\u4E0E Claude \u4E0D\u540C\uFF08`session` \u5934 + `tool_execution_start/end` + `message_update.usage`\uFF09\uFF0C\u9762\u677F\u6309 Pi \u7684\u5F62\u72B6\u89E3\u6790\u3002\u975E\u4EA4\u4E92\u6A21\u5F0F**\u4E0D\u4F1A\u5F39\u4FE1\u4EFB\u786E\u8BA4**\uFF1A\u6CA1\u5B58\u8FC7\u4FE1\u4EFB\u51B3\u5B9A\u65F6\u53EA\u662F\u5FFD\u7565\u9879\u76EE\u91CC\u7684 `.pi/`\u3001`AGENTS.md` \u7B49\u8D44\u6E90\uFF08\u8981\u5728\u672C\u9879\u76EE\u751F\u6548\uFF0C\u5148\u4EA4\u4E92\u8DD1\u4E00\u6B21 `/trust`\uFF09\u3002\u5B83\u81EA\u5E26\u7684 `ask_question` \u5DE5\u5177\u5728\u65E0\u4EBA\u5E94\u7B54\u65F6\u53EA\u4F1A\u628A\u8BDD\u7559\u5728\u7ED3\u5C3E\uFF0C\u5ACC\u5B83\u53CD\u590D\u8BF7\u793A\u5C31\u5728\u6A21\u677F\u91CC\u52A0 `--exclude-tools ask_question`\u3002",
    install: "npm i -g --ignore-scripts @earendil-works/pi-coding-agent",
    modelFlag: ["--model", "{model}"]
  },
  {
    id: "aider",
    label: "aider",
    command: "aider",
    versionArgs: ["--version"],
    firstArgs: ["--message-file", "{prompt_file}", "--yes-always", "--no-stream", "--no-show-release-notes"],
    resumeArgs: null,
    prompt: "file",
    format: "plain",
    provides: { tools: false, usage: true, sessionId: false },
    note: "\u7EAF\u6587\u672C\u8F93\u51FA\uFF1A\u9762\u677F\u4ECE `Edit:/Add:` \u884C\u8BA4\u6539\u52A8\u6587\u4EF6\u3001\u4ECE `Tokens: \u2026 Cost: \u2026` \u884C\u8BA4\u7528\u91CF\u3002\u5B83\u4F1A**\u81EA\u5DF1 commit**\uFF08\u9ED8\u8BA4\u5F00\uFF09\uFF0C\u6240\u4EE5\u300C\u81EA\u52A8\u63D0\u4EA4\u300D\u90A3\u683C\u91CD\u590D\u63D0\u4EA4\u662F\u6B63\u5E38\u73B0\u8C61\u3002\u8981\u7EED\u4F1A\u8BDD\u5C31\u81EA\u5DF1\u7528 `--load-session/--save-session` \u914D\u6A21\u677F\u3002",
    install: "python -m pip install -U aider-chat"
  },
  {
    id: "dsh",
    label: "DeepSeek Harness\uFF08dsh headless\uFF09",
    command: "dsh",
    /**
     * `dsh` 只有三个字母，放宽成前缀匹配会把 `dsh-xxx`、`dshell` 都认进来 —— 猜错比不猜糟。
     * （`dsh` 本身既是启动器又是命令名：装在 PATH 上就是一个可执行文件。）
     */
    strictMatch: true,
    versionArgs: ["--version"],
    /**
     * `dsh headless --json -`：一轮任务，事件流打在 stdout（session/status/thinking/text/tool_call/
     * tool_result/final），`-` 表示任务文本走 stdin（长指令不受 argv 长度限制）。
     */
    firstArgs: ["headless", "--json", "-"],
    /** 续轮：`--session-id <上一轮 session 事件里的 id>`（0.2.0-rc.2 起支持；未知 id 会报错） */
    resumeArgs: ["headless", "--json", "--session-id", "{resume}", "-"],
    prompt: "stdin",
    format: "dsh-json",
    provides: { tools: true, usage: true, sessionId: true },
    note: "\u628A\u672C\u673A\u7684 DSH\uFF08DeepSeek Harness\uFF09\u5F53\u5F15\u64CE\u7528\uFF1A\u4E00\u8F6E\u4E00\u4E2A\u4F1A\u8BDD\uFF0C`--session-id` \u7EED\u63A5\uFF1B\u5199\u6587\u4EF6\u7684\u80FD\u529B\u53D7 DSH \u81EA\u5DF1\u7684\u6C99\u7BB1\u7B56\u7565\u7BA1\uFF08\u9ED8\u8BA4 workspace-write\uFF0C\u5DE5\u4F5C\u76EE\u5F55\u5185\u53EF\u5199\uFF09\u3002\u8981\u5B83\u771F\u80FD\u5E72\u6D3B\uFF0CDSH \u90A3\u8FB9\u5F97\u5148\u914D\u597D\u6A21\u578B\u3002",
    install: "npm i -g @deepseek-ai/dsh"
  }
];
var GENERIC_CLI_PRESET = {
  id: "generic",
  label: "\u901A\u7528\uFF08stdin + \u65E5\u5FD7\uFF09",
  command: "",
  versionArgs: ["--version"],
  firstArgs: [],
  resumeArgs: null,
  prompt: "stdin",
  // 认不出的 CLI 里一半在吐 JSON 事件，所以还是先按 JSON 试，剩下逐行进日志
  format: "jsonl",
  provides: { tools: false, usage: false, sessionId: false },
  note: "\u6CA1\u5339\u914D\u5230\u9884\u8BBE\uFF1A\u6307\u4EE4\u8D70 stdin\uFF0CJSON \u884C\u5C3D\u91CF\u89E3\u6790\u3001\u5176\u4F59\u9010\u884C\u8FDB\u65E5\u5FD7\u3002\u591A\u6570 CLI \u8FD8\u9700\u8981\u300C\u975E\u4EA4\u4E92 / \u514D\u786E\u8BA4\u300D\u5F00\u5173\uFF0C\u53BB\u53C2\u6570\u6A21\u677F\u91CC\u8865\u4E0A\u3002",
  install: ""
};
var CLI_PRESET_IDS = ["auto", "custom", ...CLI_PRESET_LIST.map((p) => p.id)];
var CLI_PRESET_BY_ID = Object.fromEntries(
  CLI_PRESET_LIST.map((p) => [p.id, p])
);
function resolveCliPreset(profile, command) {
  const named = profile ? CLI_PRESET_BY_ID[profile] : void 0;
  if (named) return named;
  if (profile === "custom") return { ...GENERIC_CLI_PRESET, id: "custom", label: "\u81EA\u5B9A\u4E49\u6A21\u677F" };
  const base = (command || "").trim().split(/\s+/).pop() ?? "";
  const stem = base.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, "");
  if (!stem) return GENERIC_CLI_PRESET;
  for (const p of CLI_PRESET_LIST) {
    if (p.strictMatch) {
      if (stem === p.command) return p;
      continue;
    }
    if (stem === p.command || stem.startsWith(p.command)) return p;
    if (p.aliases?.some((a) => stem === a || stem.startsWith(`${a}-`))) return p;
  }
  return GENERIC_CLI_PRESET;
}
function describeCliInvocation(p, opts = {}) {
  const t = opts.template?.trim();
  const bits = [];
  bits.push(
    t ? t.includes("{prompt_file}") ? "\u6307\u4EE4\u8D70\u4E34\u65F6\u6587\u4EF6" : t.includes("{prompt}") ? "\u6307\u4EE4\u8D70\u53C2\u6570" : "\u6307\u4EE4\u8D70 stdin" : p.prompt === "stdin" ? "\u6307\u4EE4\u8D70 stdin" : p.prompt === "file" ? "\u6307\u4EE4\u8D70\u4E34\u65F6\u6587\u4EF6" : "\u6307\u4EE4\u8D70\u53C2\u6570"
  );
  bits.push(
    p.format === "claude-stream-json" ? "stream-json \u7ED3\u6784\u5316\u65F6\u95F4\u7EBF" : p.format === "pi-jsonl" ? "JSONL \u4E8B\u4EF6\uFF08session \u5934 + tool_execution_*\uFF09" : p.format === "dsh-json" ? "DSH \u8FD0\u884C\u4E8B\u4EF6\u6D41\uFF08session/tool/final\uFF09" : p.format === "jsonl" ? "JSONL \u4E8B\u4EF6" : p.format === "final-json" ? "\u7ED3\u675F\u65F6\u4E00\u4E2A JSON" : "\u7EAF\u6587\u672C\u65E5\u5FD7"
  );
  const resumable = t ? t.includes("{resume}") : Boolean(p.resumeArgs);
  bits.push(resumable ? "\u652F\u6301\u591A\u8F6E\u7EED\u4F1A\u8BDD" : "\u4E0D\u652F\u6301\u7EED\u4F1A\u8BDD\uFF08\u8FFD\u52A0\u6307\u4EE4\u4F1A\u65B0\u5F00\u4E00\u8F6E\uFF09");
  return bits.join(" \xB7 ");
}

// src/shared/specify-templates.ts
var BUILTIN_SPECIFY_TEMPLATE = {
  id: "builtin",
  name: "\u9ED8\u8BA4\uFF1A\u76EE\u6807 / \u8303\u56F4 / \u9A8C\u6536 / \u98CE\u9669 / \u62C6\u89E3",
  instruction: [
    "\u8BF7\u628A\u8FD9\u4E2A\u5F00\u53D1\u60F3\u6CD5\u68B3\u7406\u6210\u300C\u53EF\u5B9E\u73B0\u89C4\u683C\u300D\uFF0C\u8F93\u51FA Markdown\uFF0C\u5305\u542B\uFF1A",
    "1. \u76EE\u6807\u4E0E\u7528\u6237\u4EF7\u503C\uFF082-3 \u53E5\uFF09",
    "2. \u5B9E\u73B0\u8303\u56F4\uFF08\u505A\u4EC0\u4E48 / \u660E\u786E\u4E0D\u505A\u4EC0\u4E48\uFF09",
    "3. \u9A8C\u6536\u6807\u51C6\uFF08\u53EF\u52FE\u9009\u7684\u6E05\u5355\uFF09",
    "4. \u6280\u672F\u8981\u70B9\u4E0E\u98CE\u9669",
    "5. \u5EFA\u8BAE\u62C6\u89E3\u6210\u54EA\u51E0\u4E2A\u5F00\u53D1\u4EFB\u52A1"
  ].join("\n")
};
var BUILTIN_SPECIFY_TEMPLATE_ID = BUILTIN_SPECIFY_TEMPLATE.id;
var SPECIFY_PLACEHOLDERS = ["{title}", "{description}", "{spec}"];
function usesSpecifyPlaceholders(instruction) {
  return SPECIFY_PLACEHOLDERS.some((p) => String(instruction ?? "").includes(p));
}
function renderSpecifyInstruction(tpl, idea) {
  const instruction = String(tpl?.instruction ?? "").trim() || BUILTIN_SPECIFY_TEMPLATE.instruction;
  if (usesSpecifyPlaceholders(instruction)) {
    return instruction.replaceAll("{title}", idea.title).replaceAll("{description}", idea.description?.trim() || "\uFF08\u6CA1\u6709\u6B63\u6587\uFF09").replaceAll("{spec}", idea.spec?.trim() || "\uFF08\u8FD8\u6CA1\u6709\u89C4\u683C\u8349\u7A3F\uFF09");
  }
  return [
    instruction,
    "",
    `\u60F3\u6CD5\u6807\u9898\uFF1A${idea.title}`,
    idea.description?.trim() ? `\u60F3\u6CD5\u539F\u6587\uFF1A
${idea.description.trim()}` : "",
    idea.spec?.trim() ? `\u5DF2\u6709\u7684\u89C4\u683C\u8349\u7A3F\uFF1A
${idea.spec.trim()}` : ""
  ].filter(Boolean).join("\n");
}
function normalizeSpecifyTemplates(input) {
  const arr = Array.isArray(input) ? input : [];
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const t = raw;
    const instruction = String(t.instruction ?? "").trim().slice(0, 8e3);
    if (!instruction) continue;
    let id = String(t.id ?? "").trim().replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
    if (!id || seen.has(id)) id = generateSpecifyTemplateId(seen);
    seen.add(id);
    out.push({ id, name: String(t.name ?? "").trim().slice(0, 40) || "\u672A\u547D\u540D\u6A21\u677F", instruction });
    if (out.length >= 12) break;
  }
  return out;
}
function generateSpecifyTemplateId(existing = []) {
  const taken = new Set(existing);
  for (let i = 0; i < 1e3; i += 1) {
    const id = `tpl_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}${i === 0 ? "" : `_${i}`}`;
    if (!taken.has(id)) return id.slice(0, 40);
  }
  return `tpl_${Date.now().toString(36)}`;
}
function resolveSpecifyTemplate(templates, id) {
  const list = Array.isArray(templates) ? templates : [];
  if (id === BUILTIN_SPECIFY_TEMPLATE_ID) return BUILTIN_SPECIFY_TEMPLATE;
  return list.find((t) => t.id === id) ?? BUILTIN_SPECIFY_TEMPLATE;
}

// src/core/events.ts
var EventBus = class {
  listeners = /* @__PURE__ */ new Set();
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  publish(ev) {
    for (const fn of [...this.listeners]) {
      try {
        fn(ev);
      } catch {
      }
    }
  }
  get size() {
    return this.listeners.size;
  }
};
var bus = new EventBus();

// src/core/store/store.ts
var emptyArray = () => [];
var PersistQueue = class {
  constructor(file, label, mode) {
    this.file = file;
    this.label = label;
    this.mode = mode;
  }
  chain = Promise.resolve();
  schedule(getValue) {
    this.chain = this.chain.then(() => writeJsonAtomic(this.file, getValue(), this.mode)).catch((err) => {
      console.error(`[${this.label}] persist failed:`, err);
    });
  }
  flush() {
    return this.chain;
  }
};
var Store = class _Store {
  bus;
  ideas = /* @__PURE__ */ new Map();
  tasks = /* @__PURE__ */ new Map();
  repos = /* @__PURE__ */ new Map();
  settingsCache = { ...DEFAULT_SETTINGS };
  threadCache = /* @__PURE__ */ new Map();
  queue = {
    ideas: new PersistQueue(paths.file("ideas.json"), "ideas"),
    tasks: new PersistQueue(paths.file("tasks.json"), "tasks"),
    repos: new PersistQueue(paths.file("repos.json"), "repos"),
    // settings 里可能有 API key，落盘时收紧到仅本人可读
    settings: new PersistQueue(paths.file("settings.json"), "settings", 384)
  };
  closed = false;
  constructor(bus2) {
    this.bus = bus2;
  }
  static async open(bus2 = new EventBus()) {
    paths.ensure();
    const s = new _Store(bus2);
    const [ideas, tasks, repos, settings] = await Promise.all([
      readJson(paths.file("ideas.json"), emptyArray()),
      readJson(paths.file("tasks.json"), emptyArray()),
      readJson(paths.file("repos.json"), emptyArray()),
      readJson(paths.file("settings.json"), DEFAULT_SETTINGS)
    ]);
    for (const i of ideas) s.ideas.set(i.id, { ...i, workDir: typeof i.workDir === "string" && i.workDir.trim() ? i.workDir : null });
    for (const t of tasks) s.tasks.set(t.id, t);
    for (const r of repos) s.repos.set(r.id, r);
    s.settingsCache = normalizeSettings(settings);
    s.sweepAutoArchive();
    s.sweepAutoPurgeTrash();
    return s;
  }
  /**
   * 自动归档：若开启 `autoArchiveDone`（默认开启），扫描所有 `status === 'done'` 且完成时间
   * （`closedAt ?? updatedAt ?? createdAt`）距今超过 `autoArchiveDays`（默认 15 天）的想法，
   * 自动转为 `'archived'` 并记录 `previousStatus: 'done'` 与 `archivedAt`。
   */
  sweepAutoArchive(now = Date.now()) {
    const autoOn = this.settingsCache.autoArchiveDone ?? true;
    if (!autoOn) return 0;
    const days = clampInt(this.settingsCache.autoArchiveDays, 1, 365, DEFAULT_SETTINGS.autoArchiveDays ?? 15);
    const cutoff = now - days * 864e5;
    let count = 0;
    for (const cur of this.ideas.values()) {
      if (cur.status !== "done") continue;
      const doneAt = cur.closedAt ?? cur.updatedAt ?? cur.createdAt;
      if (doneAt <= cutoff) {
        const next = {
          ...cur,
          status: "archived",
          previousStatus: "done",
          archivedAt: now,
          updatedAt: now
        };
        this.ideas.set(cur.id, next);
        count += 1;
        this.bus.publish({ type: "entity", entity: "idea", id: cur.id, op: "upsert" });
      }
    }
    if (count > 0) {
      this.queue.ideas.schedule(() => [...this.ideas.values()]);
    }
    return count;
  }
  /**
   * 回收站超期自动清理：若开启 `autoPurgeTrash`（默认关闭），扫描所有 `status === 'trash'` 且移入时间
   * （`trashedAt ?? updatedAt ?? createdAt`）距今超过 `autoPurgeTrashDays`（默认 30 天）的想法，
   * 自动彻底删除。
   */
  sweepAutoPurgeTrash(now = Date.now()) {
    const autoOn = this.settingsCache.autoPurgeTrash ?? false;
    if (!autoOn) return 0;
    const days = clampInt(this.settingsCache.autoPurgeTrashDays, 1, 365, DEFAULT_SETTINGS.autoPurgeTrashDays ?? 30);
    const cutoff = now - days * 864e5;
    const toDelete = [];
    for (const cur of this.ideas.values()) {
      if (cur.status !== "trash") continue;
      const trashedAt = cur.trashedAt ?? cur.updatedAt ?? cur.createdAt;
      if (trashedAt <= cutoff) {
        toDelete.push(cur.id);
      }
    }
    for (const id of toDelete) {
      try {
        fs2.rmSync(paths.attachmentBlobDir(id), { recursive: true, force: true });
      } catch {
      }
      this.deleteIdea(id);
    }
    return toDelete.length;
  }
  /* ---------------- ideas ---------------- */
  listIdeas(filter = {}) {
    let out = [...this.ideas.values()];
    if (filter.status) {
      out = out.filter((i) => i.status === filter.status);
    } else if (!filter.includeTrash) {
      out = out.filter((i) => i.status !== "trash");
    }
    if (filter.repoId) out = out.filter((i) => i.repoId === filter.repoId);
    if (filter.tag) out = out.filter((i) => i.tags.includes(filter.tag));
    if (filter.q) {
      const q = filter.q.toLowerCase();
      out = out.filter(
        (i) => i.title.toLowerCase().includes(q) || i.description.toLowerCase().includes(q) || i.tags.some((t) => t.toLowerCase().includes(q))
      );
    }
    const rank = { p0: 0, p1: 1, p2: 2, p3: 3 };
    return out.sort(
      (a, b) => (rank[a.priority] ?? 9) - (rank[b.priority] ?? 9) || b.starred - a.starred || b.updatedAt - a.updatedAt
    );
  }
  getIdea(id) {
    return this.ideas.get(id);
  }
  /** 按外部来源引用（plugin + taskId）查找非回收站想法，用于桥接幂等去重 */
  findIdeaBySourceRef(sourceRef) {
    for (const idea of this.ideas.values()) {
      if (idea.status === "trash") continue;
      if (idea.sourceRef && idea.sourceRef.plugin === sourceRef.plugin && idea.sourceRef.taskId === sourceRef.taskId) {
        return idea;
      }
    }
    return void 0;
  }
  /** 按桥接创建幂等键查找非回收站想法 */
  findIdeaByBridgeKey(key) {
    if (!key) return void 0;
    for (const idea of this.ideas.values()) {
      if (idea.status === "trash") continue;
      if (idea.bridgeIdempotencyKey === key) return idea;
    }
    return void 0;
  }
  putIdea(idea) {
    this.ideas.set(idea.id, idea);
    this.queue.ideas.schedule(() => [...this.ideas.values()]);
    this.bus.publish({ type: "entity", entity: "idea", id: idea.id, op: "upsert" });
    return idea;
  }
  deleteIdea(id) {
    this.ideas.delete(id);
    for (const t of [...this.tasks.values()]) if (t.ideaId === id) this.tasks.delete(t.id);
    this.threadCache.delete(id);
    this.queue.ideas.schedule(() => [...this.ideas.values()]);
    this.queue.tasks.schedule(() => [...this.tasks.values()]);
    this.bus.publish({ type: "entity", entity: "idea", id, op: "delete" });
  }
  /* ---------------- tasks ---------------- */
  listTasks(filter = {}) {
    let out = [...this.tasks.values()];
    if (filter.ideaId) out = out.filter((t) => t.ideaId === filter.ideaId);
    if (filter.status) {
      const want = Array.isArray(filter.status) ? filter.status : [filter.status];
      out = out.filter((t) => want.includes(t.status));
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }
  getTask(id) {
    return this.tasks.get(id);
  }
  /** 按桥接启动幂等键查找任务 */
  findTaskByIdempotencyKey(key) {
    if (!key) return void 0;
    for (const task of this.tasks.values()) {
      if (task.idempotencyKey === key) return task;
    }
    return void 0;
  }
  putTask(task) {
    this.tasks.set(task.id, task);
    this.queue.tasks.schedule(() => [...this.tasks.values()]);
    this.bus.publish({ type: "entity", entity: "task", id: task.id, op: "upsert" });
    return task;
  }
  deleteTask(id) {
    this.tasks.delete(id);
    this.queue.tasks.schedule(() => [...this.tasks.values()]);
    this.bus.publish({ type: "entity", entity: "task", id, op: "delete" });
  }
  /* ---------------- repos ---------------- */
  listRepos() {
    return [...this.repos.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  getRepo(id) {
    return this.repos.get(id);
  }
  putRepo(repo) {
    this.repos.set(repo.id, repo);
    this.queue.repos.schedule(() => [...this.repos.values()]);
    this.bus.publish({ type: "entity", entity: "repo", id: repo.id, op: "upsert" });
    return repo;
  }
  deleteRepo(id) {
    this.repos.delete(id);
    this.queue.repos.schedule(() => [...this.repos.values()]);
    this.bus.publish({ type: "entity", entity: "repo", id, op: "delete" });
  }
  /* ---------------- settings ---------------- */
  getSettings() {
    return this.settingsCache;
  }
  async setSettings(patch) {
    const next = normalizeSettings({
      ...this.settingsCache,
      ...patch,
      cli: { ...this.settingsCache.cli, ...patch.cli ?? {} },
      api: { ...this.settingsCache.api, ...patch.api ?? {} },
      mock: { ...this.settingsCache.mock, ...patch.mock ?? {} }
    });
    this.settingsCache = next;
    this.queue.settings.schedule(() => next);
    await this.queue.settings.flush();
    return next;
  }
  /* ---------------- threads (per-idea 多轮对话) ---------------- */
  async listMessages(ideaId) {
    const cached = this.threadCache.get(ideaId);
    if (cached) return cached.slice();
    const msgs = await readJsonl(this.threadFile(ideaId));
    this.threadCache.set(ideaId, msgs);
    return msgs.slice();
  }
  async appendMessages(ideaId, msgs) {
    if (!msgs.length) return;
    const file = this.threadFile(ideaId);
    await fsp2.mkdir(path3.dirname(file), { recursive: true });
    await appendJsonl(file, msgs);
    const cache = this.threadCache.get(ideaId) ?? [];
    this.threadCache.set(ideaId, [...cache, ...msgs]);
    for (const m of msgs) {
      this.bus.publish({ type: "entity", entity: "message", id: m.id, op: "upsert" });
    }
  }
  /** 重写整个 thread（用于把 streaming 占位消息定稿） */
  async rewriteThread(ideaId, msgs) {
    const file = this.threadFile(ideaId);
    await fsp2.mkdir(path3.dirname(file), { recursive: true });
    await fsp2.writeFile(file, msgs.map((m) => JSON.stringify(m)).join("\n") + "\n", "utf8");
    this.threadCache.set(ideaId, msgs);
    this.bus.publish({ type: "entity", entity: "message", id: ideaId, op: "upsert" });
  }
  threadFile(ideaId) {
    return path3.join(paths.data(), "threads", `${ideaId}.jsonl`);
  }
  /* ---------------- agent event log ---------------- */
  async appendEvents(events) {
    const byTask = /* @__PURE__ */ new Map();
    for (const e of events) {
      const arr = byTask.get(e.taskId) ?? [];
      arr.push(e);
      byTask.set(e.taskId, arr);
    }
    await Promise.all(
      [...byTask.entries()].map(([taskId, evs]) => appendJsonl(paths.eventLog(taskId), evs))
    );
  }
  async listEvents(taskId, opts = {}) {
    const all = await readJsonl(paths.eventLog(taskId), { tail: opts.tail });
    if (opts.afterSeq != null) return all.filter((e) => e.seq > opts.afterSeq);
    return all;
  }
  /* ---------------- lifecycle ---------------- */
  async flush() {
    await Promise.all(Object.values(this.queue).map((q) => q.flush()));
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.flush();
  }
  /** 用于「导出/备份」，一次性拿到全部实体 */
  snapshot() {
    return {
      ideas: [...this.ideas.values()],
      tasks: [...this.tasks.values()],
      repos: [...this.repos.values()],
      settings: this.settingsCache
    };
  }
  /**
   * 从磁盘重新读一遍（恢复快照 / 导入备份后必须调，否则内存里还是旧数据，
   * 界面会「恢复成功但看起来没变」）。恢复的文件已经落盘，这里只负责换掉缓存，
   * 并推一遍 entity 事件让界面刷新。
   */
  async reload() {
    this.threadCache.clear();
    const [ideas, tasks, repos, settings] = await Promise.all([
      readJson(paths.file("ideas.json"), emptyArray()),
      readJson(paths.file("tasks.json"), emptyArray()),
      readJson(paths.file("repos.json"), emptyArray()),
      readJson(paths.file("settings.json"), DEFAULT_SETTINGS)
    ]);
    this.ideas.clear();
    this.tasks.clear();
    this.repos.clear();
    for (const i of ideas) this.ideas.set(i.id, { ...i, workDir: typeof i.workDir === "string" && i.workDir.trim() ? i.workDir : null });
    for (const t of tasks) this.tasks.set(t.id, t);
    for (const r of repos) this.repos.set(r.id, r);
    this.settingsCache = normalizeSettings(settings);
    for (const i of this.ideas.values()) this.bus.publish({ type: "entity", entity: "idea", id: i.id, op: "upsert" });
    for (const t of this.tasks.values()) this.bus.publish({ type: "entity", entity: "task", id: t.id, op: "upsert" });
    for (const r of this.repos.values()) this.bus.publish({ type: "entity", entity: "repo", id: r.id, op: "upsert" });
  }
  static exists(root) {
    return fs2.existsSync(path3.join(root, "data", "ideas.json"));
  }
};
function normalizeSettings(input) {
  const s = input ?? {};
  return {
    activeAdapter: ["mock", "cli", "api"].includes(s.activeAdapter) ? s.activeAdapter : DEFAULT_SETTINGS.activeAdapter,
    concurrency: clampInt(s.concurrency, 1, 8, DEFAULT_SETTINGS.concurrency),
    cli: {
      ...DEFAULT_SETTINGS.cli,
      ...s.cli ?? {},
      // 只认在册的预设名，认不出来一律回到 auto（按命令名猜），避免手改 JSON 打出个死值
      profile: CLI_PRESET_IDS.includes(String(s.cli?.profile ?? "")) ? s.cli.profile : "auto",
      timeoutSec: clampInt(s.cli?.timeoutSec, 0, 24 * 3600, DEFAULT_SETTINGS.cli.timeoutSec),
      // 模型名不做白名单：各家写法差很远（别名 / 全名 / provider/id），这里只清洗与限长
      model: String(s.cli?.model ?? "").trim().slice(0, 120)
    },
    prompt: {
      forbidQuestions: s.prompt?.forbidQuestions ?? DEFAULT_SETTINGS.prompt.forbidQuestions,
      carryOverChars: clampInt(s.prompt?.carryOverChars, 0, 2e4, DEFAULT_SETTINGS.prompt.carryOverChars),
      contextChars: clampInt(s.prompt?.contextChars, 0, 1e5, DEFAULT_SETTINGS.prompt.contextChars),
      // 「AI 梳理」模板：白名单式重建 —— 新字段漏在这里就会被一保存就丢（踩过 accent 的坑）
      specifyTemplates: normalizeSpecifyTemplates(s.prompt?.specifyTemplates),
      specifyTemplateId: normalizedSpecifyTemplateId(
        s.prompt?.specifyTemplateId,
        normalizeSpecifyTemplates(s.prompt?.specifyTemplates)
      )
    },
    api: {
      ...DEFAULT_SETTINGS.api,
      ...s.api ?? {},
      temperature: clampNum(s.api?.temperature, 0, 1.5, DEFAULT_SETTINGS.api.temperature),
      maxTurns: clampInt(s.api?.maxTurns, 1, 200, DEFAULT_SETTINGS.api.maxTurns)
    },
    mock: {
      writeFiles: s.mock?.writeFiles ?? true,
      stepDelayMs: clampInt(s.mock?.stepDelayMs, 0, 4e3, DEFAULT_SETTINGS.mock.stepDelayMs)
    },
    autoCommit: s.autoCommit ?? DEFAULT_SETTINGS.autoCommit,
    autoArchiveDone: s.autoArchiveDone ?? DEFAULT_SETTINGS.autoArchiveDone ?? true,
    autoArchiveDays: clampInt(s.autoArchiveDays, 1, 365, DEFAULT_SETTINGS.autoArchiveDays ?? 15),
    autoPurgeTrash: s.autoPurgeTrash ?? DEFAULT_SETTINGS.autoPurgeTrash ?? false,
    autoPurgeTrashDays: clampInt(s.autoPurgeTrashDays, 1, 365, DEFAULT_SETTINGS.autoPurgeTrashDays ?? 30),
    dailyTokenBudget: clampInt(s.dailyTokenBudget, 0, 1e9, DEFAULT_SETTINGS.dailyTokenBudget ?? 0),
    taskTokenBudget: clampInt(s.taskTokenBudget, 0, 1e9, DEFAULT_SETTINGS.taskTokenBudget ?? 0),
    autoCleanMergedWorktrees: s.autoCleanMergedWorktrees ?? DEFAULT_SETTINGS.autoCleanMergedWorktrees ?? false,
    worktreeKeepRecent: clampInt(s.worktreeKeepRecent, 0, 50, DEFAULT_SETTINGS.worktreeKeepRecent ?? 3),
    autoStartUnblocked: s.autoStartUnblocked ?? DEFAULT_SETTINGS.autoStartUnblocked ?? true,
    webhookUrl: String(s.webhookUrl ?? DEFAULT_SETTINGS.webhookUrl ?? "").trim().slice(0, 500),
    webhookEvents: Array.isArray(s.webhookEvents) ? [...new Set(s.webhookEvents.filter((k) => WEBHOOK_EVENT_KINDS.includes(String(k))))] : [...DEFAULT_SETTINGS.webhookEvents ?? ["review", "blocked"]],
    prCommand: typeof s.prCommand === "string" ? s.prCommand : DEFAULT_SETTINGS.prCommand,
    theme: s.theme === "light" || s.theme === "system" ? s.theme : "dark",
    // 强调色只认在册预设，认不出来回 blue。这里之前漏了整个字段（白名单式重建没带它），
    // 导致设置页选了强调色一保存就被丢弃、界面弹回默认蓝
    accent: ACCENT_IDS.includes(String(s.accent)) ? s.accent : DEFAULT_SETTINGS.accent,
    // 新闻合集：整个子对象是白名单式重建 —— 新增字段必须在这里补，否则一保存就被丢弃
    feed: normalizeFeedSettings(s.feed),
    // 备份：同上，白名单式重建
    backup: normalizeBackupSettings(s.backup),
    // 飞书：同上（密钥只清洗不校验）
    feishu: normalizeFeishuSettings(s.feishu)
  };
}
function normalizedSpecifyTemplateId(id, templates) {
  const want = String(id ?? "").trim();
  if (want === BUILTIN_SPECIFY_TEMPLATE_ID) return want;
  return templates.some((t) => t.id === want) ? want : BUILTIN_SPECIFY_TEMPLATE_ID;
}
function strList(v, maxItems, maxLen = 60) {
  const arr = Array.isArray(v) ? v : [];
  const out = [];
  for (const item of arr) {
    const t = String(item ?? "").trim().slice(0, maxLen);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= maxItems) break;
  }
  return out;
}
function normalizeFeedSettings(input) {
  const d = DEFAULT_SETTINGS.feed;
  const s = input ?? {};
  const kw = s.keywords ?? {};
  const zones = Array.isArray(s.biliZones) ? [...new Set(s.biliZones.map((z) => Number(z)).filter((z) => BILI_ZONE_NAME.has(z)))].slice(0, 22) : d.biliZones;
  return {
    enabled: s.enabled ?? d.enabled,
    autoRefresh: s.autoRefresh ?? d.autoRefresh,
    githubTtlMin: clampInt(s.githubTtlMin, 10, 24 * 60, d.githubTtlMin),
    biliTtlMin: clampInt(s.biliTtlMin, 10, 24 * 60, d.biliTtlMin),
    // 密钥类只清洗不校验：不打印、不截断成半截（使用者自己粘贴）
    githubToken: String(s.githubToken ?? "").trim().slice(0, 200),
    githubNewRepos: s.githubNewRepos ?? d.githubNewRepos,
    keywords: {
      model: kw.model ? strList(kw.model, 80) : d.keywords.model,
      tool: kw.tool ? strList(kw.tool, 80) : d.keywords.tool,
      skill: kw.skill ? strList(kw.skill, 80) : d.keywords.skill,
      exclude: kw.exclude ? strList(kw.exclude, 80) : d.keywords.exclude
    },
    biliZones: zones,
    biliIncludePopular: s.biliIncludePopular ?? d.biliIncludePopular,
    biliAiVirtual: s.biliAiVirtual ?? d.biliAiVirtual,
    biliCookie: String(s.biliCookie ?? "").trim().slice(0, 500),
    // 关注 UP：只留数字 mid（界面上是链接，解析在 bilibili.parseUpLinks；这里做白名单兜底）
    upMids: strList(
      (Array.isArray(s.upMids) ? s.upMids : []).map((m) => String(m).replace(/\D/g, "")).filter((m) => m && m.length <= 20),
      50,
      20
    ),
    perZoneLimit: clampInt(s.perZoneLimit, 5, 100, d.perZoneLimit),
    trendTopN: clampInt(s.trendTopN, 3, 10, d.trendTopN)
  };
}
function normalizeBackupSettings(input) {
  const d = DEFAULT_SETTINGS.backup;
  const s = input ?? {};
  return {
    enabled: s.enabled ?? d.enabled,
    autoOnChange: s.autoOnChange ?? d.autoOnChange,
    captureOnExit: s.captureOnExit ?? d.captureOnExit,
    minIntervalMin: clampInt(s.minIntervalMin, 1, 24 * 60, d.minIntervalMin),
    keepRecent: clampInt(s.keepRecent, 1, 500, d.keepRecent),
    keepDaily: clampInt(s.keepDaily, 0, 365, d.keepDaily),
    keepWeekly: clampInt(s.keepWeekly, 0, 260, d.keepWeekly),
    keepMonthly: clampInt(s.keepMonthly, 0, 240, d.keepMonthly),
    maxBytesMb: clampInt(s.maxBytesMb, 0, 1024 * 100, d.maxBytesMb),
    includeAttachments: s.includeAttachments ?? d.includeAttachments,
    includeEvents: s.includeEvents ?? d.includeEvents,
    // 只认两种范围；认不出来回轻量（宁可少备份，不要意外把附件塞进每一份快照）
    defaultMode: s.defaultMode === "full" ? "full" : "lean"
  };
}
function normalizeFeishuSettings(input) {
  const d = DEFAULT_SETTINGS.feishu;
  const s = input ?? {};
  const secret = (v, max = 400) => String(v ?? "").trim().slice(0, max);
  return {
    enabled: s.enabled ?? d.enabled,
    site: s.site === "lark" ? "lark" : "feishu",
    appId: secret(s.appId, 120),
    appSecret: secret(s.appSecret),
    appToken: secret(s.appToken, 120),
    tableId: secret(s.tableId, 120),
    autoSync: s.autoSync ?? d.autoSync,
    minIntervalMin: clampInt(s.minIntervalMin, 1, 24 * 60, d.minIntervalMin),
    tombstone: s.tombstone ?? d.tombstone
  };
}
function clampInt(v, min, max, fallback) {
  const n = typeof v === "string" ? Number.parseInt(v, 10) : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}
function clampNum(v, min, max, fallback) {
  const n = typeof v === "string" ? Number.parseFloat(v) : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// src/shared/build-info.ts
var BUILD_AT = true ? "2026-10-13T09:46:17.907Z" : null;

// src/shared/api-rev.ts
var API_REV = 2;

// src/core/agents/adapter.ts
import { randomUUID } from "node:crypto";
import fs3 from "node:fs";
import os2 from "node:os";
import path4 from "node:path";
import zlib from "node:zlib";
var AgentUnavailableError = class extends Error {
  constructor(message, hint) {
    super(message);
    this.hint = hint;
    this.name = "AgentUnavailableError";
  }
};
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortError());
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new AbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
var AbortError = class extends Error {
  constructor() {
    super("\u5DF2\u88AB\u7528\u6237\u4E2D\u65AD");
    this.name = "AbortError";
  }
};
function isAbort(err) {
  return err instanceof AbortError || err?.name === "AbortError";
}
var AUTH_ERROR_PATTERNS = [
  // 裸状态码必须与认证词汇同行出现，免得把行号/大小里的「401」当成认证失败
  /\b401\b[^\n]{0,80}(auth|unauthorized|login|token|登录|认证)|(?:auth|unauthorized|login|token|登录|认证)[^\n]{0,80}\b401\b/i,
  /\b403\b[^\n]{0,80}(auth|unauthorized|login|token|登录|认证|forbidden)|(?:auth|unauthorized|login|token|登录|认证|forbidden)[^\n]{0,80}\b403\b/i,
  /unauthorized/i,
  /authentication required/i,
  /please use \/login/i,
  /not (?:logged in|authenticated)|authentication (?:failed|expired|error)/i,
  /invalid (?:api[- ]?key|token|credentials?)|(?:api[- ]?key|token|credentials?) (?:invalid|expired)/i,
  /登录(?:已)?(?:过期|失效)|请(?:先)?(?:重新)?登录|尚未登录|未登录|需要(?:重新)?登录|认证失败/i
];
function looksLikeAuthError(text) {
  if (!text) return false;
  return AUTH_ERROR_PATTERNS.some((re) => re.test(text));
}
var WRITER_HELD_PATTERNS = [
  /is already owned by an active write handle/i,
  /SessionAlreadyOwnedError/i,
  /session\/writer-held/i,
  /is live in this process,\s*so the one-shot runner cannot own an exclusive run interval/i
];
function looksLikeWriterHeldError(text, fallbackSessionId = null) {
  if (!text) return { held: false, sessionId: fallbackSessionId };
  const held = WRITER_HELD_PATTERNS.some((re) => re.test(text));
  if (!held) return { held: false, sessionId: fallbackSessionId };
  const m = text.match(/session\s+["']([^"']+)["']/i);
  return { held: true, sessionId: m?.[1] ?? fallbackSessionId };
}
function explainWriterHeldError(sessionId, raw) {
  const sid = sessionId ? `\uFF08${sessionId}\uFF09` : "";
  const tail = raw ? `
\u2015\u2015
\u539F\u59CB\u9519\u8BEF\uFF1A${raw.trim()}` : "";
  return `\u8BE5\u4F1A\u8BDD${sid}\u6B63\u88AB DSH \u684C\u9762\u7248\u6253\u5F00\uFF08\u6216\u53E6\u4E00\u8F6E\u5BF9\u8BDD\u6B63\u5728\u6267\u884C\uFF09\uFF0C\u5360\u7528\u7740\u5355\u5199\u8005\u9501\uFF0C\u672C\u8F6E\u6307\u4EE4\u5C1A\u672A\u53D1\u9001\u3002\u8BF7\u7B49\u684C\u9762\u7248\u91CC\u8BE5\u4F1A\u8BDD\u5F53\u524D\u56DE\u590D\u7ED3\u675F\uFF08\u82E5\u88AB\u5916\u90E8\u8FDB\u7A0B\u5360\u7528\u5219\u5148\u5173\u95ED\u8BE5\u8FDB\u7A0B\u6216\u91CD\u542F\u684C\u9762\u7248\uFF09\uFF0C\u7136\u540E\u76F4\u63A5\u70B9\u300C\u91CD\u8BD5\u672C\u8F6E\u300D\u3002${tail}`;
}
var WriterHeldError = class extends Error {
  constructor(message, sessionId = null, rawMessage) {
    super(message);
    this.sessionId = sessionId;
    this.rawMessage = rawMessage;
    this.name = "WriterHeldError";
  }
  code = "writer-held";
  retryable = true;
};
var CORRUPT_SESSION_PATTERNS = [
  /stored session\s+["']?[^"'\n]+["']?\s+is corrupt/i,
  /stored log is corrupt/i,
  /SessionFormatError/i,
  /SessionPersistenceCorruptionError/i,
  /SESSION_QUERY_CORRUPT_SESSION/i,
  /agent\/inbox\/spliced requires message objects/i,
  /user\/message requires an object/i
];
function extractRawLogPathFromError(text) {
  if (!text) return null;
  const m = text.match(/\(raw log:\s*([^)\r\n]+)\)/i);
  return m?.[1]?.trim() || null;
}
function looksLikeCorruptSessionError(text, fallbackSessionId = null) {
  if (!text) return { corrupt: false, sessionId: fallbackSessionId, rawLogPath: null };
  const corrupt = CORRUPT_SESSION_PATTERNS.some((re) => re.test(text));
  if (!corrupt) return { corrupt: false, sessionId: fallbackSessionId, rawLogPath: null };
  const m = text.match(/session\s+["']([^"']+)["']/i);
  return {
    corrupt: true,
    sessionId: m?.[1] ?? fallbackSessionId,
    rawLogPath: extractRawLogPathFromError(text)
  };
}
function scanZstdFrames(buffer) {
  const ZSTD_MAGIC = 4247762216;
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) break;
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`invalid zstd frame magic at byte ${offset}`);
    }
    offset += 4;
    if (offset === buffer.length) break;
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) {
      throw new Error(`reserved zstd frame-header bit at byte ${offset - 1}`);
    }
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? singleSegment ? 1 : 0 : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) break;
    offset += remainingHeaderBytes;
    for (; ; ) {
      if (buffer.length - offset < 3) return frames;
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = blockHeader >>> 1 & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) {
        throw new Error(`reserved zstd block type at byte ${offset - 3}`);
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return frames;
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) break;
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return frames;
}
function isValidV4UserMessageObject(val) {
  if (typeof val !== "object" || val === null || Array.isArray(val)) return false;
  const obj = val;
  if (typeof obj.id !== "string" || !obj.id.trim()) return false;
  if (obj.role !== "user") return false;
  if (!Array.isArray(obj.content)) return false;
  const src = obj.source;
  if (typeof src !== "object" || src === null || Array.isArray(src)) return false;
  const kind = src.kind;
  if (typeof kind !== "string" || !kind.trim() || kind === "plugin") return false;
  return true;
}
function coerceToV4UserMessageObject(val) {
  if (typeof val === "object" && val !== null && !Array.isArray(val)) {
    const obj = { ...val };
    if (typeof obj.id !== "string" || !obj.id.trim()) obj.id = randomUUID();
    obj.role = "user";
    if (!Array.isArray(obj.content)) {
      const text = typeof obj.text === "string" ? obj.text : typeof obj.content === "string" ? obj.content : "";
      obj.content = [{ type: "text", text }];
    }
    const src = obj.source;
    if (typeof src !== "object" || src === null || Array.isArray(src) || typeof src.kind !== "string" || !src.kind.trim() || src.kind === "plugin") {
      obj.source = { kind: "user" };
    }
    return obj;
  }
  return {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text: String(val ?? "") }],
    source: { kind: "user" }
  };
}
function repairDshSessionJsonlText(jsonlText) {
  let changed = false;
  let fixedCount = 0;
  const lines = jsonlText.split("\n").map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return line;
    }
    if (!parsed || typeof parsed !== "object") return line;
    if (parsed.type === "agent/inbox/spliced" && parsed.data && typeof parsed.data === "object" && !Array.isArray(parsed.data)) {
      const data = parsed.data;
      if (Array.isArray(data.inserted) && data.inserted.some((item) => !isValidV4UserMessageObject(item))) {
        changed = true;
        data.inserted = data.inserted.map((item) => {
          if (isValidV4UserMessageObject(item)) return item;
          fixedCount += 1;
          return coerceToV4UserMessageObject(item);
        });
        return JSON.stringify(parsed);
      }
    }
    if (parsed.type === "user/message" && !isValidV4UserMessageObject(parsed.data)) {
      changed = true;
      fixedCount += 1;
      parsed.data = coerceToV4UserMessageObject(parsed.data);
      return JSON.stringify(parsed);
    }
    return line;
  });
  return { changed, fixedCount, text: lines.join("\n") };
}
function repairDshSessionLogFile(logPath) {
  try {
    if (!logPath || !fs3.existsSync(logPath)) return { repaired: false, fixedCount: 0 };
    const raw = fs3.readFileSync(logPath);
    if (raw.length === 0) return { repaired: false, fixedCount: 0 };
    if (!logPath.endsWith(".zstd")) {
      const { changed, fixedCount, text } = repairDshSessionJsonlText(raw.toString("utf8"));
      if (!changed) return { repaired: false, fixedCount: 0 };
      fs3.writeFileSync(logPath, Buffer.from(text, "utf8"));
      return { repaired: true, fixedCount };
    }
    if (typeof zlib.zstdDecompressSync !== "function" || typeof zlib.zstdCompressSync !== "function") {
      return { repaired: false, fixedCount: 0 };
    }
    const frames = scanZstdFrames(raw);
    if (frames.length === 0) return { repaired: false, fixedCount: 0 };
    let totalFixed = 0;
    let anyChanged = false;
    const checksumFlag = zlib.constants?.ZSTD_c_checksumFlag;
    const compressOpts = typeof checksumFlag === "number" ? { params: { [checksumFlag]: 1 } } : void 0;
    const outFrames = frames.map((f) => {
      const slice = raw.subarray(f.start, f.end);
      const decoded = zlib.zstdDecompressSync(slice).toString("utf8");
      const { changed, fixedCount, text } = repairDshSessionJsonlText(decoded);
      if (!changed) return slice;
      anyChanged = true;
      totalFixed += fixedCount;
      return compressOpts ? zlib.zstdCompressSync(Buffer.from(text, "utf8"), compressOpts) : zlib.zstdCompressSync(Buffer.from(text, "utf8"));
    });
    if (!anyChanged) return { repaired: false, fixedCount: 0 };
    fs3.writeFileSync(logPath, Buffer.concat(outFrames));
    return { repaired: true, fixedCount: totalFixed };
  } catch {
    return { repaired: false, fixedCount: 0 };
  }
}
function findDshSessionLogPaths(sessionId, dshHome) {
  if (!sessionId || typeof sessionId !== "string") return [];
  const root = path4.join(dshHome || process.env.DSH_HOME || path4.join(os2.homedir(), ".dsh"), "sessions");
  if (!fs3.existsSync(root)) return [];
  const found = [];
  const collectInSessionDir = (sessionDir) => {
    try {
      if (!fs3.existsSync(sessionDir)) return;
      for (const entry of fs3.readdirSync(sessionDir, { withFileTypes: true })) {
        if (entry.isFile() && (entry.name.endsWith(".jsonl.zstd") || entry.name.endsWith(".jsonl"))) {
          found.push(path4.join(sessionDir, entry.name));
        }
      }
    } catch {
    }
  };
  collectInSessionDir(path4.join(root, sessionId));
  try {
    for (const bucket of fs3.readdirSync(root, { withFileTypes: true })) {
      if (!bucket.isDirectory() || bucket.name === sessionId) continue;
      collectInSessionDir(path4.join(root, bucket.name, sessionId));
    }
  } catch {
  }
  return found;
}
function repairDshSessionById(sessionId, errText, dshHome) {
  const candidates = /* @__PURE__ */ new Set();
  const fromErr = extractRawLogPathFromError(errText);
  if (fromErr) candidates.add(fromErr);
  if (sessionId) {
    for (const p of findDshSessionLogPaths(sessionId, dshHome)) candidates.add(p);
  }
  let repaired = false;
  let fixedCount = 0;
  const repairedPaths = [];
  for (const logPath of candidates) {
    const res = repairDshSessionLogFile(logPath);
    if (res.repaired) {
      repaired = true;
      fixedCount += res.fixedCount;
      repairedPaths.push(logPath);
    }
  }
  return { repaired, fixedCount, paths: repairedPaths };
}
function buildFollowUpInstruction(input) {
  const base = (input.rawInstruction ?? input.instruction).trim();
  const atts = input.context.attachments ?? [];
  const lastUser = [...input.context.priorMessages ?? []].reverse().find((m) => m.role === "user");
  const msgImgs = lastUser?.images ?? [];
  const lines = [base];
  if (msgImgs.length > 0) {
    const imgRefs = msgImgs.map((im) => {
      const matched = atts.find((a) => a.name === im.name || a.path.endsWith(`/${im.name}`));
      return matched ? `\`${matched.path}\`` : `\`${im.name}\``;
    });
    lines.push("", `\u672C\u8F6E\u9644\u56FE\uFF08\u5DF2\u653E\u5165\u5DE5\u4F5C\u533A\uFF0C\u53EF\u76F4\u63A5\u8BFB\u53D6\u67E5\u770B\uFF09\uFF1A${imgRefs.join("\u3001")}`);
  }
  if (atts.length > 0) {
    lines.push("", `\u53C2\u8003\u8D44\u6599\uFF08\u5DF2\u653E\u5165\u5DE5\u4F5C\u533A\uFF09\uFF1A${atts.map((a) => `\`${a.path}\`\uFF08${humanSize(a.size)}\uFF09`).join("\u3001")}`);
  }
  return lines.join("\n");
}
function commandsBlockedLine(verifyCommand) {
  const handoff = verifyCommand ? `\u9700\u8981\u8DD1\u6D4B\u8BD5\u6216\u6784\u5EFA\u65F6\u4E0D\u5FC5\u81EA\u5DF1\u8DD1\uFF1A\u672C\u8F6E\u7ED3\u675F\u540E\u9762\u677F\u4F1A\u6267\u884C\u4ED3\u5E93\u914D\u597D\u7684 \`${verifyCommand}\`\uFF0C\u5931\u8D25\u8F93\u51FA\u4F1A\u81EA\u52A8\u56DE\u704C\u7ED9\u4F60\u4E0B\u4E00\u8F6E\u3002` : "\u9700\u8981\u8DD1\u6D4B\u8BD5\u6216\u6784\u5EFA\u65F6\u522B\u81EA\u5DF1\u8DD1\uFF0C\u4E5F\u522B\u5361\u5728\u8FD9\u4E00\u70B9\u4E0A\uFF1A\u5728\u7ED3\u8BBA\u91CC\u7528\u4E00\u884C\u300C\u5EFA\u8BAE\u547D\u4EE4\uFF1A\u300D\u5199\u6E05\u8BE5\u8DD1\u4EC0\u4E48\uFF0C\u9762\u677F\u4F1A\u4EE3\u8DD1\u5E76\u628A\u5931\u8D25\u8F93\u51FA\u56DE\u704C\u7ED9\u4E0B\u4E00\u8F6E\u3002";
  return `- \u8FD9\u4E00\u8F6E\u4F60\u8FD0\u884C\u5728\u65E0\u7EC8\u7AEF\u6A21\u5F0F\u4E0B\uFF0C\u4EFB\u4F55\u9700\u8981\u6279\u51C6\u7684\u52A8\u4F5C\u90FD\u4F1A\u88AB**\u76F4\u63A5\u62D2\u7EDD**\uFF08\u6CA1\u6709\u4EBA\u6765\u70B9\u786E\u8BA4\uFF09\uFF1A\u4E0D\u8981\u7528 shell \u547D\u4EE4\u63A2\u6D4B\u76EE\u5F55\u7ED3\u6784\u6216\u8BFB\u6587\u4EF6\uFF0C\u7528\u8BFB\u6587\u4EF6 / \u641C\u7D22 / \u5217\u76EE\u5F55\u8FD9\u7C7B\u5DE5\u5177\u5373\u53EF\u3002${handoff}`;
}
function buildInstruction(input) {
  const { instruction, context } = input;
  const p = { ...DEFAULT_SETTINGS.prompt, ...input.settings.prompt ?? {} };
  const clip = (v, max) => max > 0 && v.length > max ? `${v.slice(0, max)}
\u2026\uFF08\u540E\u9762 ${v.length - max} \u5B57\u5DF2\u7701\u7565\uFF0C\u9700\u8981\u5C31\u770B\u4ED3\u5E93\u91CC\u7684\u539F\u6587\uFF09` : v;
  const parts = [
    `# \u4EFB\u52A1
${context.ideaTitle}`,
    context.description ? `## \u60F3\u6CD5\u539F\u6587
${clip(context.description, p.contextChars)}` : "",
    context.spec ? `## \u5DF2\u786E\u8BA4\u7684\u89C4\u683C (spec)
${clip(context.spec, p.contextChars)}` : "",
    context.attachments?.length ? `## \u53C2\u8003\u8D44\u6599\uFF08\u9762\u677F\u5DF2\u653E\u8FDB\u5DE5\u4F5C\u533A\uFF0C\u8DEF\u5F84\u76F8\u5BF9\u5F53\u524D\u76EE\u5F55\uFF09
${context.attachments.map((a) => `- \`${a.path}\`\uFF08${humanSize(a.size)}\uFF09`).join("\n")}` : "",
    carryOver(input, p.carryOverChars),
    `## \u672C\u8F6E\u8BF7\u6267\u884C
${instruction}`,
    "",
    "## \u7EA6\u675F",
    `- \u4F60\u53EA\u80FD\u5728\u5F53\u524D\u5DE5\u4F5C\u76EE\u5F55 ${input.workspacePath} \u5185\u6539\u52A8\uFF0C\u4E0D\u8981\u52A8\u4ED3\u5E93\u5916\u4EFB\u4F55\u6587\u4EF6\u3002`,
    context.ideaDir ? `- \u8FD9\u6761\u60F3\u6CD5\u7684\u6587\u4EF6\u5168\u90E8\u653E\u5728\u4ED3\u5E93\u5185\u7684 \`${context.ideaDir}/\` \u4E0B\uFF1A\u65B0\u5EFA\u4E0E\u4FEE\u6539\u90FD\u53EA\u5728\u8FD9\u76EE\u5F55\u91CC\uFF0C\u4E0D\u8981\u53BB\u78B0\u540C\u7EA7\u5176\u5B83\u60F3\u6CD5\u7684\u76EE\u5F55\u3002` : "",
    "- \u4E0D\u8981\u6267\u884C git push\uFF0C\u4E5F\u4E0D\u8981\u6539 git \u5386\u53F2\uFF1B\u63D0\u4EA4\u4E0E\u5426\u7531\u9762\u677F\u51B3\u5B9A\u3002",
    context.attachments?.length ? "- `.aitasks/attachments/` \u4E0B\u7684\u53C2\u8003\u8D44\u6599\u662F**\u53EA\u8BFB**\u80CC\u666F\u6750\u6599\uFF1A\u4E0D\u8981\u4FEE\u6539\u3001\u4E0D\u8981\u5220\u9664\uFF1B\u5B83\u4EEC\u5DF2\u88AB\u6392\u9664\u51FA git\uFF0C\u4E5F\u4E0D\u4F1A\u88AB\u63D0\u4EA4\u3002" : "",
    context.commandsBlocked === true ? commandsBlockedLine(context.verifyCommand) : "",
    context.allowedTools?.length ? `- \u672C\u8F6E\u9762\u677F\u5DF2\u6309\u4ED3\u5E93\u7684\u9A8C\u8BC1\u547D\u4EE4\u7ED9\u542F\u52A8\u53C2\u6570\u9644\u52A0\u4E86\u767D\u540D\u5355\uFF1A\`${context.allowedTools.join("\u3001")}\`\u3002\u8981\u8DD1\u9A8C\u8BC1\u5C31\u7528**\u9010\u5B57**\u547D\u4EE4\uFF1A${(context.allowedCommands ?? []).map((c) => `\`${c}\``).join("\u3001")} \u2014\u2014 \u4E0D\u8981\u52A0\u91CD\u5B9A\u5411\uFF08\u5982 2>&1\uFF09\u3001\u4E0D\u8981\u7528 && ; | \u7EC4\u5408\u3001\u4E0D\u8981\u6539\u5199\u4EFB\u4F55\u5B57\u7B26\uFF0C\u6539\u5199\u4E00\u4E2A\u5B57\u7B26\u767D\u540D\u5355\u5C31\u5931\u914D\uFF1B\u767D\u540D\u5355\u4E4B\u5916\u7684\u52A8\u4F5C\u4ECD\u4F1A\u88AB\u76F4\u63A5\u62D2\u7EDD\u3002` : "",
    context.fullOpenDeny?.length ? `- \u672C\u8F6E\u662F\u5168\u5F00\u6863\u4F4D\uFF1A\u9664\u88AB\u9762\u677F\u7981\u7528\u7684 ${context.fullOpenDeny.join("\u3001")} \u4E4B\u5916\uFF0C\u4EFB\u4F55\u547D\u4EE4\u90FD\u4F1A**\u76F4\u63A5\u6267\u884C**\uFF08\u5305\u62EC\u5220\u6587\u4EF6\u3001\u8054\u7F51\uFF09\u3002\u88AB\u7981\u7684\u63A8\u9001\u522B\u5C1D\u8BD5\u3001\u4E5F\u522B\u62C6\u6761\u7ED5\u8FC7\uFF1B\u52A8\u624B\u524D\u5148\u60F3\u6E05\u695A\u5F71\u54CD\u8303\u56F4\u3002` : "",
    "- \u6539\u52A8\u8981\u80FD\u7F16\u8BD1\u901A\u8FC7\uFF0C\u9075\u5FAA\u4ED3\u5E93\u73B0\u6709\u98CE\u683C\uFF1B\u9700\u8981\u65B0\u4F9D\u8D56\u8BF7\u5728\u7ED3\u8BBA\u91CC\u8BF4\u660E\u3002",
    "- \u7ED3\u675F\u65F6\u7528\u4E00\u6BB5\u4E2D\u6587\u8BF4\u660E\u300C\u505A\u4E86\u4EC0\u4E48 / \u6CA1\u505A\u4EC0\u4E48 / \u5EFA\u8BAE\u4E0B\u4E00\u6B65\u300D\u3002",
    p.forbidQuestions ? "- \u8FD9\u662F\u4E00\u6B21**\u65E0\u4EBA\u503C\u5B88**\u7684\u8FD0\u884C\uFF1A\u4E0D\u8981\u63D0\u95EE\u3001\u4E0D\u8981\u7B49\u786E\u8BA4\u3001\u4E0D\u8981\u53EA\u7ED9\u65B9\u6848\u4E0D\u52A8\u624B\u3002\u62FF\u4E0D\u51C6\u5C31\u6309\u6700\u5408\u7406\u7684\u5047\u8BBE\u76F4\u63A5\u505A\u5B8C\uFF0C\u5E76\u5728\u7ED3\u5C3E\u7528\u4E00\u884C\u300C\u5047\u8BBE\uFF1A\u300D\u5199\u6E05\u4F60\u66FF\u6211\u5B9A\u4E86\u4EC0\u4E48\u3002" : "",
    p.forbidQuestions ? "" : "- \u5982\u679C\u67D0\u4EF6\u4E8B\u5FC5\u987B\u6211\u62CD\u677F\u624D\u80FD\u7EE7\u7EED\uFF0C\u628A\u5F85\u51B3\u95EE\u9898\u5199\u8FDB\u7ED3\u8BBA**\u672B\u5C3E**\u7684 ```questions \u4EE3\u7801\u5757\uFF08\u9762\u677F\u4F1A\u8F6C\u6210\u9009\u9879\u5361\uFF09\uFF1A\u6BCF\u9898\u4E24\u884C\uFF0C`- q: \u95EE\u9898` \u4E0E `options: \u9009\u9879A | \u9009\u9879B\uFF08\u63A8\u8350\uFF09`\uFF0C\u63A8\u8350\u9879\u6807\uFF08\u63A8\u8350\uFF09\u3001\u653E\u524D\u9762\uFF0C\u6700\u591A 3 \u9898\uFF1B\u6CA1\u6709\u5F85\u51B3\u95EE\u9898\u5C31**\u4E0D\u8981**\u52A0\u8FD9\u4E2A\u5757\uFF0C\u95EE\u9898\u80CC\u666F\u4E0E\u4F60\u7684\u503E\u5411\u5199\u5728\u6B63\u6587\u91CC\u3002"
  ].filter(Boolean);
  return parts.join("\n\n");
}
function carryOver(input, max) {
  if (!max || input.resumeSessionId) return "";
  const last = [...input.context.priorMessages].reverse().find((m) => m.role === "assistant" && m.content.trim());
  if (!last) return "";
  const body = last.content.trim();
  const cut = body.length > max ? `${body.slice(0, max)}\u2026` : body;
  return `## \u4E0A\u4E00\u8F6E\u7ED3\u8BBA\uFF08\u5DF2\u63A5\u4E0D\u4E0A\u4F1A\u8BDD\uFF0C\u91CD\u65B0\u7ED9\u4F60\u4E00\u6B21\uFF09
${cut}
\u5DF2\u7ECF\u505A\u5B8C\u7684\u90E8\u5206\u522B\u91CD\u505A\uFF0C\u4ECE\u300C\u6CA1\u505A\u4EC0\u4E48 / \u5EFA\u8BAE\u4E0B\u4E00\u6B65\u300D\u63A5\u7740\u5F80\u4E0B\u63A8\u3002`;
}
function humanSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// src/core/agents/tools.ts
import fs4 from "node:fs";
import path5 from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
var runExec = promisify(execFile);
var TOOL_DEFS = [
  {
    name: "list_files",
    description: '\u5217\u51FA\u76EE\u5F55\u5185\u5BB9\uFF08\u9012\u5F52\uFF0C\u81EA\u52A8\u8DF3\u8FC7 node_modules/.git/dist\uFF09\u3002\u8FD4\u56DE "\u8DEF\u5F84\\t\u5927\u5C0F" \u5217\u8868\u3002',
    parameters: {
      type: "object",
      properties: { dir: { type: "string", description: "\u76F8\u5BF9\u76EE\u5F55\uFF0C\u9ED8\u8BA4 ." } }
    }
  },
  {
    name: "read_file",
    description: "\u8BFB\u53D6\u6587\u672C\u6587\u4EF6\u5185\u5BB9\u3002",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "number", description: "\u8D77\u59CB\u884C\uFF081-based\uFF09" },
        limit: { type: "number", description: "\u6700\u591A\u884C\u6570" }
      },
      required: ["path"]
    }
  },
  {
    name: "write_file",
    description: "\u521B\u5EFA\u6216\u6574\u4F53\u8986\u5199\u4E00\u4E2A\u6587\u672C\u6587\u4EF6\uFF08\u4F1A\u81EA\u52A8\u5EFA\u76EE\u5F55\uFF09\u3002",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"]
    }
  },
  {
    name: "edit_file",
    description: "\u7CBE\u786E\u5B57\u7B26\u4E32\u66FF\u6362\uFF08search \u5FC5\u987B\u5728\u6587\u4EF6\u4E2D\u552F\u4E00\u51FA\u73B0\uFF09\u3002\u4F18\u5148\u7528\u5B83\u505A\u5C0F\u6539\u52A8\u3002",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        search: { type: "string" },
        replace: { type: "string" }
      },
      required: ["path", "search", "replace"]
    }
  },
  {
    name: "run_command",
    description: "\u5728 worktree \u5185\u6267\u884C shell \u547D\u4EE4\uFF08\u6784\u5EFA/\u6D4B\u8BD5\u7B49\uFF09\uFF0C\u8FD4\u56DE stdout+stderr\u3002\u7981\u6B62 git push\u3002",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"]
    }
  },
  {
    name: "finish",
    description: "\u5BA3\u5E03\u672C\u8F6E\u5B8C\u6210\u3002\u5FC5\u987B\u6700\u540E\u8C03\u7528\uFF0Csummary \u7528\u4E2D\u6587\u5199\u6E05\u505A\u4E86\u4EC0\u4E48\u3001\u6CA1\u505A\u4EC0\u4E48\u3001\u5EFA\u8BAE\u4E0B\u4E00\u6B65\u3002",
    parameters: {
      type: "object",
      properties: { summary: { type: "string" }, followups: { type: "array", items: { type: "string" } } },
      required: ["summary"]
    }
  }
];
var BLOCKED = /\b(sudo|rm\s+-rf\s+[/~]|git\s+push|--force\s+push|mkfs|:\(\)\s*\{)/i;
var PathEscapeError = class extends Error {
};
function resolveInWorkspace(ctx, rel) {
  const raw = String(rel ?? ".").trim();
  if (path5.isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw)) {
    throw new PathEscapeError(`\u53EA\u5141\u8BB8 worktree \u5185\u7684\u76F8\u5BF9\u8DEF\u5F84\uFF0C\u6536\u5230\u7EDD\u5BF9\u8DEF\u5F84\uFF1A${raw}`);
  }
  const clean = raw.replace(/^\.?[\\/]+/, "");
  const abs = path5.resolve(ctx.workspace, clean);
  const root = path5.resolve(ctx.workspace);
  if (abs !== root && !abs.startsWith(root + path5.sep)) {
    throw new PathEscapeError(`\u8DEF\u5F84\u8D8A\u754C\uFF0C\u5DF2\u62D2\u7EDD\uFF1A${rel}`);
  }
  return abs;
}
async function executeTool(ctx, name, args) {
  try {
    switch (name) {
      case "list_files":
        return { ok: true, content: listFiles(ctx, String(args.dir ?? ".")) };
      case "read_file":
        return { ok: true, content: readFile(ctx, String(args.path), args.offset, args.limit) };
      case "write_file":
        return { ok: true, content: writeFile(ctx, String(args.path), String(args.content ?? "")) };
      case "edit_file":
        return { ok: true, content: editFile(ctx, args) };
      case "run_command":
        return await runCommand(ctx, String(args.command ?? ""));
      case "finish":
        return { ok: true, content: String(args.summary ?? "done") };
      default:
        return { ok: false, content: `\u672A\u77E5\u5DE5\u5177\uFF1A${name}` };
    }
  } catch (err) {
    return { ok: false, content: `${err.name ?? "Error"}: ${err.message}` };
  }
}
var SKIP_DIRS = /* @__PURE__ */ new Set(["node_modules", ".git", "dist", "build", ".next", "target", "__pycache__", ".venv"]);
function listFiles(ctx, dir) {
  const abs = resolveInWorkspace(ctx, dir);
  if (!fs4.existsSync(abs)) return `(\u76EE\u5F55\u4E0D\u5B58\u5728\uFF1A${dir})`;
  const lines = [];
  const walk2 = (d, depth) => {
    if (depth > 4 || lines.length > 600) return;
    for (const ent of fs4.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP_DIRS.has(ent.name) || ent.name.startsWith(".env")) continue;
      const full = path5.join(d, ent.name);
      const rel = path5.relative(ctx.workspace, full).split(path5.sep).join("/");
      if (ent.isDirectory()) {
        lines.push(`${rel}/`);
        walk2(full, depth + 1);
      } else {
        lines.push(`${rel}	${fs4.statSync(full).size}`);
      }
    }
  };
  if (fs4.statSync(abs).isDirectory()) walk2(abs, 0);
  else return `${path5.relative(ctx.workspace, abs)}	${fs4.statSync(abs).size}`;
  return lines.join("\n") || "(\u7A7A\u76EE\u5F55)";
}
function readFile(ctx, rel, offset, limit) {
  const abs = resolveInWorkspace(ctx, rel);
  if (!fs4.existsSync(abs)) throw new Error(`\u6587\u4EF6\u4E0D\u5B58\u5728\uFF1A${rel}`);
  const raw = fs4.readFileSync(abs, "utf8");
  const off = typeof offset === "number" ? Math.max(1, offset) : 1;
  const lim = typeof limit === "number" && limit > 0 ? limit : 800;
  const all = raw.split("\n");
  const slice = all.slice(off - 1, off - 1 + lim);
  const text = slice.map((l, i) => `${off + i}\0${l}`).join("\n");
  if (text.length > 6e4) return `${text.slice(0, 6e4)}
(\u622A\u65AD)`;
  return text;
}
function writeFile(ctx, rel, content) {
  const abs = resolveInWorkspace(ctx, rel);
  fs4.mkdirSync(path5.dirname(abs), { recursive: true });
  const existed = fs4.existsSync(abs);
  fs4.writeFileSync(abs, content, "utf8");
  ctx.onFileChange(path5.relative(ctx.workspace, abs).split(path5.sep).join("/"), "write");
  return `${existed ? "\u5DF2\u66F4\u65B0" : "\u5DF2\u521B\u5EFA"} ${rel}\uFF08${content.length} \u5B57\u7B26\uFF09`;
}
function editFile(ctx, args) {
  const rel = String(args.path);
  const abs = resolveInWorkspace(ctx, rel);
  if (!fs4.existsSync(abs)) throw new Error(`\u6587\u4EF6\u4E0D\u5B58\u5728\uFF1A${rel}`);
  const search = String(args.search ?? "");
  const replace = String(args.replace ?? "");
  if (!search) throw new Error("search \u4E0D\u80FD\u4E3A\u7A7A");
  const raw = fs4.readFileSync(abs, "utf8");
  const count = raw.split(search).length - 1;
  if (count === 0) throw new Error(`\u6CA1\u627E\u5230\u8981\u66FF\u6362\u7684\u5185\u5BB9\uFF08\u5148 read_file \u786E\u8BA4\u539F\u6587\uFF09`);
  if (count > 1) throw new Error(`search \u51FA\u73B0 ${count} \u6B21\uFF0C\u4E0D\u552F\u4E00\uFF1B\u8BF7\u6269\u5927\u4E0A\u4E0B\u6587`);
  fs4.writeFileSync(abs, raw.replace(search, replace), "utf8");
  ctx.onFileChange(path5.relative(ctx.workspace, abs).split(path5.sep).join("/"), "edit");
  return `\u5DF2\u66FF\u6362 ${rel} \u4E2D\u7684 1 \u5904`;
}
async function runCommand(ctx, command) {
  const cmd = command.trim();
  if (!cmd) return { ok: false, content: "\u547D\u4EE4\u4E3A\u7A7A" };
  if (BLOCKED.test(cmd)) return { ok: false, content: `\u547D\u4EE4\u88AB\u9762\u677F\u7684\u62A4\u680F\u62D2\u7EDD\uFF08\u5371\u9669\u64CD\u4F5C\uFF09\uFF1A${cmd}` };
  try {
    const { stdout, stderr } = await runExec(cmd, {
      cwd: ctx.workspace,
      shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
      maxBuffer: 8 * 1024 * 1024,
      timeout: ctx.commandTimeoutMs ?? 18e4,
      env: { ...process.env, CI: "1", GIT_TERMINAL_PROMPT: "0" }
    });
    const out = `${stdout}${stderr ? `
[stderr]
${stderr}` : ""}`.trim();
    ctx.log(`$ ${cmd}
${out.slice(0, 400)}`);
    return { ok: true, content: out.length > 24e3 ? `${out.slice(0, 24e3)}
(\u8F93\u51FA\u622A\u65AD)` : out || "(\u65E0\u8F93\u51FA)" };
  } catch (err) {
    const e = err;
    const out = `${e.stdout ?? ""}
${e.stderr ?? ""}`.trim();
    return {
      ok: false,
      content: `${e.killed ? "\u547D\u4EE4\u8D85\u65F6\u88AB\u7EC8\u6B62\uFF1B" : ""}${out || e.message || "\u6267\u884C\u5931\u8D25"}`.slice(0, 12e3)
    };
  }
}

// src/core/agents/api.ts
var ApiAgentAdapter = class {
  id = "api";
  label = "LLM API (OpenAI \u517C\u5BB9 / Anthropic)";
  async capabilities(settings) {
    const api = settings?.api ?? this.cfg().api;
    const ok2 = api.apiKey.trim().length > 0 && api.baseUrl.trim().length > 0;
    return {
      streaming: true,
      tools: true,
      resume: false,
      available: ok2,
      detail: ok2 ? `${api.provider} \xB7 ${api.model}` : "\u672A\u586B\u5199 API Key / Base URL"
    };
  }
  cfg() {
    return {
      api: {
        provider: process.env.AI_TASKS_API_PROVIDER || "openai",
        baseUrl: process.env.AI_TASKS_API_BASE || "https://api.openai.com/v1",
        model: process.env.AI_TASKS_API_MODEL || "gpt-5",
        apiKey: process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || "",
        temperature: 0.2,
        maxTurns: 30
      }
    };
  }
  async run(input) {
    const api = input.settings.api;
    if (!api.apiKey.trim()) {
      throw new AgentUnavailableError(
        "API \u6A21\u5F0F\u7F3A\u5C11\u5BC6\u94A5",
        "\u8BF7\u5728\u300C\u8BBE\u7F6E \u2192 \u5F15\u64CE \u2192 LLM API\u300D\u91CC\u586B API Key\uFF08\u53EA\u5B58\u672C\u5730 dataDir\uFF0C\u4E0D\u4F1A\u8FDB git\uFF09\u3002"
      );
    }
    const filesChanged = /* @__PURE__ */ new Set();
    const toolCtx = {
      workspace: input.workspacePath,
      onFileChange: (rel, op) => {
        filesChanged.add(rel);
        input.emit("file_change", { path: rel, op, source: "api" });
      },
      log: (text) => input.emit("log", { stream: "tool", text })
    };
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: input.instruction }
    ];
    if (input.resumeSessionId) {
      const prior = input.context.priorMessages.slice(-12);
      if (prior.length) {
        messages.splice(1, 0, {
          role: "system",
          content: `# \u4E4B\u524D\u7684\u5BF9\u8BDD\uFF08\u7528\u4E8E\u7EED\u63A5\uFF0C\u4E0D\u8981\u91CD\u590D\u5DF2\u5B8C\u6210\u7684\u5DE5\u4F5C\uFF09
${prior.map((m) => `[${m.role}] ${m.content}`).join("\n\n").slice(0, 12e3)}`
        });
      }
    }
    input.emit("status", { state: "running", phase: "plan", engine: `${api.provider}:${api.model}` });
    const usage = {};
    let summary = "";
    let finished = false;
    for (let turn = 1; turn <= api.maxTurns; turn += 1) {
      if (input.signal.aborted) throw new AbortError();
      input.emit("status", { state: "running", phase: `turn ${turn}` });
      const call = api.provider === "anthropic" ? await streamAnthropic(api, messages, input) : await streamOpenAI(api, messages, input);
      usage.inputTokens = (usage.inputTokens ?? 0) + call.usage.input;
      usage.outputTokens = (usage.outputTokens ?? 0) + call.usage.output;
      input.emit("usage", { ...call.usage, turn });
      if (call.text.trim()) {
        messages.push({ role: "assistant", content: call.text, tool_calls: call.toolCalls.length ? call.toolCalls : void 0 });
        if (!call.toolCalls.length) input.emit("assistant_message", { content: call.text.trim() });
      } else {
        messages.push({ role: "assistant", content: "", tool_calls: call.toolCalls.length ? call.toolCalls : void 0 });
      }
      if (!call.toolCalls.length) {
        summary = call.text.trim() || summary;
        break;
      }
      for (const tc of call.toolCalls) {
        let args = {};
        try {
          args = tc.argsJson ? JSON.parse(tc.argsJson) : {};
        } catch {
          args = {};
        }
        input.emit("tool_call", { name: tc.name, args, turn });
        const isFinish = tc.name === "finish";
        const outcome = isFinish ? { ok: true, content: String(args.summary ?? "done") } : await executeTool(toolCtx, tc.name, args);
        if (isFinish) {
          finished = true;
          summary = String(args.summary ?? "").trim();
          const fu = Array.isArray(args.followups) ? args.followups.map(String) : [];
          input.emit("result", { ok: true, summary, followups: fu });
        }
        input.emit("tool_result", { name: tc.name, ok: outcome.ok, summary: outcome.content.slice(0, 1500) });
        messages.push({ role: "tool", content: outcome.content, tool_call_id: tc.id, name: tc.name });
      }
      if (finished) break;
      summary = call.text.trim() || summary;
    }
    if (!finished && !summary) {
      summary = `\u5DF2\u8FBE\u5230\u6700\u5927\u8F6E\u6570\uFF08${api.maxTurns}\uFF09\uFF0C\u672C\u8F6E\u5148\u505C\u5728\u8FD9\u91CC\uFF1B\u53EF\u4EE5\u5728\u9762\u677F\u91CC\u7EE7\u7EED\u53D1\u6D88\u606F\u63A8\u8FDB\u3002`;
      input.emit("status", { state: "running", phase: "max_turns_reached" });
    }
    if (input.signal.aborted) throw new AbortError();
    input.emit("assistant_message", { content: summary });
    return {
      summary,
      sessionId: `api_${Date.now().toString(36)}`,
      filesChanged: [...filesChanged],
      commits: [],
      usage,
      // API 模式没有引擎侧会话可言：每一轮都是面板把整条对话史重放给它
      resumed: false,
      model: api.model.trim() || null
    };
  }
};
var SYSTEM_PROMPT = `\u4F60\u662F\u5D4C\u5165\u5728\u300CAI \u4EFB\u52A1\u7BA1\u7406\u9762\u677F\u300D\u91CC\u7684\u8D44\u6DF1\u5DE5\u7A0B\u5E08\uFF0C\u6B63\u5728\u4E00\u4E2A\u9694\u79BB\u7684 git worktree \u5206\u652F\u4E0A\u5B9E\u73B0\u7528\u6237\u7684\u60F3\u6CD5\u3002

\u5DE5\u4F5C\u65B9\u5F0F\uFF1A
1. \u5148\u7528 list_files / read_file \u6478\u6E05\u4ED3\u5E93\u7ED3\u6784\u4E0E\u73B0\u6709\u7EA6\u5B9A\uFF0C\u518D\u52A8\u624B\uFF1B
2. \u5C0F\u6539\u52A8\u4E00\u5F8B\u7528 edit_file\uFF08\u7CBE\u786E\u66FF\u6362\uFF09\uFF0C\u65B0\u5EFA\u6587\u4EF6\u7528 write_file\uFF1B\u9700\u8981\u6784\u5EFA\u6216\u6D4B\u8BD5\u7528 run_command\uFF1B
3. \u6240\u6709\u8DEF\u5F84\u90FD\u662F\u76F8\u5BF9\u4E8E\u5F53\u524D\u5DE5\u4F5C\u76EE\u5F55\u7684\uFF0C\u7981\u6B62\u8D8A\u754C\u8BBF\u95EE\uFF1B\u7981\u6B62 git push\uFF1B
4. \u4FDD\u6301\u6539\u52A8\u805A\u7126\u4E8E\u672C\u6B21\u6307\u4EE4\uFF0C\u4E0D\u8981\u987A\u624B\u91CD\u6784\u65E0\u5173\u4EE3\u7801\uFF1B
5. \u7ED3\u675F\u65F6\u5FC5\u987B\u8C03\u7528 finish\uFF0C\u7528\u4E2D\u6587\u5199\u6E05\uFF1A\u505A\u4E86\u4EC0\u4E48 / \u6CA1\u505A\u4EC0\u4E48 / \u5EFA\u8BAE\u4E0B\u4E00\u6B65\u3002

\u9762\u677F\u4F1A\u628A\u4F60\u7684\u6BCF\u6B21\u5DE5\u5177\u8C03\u7528\u5B9E\u65F6\u5C55\u793A\u7ED9\u7528\u6237\uFF0C\u7528\u6237\u4E5F\u53EF\u80FD\u4E2D\u9014\u8FFD\u52A0\u6307\u4EE4\u3002`;
async function* sseLines(res) {
  const reader = res.body?.getReader();
  if (!reader) return;
  const dec = new TextDecoder();
  let buf = "";
  for (; ; ) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      const t = line.trim();
      if (t.startsWith("data:")) yield t.slice(5).trim();
    }
  }
}
async function ensureOk(res) {
  if (res.ok) return;
  const body = await res.text().catch(() => "");
  let msg = body.slice(0, 1200);
  try {
    const j = JSON.parse(body);
    msg = j.error?.message ?? msg;
  } catch {
  }
  throw new Error(`API ${res.status}\uFF1A${msg}`);
}
async function streamOpenAI(api, messages, input) {
  const url = `${api.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${api.apiKey}` },
    signal: input.signal,
    body: JSON.stringify({
      model: api.model,
      stream: true,
      stream_options: { include_usage: true },
      temperature: api.temperature,
      messages: messages.map(
        (m) => m.role === "tool" ? { role: "tool", tool_call_id: m.tool_call_id, content: m.content } : {
          role: m.role,
          content: m.content,
          ...m.tool_calls?.length ? {
            tool_calls: m.tool_calls.map((tc) => ({
              id: tc.id,
              type: "function",
              function: { name: tc.name, arguments: tc.argsJson || "{}" }
            }))
          } : {}
        }
      ),
      tools: TOOL_DEFS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }))
    })
  });
  await ensureOk(res);
  let text = "";
  const toolCalls = /* @__PURE__ */ new Map();
  const usage = { input: 0, output: 0 };
  for await (const data of sseLines(res)) {
    if (data === "[DONE]") break;
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    if (chunk.usage) {
      const u = chunk.usage;
      usage.input = u.prompt_tokens ?? usage.input;
      usage.output = u.completion_tokens ?? usage.output;
    }
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string" && delta.content) {
      text += delta.content;
      input.emit("text_delta", { text: delta.content });
    }
    for (const tc of delta.tool_calls ?? []) {
      const idx = Number(tc.index ?? 0);
      const cur = toolCalls.get(idx) ?? { id: "", name: "", argsJson: "" };
      const fn = tc.function ?? {};
      if (typeof tc.id === "string") cur.id = tc.id;
      if (typeof fn.name === "string") cur.name += fn.name;
      if (typeof fn.arguments === "string") cur.argsJson += fn.arguments;
      toolCalls.set(idx, cur);
      if (cur.name) input.emit("tool_call", { name: cur.name, streaming: true, turn: 0 });
    }
  }
  return { text, toolCalls: [...toolCalls.values()].map((c, i) => ({ ...c, id: c.id || `call_${i}` })), usage };
}
async function streamAnthropic(api, messages, input) {
  const url = `${api.baseUrl.replace(/\/+$/, "")}/messages`;
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const rest = messages.filter((m) => m.role !== "system");
  const anthropicMessages = rest.map(
    (m) => m.role === "tool" ? { role: "user", content: [{ type: "tool_result", tool_use_id: m.tool_call_id, content: m.content }] } : m.role === "assistant" && m.tool_calls?.length ? {
      role: "assistant",
      content: [
        ...m.content ? [{ type: "text", text: m.content }] : [],
        ...m.tool_calls.map((tc) => ({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: safeJson(tc.argsJson)
        }))
      ]
    } : { role: m.role, content: m.content }
  );
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": api.apiKey,
      "anthropic-version": "2023-06-01"
    },
    signal: input.signal,
    body: JSON.stringify({
      model: api.model,
      max_tokens: 8e3,
      temperature: api.temperature,
      stream: true,
      system,
      messages: anthropicMessages,
      tools: TOOL_DEFS.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
    })
  });
  await ensureOk(res);
  let text = "";
  const toolCalls = /* @__PURE__ */ new Map();
  const usage = { input: 0, output: 0 };
  for await (const data of sseLines(res)) {
    let evt;
    try {
      evt = JSON.parse(data);
    } catch {
      continue;
    }
    const type = String(evt.type ?? "");
    if (type === "message_start") {
      const u = evt.message?.usage;
      if (u) {
        usage.input = u.input_tokens ?? 0;
        usage.output = u.output_tokens ?? 0;
      }
    } else if (type === "content_block_start") {
      const block = evt.content_block;
      if (block?.type === "tool_use") {
        toolCalls.set(Number(evt.index ?? 0), {
          id: String(block.id ?? ""),
          name: String(block.name ?? ""),
          argsJson: "",
          blockId: String(block.id ?? "")
        });
        input.emit("tool_call", { name: String(block.name ?? ""), streaming: true });
      }
    } else if (type === "content_block_delta") {
      const d = evt.delta;
      if (d?.type === "text_delta" && typeof d.text === "string") {
        text += d.text;
        input.emit("text_delta", { text: d.text });
      } else if (d?.type === "input_json_delta" && typeof d.partial_json === "string") {
        const cur = toolCalls.get(Number(evt.index ?? 0));
        if (cur) cur.argsJson += d.partial_json;
      }
    } else if (type === "message_delta") {
      const u = evt.usage;
      if (u?.output_tokens) usage.output = u.output_tokens;
    } else if (type === "error") {
      throw new Error(`Anthropic \u6D41\u9519\u8BEF\uFF1A${JSON.stringify(evt).slice(0, 500)}`);
    }
  }
  usage.input ||= 0;
  return {
    text,
    toolCalls: [...toolCalls.values()].map(({ blockId: _b, ...c }) => c),
    usage
  };
}
function safeJson(s) {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return {};
  }
}

// src/core/agents/cli.ts
import { spawn as spawn2 } from "node:child_process";
import fs7 from "node:fs";
import os3 from "node:os";
import path8 from "node:path";
import readline from "node:readline";

// src/core/exec.ts
import fs5 from "node:fs";
import path6 from "node:path";
import { spawn } from "node:child_process";
var SHIMS = /* @__PURE__ */ new Set([".cmd", ".bat"]);
var WIN_EXTS = [".cmd", ".exe", ".bat", ".com"];
var NODE_SCRIPT_EXTS = /* @__PURE__ */ new Set([".mjs", ".cjs", ".js"]);
function isNodeScript(file) {
  return NODE_SCRIPT_EXTS.has(path6.extname(file).toLowerCase());
}
var WIN_NATIVE_EXTS = /* @__PURE__ */ new Set([".exe", ".cmd", ".bat", ".com"]);
function looksLikeNodeScript(file, readHead) {
  if (isNodeScript(file)) return true;
  try {
    const head = readHead(file);
    const first = head.split("\n", 1)[0] ?? "";
    return /^#!/.test(first) && /(^|[\s/])node([\s]|$)/.test(first);
  } catch {
    return false;
  }
}
var readHeadReal = (file) => {
  const fd = fs5.openSync(file, "r");
  try {
    const buf = Buffer.alloc(256);
    const n = fs5.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    fs5.closeSync(fd);
  }
};
var statRealFile = (file) => {
  try {
    return fs5.statSync(file);
  } catch {
    return null;
  }
};
function hasExecBit(file, statFile) {
  const st = statFile(file);
  return Boolean(st && st.isFile() && (st.mode & 73) !== 0);
}
function ok(file, mode, statFile) {
  const st = statFile(file);
  if (!st || !st.isFile()) return false;
  if (mode === 0) return true;
  return (st.mode & mode) !== 0;
}
function whichExecutable(cmd, platform = process.platform, statFile = statRealFile) {
  if (!cmd) return null;
  const mode = platform === "win32" ? 0 : 73;
  const exts = platform === "win32" && !path6.extname(cmd) ? [...WIN_EXTS, ".ps1"] : [""];
  const hasDir = cmd.includes("/") || cmd.includes(path6.sep) || /^[a-zA-Z]:/.test(cmd);
  if (hasDir) {
    for (const ext of exts) {
      const candidate = cmd + ext;
      if (ok(candidate, mode, statFile)) return candidate;
    }
    return ok(cmd, mode, statFile) ? cmd : null;
  }
  for (const dir of (process.env.PATH ?? "").split(path6.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path6.join(dir, cmd + ext);
      if (ok(candidate, mode, statFile)) return candidate;
    }
  }
  return null;
}
function needsComSpec(file, platform = process.platform) {
  if (platform !== "win32") return false;
  return SHIMS.has(path6.extname(file).toLowerCase());
}
function quoteCmdArg(arg) {
  const BS = String.fromCharCode(92);
  const LITERAL = /* @__PURE__ */ new Map([
    [String.fromCharCode(10), BS + "n"],
    [String.fromCharCode(13), BS + "r"],
    [String.fromCharCode(9), BS + "t"]
  ]);
  let out = "";
  let slashes = 0;
  for (const c of arg) {
    if (c === BS) {
      slashes++;
      continue;
    }
    if (c === '"') {
      out += BS.repeat(slashes * 2 + 1) + c;
      slashes = 0;
      continue;
    }
    const literal = LITERAL.get(c);
    if (literal) {
      out += BS.repeat(slashes) + literal;
      slashes = 0;
      continue;
    }
    out += BS.repeat(slashes) + c;
    slashes = 0;
  }
  out += BS.repeat(slashes * 2);
  return '"' + out + '"';
}
function cmdToken(value) {
  return /^[\w.\\/:+=,@-]+$/.test(value) ? value : quoteCmdArg(value);
}
function wrapForComSpec(file, args, opts = {}) {
  if (!needsComSpec(file, opts.platform ?? process.platform)) return null;
  const line = [cmdToken(file), ...args.map((a) => cmdToken(a))].join(" ");
  return {
    file: opts.comspec && opts.comspec.trim() ? opts.comspec : process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", '"' + line + '"'],
    windowsVerbatimArguments: true
  };
}
async function planExec(bin, args, opts = {}) {
  const platform = opts.platform ?? process.platform;
  const statFile = opts.statFile ?? statRealFile;
  const readHead = opts.readHead ?? readHeadReal;
  const resolved = whichExecutable(bin, platform, statFile);
  const file = resolved ?? bin;
  const scriptFile = looksLikeNodeScript(file, readHead);
  const winNonNative = platform === "win32" && !WIN_NATIVE_EXTS.has(path6.extname(file).toLowerCase());
  if (scriptFile && (winNonNative || !hasExecBit(file, statFile))) {
    const st = statFile(file);
    if (st?.isFile()) {
      return {
        file: process.execPath,
        args: [file, ...args],
        windowsVerbatimArguments: false,
        resolved: file,
        viaComSpec: false,
        shim: false
      };
    }
  }
  const shim = SHIMS.has(path6.extname(file).toLowerCase());
  const wrap = wrapForComSpec(file, args, { platform, comspec: opts.comspec });
  if (wrap) return { ...wrap, resolved, viaComSpec: true, shim };
  return { file, args, windowsVerbatimArguments: false, resolved, viaComSpec: false, shim };
}
function killTree(child, platform = process.platform) {
  if (platform === "win32" && typeof child.pid === "number") {
    try {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      killer.on("error", () => {
        try {
          child.kill("SIGTERM");
        } catch {
        }
      });
      return true;
    } catch {
    }
  }
  const killed = child.kill("SIGTERM");
  const timer = setTimeout(() => {
    try {
      if (!child.killed) child.kill("SIGKILL");
    } catch {
    }
  }, 3e3);
  timer.unref?.();
  return killed;
}
function explainExecError(err, bin, plan) {
  const e = err;
  const raw = e?.message ?? String(err ?? "\u6267\u884C\u5931\u8D25");
  const code = e?.code;
  if (code === "ENOENT") {
    return plan?.resolved === null ? `PATH \u91CC\u627E\u4E0D\u5230 \`${bin}\`\uFF1A\u6CA1\u88C5\u5C31\u6309\u5B89\u88C5\u547D\u4EE4\u88C5\uFF0C\u6216\u586B\u7EDD\u5BF9\u8DEF\u5F84\uFF08GUI \u542F\u52A8\u65F6 PATH \u6BD4\u7EC8\u7AEF\u77ED\uFF09` : `\u627E\u4E0D\u5230\u53EF\u6267\u884C\u6587\u4EF6\uFF1A${raw}\uFF08Windows \u4E0A\u6309 PATHEXT \u4E5F\u6CA1\u89E3\u6790\u5230 \`${bin}\`\uFF0C\u8BD5\u8BD5\u586B\u7EDD\u5BF9\u8DEF\u5F84\uFF09`;
  }
  if (code === "EINVAL") {
    const head = plan?.viaComSpec ? `\u5DF2\u7ECF\u4EA4\u7ED9 cmd.exe \u6267\u884C\u4E86\u8FD8\u662F\u88AB\u62D2\uFF08EINVAL\uFF09\uFF1A\u591A\u534A\u662F\u53C2\u6570\u91CC\u6709 cmd \u7684\u4FDD\u7559\u5B57\u7B26\uFF0C\u6216 \`${bin}\` \u6307\u5411\u7684\u662F\u76EE\u5F55\u800C\u4E0D\u662F\u6587\u4EF6` : `\`${bin}\` \u6CA1\u80FD\u76F4\u63A5\u6267\u884C\uFF08EINVAL\uFF09\uFF1AWindows \u4E0A npm/tnpm \u88C5\u51FA\u6765\u7684 CLI \u662F .cmd \u6279\u5904\u7406\u57AB\u7247\uFF0CNode \u226520.12 \u62D2\u7EDD\u76F4\u63A5 spawn \u5B83`;
    return `${head}\u3002\u53EF\u4EE5\uFF1A\u2460\u300C\u53C2\u6570\u6A21\u677F\u300D\u91CC\u628A {prompt} \u6362\u6210 {prompt_file}\uFF08\u957F\u6587\u672C\u522B\u7ECF\u547D\u4EE4\u884C\uFF09\uFF1B\u2461\u547D\u4EE4\u586B .cmd \u7684\u7EDD\u5BF9\u8DEF\u5F84\uFF1B\u2462\u4ECD\u4E0D\u6210\u5C31\u6539\u7528 API \u6A21\u5F0F`;
  }
  if (code === "EACCES") return `\u6CA1\u6709\u6743\u9650\u6267\u884C \`${bin}\`\uFF1A${raw}`;
  return raw;
}

// src/core/agents/permissions.ts
var PERMISSIVE_FLAGS = /* @__PURE__ */ new Set([
  "--dangerously-skip-permissions",
  // claude / codebuddy
  "--dangerously-bypass-approvals-and-sandbox",
  // codex
  "--full-auto",
  // codex
  "--yes-always",
  // aider
  "--yolo",
  // qwen / gemini 旧写法
  "--force",
  // cursor：不带它连文件都不落盘
  "--auto"
  // opencode
]);
var PERMISSIVE_KV = [
  ["--permission-mode", ["bypassPermissions"]],
  ["--approval-mode", ["yolo"]],
  ["--approval_mode", ["yolo"]],
  ["--ask-for-approval", ["never"]],
  // codex：不问 = 在它自己的沙箱里直接跑
  ["-a", ["never"]],
  ["--sandbox", ["workspace-write", "danger-full-access"]]
];
var RESTRICTIVE_MODES = /* @__PURE__ */ new Set(["default", "acceptEdits", "plan", "dontAsk"]);
var ALLOWLIST_FLAGS = ["--allowedTools", "--allowed-tools"];
function tokensOf(raw) {
  return raw.split(/\s+/).map((t) => t.trim()).filter(Boolean);
}
function valueOf(tokens, flag) {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === flag) return tokens[i + 1];
    if (t.startsWith(`${flag}=`)) return t.slice(flag.length + 1);
  }
  return void 0;
}
function allowlistMentions(tokens, tool) {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const flag = ALLOWLIST_FLAGS.find((f) => t === f || t.startsWith(`${f}=`));
    if (!flag) continue;
    const values = [];
    if (t.includes("=")) values.push(t.slice(flag.length + 1));
    for (let j = i + 1; j < tokens.length && !tokens[j].startsWith("-"); j++) values.push(tokens[j]);
    if (values.some((v) => v.replace(/^["']|["']$/g, "").split(",").some((x) => x.trim().startsWith(tool)))) return true;
  }
  return false;
}
function isPermissive(tokens) {
  if (tokens.some((t) => PERMISSIVE_FLAGS.has(t))) return true;
  if (tokens.some((t) => /^-[a-zA-Z]*y[a-zA-Z]*$/.test(t))) return true;
  return PERMISSIVE_KV.some(([flag, values]) => {
    const v = valueOf(tokens, flag);
    return v !== void 0 && values.includes(v);
  });
}
function effectiveCliArgs(st, forResume, plan) {
  const template = st.cli.argsTemplate.trim();
  if (template) return template;
  const preset = resolveCliPreset(st.cli.profile, st.cli.command);
  const args = (forResume && preset.resumeArgs ? preset.resumeArgs : preset.firstArgs).join(" ");
  if (!plan || plan.kind === "inherit" || plan.kind === "inert") return args;
  return applyPermissionToTokens(tokensOf(args), plan).join(" ");
}
function cliCommandsBlocked(st, forResume, plan) {
  const tokens = tokensOf(effectiveCliArgs(st, forResume, plan));
  if (isPermissive(tokens)) return false;
  const mode = valueOf(tokens, "--permission-mode");
  if (mode !== void 0 && RESTRICTIVE_MODES.has(mode)) {
    return allowlistMentions(tokens, "Bash") ? false : true;
  }
  return null;
}
var STRONG_DENY_PATTERNS = [
  // CodeBuddy 2.157.0 真机原话（两轮实测一致）：
  // "Error: Permission to use Bash has been denied because this tool requires approval but permission
  //  prompts are not available in non-interactive mode. …"
  /permission to use .{0,60}(has been|was|is) (denied|blocked|rejected)/i,
  /requires? (user |explicit |manual )?approval but (the )?permission (prompts?|approvals?) (are|is|was) not available/i,
  // Claude Code 系同款语义的旧措辞（也是本仓假夹具历史用的那句）
  /requested permissions? to use .{0,60}(haven't|have not|not been) granted/i
];
function looksLikePermissionDenyStrong(text) {
  if (!text) return false;
  return STRONG_DENY_PATTERNS.some((re) => re.test(text));
}
var FULL_OPEN_DEFAULT_DENY = ["Bash(git push:*)", "PowerShell(git push:*)"];
function deriveAllowedTools(verifyCommand) {
  const raw = (verifyCommand ?? "").trim();
  if (!raw) return null;
  const parts = raw.split(/&&|\|\||;|\|/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  if (parts.some((p) => /[<>]/.test(p))) return null;
  const ok2 = parts.filter((p) => !/^(sudo\b|git\s+push\b)/.test(p));
  if (!ok2.length) return null;
  return { tools: ok2.flatMap((c) => [`Bash(${c}:*)`, `PowerShell(${c}:*)`]), commands: ok2 };
}
function presetSupportsPermOverride(preset) {
  return preset.firstArgs.includes("--permission-mode");
}
function permModeLabel(mode) {
  return mode === "allowlist" ? "\u767D\u540D\u5355" : mode === "full" ? "\u5168\u5F00" : "\u7EE7\u627F\u9884\u8BBE";
}
function resolvePermissionPlan(repo, st) {
  const cfg = repo.agentPermissions;
  const mode = cfg?.mode ?? "inherit";
  if (mode === "inherit") return { kind: "inherit" };
  if (st.cli.argsTemplate.trim()) {
    return {
      kind: "inert",
      reason: `\u8FD9\u4E00\u5BB6\u914D\u4E86\u53C2\u6570\u6A21\u677F\uFF08\u6A21\u677F\u4F18\u5148\uFF09\uFF0C\u4ED3\u5E93\u6743\u9650\u6863\u4F4D\u300C${permModeLabel(mode)}\u300D\u6CA1\u6709\u751F\u6548\uFF1B\u8981\u653E\u884C\u5C31\u5728\u6A21\u677F\u91CC\u81EA\u5DF1\u52A0\u65D7\u6807`
    };
  }
  const preset = resolveCliPreset(st.cli.profile, st.cli.command);
  if (!presetSupportsPermOverride(preset)) {
    return { kind: "inert", reason: `${preset.label} \u7684\u9884\u8BBE\u6CA1\u6709\u53EF\u66FF\u6362\u7684\u6743\u9650\u65D7\u6807\uFF08\u8981\u4E48\u672C\u6765\u5C31\u514D\u6279\u3001\u8981\u4E48\u7528\u6CD5\u4E0D\u540C\uFF09\uFF0C\u4ED3\u5E93\u6743\u9650\u6863\u4F4D\u4E0D\u751F\u6548` };
  }
  if (mode === "allowlist") {
    const derived = deriveAllowedTools(repo.verifyCommand);
    if (!derived) return { kind: "inert", reason: "\u767D\u540D\u5355\u6D3E\u751F\u4E0D\u51FA\u6765\uFF1A\u9A8C\u8BC1\u547D\u4EE4\u7A7A\u7740\u3001\u6216\u542B\u91CD\u5B9A\u5411/\u7BA1\u9053\u62C6\u4E0D\u51FA\u5B50\u547D\u4EE4\uFF1B\u672C\u8F6E\u6309\u9884\u8BBE\u6863\u4F4D\u8DD1" };
    return { kind: "allowlist", tools: derived.tools, commands: derived.commands };
  }
  const extra = (cfg?.extraDeny ?? []).map((s) => String(s).trim()).filter(Boolean);
  return { kind: "full", deny: [...FULL_OPEN_DEFAULT_DENY, ...extra] };
}
function applyPermissionToTokens(tokens, plan) {
  if (plan.kind === "allowlist") {
    return plan.tools.length ? [...tokens, "--allowedTools", plan.tools.join(",")] : tokens;
  }
  if (plan.kind === "full") {
    const out = [...tokens];
    const at = out.indexOf("--permission-mode");
    if (at >= 0 && out[at + 1] !== void 0) out[at + 1] = "bypassPermissions";
    if (plan.deny.length) out.push("--disallowedTools", plan.deny.join(","));
    return out;
  }
  return tokens;
}
function permissionDenyNotice(count, verifyCommand) {
  const head = `\u672C\u8F6E\u6709 ${count} \u6B21\u5DE5\u5177\u8C03\u7528\u88AB\u5F15\u64CE\u7684\u6743\u9650\u7B56\u7565\u62D2\u7EDD`;
  const why = "\uFF08\u65E0\u5934\u6A21\u5F0F\u6CA1\u6709\u7EC8\u7AEF\uFF0C\u9700\u8981\u6279\u51C6\u7684\u52A8\u4F5C\u662F\u76F4\u63A5\u62D2\u7EDD\uFF0C\u4E0D\u4F1A\u7B49\u4EBA\uFF09";
  const viaPanel = verifyCommand ? `\u672C\u4ED3\u5E93\u914D\u7684\u9A8C\u8BC1\u547D\u4EE4 \`${verifyCommand}\` \u7531\u9762\u677F\u6267\u884C\u3001\u5931\u8D25\u8F93\u51FA\u81EA\u52A8\u56DE\u704C\uFF0CAI \u4E0D\u5FC5\u81EA\u5DF1\u8DD1\uFF1B` : "\u60F3\u8BA9\u6D4B\u8BD5/\u6784\u5EFA\u8DD1\u8D77\u6765\uFF0C\u628A\u547D\u4EE4\u5199\u8FDB\u300C\u4ED3\u5E93 \u2192 \u9A8C\u8BC1\u547D\u4EE4\u300D\uFF0C\u9762\u677F\u4F1A\u5728\u6BCF\u8F6E\u7ED3\u675F\u540E\u4EE3\u8DD1\u5E76\u628A\u5931\u8D25\u8F93\u51FA\u56DE\u704C\u7ED9\u4E0B\u4E00\u8F6E\uFF1B";
  const upgrade = "\u786E\u5B9E\u8981\u8BA9 AI \u81EA\u5DF1\u8DD1\u547D\u4EE4\uFF0C\u5C31\u7ED9\u8FD9\u4E00\u5BB6 CLI \u914D\u514D\u6279\u6863\u4F4D\uFF1B`--allowedTools` \u767D\u540D\u5355\u4E5F\u884C\uFF0C\u4F46\u771F\u673A\u5B9E\u6D4B\u5B83\u504F\u8106\uFF08\u6A21\u578B\u7231\u628A `npm test` \u6539\u5199\u6210 `npm test 2>&1`\u3001\u88AB\u62D2\u540E\u8FD8\u4F1A\u6362 PowerShell \u5DE5\u5177\u518D\u8BD5\uFF09\uFF0C\u767D\u540D\u5355\u8981 Bash+PowerShell \u53CC\u4EFD\u5E76\u914D\u300C\u539F\u6837\u6267\u884C\u300D\u7EA6\u675F\uFF0C\u5168\u5F00 `-y` \u5219\u52A1\u5FC5\u914D `--disallowedTools` \u6321\u4F4F git push\uFF0C\u505A\u6CD5\u89C1 docs/ENGINE-RECIPES.md\u300C\u6743\u9650\u300D\u4E00\u8282\u3002";
  return `${head}${why}\u3002${viaPanel}${upgrade}`;
}

// src/core/agents/cli-formats.ts
function firstKeyOf(v) {
  if (!v || typeof v !== "object") return void 0;
  const k = Object.keys(v)[0];
  return k && k !== "undefined" ? k : void 0;
}
function modelOf(...srcs) {
  for (const s of srcs) {
    if (!s || typeof s !== "object") continue;
    const o = s;
    for (const k of ["model", "modelID", "modelId", "model_id"]) {
      if (typeof o[k] === "string" && o[k].trim()) return o[k].trim();
    }
  }
  return void 0;
}
function parsePiLine(line) {
  if (!line.startsWith("{")) return null;
  const obj = tryJson(line);
  if (!obj) return null;
  const out = [];
  const type = String(obj.type ?? "");
  const msg = obj.message ?? void 0;
  if (type === "session") {
    const id = typeof obj.id === "string" ? obj.id : void 0;
    const out2 = id ? [{ kind: "init", sessionId: id }] : [];
    const m = modelOf(obj);
    if (m) out2.push({ kind: "model", name: m });
    return out2;
  }
  if (type === "message_end") {
    const blocks = msg?.content;
    if (typeof blocks === "string") out.push({ kind: "text", text: blocks });
    else if (Array.isArray(blocks)) {
      for (const b of blocks) {
        if (!b || typeof b !== "object") continue;
        if (b.type === "text" && typeof b.text === "string") out.push({ kind: "text", text: b.text });
        if (b.type === "thinking" && typeof b.thinking === "string") out.push({ kind: "text", text: b.thinking });
      }
    }
    const usage = usageOf(msg?.usage ?? obj.usage);
    if (usage) out.push({ kind: "usage", usage });
    const m = modelOf(msg, obj);
    if (m) out.push({ kind: "model", name: m });
    return out.length ? out : [];
  }
  if (type === "tool_execution_start") {
    const args = obj.args ?? {};
    return [{ kind: "tool_use", name: String(obj.toolName ?? "tool"), args: normalizeToolArgs(typeof args === "object" && args ? args : {}) }];
  }
  if (type === "tool_execution_end") {
    return [{ kind: "tool_result", name: String(obj.toolName ?? "tool"), content: textOf(obj.result), isError: obj.isError === true }];
  }
  if (type === "turn_end") {
    const err = msg?.error;
    if (typeof err === "string" && err.trim()) return [{ kind: "error", message: err.trim() }];
    return [];
  }
  if (type === "message_update") {
    const ev = obj.assistantMessageEvent;
    if (ev?.type === "error") {
      const m = typeof ev.error === "string" ? ev.error : JSON.stringify(ev.error ?? ev.reason ?? "\u672A\u77E5\u9519\u8BEF");
      return [{ kind: "error", message: `\u5F15\u64CE\u62A5\u9519\uFF1A${truncateText(m, 800)}` }];
    }
    return [];
  }
  return null;
}
function usageOf(raw) {
  if (!raw || typeof raw !== "object") return void 0;
  const u = raw;
  const n = (v) => typeof v === "number" && Number.isFinite(v) ? v : void 0;
  const out = {};
  const input = n(u.input) ?? n(u.inputTokens);
  const output = n(u.output) ?? n(u.outputTokens);
  const total = n(u.totalTokens);
  const cost = n(u.cost?.total) ?? n(u.costUsd);
  if (input !== void 0) out.inputTokens = input;
  if (output !== void 0) out.outputTokens = output;
  if (total !== void 0) out.totalTokens = total;
  if (cost !== void 0) out.costUsd = cost;
  return Object.keys(out).length ? out : void 0;
}
function textOf(result) {
  const r = result;
  const blocks = r?.content;
  if (typeof blocks === "string") return blocks;
  if (Array.isArray(blocks)) {
    return blocks.map((b) => {
      const x = b;
      return typeof x?.text === "string" ? x.text : "";
    }).filter(Boolean).join("\n");
  }
  return result == null ? "" : JSON.stringify(result).slice(0, 4e3);
}
function truncateText(v, max) {
  return v.length > max ? `${v.slice(0, max)}\u2026\uFF08\u5DF2\u622A\u65AD ${v.length - max} \u5B57\uFF09` : v;
}
function parseStreamJson(line) {
  if (!line.startsWith("{")) return null;
  const obj = tryJson(line);
  if (!obj) return null;
  const out = [];
  const type = String(obj.type ?? "");
  const subtype = String(obj.subtype ?? "");
  if (type === "system" && subtype === "init") {
    out.push({ kind: "init", sessionId: idOf(obj) });
    const m = modelOf(obj);
    if (m) out.push({ kind: "model", name: m });
    if (typeof obj.permissionMode === "string" && obj.permissionMode) {
      out.push({ kind: "permission_mode", mode: obj.permissionMode });
    }
    return out;
  }
  if (type === "assistant" || type === "message") {
    const m = modelOf(obj, obj.message);
    if (m) out.push({ kind: "model", name: m });
    const content = obj.message?.content ?? obj.content;
    if (typeof content === "string") out.push({ kind: "text", text: content });
    else if (Array.isArray(content)) {
      for (const block of content) {
        const b = block;
        if (b.type === "text" && typeof b.text === "string") out.push({ kind: "text", text: b.text });
        if (b.type === "thinking" && typeof b.thinking === "string") out.push({ kind: "text", text: b.thinking });
        if (b.type === "tool_use") {
          const raw = b.input ?? {};
          out.push({ kind: "tool_use", name: String(b.name ?? "tool"), args: normalizeToolArgs(raw) });
        }
      }
    }
    return out.length ? out : null;
  }
  if (type === "user") {
    const content = obj.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        const b = block;
        if (b.type === "tool_result") {
          out.push({ kind: "tool_result", content: flatten(b.content), isError: Boolean(b.is_error) });
        }
      }
    }
    return out.length ? out : null;
  }
  if (type === "tool_call" || type === "tool") {
    const name = String(obj.name ?? obj.tool ?? "tool");
    out.push({ kind: "tool_use", name, args: normalizeToolArgs(obj.args ?? obj.input ?? {}) });
    if (subtype === "completed" || obj.result != null) {
      out.push({ kind: "tool_result", name, content: flatten(obj.result ?? obj.output ?? ""), isError: Boolean(obj.is_error) });
    }
    return out;
  }
  if (type === "result") {
    const usage = readUsage(obj);
    if (Object.keys(usage).length) out.push({ kind: "usage", usage });
    if (Array.isArray(obj.permission_denials) && obj.permission_denials.length) {
      const tools = obj.permission_denials.map((d) => {
        const input = d.tool_input && typeof d.tool_input === "object" ? d.tool_input : {};
        const brief = input.command ?? input.file_path ?? input.path ?? "";
        return `${String(d.tool_name ?? "tool")}${brief ? `(${String(brief).slice(0, 60)})` : ""}`;
      });
      out.push({ kind: "denials", count: tools.length, tools });
    }
    if (subtype && subtype !== "success") out.push({ kind: "error", message: String(obj.result ?? obj.error ?? subtype) });
    out.push({ kind: "result", result: obj.result != null ? String(obj.result) : void 0, sessionId: idOf(obj) });
    return out.length ? out : null;
  }
  return null;
}
function parseDshLine(line) {
  if (!line.startsWith("{")) return [];
  const obj = tryJson(line);
  if (!obj) return [];
  const out = [];
  switch (String(obj.type ?? "")) {
    case "session": {
      const sid = typeof obj.sessionId === "string" && obj.sessionId ? obj.sessionId : void 0;
      if (sid) out.push({ kind: "init", sessionId: sid });
      break;
    }
    case "status": {
      const usage = readUsage(obj);
      if (Object.keys(usage).length) out.push({ kind: "usage", usage });
      break;
    }
    case "thinking":
      if (typeof obj.text === "string" && obj.text) out.push({ kind: "text", text: obj.text });
      break;
    case "text":
      if (typeof obj.text === "string" && obj.text) out.push({ kind: "text", text: obj.text });
      break;
    case "tool_call":
      out.push({
        kind: "tool_use",
        name: String(obj.tool ?? "tool"),
        args: normalizeToolArgs(obj.input ?? {})
      });
      break;
    case "tool_result":
      out.push({
        kind: "tool_result",
        // 事件里只有 callId；名字从上一轮的 tool_call 里对不上就不写名字（面板按内容展示）
        content: flatten(obj.result ?? ""),
        isError: obj.status === "error"
      });
      break;
    case "final":
      if (typeof obj.text === "string") out.push({ kind: "result", result: obj.text });
      break;
    case "error":
      out.push({ kind: "error", message: pickString(obj, ["message", "text", "error"]) ?? "DSH \u62A5\u9519" });
      break;
    default:
      break;
  }
  return out;
}
function parseJsonlLine(line) {
  const obj = tryJson(line);
  if (!obj) return [];
  const out = [];
  const item = obj.item ?? obj.part ?? obj.data ?? obj;
  const type = String(obj.type ?? item.type ?? "");
  const sid = idOf(obj) ?? idOf(item);
  if (sid) out.push({ kind: "init", sessionId: sid });
  const model = modelOf(obj, item) ?? firstKeyOf(obj.stats?.models);
  if (model) out.push({ kind: "model", name: model });
  const text = pickString(item, ["text", "message", "content", "response", "summary"]) ?? pickString(obj, ["text", "message", "msg"]);
  if (text && (type === "item.completed" || type === "agent_message" || type === "text" || type === "message" || type === "response" || !type)) {
    out.push({ kind: "text", text });
  }
  const state = item.state ?? {};
  const toolInput = state.input ?? item.input ?? item.args ?? {};
  const toolName = String(item.tool ?? item.name ?? "");
  if (type.includes("item.") || toolName) {
    if (item.type === "command_execution" || toolName === "bash" || toolName === "shell") {
      const command = String(item.command ?? toolInput.command ?? "");
      out.push({ kind: "tool_use", name: "run_command", args: { command } });
      const exit = item.exit_code ?? state.exit_code;
      if (exit != null) {
        out.push({
          kind: "tool_result",
          name: "run_command",
          content: String(item.aggregated_output ?? state.output ?? item.output ?? `exit ${exit}`),
          isError: Number(exit) !== 0
        });
      } else if (state.status === "completed" && state.output != null) {
        out.push({ kind: "tool_result", name: "run_command", content: flatten(state.output), isError: false });
      }
    }
    if (item.type === "file_change") {
      for (const ed of Array.isArray(item.changes) ? item.changes : []) {
        const p = String(ed.path ?? ed.file ?? "");
        if (p) out.push({ kind: "tool_use", name: "edit_file", args: { path: p } });
      }
    }
    if (toolName && toolName !== "bash" && toolName !== "shell") {
      out.push({
        kind: "tool_use",
        name: toolName,
        args: normalizeToolArgs(toolInput)
      });
      const output = state.output ?? item.output;
      if (state.status === "completed" || output != null && output !== "") {
        out.push({ kind: "tool_result", name: toolName, content: flatten(output), isError: state.status === "error" });
      }
    }
  }
  if (type === "error" || item.type === "error") {
    out.push({ kind: "error", message: pickString(item, ["message", "text"]) ?? pickString(obj, ["message", "error"]) ?? "\u5F15\u64CE\u62A5\u9519" });
  }
  const usage = readUsage(obj);
  if (Object.keys(usage).length) out.push({ kind: "usage", usage });
  if (type === "turn.completed" || type === "task_complete" || type === "done" || obj.is_final === true) {
    out.push({ kind: "result", result: text ?? void 0, sessionId: sid });
  }
  return out;
}
function parseFinalJson(raw) {
  const out = [];
  const doc = extractJsonDoc(raw);
  if (!doc) {
    for (const l of raw.split("\n")) {
      const t = l.trim();
      if (t.startsWith("{")) out.push(...parseJsonlLine(t));
    }
    if (out.length) return out;
    return raw.trim() ? [{ kind: "text", text: raw.trim() }] : [];
  }
  const sid = idOf(doc);
  if (sid) out.push({ kind: "init", sessionId: sid });
  const resp = pickString(doc, ["response", "result", "text", "message", "summary"]);
  if (resp) out.push({ kind: "text", text: resp });
  for (const tc of Array.isArray(doc.toolCalls) ? doc.toolCalls : []) {
    const name = String(tc.name ?? tc.tool ?? "tool");
    const args = tc.args ?? tc.input ?? {};
    out.push({ kind: "tool_use", name, args: normalizeToolArgs(args) });
  }
  const usage = readUsage(doc);
  if (Object.keys(usage).length) out.push({ kind: "usage", usage });
  const statsModel = modelOf(doc) ?? firstKeyOf(doc.stats?.models);
  if (statsModel) out.push({ kind: "model", name: statsModel });
  const err = pickString(doc, ["error"]);
  if (err) out.push({ kind: "error", message: err });
  out.push({ kind: "result", result: resp ?? void 0, sessionId: sid });
  return out;
}
var AIDER_EDIT = /^\s*(?:Add|Edit|Updated|Removed)\s*:\s*(\S.*)$/i;
var AIDER_TOKENS = /Tokens:\s*([\d.,]+\s*k?)\s*sent,\s*([\d.,]+\s*k?)\s*received/i;
var AIDER_COST = /Cost:\s*\$([\d.,]+)/i;
var AIDER_NOISE = /^\s*(Aider\b|Ready|No git repo|Added \d|\bwarning:\b.*(not set|missing))/i;
function parsePlainLine(line) {
  const out = [];
  const edit = AIDER_EDIT.exec(line);
  if (edit) {
    for (const p of edit[1].split(/[,，]/).map((s) => s.trim()).filter(Boolean)) {
      out.push({ kind: "tool_use", name: /^Add/i.test(line) ? "write_file" : "edit_file", args: { path: p } });
    }
  }
  const tk = AIDER_TOKENS.exec(line);
  if (tk) {
    const usage = { inputTokens: parseKCount(tk[1]), outputTokens: parseKCount(tk[2]) };
    const cost = AIDER_COST.exec(line);
    out.push({ kind: "usage", usage: cost ? { ...usage, costUsd: parseKCount(cost[1]) } : usage });
  }
  return out;
}
function plainSummary(raw) {
  const fenced = [];
  let inBlock = false;
  for (const line of raw.split("\n")) {
    if (/^#{3,}\s*$/.test(line.trim())) {
      inBlock = !inBlock;
      continue;
    }
    if (inBlock) fenced.push(line);
  }
  if (fenced.join("").trim()) return fenced.join("\n").trim();
  return raw.split("\n").filter((l) => !AIDER_NOISE.test(l) && !AIDER_EDIT.test(l) && !AIDER_TOKENS.test(l)).join("\n").trim();
}
function makeCliParser(format) {
  let sawText = false;
  let sawAny = false;
  const track = (evts) => {
    if (evts.length) sawAny = true;
    if (evts.some((e) => e.kind === "text" || e.kind === "result")) sawText = true;
    return evts;
  };
  return {
    get sawText() {
      return sawText;
    },
    get sawAny() {
      return sawAny;
    },
    feed(line) {
      if (format === "plain") return track(parsePlainLine(line));
      if (format === "pi-jsonl") {
        const pi = parsePiLine(line);
        return track(pi?.length ? pi : parseJsonlLine(line));
      }
      if (format === "dsh-json") {
        const dsh = parseDshLine(line);
        return track(dsh.length ? dsh : parseJsonlLine(line));
      }
      const structured = parseStreamJson(line);
      if (structured?.length) return track(structured);
      if (format === "final-json" && !line.startsWith("{")) return [];
      return track(parseJsonlLine(line));
    },
    finish(raw) {
      if (format === "final-json") {
        return this.sawAny ? [] : track(parseFinalJson(raw));
      }
      if (format === "claude-stream-json" || format === "pi-jsonl" || format === "dsh-json") return [];
      if (this.sawText) return [];
      const s = plainSummary(raw);
      return s ? track([{ kind: "text", text: s }]) : [];
    }
  };
}
function tryJson(line) {
  try {
    const v = JSON.parse(line);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}
function extractJsonDoc(raw) {
  const direct = tryJson(raw.trim());
  if (direct) return direct;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) return tryJson(raw.slice(start, end + 1));
  return null;
}
function idOf(o) {
  for (const k of ["session_id", "sessionID", "sessionId", "chat_id", "chatId", "conversation_id"]) {
    const v = o[k];
    if (typeof v === "string" && v) return v;
  }
  return void 0;
}
function pickString(o, keys) {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return void 0;
}
function flatten(c) {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x) => x && typeof x === "object" ? String(x.text ?? "") : String(x)).join("\n");
  if (c == null) return "";
  return JSON.stringify(c).slice(0, 800);
}
function readUsage(obj) {
  const out = {};
  const srcs = [];
  for (const k of ["usage", "stats", "tokens", "costs", "metrics"]) {
    const v = obj[k];
    if (v && typeof v === "object") srcs.push(v);
  }
  srcs.push(obj);
  const num2 = (v) => typeof v === "number" && Number.isFinite(v) ? v : void 0;
  for (const s of srcs) {
    if (num2(s.approximate) === 1) out.approximate = 1;
    for (const k of ["input_tokens", "prompt_tokens", "inputTokens", "input"]) {
      const n = num2(s[k]);
      if (n != null) out.inputTokens = (out.inputTokens ?? 0) + n;
    }
    for (const k of ["output_tokens", "completion_tokens", "outputTokens", "output", "candidates"]) {
      const n = num2(s[k]);
      if (n != null) out.outputTokens = (out.outputTokens ?? 0) + n;
    }
    for (const k of ["totalTokens", "total_tokens", "total"]) {
      const n = num2(s[k]);
      if (n != null) out.totalTokens = (out.totalTokens ?? 0) + n;
    }
    for (const k of ["total_cost_usd", "costUsd", "cost"]) {
      const n = num2(s[k]);
      if (n != null) out.costUsd = n;
    }
  }
  for (const holder of ["part", "item", "message"]) {
    const h = obj[holder];
    if (!h || typeof h !== "object") continue;
    const tk = h.tokens;
    if (tk && typeof tk === "object") {
      out.inputTokens = (out.inputTokens ?? 0) + (num2(tk.input) ?? 0);
      out.outputTokens = (out.outputTokens ?? 0) + (num2(tk.output) ?? 0) + (num2(tk.reasoning) ?? 0);
    }
    const cost = num2(h.cost) ?? num2(h.total_cost_usd);
    if (cost != null) out.costUsd = cost;
  }
  const models = obj.stats?.models;
  if (models && typeof models === "object") {
    for (const m of Object.values(models)) {
      const tk = m?.tokens;
      if (!tk) continue;
      out.inputTokens = (out.inputTokens ?? 0) + (num2(tk.input) ?? 0);
      out.outputTokens = (out.outputTokens ?? 0) + (num2(tk.candidates) ?? num2(tk.output) ?? 0);
      const tt = num2(tk.total) ?? num2(tk.total_tokens);
      if (tt) out.totalTokens = (out.totalTokens ?? 0) + tt;
    }
  }
  return out;
}
function normalizeToolArgs(raw) {
  const args = {};
  const map = {
    file_path: "path",
    notebook_path: "path",
    new_string: "replacement",
    old_string: "search",
    abs_path: "path",
    path: "path",
    filenames: "paths"
  };
  for (const [k, v] of Object.entries(raw)) args[map[k] ?? k] = v;
  return args;
}
function parseKCount(s) {
  const n = Number.parseFloat(String(s).replace(/,/g, ""));
  if (!Number.isFinite(n)) return 0;
  return /k/i.test(s) ? Math.round(n * 1e3) : Math.round(n * 100) / 100;
}

// src/core/workspace/worktree.ts
import fs6 from "node:fs";
import path7 from "node:path";

// src/core/workspace/git.ts
import { execFile as execFile2 } from "node:child_process";
import { promisify as promisify2 } from "node:util";
var run = promisify2(execFile2);
async function git(cwd, args, opts = {}) {
  try {
    const { stdout, stderr } = await run("git", args, {
      cwd,
      maxBuffer: 32 * 1024 * 1024,
      timeout: opts.timeout ?? 12e4,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...opts.env ?? {} },
      windowsHide: true
    });
    return {
      ok: true,
      // 注意：不能 trim 前导空格，`status --porcelain` 的第 1、2 列就是状态位
      stdout: stdout.replace(/[\r\n]+$/, ""),
      stderr: stderr.trim(),
      code: 0
    };
  } catch (err) {
    const e = err;
    const stdout = typeof e.stdout === "string" ? e.stdout.replace(/[\r\n]+$/, "") : "";
    let stderr = typeof e.stderr === "string" ? e.stderr.trim() : "";
    if (!stderr && e.message) {
      const m = e.message.match(/stderr:\s*([\s\S]*)/);
      stderr = m ? m[1].trim() : e.message;
    }
    return { ok: false, stdout, stderr: stderr.replace(/[\r\n]+$/, ""), code: typeof e.code === "number" ? e.code : 1 };
  }
}
function mustOk(res, action) {
  if (!res.ok) throw new Error(`${action} \u5931\u8D25\uFF1A${res.stderr || res.stdout || `exit ${res.code}`}`);
  return res.stdout;
}
function parsePorcelain(raw) {
  if (!raw.trim()) return [];
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const x = line[0] ?? " ";
    const y = line[1] ?? " ";
    let p = line.slice(3);
    let origPath;
    const arrow = p.indexOf(" -> ");
    if (arrow >= 0) {
      origPath = p.slice(0, arrow);
      p = p.slice(arrow + 4);
    }
    out.push({ x, y, path: p.replace(/^"|"$/g, ""), origPath });
  }
  return out;
}
async function repoInfo(path19) {
  const inside = await git(path19, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok) throw new Error(`${path19} \u4E0D\u662F git \u4ED3\u5E93`);
  const root = mustOk(await git(path19, ["rev-parse", "--show-toplevel"]), "\u5B9A\u4F4D\u4ED3\u5E93\u6839\u76EE\u5F55");
  const head = await git(path19, ["symbolic-ref", "--short", "HEAD"]);
  const hasOrigin = (await git(root, ["remote", "get-url", "origin"])).ok;
  const originHead = await git(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  let defaultBranch = originHead.ok ? originHead.stdout.replace(/^origin\//, "") : "";
  if (!defaultBranch) {
    for (const cand of ["main", "master"]) {
      if ((await git(root, ["rev-parse", "--verify", `refs/heads/${cand}`])).ok) {
        defaultBranch = cand;
        break;
      }
    }
  }
  if (!defaultBranch) defaultBranch = head.ok ? head.stdout : "main";
  const count = await git(root, ["rev-list", "--count", "HEAD"]);
  const status = await git(root, ["status", "--porcelain=v1"]);
  return {
    root,
    currentBranch: head.ok ? head.stdout : null,
    defaultBranch,
    hasOrigin,
    commitCount: count.ok ? Number.parseInt(count.stdout, 10) || 0 : 0,
    dirty: status.ok ? parsePorcelain(status.stdout).length : 0
  };
}

// src/core/workspace/worktree.ts
function samePath(a, b, platform = process.platform) {
  if (!a || !b) return false;
  const P = platform === "win32" ? path7.win32 : path7.posix;
  const norm = (p) => P.resolve(p).replace(/[\\/]+$/, "");
  const [x, y] = [norm(a), norm(b)];
  return platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
}
function pathIsUnder(child, root, platform = process.platform) {
  if (!child || !root) return false;
  const P = platform === "win32" ? path7.win32 : path7.posix;
  const norm = (p) => P.resolve(p).replace(/[\\/]+$/, "");
  const lower = (p) => platform === "win32" ? p.toLowerCase() : p;
  const [c, r] = [lower(norm(child)), lower(norm(root))];
  return c === r || c.startsWith(r + P.sep);
}
var WorkspaceManager = class {
  worktreeRoot(repo) {
    return repo.worktreeRoot?.trim() ? path7.join(repo.worktreeRoot, sanitizeSegment(repo.name)) : path7.join(paths.worktrees(), sanitizeSegment(repo.name));
  }
  worktreePath(repo, taskId) {
    return path7.join(this.worktreeRoot(repo), sanitizeSegment(taskId));
  }
  branchName(ideaTitle, taskId) {
    return `ai/${slug(ideaTitle, 24)}-${sanitizeSegment(taskId).slice(-6)}`;
  }
  async prepare(repo, opts) {
    const info = await repoInfo(repo.path);
    const baseRef = opts.baseRef || info.defaultBranch;
    const empty = info.commitCount === 0;
    const allowDirty = opts.allowDirty ?? repo.allowDirty;
    if (info.dirty > 0 && !allowDirty && !empty && info.currentBranch === info.defaultBranch) {
      throw new Error(
        `\u4E3B\u5DE5\u4F5C\u533A\u6709 ${info.dirty} \u5904\u672A\u63D0\u4EA4\u6539\u52A8\uFF0C\u5148\u63D0\u4EA4\u6216 stash \u540E\u518D\u5F00\u59CB\uFF08\u4E5F\u53EF\u5728\u4ED3\u5E93\u8BBE\u7F6E\u91CC\u5141\u8BB8\u810F\u542F\u52A8\uFF09`
      );
    }
    let exists = await git(repo.path, ["rev-parse", "--verify", baseRef]);
    if (!exists.ok && empty) {
      exists = await bootstrapBaseline(repo, baseRef, opts.note);
    }
    if (!exists.ok) {
      throw new Error(
        `\u57FA\u7EBF\u5206\u652F ${baseRef} \u4E0D\u5B58\u5728\uFF1A\u4ED3\u5E93 ${repo.name} \u91CC\u6CA1\u6709\u8FD9\u6761\u5206\u652F\u3002` + (empty ? "\uFF08\u7A7A\u4ED3\u5E93\u8865\u9996\u4E2A\u63D0\u4EA4\u4E5F\u5931\u8D25\u4E86\uFF1A" + (exists.stderr || exists.stdout || "git \u6CA1\u7ED9\u539F\u56E0") + "\uFF09" : "\u5728\u300C\u4ED3\u5E93\u300D\u9875\u628A\u9ED8\u8BA4\u5206\u652F\u6539\u6210\u5B9E\u9645\u5B58\u5728\u7684\u90A3\u6761\uFF08git branch \u53EF\u67E5\uFF09")
      );
    }
    const wtPath = this.worktreePath(repo, opts.taskId);
    const branch = this.branchName(opts.ideaTitle, opts.taskId);
    fs6.mkdirSync(this.worktreeRoot(repo), { recursive: true });
    if (!fs6.existsSync(wtPath)) {
      const branchExists = (await git(repo.path, ["rev-parse", "--verify", branch])).ok;
      const args = branchExists ? ["worktree", "add", wtPath, branch] : ["worktree", "add", "-b", branch, wtPath, baseRef];
      mustOk(await git(repo.path, args, { timeout: 18e4 }), "\u521B\u5EFA worktree");
    }
    const head = await git(wtPath, ["rev-parse", "HEAD"]);
    const baseCommit = await git(repo.path, ["rev-parse", baseRef]);
    return {
      repoId: repo.id,
      path: wtPath,
      branch,
      baseRef,
      baseCommit: baseCommit.ok ? baseCommit.stdout : null,
      headCommit: head.ok ? head.stdout : null,
      mergedAt: null,
      discarded: false
    };
  }
  async diffStat(ws) {
    const base = ws.baseCommit ?? ws.baseRef;
    const num2 = await git(ws.path, ["diff", "--numstat", `${base}...HEAD`]);
    const name = await git(ws.path, ["diff", "--name-status", `${base}...HEAD`]);
    const entries = [];
    const nameMap = /* @__PURE__ */ new Map();
    if (name.ok) {
      for (const line of name.stdout.split("\n")) {
        const [st, ...rest] = line.split("	");
        if (st && rest[0]) nameMap.set(rest[0], st);
      }
    }
    let additions = 0;
    let deletions = 0;
    if (num2.ok && num2.stdout) {
      for (const line of num2.stdout.split("\n")) {
        const [a, d, p] = line.split("	");
        const ai = a === "-" ? 0 : Number.parseInt(a, 10) || 0;
        const di = d === "-" ? 0 : Number.parseInt(d, 10) || 0;
        additions += ai;
        deletions += di;
        if (p) entries.push({ path: p, additions: ai, deletions: di, status: nameMap.get(p) ?? "M" });
      }
    }
    const untracked = await git(ws.path, ["status", "--porcelain=v1"]);
    if (untracked.ok) {
      for (const f of parsePorcelain(untracked.stdout)) {
        if (entries.some((e) => e.path === f.path)) continue;
        entries.push({
          path: f.path,
          additions: 0,
          deletions: 0,
          status: f.x === "?" ? "A" : f.y === "D" || f.x === "D" ? "D" : "M"
        });
      }
    }
    return { files: entries.length, additions, deletions, entries };
  }
  /** unified diff 文本，可选只看某个文件 */
  async diffText(ws, filePath, context = 3) {
    const base = ws.baseCommit ?? ws.baseRef;
    const args = ["diff", `--unified=${context}`, `${base}...HEAD`];
    if (filePath) args.push("--", filePath);
    const committed = await git(ws.path, args);
    if (!committed.ok) return "";
    let out = committed.stdout;
    if (!filePath) {
      const wt = await git(ws.path, ["diff", "--no-color", "HEAD"]);
      if (wt.ok && wt.stdout) out = `${out}
${wt.stdout}`.trim();
    }
    return out;
  }
  async fileContent(ws, filePath, maxBytes = 2e5) {
    const abs = path7.resolve(ws.path, filePath);
    if (!abs.startsWith(path7.resolve(ws.path) + path7.sep)) throw new Error("\u975E\u6CD5\u8DEF\u5F84");
    if (!fs6.existsSync(abs)) return "";
    const st = fs6.statSync(abs);
    if (st.size > maxBytes) return `// \u6587\u4EF6\u8FC7\u5927 (${st.size} bytes)\uFF0C\u672A\u5728\u9762\u677F\u5185\u9884\u89C8`;
    return fs6.readFileSync(abs, "utf8");
  }
  async commitAll(ws, message) {
    const status = await git(ws.path, ["status", "--porcelain=v1"]);
    if (!status.ok || !status.stdout.trim()) return null;
    mustOk(await git(ws.path, ["add", "-A", "."]), "\u6682\u5B58\u6539\u52A8");
    const res = await git(ws.path, ["-c", "commit.gpgsign=false", ...await identityArgs(ws.path), "commit", "-m", message]);
    if (!res.ok) throw new Error(`\u63D0\u4EA4\u5931\u8D25\uFF1A${res.stderr || res.stdout}`);
    const head = await git(ws.path, ["rev-parse", "--short", "HEAD"]);
    return head.ok ? head.stdout : null;
  }
  async log(ws) {
    const base = ws.baseCommit ?? ws.baseRef;
    const res = await git(ws.path, ["log", "--format=%h%s%an%at", `${base}..HEAD`]);
    if (!res.ok) return [];
    return res.stdout.split("\n").filter(Boolean).map((line) => {
      const [hash, subject, author, ts] = line.split("");
      return { hash, subject, author, ts: Number.parseInt(ts, 10) * 1e3 };
    });
  }
  async status(ws) {
    const st = await git(ws.path, ["status", "--porcelain=v1"]);
    const changed = st.ok ? parsePorcelain(st.stdout).length : 0;
    const counts = await git(ws.path, ["rev-list", "--left-right", "--count", `${ws.baseRef}...HEAD`]);
    const [behind, ahead] = counts.ok ? counts.stdout.split(/\s+/).map((n) => Number.parseInt(n, 10) || 0) : [0, 0];
    return { clean: changed === 0, changed, branch: ws.branch, ahead, behind };
  }
  /**
   * 合并前冲突预检（#6）：无副作用地模拟将 `ws.branch` 合并进 `ws.baseRef`，
   * 提前识别基线是否已前进（behind > 0）、是否存在文件冲突或主工作区脏阻塞。
   */
  async checkMerge(repo, ws, commits = []) {
    const alreadyMerged = await this.isMergedInto(repo, ws, commits);
    const info = await repoInfo(repo.path);
    const baseDirty = info.dirty;
    const counts = await git(repo.path, ["rev-list", "--left-right", "--count", `${ws.baseRef}...${ws.branch}`]);
    const [behind, ahead] = counts.ok ? counts.stdout.split(/\s+/).map((n) => Number.parseInt(n, 10) || 0) : [0, 0];
    if (alreadyMerged) {
      return {
        canMerge: true,
        alreadyMerged: true,
        ahead,
        behind,
        baseDirty,
        conflictFiles: [],
        summary: "\u4EFB\u52A1\u6210\u679C\u5DF2\u5408\u5E76\u5230\u57FA\u7EBF\u5206\u652F"
      };
    }
    const conflictSet = /* @__PURE__ */ new Set();
    const mt = await git(repo.path, ["merge-tree", "--write-tree", "--name-only", ws.baseRef, ws.branch]);
    if (!mt.ok) {
      if (mt.code === 129 || /unknown option/i.test(mt.stderr)) {
        const mb = await git(repo.path, ["merge-base", ws.baseRef, ws.branch]);
        if (mb.ok && mb.stdout.trim()) {
          const oldMt = await git(repo.path, ["merge-tree", mb.stdout.trim(), ws.baseRef, ws.branch]);
          if (oldMt.stdout.includes("<<<<<<<") || /changed in both/i.test(oldMt.stdout)) {
            for (const m of oldMt.stdout.matchAll(/^\s+(?:our|their|base)\s+\d+\s+[0-9a-f]+\s+(.+)$/gm)) {
              if (m[1]?.trim()) conflictSet.add(m[1].trim());
            }
          }
        }
      } else {
        const lines = mt.stdout.split("\n");
        for (let i = 1; i < lines.length; i += 1) {
          const l = lines[i].trim();
          if (!l) break;
          if (!l.startsWith("Auto-merging ") && !l.startsWith("CONFLICT ")) {
            conflictSet.add(l);
          }
        }
        for (const m of mt.stdout.matchAll(/Merge conflict in (.+)$/gm)) {
          if (m[1]?.trim()) conflictSet.add(m[1].trim());
        }
      }
    }
    const conflictFiles = [...conflictSet];
    const blockedByDirty = baseDirty > 0 && !repo.allowDirty && info.currentBranch === ws.baseRef;
    const canMerge = conflictFiles.length === 0 && !blockedByDirty;
    let summary = "";
    if (conflictFiles.length > 0) {
      summary = `\u68C0\u6D4B\u5230 ${conflictFiles.length} \u4E2A\u6587\u4EF6\u5B58\u5728\u5408\u5E76\u51B2\u7A81\uFF08${conflictFiles.slice(0, 4).join("\u3001")}${conflictFiles.length > 4 ? " \u7B49" : ""}\uFF09${behind > 0 ? `\uFF0C\u57FA\u7EBF ${ws.baseRef} \u5DF2\u524D\u8FDB ${behind} \u4E2A\u63D0\u4EA4` : ""}`;
    } else if (blockedByDirty) {
      summary = `\u65E0\u4EE3\u7801\u51B2\u7A81\uFF0C\u4F46\u4E3B\u5DE5\u4F5C\u533A\u6709 ${baseDirty} \u5904\u672A\u63D0\u4EA4\u6539\u52A8\uFF08\u9700\u5148\u63D0\u4EA4/stash \u6216\u5F00\u542F\u300C\u5141\u8BB8\u810F\u542F\u52A8\u300D\uFF09`;
    } else if (behind > 0) {
      summary = `\u53EF\u5E72\u51C0\u4E09\u65B9\u5408\u5E76\uFF08\u57FA\u7EBF ${ws.baseRef} \u5DF2\u524D\u8FDB ${behind} \u4E2A\u63D0\u4EA4\uFF0C\u65E0\u51B2\u7A81\uFF09`;
    } else {
      summary = `\u53EF\u5E72\u51C0\u5408\u5E76\uFF08\u57FA\u7EBF ${ws.baseRef} \u672A\u53D1\u751F\u5206\u53C9\uFF0C\u65E0\u51B2\u7A81\uFF09`;
    }
    return {
      canMerge,
      alreadyMerged: false,
      ahead,
      behind,
      baseDirty,
      conflictFiles,
      summary
    };
  }
  /** 跑仓库配置的检查命令（如 npm test），用于合并前把关 */
  async runChecks(repo, ws, timeout = 6e5, cwd) {
    const cmd = (repo.verifyCommand ?? "").trim();
    if (!cmd) return { ok: true, output: "" };
    const [bin, ...args] = splitCommand(cmd);
    const { execFile: execFile3 } = await import("node:child_process");
    const { promisify: promisify3 } = await import("node:util");
    const plan = await planExec(bin, args);
    try {
      const { stdout, stderr } = await promisify3(execFile3)(plan.file, plan.args, {
        // 绑了「想法目录」时在子目录里跑：package.json 往往就在那儿
        cwd: cwd ?? ws.path,
        maxBuffer: 16 * 1024 * 1024,
        timeout,
        windowsVerbatimArguments: plan.windowsVerbatimArguments
      });
      return { ok: true, output: `${stdout}
${stderr}`.trim() };
    } catch (err) {
      const e = err;
      return { ok: false, output: `${e.stdout ?? ""}
${e.stderr ?? ""}
${e.message ?? ""}`.trim() };
    }
  }
  /** 合并到基线分支。在主仓库里执行，先确认主工作区干净。 */
  async mergeToBase(repo, ws, message) {
    const info = await repoInfo(repo.path);
    if (info.dirty > 0 && !repo.allowDirty) {
      return {
        ok: false,
        detail: `\u4E3B\u5DE5\u4F5C\u533A\u6709 ${info.dirty} \u5904\u672A\u63D0\u4EA4\u6539\u52A8\uFF0C\u5148\u63D0\u4EA4\u6216 stash \u540E\u518D\u5408\u5E76\uFF08\u4E5F\u53EF\u5728\u300C\u4ED3\u5E93 \u2192 \u5141\u8BB8\u810F\u542F\u52A8\u300D\u6253\u5F00\u540E\u91CD\u8BD5\uFF09`
      };
    }
    if (info.currentBranch !== ws.baseRef) {
      const co = await git(repo.path, ["checkout", ws.baseRef]);
      if (!co.ok) return { ok: false, detail: `\u5207\u6362\u5230 ${ws.baseRef} \u5931\u8D25\uFF1A${co.stderr}` };
    }
    const res = await git(
      repo.path,
      // 合并也会产出一个 commit，所以同一套身份兜底要用上（否则"AI 干完了、验收按不下去"）
      ["-c", "commit.gpgsign=false", ...await identityArgs(repo.path), "merge", "--no-ff", "--no-edit", "-m", message ?? `chore(ai): ${ws.branch}`, ws.branch],
      { timeout: 18e4 }
    );
    if (!res.ok) {
      await git(repo.path, ["merge", "--abort"]);
      return { ok: false, detail: `\u5408\u5E76\u51B2\u7A81\uFF0C\u5DF2\u4E2D\u6B62\uFF1A${res.stderr || res.stdout}` };
    }
    return { ok: true, detail: res.stdout || res.stderr || "\u5DF2\u5408\u5E76" };
  }
  /**
   * 这条任务的成果是否已经在基线里？
   *
   * 判据一律用 **git 事实**，不用 `workspace.mergedAt`（那个字段被旧代码写脏过：
   * 「只记验收」也写它）。分支还在 → `merge-base --is-ancestor <branch> <baseRef>`；
   * 分支已删（验收后清理过）→ 逐笔看 `task.commits` 是不是 baseRef 的祖先。
   * 拿不准一律 false —— 宁可多合一次，也不谎报「已合并」。
   */
  async isMergedInto(repo, ws, commits = []) {
    const has = await git(repo.path, ["rev-parse", "--verify", ws.branch]);
    if (has.ok) return (await git(repo.path, ["merge-base", "--is-ancestor", ws.branch, ws.baseRef])).ok;
    if (!commits.length) return false;
    for (const c of commits) {
      if (!(await git(repo.path, ["merge-base", "--is-ancestor", c, ws.baseRef])).ok) return false;
    }
    return true;
  }
  async cleanup(repo, ws, opts = {}) {
    const root = path7.resolve(this.worktreeRoot(repo));
    const target = path7.resolve(ws.path);
    if (!pathIsUnder(target, root)) throw new Error(`\u62D2\u7EDD\u6E05\u7406\u975E\u6258\u7BA1\u76EE\u5F55\uFF1A${target}`);
    await git(repo.path, ["worktree", "remove", "--force", target]);
    if (!fs6.existsSync(target)) fs6.rmSync(target, { recursive: true, force: true });
    await git(repo.path, ["worktree", "prune"]);
    if (opts.deleteBranch) {
      const res = await git(repo.path, ["branch", opts.unmergedOk ? "-D" : "-d", ws.branch]);
      mustOk(res, `\u5220\u9664\u4EFB\u52A1\u5206\u652F ${ws.branch}`);
    }
  }
  /**
   * 该仓库里由面板托管的 worktree（不含主工作区）。
   * 除了 `git worktree list`，也扫一遍托管目录，把上次崩溃留下的孤儿目录揪出来。
   */
  async listManaged(repo) {
    const root = path7.resolve(this.worktreeRoot(repo));
    const all = await this.listWorktrees(repo);
    const out = [];
    for (const w of all) {
      const abs = path7.resolve(w.path);
      if (samePath(abs, root) || !pathIsUnder(abs, root)) continue;
      out.push({ taskId: path7.basename(abs), path: abs, branch: w.branch, orphan: false });
    }
    const seen = new Set(out.map((o) => o.taskId));
    try {
      for (const name of await fs6.promises.readdir(root)) {
        if (seen.has(name)) continue;
        const abs = path7.join(root, name);
        if ((await fs6.promises.stat(abs)).isDirectory()) {
          out.push({ taskId: name, path: abs, branch: null, orphan: true });
        }
      }
    } catch {
    }
    return out;
  }
  async listWorktrees(repo) {
    const res = await git(repo.path, ["worktree", "list", "--porcelain"]);
    if (!res.ok) return [];
    const out = [];
    let cur = null;
    for (const line of res.stdout.split("\n")) {
      if (line.startsWith("worktree ")) {
        cur = { path: line.slice(9), branch: null };
      } else if (line.startsWith("branch ") && cur) {
        cur.branch = line.slice(7).replace("refs/heads/", "");
        out.push(cur);
        cur = null;
      } else if (!line && cur) {
        out.push(cur);
        cur = null;
      }
    }
    if (cur) out.push(cur);
    return out;
  }
  /** 强制移除一个托管目录（git 已经不认的孤儿目录用这个） */
  async removeOrphan(repo, absPath) {
    const root = path7.resolve(this.worktreeRoot(repo));
    const target = path7.resolve(absPath);
    if (!target.startsWith(root + path7.sep)) throw new Error(`\u62D2\u7EDD\u6E05\u7406\u975E\u6258\u7BA1\u76EE\u5F55\uFF1A${target}`);
    await fs6.promises.rm(target, { recursive: true, force: true });
    await git(repo.path, ["worktree", "prune"]);
  }
  /**
   * 列出仓库受管文件列表（A2：供指令输入框 `@` 文件引用自动补全）。
   * 按文件名匹配优先、路径包含次之排序，返回最多 limit 条 posix 相对路径。
   */
  async listRepoFiles(repo, query, limit = 120) {
    const res = await git(repo.path, ["ls-files"]);
    if (!res.ok) return [];
    const all = res.stdout.split("\n").map((s) => s.trim().replace(/\\/g, "/")).filter(Boolean);
    const q = String(query ?? "").trim().replace(/^@+/, "").toLowerCase();
    const cap = Math.max(1, Math.min(500, limit || 120));
    if (!q) return all.slice(0, cap);
    const exactBase = [];
    const baseHit = [];
    const pathHit = [];
    for (const f of all) {
      const lower = f.toLowerCase();
      const base = lower.slice(lower.lastIndexOf("/") + 1);
      if (base.startsWith(q)) exactBase.push(f);
      else if (base.includes(q)) baseHit.push(f);
      else if (lower.includes(q)) pathHit.push(f);
    }
    return [...exactBase, ...baseHit, ...pathHit].slice(0, cap);
  }
};
async function dirSizeKb(dir, maxEntries = 2e4) {
  let bytes = 0;
  let entries = 0;
  const stack = [dir];
  while (stack.length && entries < maxEntries) {
    const cur = stack.pop();
    let items;
    try {
      items = await withFileTypes(cur);
    } catch {
      continue;
    }
    for (const it of items) {
      if (++entries > maxEntries) break;
      const abs = path7.join(cur, it.name);
      if (it.isDirectory()) stack.push(abs);
      else if (it.isFile()) {
        try {
          bytes += (await fs6.promises.stat(abs)).size;
        } catch {
        }
      }
    }
  }
  return Math.round(bytes / 1024);
}
async function withFileTypes(dir) {
  const handle = await fs6.promises.opendir(dir);
  const out = [];
  for await (const d of handle) out.push(d);
  return out;
}
function splitCommand(cmd) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while (m = re.exec(cmd)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}
async function identityArgs(cwd) {
  const who = await git(cwd, ["config", "user.email"]);
  return who.ok && who.stdout.trim() ? [] : ["-c", "user.name=ai-tasks-mgr", "-c", "user.email=ai-tasks-mgr@localhost"];
}
async function bootstrapBaseline(repo, baseRef, note) {
  const moved = await git(repo.path, ["symbolic-ref", "HEAD", `refs/heads/${baseRef}`]);
  if (!moved.ok) return moved;
  const staged = await git(repo.path, ["add", "-A", "."]);
  if (!staged.ok) return staged;
  const res = await git(repo.path, [...await identityArgs(repo.path), "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", `chore(ai): \u5EFA\u521D\u59CB\u57FA\u7EBF\uFF08\u9762\u677F\u4E3A\u7A7A\u4ED3\u5E93 ${repo.name} \u8865\u7684\u9996\u4E2A\u63D0\u4EA4\uFF09`]);
  if (res.ok) note?.(`\u7A7A\u4ED3\u5E93\uFF1A\u5DF2\u5728 ${baseRef} \u4E0A\u5EFA\u521D\u59CB\u63D0\u4EA4${staged.stdout ? "\uFF08\u5F53\u524D\u6587\u4EF6\u5DF2\u6536\u8FDB\u57FA\u7EBF\uFF09" : ""}`);
  return res;
}

// src/core/agents/cli.ts
function cliFailureMessage(bin, code, parts) {
  const seen = /* @__PURE__ */ new Set();
  const pieces = [parts.resultText, parts.stderrTail, parts.stdoutTail, parts.assistantText].map((x) => (x ?? "").trim()).filter((x) => x && !seen.has(x) && (seen.add(x), true));
  const body = truncate(pieces.join("\n\u2015\u2015\n") || `\u8FDB\u7A0B\u9000\u51FA\u7801 ${code}`, 1500);
  const base = `${bin} \u6267\u884C\u5931\u8D25\uFF08\u9000\u51FA\u7801 ${code}\uFF09\uFF1A${body}`;
  if (!looksLikeAuthError(body)) return base;
  return `${base}
\u8FD9\u662F\u8BA4\u8BC1\u5931\u8D25\uFF08\u4EE4\u724C\u8FC7\u671F / \u672A\u767B\u5F55 / \u7F51\u7EDC\u73AF\u5883\u4E0D\u5BF9\uFF09\uFF0C\u9762\u677F\u65E0\u6CD5\u4EE3\u767B\u5F55\uFF1A\u5728\u7EC8\u7AEF\u91CC\u91CD\u65B0\u767B\u5F55\uFF08\`${bin} /login\` \u6216\u76F4\u63A5\u8FD0\u884C \`${bin}\` \u6309\u63D0\u793A\u767B\u5F55\uFF09\u540E\u518D\u7EE7\u7EED\u3002\u4E2D\u56FD\u7248 / iOA \u7248\u7528 API Key \u65F6\u8FD8\u8981\u786E\u8BA4 CODEBUDDY_INTERNET_ENVIRONMENT\uFF08internal / ioa\uFF09\u2014\u2014\u9762\u677F\u4E0D\u4F1A\u5265\u79BB\u8FD9\u4E2A\u53D8\u91CF\u3002`;
}
var ENV_PASSTHROUGH = /^CODEBUDDY_INTERNET_ENVIRONMENT$/i;
function buildSpawnEnv(processEnv, presetEnv, userEnv) {
  const base = {};
  for (const [k, v] of Object.entries(processEnv)) {
    if (/^CODEBUDDY_/i.test(k) && !ENV_PASSTHROUGH.test(k)) continue;
    base[k] = v;
  }
  return { ...base, ...presetEnv ?? {}, ...userEnv ?? {} };
}
var FIRST_BYTE_TIMEOUT_SEC = 60;
var seamFallbackNoted = false;
var CliAgentAdapter = class {
  /**
   * 子进程从哪条缝出去。默认 null ＝ node 的 `spawn`（桌面端、web 端、测试都是这条）；
   * DSH 插件在进程内跑内核时塞进来一个「走 `ctx.subprocess`」的实现（见 exec.ts 的 SpawnSeam）。
   * `platform` 可注入只为测试：Windows 上「cmd.exe 垫片」那条路的 argv 是按 Win32 规则定死的
   * （windowsVerbatimArguments），宿主接缝没这个开关，只能回落（见下面 needVerbatim 那段）。
   */
  constructor(seam = null, platform = process.platform, hostSession = null) {
    this.seam = seam;
    this.platform = platform;
    this.hostSession = hostSession;
  }
  id = "cli";
  label = "\u672C\u5730 AI CLI\uFF08Claude Code / Codex / Gemini / \u2026\uFF09";
  async capabilities(settings) {
    const cfg = settings?.cli;
    const cmd = cfg?.command.trim() || this.cmd();
    const preset = resolveCliPreset(cfg?.profile, cmd);
    const custom = Boolean(cfg?.argsTemplate.trim());
    const found = (await planExec(cmd, [])).resolved;
    const resume = custom ? cfg.argsTemplate.includes("{resume}") : Boolean(preset.resumeArgs);
    const detail = [
      found ? `\u5DF2\u627E\u5230 ${found}` : `PATH \u91CC\u627E\u4E0D\u5230 \`${cmd}\`${preset.install ? `\uFF08\u6CA1\u88C5\uFF1A${preset.install}\uFF09` : ""}`,
      `${custom ? "\u81EA\u5B9A\u4E49\u6A21\u677F" : `\u9884\u8BBE ${preset.label}`} \xB7 ${describeCliInvocation(preset, { template: cfg?.argsTemplate })}`,
      !found ? "\u4E5F\u53EF\u4EE5\u5728\u300C\u8BBE\u7F6E \u2192 \u5F00\u53D1\u5F15\u64CE\u300D\u91CC\u586B\u7EDD\u5BF9\u8DEF\u5F84\uFF0C\u6216\u6539\u7528 API \u6A21\u5F0F" : "",
      cfg?.model.trim() && !custom && !preset.modelFlag ? `\u5DF2\u586B\u7684\u6A21\u578B\u300C${cfg.model.trim()}\u300D\u5BF9 ${preset.label} \u4E0D\u751F\u6548\uFF08\u5B83\u7684\u7528\u6CD5\u91CC\u6CA1\u8FD9\u4E2A\u65D7\u6807\uFF09\uFF0C\u8BF7\u5728\u53C2\u6570\u6A21\u677F\u91CC\u81EA\u5DF1\u5199 {model}` : ""
    ].filter(Boolean).join(" \xB7 ");
    return {
      streaming: preset.format !== "final-json",
      // 只说「解析器能从这里拿到工具级事件」，别因为用户填了模板就假装结构化
      tools: preset.provides.tools,
      resume,
      available: Boolean(found),
      detail
    };
  }
  cmd() {
    return (process.env.AI_TASKS_CLI_COMMAND || "claude").trim() || "claude";
  }
  async run(input) {
    const cfg = input.settings.cli;
    const bin = (cfg.command || "claude").trim();
    const preset = resolveCliPreset(cfg.profile, bin);
    if (preset.id === "dsh" && input.resumeSessionId) {
      const preRepair = repairDshSessionById(input.resumeSessionId);
      if (preRepair.repaired) {
        input.emit("log", {
          stream: "system",
          text: `\u68C0\u6D4B\u5230\u5386\u53F2\u4F1A\u8BDD ${input.resumeSessionId} \u65E5\u5FD7\u542B\u65E7\u7248\u975E\u5BF9\u8C61\u6D88\u606F\uFF08\u5171 ${preRepair.fixedCount} \u5904\uFF09\uFF0C\u5DF2\u81EA\u52A8\u539F\u5730\u4FEE\u590D\u4F1A\u8BDD\u6587\u4EF6`
        });
      }
    }
    if (preset.id === "dsh" && input.resumeSessionId && this.hostSession?.hasLiveAgent?.(input.resumeSessionId) && typeof this.hostSession.runLiveTurn === "function") {
      const status = this.hostSession.agentStatus?.(input.resumeSessionId);
      if (status === "running") {
        throw new WriterHeldError(
          explainWriterHeldError(input.resumeSessionId, `session "${input.resumeSessionId}" is currently running in DSH GUI`),
          input.resumeSessionId,
          `session "${input.resumeSessionId}" is currently running in DSH GUI`
        );
      }
      return this.runViaHostSession(input, input.resumeSessionId, bin);
    }
    const probe = await planExec(bin, []);
    if (!probe.resolved) {
      throw new AgentUnavailableError(
        `\u627E\u4E0D\u5230 CLI \u547D\u4EE4\uFF1A${bin}`,
        preset.install ? `\u88C5\u597D\u5E76\u767B\u5F55\uFF1A${preset.install}\uFF1B\u6216\u586B\u7EDD\u5BF9\u8DEF\u5F84 / \u6539\u7528 API \u6A21\u5F0F\u3002` : "\u8BF7\u5B89\u88C5\u5E76\u767B\u5F55\u5BF9\u5E94 CLI\uFF0C\u6216\u5728\u300C\u8BBE\u7F6E \u2192 \u5F15\u64CE\u300D\u91CC\u6539\u7528 API \u6A21\u5F0F / \u81EA\u5B9A\u4E49\u547D\u4EE4\u6A21\u677F\u3002"
      );
    }
    const viaShim = probe.shim;
    const prompt = input.instruction;
    const spec = buildArgs(
      bin,
      cfg.argsTemplate,
      { workspace: input.workspacePath, resume: input.resumeSessionId, prompt, model: cfg.model.trim() },
      preset,
      // 经 cmd 转手时，多行长指令塞在参数里容易被引号/换行规则咬到；能走 stdin 就走 stdin
      { forceStdinPrompt: viaShim && !cfg.argsTemplate.trim() && preset.prompt === "argv", permission: input.permission }
    );
    if (viaShim && cfg.argsTemplate.includes("{prompt}")) {
      input.emit("log", {
        stream: "system",
        text: "\u63D0\u793A\uFF1A\u8FD9\u662F .cmd \u57AB\u7247\uFF0C\u6307\u4EE4\u8981\u7ECF cmd \u8F6C\u4E00\u624B\u3002\u82E5\u51FA\u73B0\u53C2\u6570\u88AB\u622A\u65AD/\u6362\u884C\u4E22\u5931\uFF0C\u628A\u6A21\u677F\u91CC\u7684 {prompt} \u6362\u6210 {prompt_file}"
      });
    }
    if (input.resumeSessionId && !spec.resumeApplied) {
      input.emit("log", {
        stream: "system",
        text: `${preset.label} \u6CA1\u6709\u4F1A\u8BDD\u7EED\u63A5\u7684\u7528\u6CD5\uFF0C\u8FD9\u4E00\u8F6E\u6309\u65B0\u5F00\u5904\u7406\uFF08\u5B83\u770B\u4E0D\u89C1\u4E0A\u4E00\u8F6E\u7684\u5BF9\u8BDD\uFF0C\u4F46\u5DE5\u4F5C\u76EE\u5F55\u8FD8\u662F\u540C\u4E00\u4E2A worktree\uFF0C\u6539\u52A8\u770B\u5F97\u89C1\uFF09`
      });
    }
    if (spec.promptFile) {
      await fs7.promises.writeFile(spec.promptFile, prompt + "\n", "utf8");
      input.emit("log", { stream: "system", text: `\u6307\u4EE4\u5DF2\u5199\u5165 ${spec.promptFile}` });
    }
    const launched = await planExec(bin, spec.args);
    const spawnEnv = buildSpawnEnv(process.env, preset.env, cfg.env);
    const needVerbatim = launched.windowsVerbatimArguments && this.platform === "win32";
    if (needVerbatim && this.seam && !seamFallbackNoted) {
      seamFallbackNoted = true;
      input.emit("log", {
        stream: "system",
        text: "\u8FD9\u6761 CLI \u662F .cmd/.bat \u57AB\u7247\uFF0C\u8981\u7ECF cmd.exe \u8F6C\u624B\uFF08\u53C2\u6570\u6309 Win32 \u89C4\u5219\u5B9A\u6B7B\uFF09\u2014\u2014 \u8FD9\u4E00\u6761\u4E0D\u8D70\u5BBF\u4E3B\u7684\u5B50\u8FDB\u7A0B\u63A5\u7F1D\uFF0C\u4ECD\u7531\u9762\u677F\u81EA\u5DF1\u8D77\u8FDB\u7A0B\uFF1B\u7528\u771F exe \u7684\u5F15\u64CE\u4F1A\u4EA4\u7ED9\u5BBF\u4E3B\u6258\u7BA1\u3002"
      });
    }
    const useSeam = Boolean(this.seam) && !needVerbatim;
    let child;
    try {
      child = useSeam ? this.seam({
        file: launched.file,
        args: launched.args,
        cwd: input.workspacePath,
        env: spawnEnv,
        windowsHide: true,
        windowsVerbatimArguments: false
      }) : spawn2(launched.file, launched.args, {
        cwd: input.workspacePath,
        // 先剥掉宿主注入的 CODEBUDDY_*（不剥会复用宿主会话状态 → 无限挂死），再铺预设与用户变量
        env: spawnEnv,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        windowsVerbatimArguments: launched.windowsVerbatimArguments
      });
    } catch (err) {
      throw new AgentUnavailableError(
        explainExecError(err, bin, { viaComSpec: launched.viaComSpec, resolved: launched.resolved }),
        "\u5F15\u64CE\u914D\u7F6E\u9875\uFF1A\u8BBE\u7F6E \u2192 \u5F00\u53D1\u5F15\u64CE \u2192 \u672C\u5730 AI CLI\u3002"
      );
    }
    input.emit("status", { state: "running", phase: "spawn", engine: bin, profile: preset.id, args: spec.args.join(" ") });
    input.emit("log", {
      stream: "system",
      // 命令行照实写：走 node 的脚本要看得见 `node`（不然用户会以为面板凭啥给命令加了东西）
      text: launched.viaComSpec ? `$ cmd /c ${bin} ${spec.args.join(" ")}` : launched.args.length > spec.args.length ? `$ node ${path8.basename(launched.args[0] ?? bin)} ${spec.args.join(" ")}` : `$ ${bin} ${spec.args.join(" ")}`
    });
    let assistantText = "";
    let sessionId = spec.resumeApplied ? input.resumeSessionId : null;
    const usage = {};
    const files = /* @__PURE__ */ new Set();
    const stdoutBuf = [];
    let stderrTail = "";
    let stdoutTail = "";
    let resultText = null;
    let streamErrorText = "";
    let model = null;
    let aborted = false;
    const parser = makeCliParser(spec.format);
    const handle = (e) => {
      switch (e.kind) {
        case "init":
          if (e.sessionId) sessionId = e.sessionId;
          input.emit("status", { state: "running", phase: "init", sessionId });
          break;
        case "permission_mode":
          input.emit("log", { stream: "system", text: `\u5F15\u64CE\u56DE\u62A5\u672C\u8F6E\u8BF7\u6C42\u6863\u4F4D\uFF1A${e.mode}\uFF08\u8BF7\u6C42\u503C\u672A\u5FC5\u662F\u751F\u6548\u503C\uFF09` });
          break;
        case "text":
          assistantText += e.text;
          input.emit("text_delta", { text: e.text });
          break;
        case "tool_use":
          input.emit("tool_call", { name: e.name, args: e.args });
          if (e.args?.path) files.add(String(e.args.path));
          if (Array.isArray(e.args?.paths)) for (const p of e.args.paths) files.add(String(p));
          break;
        case "tool_result": {
          const denied = looksLikePermissionDenyStrong(e.content);
          input.emit("tool_result", { name: e.name, ok: !e.isError && !denied, summary: truncate(e.content, 1200) });
          break;
        }
        case "usage":
          Object.assign(usage, e.usage ?? {});
          break;
        case "model":
          if (e.name && e.name !== model) {
            model = e.name;
            input.emit("status", { state: "running", phase: "model", model: e.name });
            input.emit("log", { stream: "system", text: `\u5F15\u64CE\u6A21\u578B\uFF1A${e.name}` });
          }
          break;
        case "result":
          if (e.result) resultText = e.result;
          if (e.sessionId) sessionId = e.sessionId;
          break;
        case "denials":
          input.emit("log", { stream: "system", denials: e.count, text: `\u5F15\u64CE\u81EA\u62A5 ${e.count} \u6B21\u6743\u9650\u62D2\u7EDD\uFF1A${e.tools.join("\u3001")}` });
          break;
        case "error":
          streamErrorText = (streamErrorText ? `${streamErrorText}
` : "") + e.message;
          input.emit("error", { message: e.message });
          break;
      }
    };
    const kill = () => {
      aborted = true;
      killTree(child);
    };
    const onAbort = () => kill();
    input.signal.addEventListener("abort", onAbort, { once: true });
    const timer = cfg.timeoutSec > 0 ? setTimeout(() => {
      input.emit("error", { message: `\u8D85\u8FC7 ${cfg.timeoutSec}s\uFF0C\u5DF2\u7EC8\u6B62\u5B50\u8FDB\u7A0B` });
      kill();
    }, cfg.timeoutSec * 1e3) : null;
    const firstByteTimeoutSec = cfg.firstByteTimeoutSec ?? FIRST_BYTE_TIMEOUT_SEC;
    let watchdogMsg = null;
    let firstByteSeen = false;
    const markFirstByte = () => {
      firstByteSeen = true;
      if (watchdog) clearTimeout(watchdog);
    };
    const watchdog = firstByteTimeoutSec > 0 ? setTimeout(() => {
      if (firstByteSeen || aborted) return;
      watchdogMsg = `${bin} \u542F\u52A8\u540E ${firstByteTimeoutSec}s \u6CA1\u6709\u4EFB\u4F55\u8F93\u51FA\uFF0C\u6309\u6302\u8D77\u5904\u7406\u5DF2\u7EC8\u6B62\u3002\u5E38\u89C1\u539F\u56E0\uFF1A\u5BBF\u4E3B\u7EC8\u7AEF\u6CE8\u5165\u4E86\u540C\u4E00\u5BB6 CLI \u7684\u4F1A\u8BDD\u53D8\u91CF\uFF08\u9762\u677F\u5DF2\u5265\u79BB CODEBUDDY_*\uFF0C\u5176\u4F59\u8BF7\u5728\u300C\u8BBE\u7F6E \u2192 \u5F15\u64CE \u2192 \u73AF\u5883\u53D8\u91CF\u300D\u81EA\u67E5\uFF09\u3001\u767B\u5F55\u6001\u8FC7\u671F\u3001\u6216\u7F51\u7EDC/\u4EE3\u7406\u5361\u4F4F\u3002`;
      input.emit("error", { message: watchdogMsg });
      kill();
    }, firstByteTimeoutSec * 1e3) : null;
    if (watchdog) {
      child.stdout.once("data", markFirstByte);
      child.stderr.once("data", markFirstByte);
    }
    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      const t = line.trim();
      if (!t) return;
      stdoutBuf.push(t);
      if (stdoutBuf.length > 4e3) stdoutBuf.shift();
      stdoutTail = (stdoutTail + t + "\n").slice(-4e3);
      const events = parser.feed(t);
      if (!events.length) {
        input.emit("log", { stream: "stdout", text: t.slice(0, 2e3) });
        return;
      }
      for (const e of events) handle(e);
    });
    child.stderr.on("data", (chunk) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-8e3);
      for (const l of chunk.toString("utf8").split("\n").filter(Boolean).slice(0, 20)) {
        input.emit("log", { stream: "stderr", text: l.slice(0, 1e3) });
      }
    });
    if (spec.promptViaStdin) {
      child.stdin.write(prompt);
      if (!prompt.endsWith("\n")) child.stdin.write("\n");
    }
    child.stdin.end();
    let code;
    try {
      code = await new Promise((resolve, reject) => {
        child.on("error", (err) => reject(new Error(explainExecError(err, bin, { viaComSpec: launched.viaComSpec, resolved: launched.resolved }))));
        child.on("close", (c) => resolve(typeof c === "number" ? c : 0));
      });
    } finally {
      rl.close();
      if (timer) clearTimeout(timer);
      if (watchdog) clearTimeout(watchdog);
      input.signal.removeEventListener("abort", onAbort);
      if (spec.promptFile) await fs7.promises.rm(spec.promptFile, { force: true }).catch(() => void 0);
    }
    for (const e of parser.finish(stdoutBuf.join("\n"))) handle(e);
    if (watchdogMsg) throw new Error(watchdogMsg);
    if (aborted || input.signal.aborted) throw new AbortError();
    const streamHeld = looksLikeWriterHeldError(streamErrorText, input.resumeSessionId);
    if (code !== 0 || streamHeld.held) {
      const rawErr = cliFailureMessage(bin, code || 1, {
        resultText: resultText || streamErrorText || null,
        stderrTail,
        stdoutTail,
        assistantText
      });
      const held = streamHeld.held ? streamHeld : looksLikeWriterHeldError(rawErr, input.resumeSessionId);
      if (held.held) {
        const targetSid = held.sessionId ?? input.resumeSessionId;
        if (targetSid && this.hostSession?.hasLiveAgent?.(targetSid) && this.hostSession.agentStatus?.(targetSid) !== "running" && typeof this.hostSession.runLiveTurn === "function") {
          input.emit("log", {
            stream: "system",
            text: `\u68C0\u6D4B\u5230\u4F1A\u8BDD ${targetSid} \u5355\u5199\u8005\u9501\u5DF2\u88AB\u5F53\u524D DSH \u684C\u9762\u7248\u6301\u6709 \u2014\u2014 \u81EA\u52A8\u5207\u6362\u4E3A\u8FDB\u7A0B\u5185\u501F\u9053\u6295\u9012\uFF08\u65E0\u9700\u5173\u95ED\u4F1A\u8BDD\u6216\u91CD\u542F\u684C\u9762\u7248\uFF09`
          });
          return this.runViaHostSession(input, targetSid, bin);
        }
        throw new WriterHeldError(explainWriterHeldError(targetSid, rawErr), targetSid, rawErr);
      }
      const corrupt = looksLikeCorruptSessionError(rawErr, input.resumeSessionId);
      if (corrupt.corrupt && input.resumeSessionId) {
        const targetSid = corrupt.sessionId ?? input.resumeSessionId;
        const retryState = input;
        const rep = repairDshSessionById(targetSid, rawErr);
        if (rep.repaired && !retryState._corruptRetried) {
          input.emit("log", {
            stream: "system",
            text: `\u68C0\u6D4B\u5230\u4F1A\u8BDD ${targetSid} \u65E5\u5FD7\u56E0\u5386\u53F2\u6D88\u606F\u683C\u5F0F\u635F\u574F\uFF08\u5DF2\u81EA\u52A8\u539F\u5730\u4FEE\u590D ${rep.fixedCount} \u5904\u8BB0\u5F55\uFF09\uFF0C\u6B63\u5728\u65E0\u7F1D\u91CD\u8BD5\u672C\u8F6E\u6307\u4EE4\u2026`
          });
          return this.run({ ...input, _corruptRetried: true });
        }
        if (!retryState._freshFallbackRetried) {
          input.emit("log", {
            stream: "system",
            level: "warn",
            text: `\u68C0\u6D4B\u5230\u4F1A\u8BDD ${targetSid} \u65E5\u5FD7\u5DF2\u635F\u574F\u4E14\u65E0\u6CD5\u539F\u5730\u6062\u590D\uFF0C\u5DF2\u81EA\u52A8\u5F00\u542F\u65B0\u4F1A\u8BDD\u5E76\u6CE8\u5165\u5386\u53F2\u4E0A\u4E0B\u6587\u7EE7\u7EED\u6267\u884C\u2026`
          });
          const fallbackBase = {
            ...input,
            resumeSessionId: null,
            instruction: input.rawInstruction ?? input.instruction
          };
          const fallbackInput = {
            ...fallbackBase,
            instruction: buildInstruction(fallbackBase)
          };
          return this.run({
            ...fallbackInput,
            _corruptRetried: true,
            _freshFallbackRetried: true
          });
        }
      }
      throw new Error(rawErr);
    }
    const summary = (resultText || assistantText || "\uFF08CLI \u672A\u8FD4\u56DE\u6587\u672C\u7ED3\u8BBA\uFF09").trim();
    input.emit("assistant_message", { content: summary });
    if (Object.keys(usage).length) input.emit("usage", usage);
    const filesChanged = [...files].filter((f) => f && !f.startsWith("/") && !f.includes(".."));
    input.emit("result", { ok: true, summary, filesChanged });
    return {
      summary,
      sessionId,
      filesChanged,
      commits: [],
      usage: Object.keys(usage).length ? { ...usage } : void 0,
      model,
      // 只有模板/预设里真写了 {resume} 且拿到了 id，才算接上了
      resumed: spec.resumeApplied
    };
  }
  /**
   * P2 进程内借道投递：
   * 通过宿主 `HostSessionSeam.runLiveTurn` 直接驱动已在 `ctx.agents` 存活的 DSH 会话跑一轮，
   * 事件流转成与 `dsh headless --json` 同构的 NDJSON 行喂给 `makeCliParser('dsh-jsonl')`。
   */
  async runViaHostSession(input, sessionId, bin) {
    const prompt = buildFollowUpInstruction(input);
    input.emit("status", {
      state: "running",
      phase: "spawn",
      engine: bin,
      profile: "dsh",
      args: `in-process followup --session-id ${sessionId}`
    });
    input.emit("log", {
      stream: "system",
      text: `\u68C0\u6D4B\u5230\u4F1A\u8BDD ${sessionId} \u5DF2\u5728 DSH \u684C\u9762\u7248\u6253\u5F00\uFF08\u5BBF\u4E3B\u6301\u6709\u5355\u5199\u8005\u9501\uFF09\u2014\u2014 \u6539\u8D70\u8FDB\u7A0B\u5185\u501F\u9053\u6295\u9012\uFF0C\u76F4\u63A5\u9A71\u52A8\u8BE5\u4F1A\u8BDD\u7EED\u804A`
    });
    let assistantText = "";
    let resolvedSessionId = sessionId;
    const usage = {};
    const files = /* @__PURE__ */ new Set();
    let resultText = null;
    let model = null;
    const parser = makeCliParser("dsh-json");
    const handle = (e) => {
      switch (e.kind) {
        case "init":
          if (e.sessionId) resolvedSessionId = e.sessionId;
          input.emit("status", { state: "running", phase: "init", sessionId: resolvedSessionId });
          break;
        case "text":
          assistantText += e.text;
          input.emit("text_delta", { text: e.text });
          break;
        case "tool_use":
          input.emit("tool_call", { name: e.name, args: e.args });
          if (e.args?.path) files.add(String(e.args.path));
          if (Array.isArray(e.args?.paths)) for (const p of e.args.paths) files.add(String(p));
          break;
        case "tool_result": {
          const denied = looksLikePermissionDenyStrong(e.content);
          input.emit("tool_result", { name: e.name, ok: !e.isError && !denied, summary: truncate(e.content, 1200) });
          break;
        }
        case "usage":
          Object.assign(usage, e.usage ?? {});
          break;
        case "model":
          if (e.name && e.name !== model) {
            model = e.name;
            input.emit("status", { state: "running", phase: "model", model: e.name });
            input.emit("log", { stream: "system", text: `\u5F15\u64CE\u6A21\u578B\uFF1A${e.name}` });
          }
          break;
        case "result":
          if (e.result) resultText = e.result;
          if (e.sessionId) resolvedSessionId = e.sessionId;
          break;
        case "error":
          input.emit("error", { message: e.message });
          break;
      }
    };
    const turnImages = collectCurrentTurnUserImages(input);
    const res = await this.hostSession.runLiveTurn({
      sessionId,
      prompt,
      ...turnImages.length ? { images: turnImages } : {},
      cwd: input.workspacePath,
      signal: input.signal,
      rpcId: `aitm:${input.taskId}:${Date.now()}`,
      onLine: (line) => {
        const t = line.trim();
        if (!t) return;
        const events = parser.feed(t);
        for (const e of events) handle(e);
      }
    });
    if (input.signal.aborted) throw new AbortError();
    if (!res.ok) {
      const errMsg = res.error || "DSH \u5BBF\u4E3B\u4F1A\u8BDD\u6267\u884C\u5931\u8D25";
      if (res.errorCode === "writer-held" || looksLikeWriterHeldError(errMsg, sessionId).held) {
        throw new WriterHeldError(explainWriterHeldError(sessionId, errMsg), sessionId, errMsg);
      }
      const corrupt = looksLikeCorruptSessionError(errMsg, sessionId);
      if (corrupt.corrupt) {
        const retryState = input;
        const rep = repairDshSessionById(sessionId, errMsg);
        if (rep.repaired && !retryState._corruptRetried) {
          input.emit("log", {
            stream: "system",
            text: `\u68C0\u6D4B\u5230\u4F1A\u8BDD ${sessionId} \u65E5\u5FD7\u56E0\u5386\u53F2\u6D88\u606F\u683C\u5F0F\u635F\u574F\uFF08\u5DF2\u81EA\u52A8\u539F\u5730\u4FEE\u590D ${rep.fixedCount} \u5904\u8BB0\u5F55\uFF09\uFF0C\u6B63\u5728\u65E0\u7F1D\u91CD\u8BD5\u672C\u8F6E\u6307\u4EE4\u2026`
          });
          return this.runViaHostSession({ ...input, _corruptRetried: true }, sessionId, bin);
        }
        if (!retryState._freshFallbackRetried) {
          input.emit("log", {
            stream: "system",
            level: "warn",
            text: `\u68C0\u6D4B\u5230\u4F1A\u8BDD ${sessionId} \u65E5\u5FD7\u5DF2\u635F\u574F\u4E14\u65E0\u6CD5\u539F\u5730\u6062\u590D\uFF0C\u5DF2\u81EA\u52A8\u5F00\u542F\u65B0\u4F1A\u8BDD\u5E76\u6CE8\u5165\u5386\u53F2\u4E0A\u4E0B\u6587\u7EE7\u7EED\u6267\u884C\u2026`
          });
          const fallbackBase = {
            ...input,
            resumeSessionId: null,
            instruction: input.rawInstruction ?? input.instruction
          };
          const fallbackInput = {
            ...fallbackBase,
            instruction: buildInstruction(fallbackBase)
          };
          return this.run({
            ...fallbackInput,
            _corruptRetried: true,
            _freshFallbackRetried: true
          });
        }
      }
      throw new Error(cliFailureMessage(bin, 1, { resultText: errMsg, assistantText }));
    }
    const summary = (res.text || resultText || assistantText || "\uFF08CLI \u672A\u8FD4\u56DE\u6587\u672C\u7ED3\u8BBA\uFF09").trim();
    input.emit("assistant_message", { content: summary });
    if (Object.keys(usage).length) input.emit("usage", usage);
    const filesChanged = [...files].filter((f) => f && !f.startsWith("/") && !f.includes(".."));
    input.emit("result", { ok: true, summary, filesChanged });
    return {
      summary,
      sessionId: resolvedSessionId,
      filesChanged,
      commits: [],
      usage: Object.keys(usage).length ? { ...usage } : void 0,
      model,
      resumed: true
    };
  }
};
function presetArgs(preset, resume) {
  if (resume && preset.resumeArgs) return { args: [...preset.resumeArgs], resumeApplied: true };
  return { args: [...preset.firstArgs], resumeApplied: Boolean(resume && preset.resumeArgs) };
}
function buildArgs(bin, template, vars, preset = resolveCliPreset(void 0, bin), opts = {}) {
  const custom = Boolean(template?.trim());
  const forceStdin = !!opts.forceStdinPrompt && !custom;
  let tokens;
  let resumeApplied = false;
  if (custom) {
    tokens = splitCommand(template.trim());
    resumeApplied = Boolean(vars.resume && tokens.includes("{resume}"));
  } else {
    const p = presetArgs(preset, vars.resume);
    tokens = p.args;
    resumeApplied = p.resumeApplied;
    const flag = vars.model ? (preset.modelFlag ?? []).map((t) => t.replaceAll("{model}", vars.model)) : [];
    if (flag.length) {
      const at = tokens.findIndex((t) => t.includes("{prompt") || t === "-");
      const gap = at > 0 && tokens[at - 1].startsWith("-") ? 1 : 0;
      if (at >= 0) tokens.splice(at - gap, 0, ...flag);
      else tokens.push(...flag);
    }
    if (opts.permission) tokens = applyPermissionToTokens(tokens, opts.permission);
  }
  const wantsFile = tokens.some((t) => t.includes("{prompt_file}"));
  const promptFile = wantsFile ? path8.join(os3.tmpdir(), `ai-tasks-prompt-${process.pid}-${Date.now()}.md`) : void 0;
  let wantsPrompt = false;
  const args = [];
  for (const tok of tokens) {
    let next = tok;
    if (next.includes("{prompt_file}")) next = next.replaceAll("{prompt_file}", promptFile ?? "");
    if (next.includes("{prompt}")) {
      wantsPrompt = true;
      if (forceStdin) continue;
      next = next.replaceAll("{prompt}", vars.prompt ?? "");
    }
    next = next.replaceAll("{workspace}", vars.workspace).replaceAll("{resume}", vars.resume ?? "").replaceAll("{model}", vars.model ?? "");
    if (!next.trim()) continue;
    args.push(next);
  }
  if (!custom && !wantsPrompt && !wantsFile && preset.prompt === "argv" && vars.prompt && !forceStdin) args.push(vars.prompt);
  const viaStdin = forceStdin ? !wantsFile : !wantsFile && !wantsPrompt && (custom ? true : preset.prompt === "stdin");
  return {
    args,
    promptViaStdin: viaStdin,
    ...promptFile ? { promptFile } : {},
    resumeApplied,
    format: preset.format
  };
}
function collectCurrentTurnUserImages(input) {
  const lastUser = [...input.context.priorMessages ?? []].reverse().find((m) => m.role === "user");
  const msgImgs = lastUser?.images ?? [];
  if (!msgImgs.length) return [];
  const atts = input.context.attachments ?? [];
  const out = [];
  for (const im of msgImgs) {
    const matched = atts.find((a) => a.name === im.name || a.path.endsWith(`/${im.name}`));
    const relPath = matched?.path ?? `.aitasks/attachments/${im.name}`;
    const absPath = path8.isAbsolute(relPath) ? relPath : path8.join(input.workspacePath, relPath);
    try {
      if (fs7.existsSync(absPath)) {
        const buf = fs7.readFileSync(absPath);
        if (buf.length > 0) {
          out.push({
            name: im.name,
            mime: im.mime || "image/png",
            dataBase64: buf.toString("base64"),
            filePath: absPath
          });
        }
      }
    } catch {
    }
  }
  return out;
}
function truncate(s, n) {
  if (!s) return "";
  return s.length > n ? `${s.slice(0, n)}
\u2026\uFF08\u622A\u65AD\uFF0C\u5171 ${s.length} \u5B57\u7B26\uFF09` : s;
}

// src/core/agents/mock.ts
import fs8 from "node:fs";
import path9 from "node:path";
var MockAgentAdapter = class {
  id = "mock";
  label = "\u5185\u7F6E\u6F14\u793A\u5F15\u64CE (offline)";
  async capabilities() {
    return { streaming: true, tools: true, resume: true, available: true, detail: "\u65E0\u9700 API key\uFF0C\u7528\u4E8E\u6F14\u793A\u4E0E\u81EA\u68C0" };
  }
  async run(input) {
    const { emit, signal, settings } = input;
    const delay = settings.mock.stepDelayMs;
    const changed = [];
    const plan = this.plan(input);
    try {
      emit("status", { state: "running", phase: "thinking" });
      emit("plan", { steps: plan.map((s) => s.title), raw: plan });
      await sleep(delay, signal);
      const files = this.mentionedFiles(input);
      if (files.length) emit("tool_call", { name: "read_file", args: { paths: files } });
      for (const f of files) {
        const abs = path9.resolve(input.workspacePath, f);
        const exists = fs8.existsSync(abs);
        emit("tool_result", { name: "read_file", ok: exists, summary: exists ? `${f}: ${fs8.statSync(abs).size} bytes` : `${f}: \u4E0D\u5B58\u5728\uFF0C\u5C06\u65B0\u5EFA` });
        await sleep(Math.min(delay / 2, 160), signal);
      }
      for (const step of plan) {
        if (signal?.aborted) throw new AbortError();
        emit("status", { state: "running", phase: step.phase });
        emit("tool_call", { name: step.tool, args: step.args, step: step.title });
        await sleep(delay, signal);
        let ok2 = true;
        let summary2 = step.dryRun ?? "ok";
        if (step.tool === "write_file" && settings.mock.writeFiles) {
          try {
            const written = this.apply(input.workspacePath, step);
            changed.push(...written);
            summary2 = written.length ? `\u5DF2\u5199\u5165 ${written.join(", ")}` : "\u65E0\u9700\u5199\u5165";
          } catch (err) {
            ok2 = false;
            summary2 = err.message;
          }
        }
        emit("tool_result", { name: step.tool, ok: ok2, summary: summary2 });
        if (ok2 && changed.length) {
          for (const c of changed) emit("file_change", { path: c, source: "mock" });
        }
        await sleep(Math.min(delay / 3, 120), signal);
      }
      const filesFromDisk = changed.length ? changed : await this.scanDirty(input.workspacePath);
      const summary = [
        `\u672C\u8F6E\u6309\u6307\u4EE4\u5B8C\u6210\u4E86 ${plan.length} \u4E2A\u6B65\u9AA4\u3002`,
        filesFromDisk.length ? `\u6539\u52A8\u6587\u4EF6\uFF1A${filesFromDisk.join(", ")}\u3002` : "\u672C\u8F6E\u4E3A\u5206\u6790\u6027\u7ED3\u8BBA\uFF0C\u672A\u4EA7\u751F\u6587\u4EF6\u6539\u52A8\u3002",
        "\uFF08\u5185\u7F6E\u6F14\u793A\u5F15\u64CE\u4EA7\u51FA\uFF1B\u6362\u6210 CLI / API \u5F15\u64CE\u540E\u7531\u771F\u5B9E\u6A21\u578B\u5B8C\u6210\u540C\u6837\u7684\u52A8\u4F5C\u3002\uFF09"
      ].join(" ");
      emit("usage", { inputTokens: input.instruction.length, outputTokens: summary.length, approximate: 1 });
      emit("assistant_message", { content: summary });
      emit("result", { ok: true, summary, filesChanged: filesFromDisk });
      return {
        summary,
        sessionId: `mock_${slug(input.ideaId, 12)}`,
        resumed: false,
        filesChanged: filesFromDisk,
        commits: [],
        usage: { inputTokens: input.instruction.length, outputTokens: summary.length, approximate: 1 }
      };
    } catch (err) {
      if (isAbort(err) || signal?.aborted) {
        emit("status", { state: "cancelled" });
        throw new AbortError();
      }
      emit("error", { message: err.message });
      throw err;
    }
  }
  mentionedFiles(input) {
    const re = /[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|md|json|css|html|sh|yml|yaml)\b/g;
    const found = /* @__PURE__ */ new Set();
    for (const m of input.instruction.matchAll(re)) {
      const rel = m[0].replace(/^\.?\//, "");
      if (!rel.includes("..")) found.add(rel);
    }
    return [...found].slice(0, 8);
  }
  plan(input) {
    const text = `${input.instruction}
${input.context.ideaTitle}`;
    const isFix = /(修复|修 bug|bugfix|报错|失败|fix)/i.test(text);
    const isReview = /(评审|review|检查|看看)/i.test(text);
    const files = this.mentionedFiles(input);
    const note = `docs/ai-notes/${slug(input.ideaId, 16)}.md`;
    const steps = [
      { title: "\u68B3\u7406\u9700\u6C42\u4E0E\u9A8C\u6536\u6807\u51C6", phase: "plan", tool: "think", args: { ideaId: input.ideaId } },
      { title: "\u626B\u63CF\u76F8\u5173\u4EE3\u7801", phase: "explore", tool: "list_files", args: { cwd: "." } }
    ];
    if (isReview) {
      steps.push({ title: "\u9010\u6587\u4EF6\u5BA1\u9605\u5E76\u8BB0\u5F55\u95EE\u9898", phase: "review", tool: "read_file", args: { paths: files } });
    } else if (isFix) {
      steps.push(
        { title: "\u5B9A\u4F4D\u5931\u8D25\u70B9", phase: "diagnose", tool: "read_file", args: { paths: files } },
        { title: "\u5199\u5165\u4FEE\u590D\u8BF4\u660E", phase: "patch", tool: "write_file", args: { path: note } }
      );
    } else {
      steps.push(
        { title: "\u62DF\u5B9A\u5B9E\u73B0\u65B9\u6848", phase: "plan", tool: "think", args: { outline: true } },
        { title: "\u843D\u76D8\u5B9E\u73B0\u8BB0\u5F55", phase: "implement", tool: "write_file", args: { path: note } }
      );
    }
    if (files.length) {
      steps.push({ title: `\u6309\u6307\u4EE4\u66F4\u65B0 ${files[0]}`, phase: "patch", tool: "write_file", args: { path: files[0] } });
    }
    steps.push({ title: "\u81EA\u68C0\u5E76\u603B\u7ED3", phase: "verify", tool: "run_cmd", args: { cmd: "git status --short" }, dryRun: "worktree \u5DF2\u5C31\u7EEA" });
    return steps;
  }
  apply(root, step) {
    const rel = String(step.args.path ?? "");
    if (!rel) return [];
    const abs = path9.resolve(root, rel);
    const rootAbs = path9.resolve(root);
    if (!abs.startsWith(rootAbs + path9.sep)) throw new Error(`\u62D2\u7EDD\u5199\u5230 worktree \u4E4B\u5916\uFF1A${rel}`);
    fs8.mkdirSync(path9.dirname(abs), { recursive: true });
    const stamp2 = (/* @__PURE__ */ new Date()).toISOString();
    if (abs.endsWith(".md")) {
      const body = [
        `# AI \u5F00\u53D1\u8BB0\u5F55`,
        ``,
        `- \u4EFB\u52A1\uFF1A${step.args.ideaId ?? ""}`,
        `- \u65F6\u95F4\uFF1A${stamp2}`,
        `- \u6B65\u9AA4\uFF1A${step.title}`,
        ``,
        `> \u8FD9\u6BB5\u5185\u5BB9\u7531\u5185\u7F6E\u6F14\u793A\u5F15\u64CE\u5199\u5165\uFF0C\u7528\u6765\u9A8C\u8BC1\u300CAI \u6539\u52A8 \u2192 \u9762\u677F diff \u2192 \u9A8C\u6536\u5408\u5E76\u300D\u7684\u95ED\u73AF\u3002`,
        `> \u63A5\u5165 Claude Code CLI \u6216 API \u5F15\u64CE\u540E\uFF0C\u8FD9\u91CC\u4F1A\u662F\u771F\u5B9E\u6A21\u578B\u7684\u4EA7\u51FA\u3002`,
        ``
      ].join("\n");
      const prev2 = fs8.existsSync(abs) ? fs8.readFileSync(abs, "utf8") : "";
      fs8.writeFileSync(abs, prev2 ? `${prev2}
---

${body}` : body, "utf8");
      return [rel];
    }
    const prev = fs8.existsSync(abs) ? fs8.readFileSync(abs, "utf8") : "";
    const marker = `
// [ai-tasks-mgr] ${stamp2} \u2014 ${step.title}
`;
    fs8.writeFileSync(abs, prev + marker, "utf8");
    return [rel];
  }
  async scanDirty(root) {
    try {
      const { execFile: execFile3 } = await import("node:child_process");
      const { promisify: promisify3 } = await import("node:util");
      const { stdout } = await promisify3(execFile3)("git", ["status", "--porcelain=v1"], { cwd: root });
      return stdout.split("\n").filter(Boolean).map((l) => l.slice(3).trim()).slice(0, 40);
    } catch {
      return [];
    }
  }
};

// src/core/agents/registry.ts
var AdapterRegistry = class {
  adapters = /* @__PURE__ */ new Map();
  /** deps.spawn / deps.hostSession：宿主给的子进程与会话接缝（DSH 插件那条，见 exec.ts） */
  constructor(deps = {}) {
    for (const a of [
      new MockAgentAdapter(),
      new CliAgentAdapter(deps.spawn ?? null, process.platform, deps.hostSession ?? null),
      new ApiAgentAdapter()
    ]) {
      this.adapters.set(a.id, a);
    }
  }
  get(id) {
    const a = this.adapters.get(id);
    if (!a) throw new Error(`\u672A\u77E5\u5F15\u64CE\uFF1A${id}`);
    return a;
  }
  list() {
    return [...this.adapters.values()];
  }
  resolve(settings) {
    const wanted = this.get(settings.activeAdapter);
    return wanted;
  }
};

// src/core/workspace/skills.ts
import fs9 from "node:fs";
import os4 from "node:os";
import path10 from "node:path";
var SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
var ATTACHMENTS_DIR = ".aitasks/attachments";
var EXCLUDE_BEGIN = "# >>> ai-tasks-mgr: \u6CE8\u5165\u7684\u6280\u80FD\uFF08\u9762\u677F\u7BA1\u7406\uFF0C\u52FF\u624B\u6539\uFF09";
var EXCLUDE_END = "# <<< ai-tasks-mgr: \u6CE8\u5165\u7684\u6280\u80FD\u7ED3\u675F";
var MANIFEST_PREFIX = "# injected: ";
var ATTACH_BEGIN = "# >>> ai-tasks-mgr: \u53C2\u8003\u9644\u4EF6\uFF08\u9762\u677F\u7BA1\u7406\uFF0C\u52FF\u624B\u6539\uFF09";
var ATTACH_END = "# <<< ai-tasks-mgr: \u53C2\u8003\u9644\u4EF6\u7ED3\u675F";
var ATTACH_MANIFEST_PREFIX = "# injected-files: ";
var SKILLS_SECTION = { begin: EXCLUDE_BEGIN, end: EXCLUDE_END, manifestPrefix: MANIFEST_PREFIX };
var ATTACH_SECTION = { begin: ATTACH_BEGIN, end: ATTACH_END, manifestPrefix: ATTACH_MANIFEST_PREFIX };
function readInjectedManifest(excludeFile) {
  return readManifestLine(excludeFile, SKILLS_SECTION);
}
function readManifestLine(excludeFile, section) {
  let content = "";
  try {
    content = fs9.readFileSync(excludeFile, "utf8");
  } catch {
    return null;
  }
  if (!content.includes(section.begin)) return null;
  const line = content.split("\n").find((l) => l.startsWith(section.manifestPrefix));
  if (!line) return [];
  return line.slice(section.manifestPrefix.length).split(",").map((x) => x.trim()).filter(Boolean);
}
function writeSection(excludeFile, section, patterns, injectedNames) {
  fs9.mkdirSync(path10.dirname(excludeFile), { recursive: true });
  let content = "";
  try {
    content = fs9.readFileSync(excludeFile, "utf8");
  } catch {
  }
  const begin = content.indexOf(section.begin);
  if (begin >= 0) {
    const end = content.indexOf(section.end, begin);
    content = end >= 0 ? content.slice(0, begin) + content.slice(end + section.end.length) : content.slice(0, begin);
  }
  content = `${content.replace(/\s+$/, "")}

${section.begin}
${patterns.join("\n")}
${section.manifestPrefix}${injectedNames.join(",")}
${section.end}
`;
  fs9.writeFileSync(excludeFile, content, "utf8");
}
function expandHome(p) {
  if (p === "~") return os4.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path10.join(os4.homedir(), p.slice(2));
  return p;
}
function gitDirOf(worktree) {
  const dotGit = path10.join(worktree, ".git");
  const st = fs9.statSync(dotGit, { throwIfNoEntry: false });
  if (st?.isFile()) {
    const m = /^gitdir:\s*(.+)$/m.exec(fs9.readFileSync(dotGit, "utf8"));
    if (!m) throw new Error(`.git \u6587\u4EF6\u91CC\u6CA1\u6709 gitdir\uFF1A${dotGit}`);
    const raw = m[1].trim();
    return path10.isAbsolute(raw) ? raw : path10.join(worktree, raw);
  }
  if (st?.isDirectory()) return dotGit;
  throw new Error(`\u4E0D\u662F git \u5DE5\u4F5C\u533A\uFF1A${worktree}`);
}
async function ensureExcludesInfra(worktree) {
  await git(worktree, ["config", "extensions.worktreeConfig", "true"]);
  let current = "";
  try {
    current = (await git(worktree, ["config", "core.excludesFile"])).stdout.trim();
  } catch {
  }
  const curAbs = current ? path10.resolve(expandHome(current)) : "";
  const gitDir = gitDirOf(worktree);
  const preferred = path10.join(gitDir, "info", "exclude-aitm");
  const excludeFile = curAbs && path10.basename(curAbs).startsWith("exclude-aitm") ? curAbs : preferred;
  if (curAbs && curAbs !== excludeFile) {
    let snap = "";
    try {
      snap = fs9.readFileSync(expandHome(curAbs), "utf8");
    } catch {
    }
    if (snap.trim()) {
      const marker = "# \u4EE5\u4E0B\u662F\u4F60\u539F\u6765\u7684 core.excludesFile\uFF08\u63A5\u7BA1\u65F6\u7684\u4E00\u6B21\u6027\u5FEB\u7167\uFF1B\u4E4B\u540E\u6539\u5168\u5C40\u6587\u4EF6\u4E0D\u4F1A\u540C\u6B65\u5230\u8FD9\u91CC\uFF09";
      let old = "";
      try {
        old = fs9.readFileSync(excludeFile, "utf8");
      } catch {
      }
      if (!old.includes(marker)) {
        fs9.mkdirSync(path10.dirname(excludeFile), { recursive: true });
        fs9.writeFileSync(excludeFile, `${marker}
${snap.replace(/\s+$/, "")}
`, "utf8");
      }
    }
  }
  await git(worktree, ["config", "--worktree", "core.excludesFile", excludeFile]);
  return excludeFile;
}
function discoverSkills(sourceDir) {
  let entries;
  try {
    entries = fs9.readdirSync(sourceDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory()).filter((e) => SKILL_NAME_RE.test(e.name)).map((e) => ({ name: e.name, dir: path10.join(sourceDir, e.name) })).filter((s) => fs9.existsSync(path10.join(s.dir, "SKILL.md")));
}
async function injectSkills(opts) {
  const skills = discoverSkills(opts.sourceDir);
  const targets = [opts.worktree, ...opts.ideaDir ? [path10.join(opts.worktree, opts.ideaDir)] : []];
  const destRoots = targets.flatMap((t) => [".codebuddy", ".claude"].map((e) => path10.join(t, e, "skills")));
  const infraExclude = await ensureExcludesInfra(opts.worktree);
  const prev = readInjectedManifest(infraExclude);
  const currentNames = skills.map((s) => s.name);
  const stale = prev ? prev.filter((n) => !currentNames.includes(n)) : [];
  const skipped = [];
  const collides = /* @__PURE__ */ new Set();
  for (const skill of skills) {
    for (const dest of destRoots) {
      const rel = path10.relative(opts.worktree, path10.join(dest, skill.name)).replaceAll(path10.sep, "/");
      if ((await git(opts.worktree, ["ls-files", "--", rel])).stdout.trim()) {
        collides.add(skill.name);
        skipped.push({ name: skill.name, reason: "\u4E0E\u4ED3\u5E93\u91CC\u5DF2\u63D0\u4EA4\u7684\u540C\u540D\u6280\u80FD\u51B2\u7A81\uFF0C\u4EE5\u4ED3\u5E93\u5185\u7248\u672C\u4E3A\u51C6" });
        break;
      }
    }
  }
  const toCopy = skills.filter((s) => !collides.has(s.name));
  const copyNames = toCopy.map((s) => s.name);
  for (const dest of destRoots) {
    fs9.mkdirSync(dest, { recursive: true });
    for (const skill of toCopy) {
      fs9.rmSync(path10.join(dest, skill.name), { recursive: true, force: true });
      fs9.cpSync(skill.dir, path10.join(dest, skill.name), { recursive: true });
    }
  }
  try {
    const patterns = targets.flatMap((root) => {
      const rel = path10.relative(opts.worktree, root).replaceAll(path10.sep, "/");
      const prefix = rel ? `/${rel}` : "";
      return [`${prefix}/.codebuddy/skills/`, `${prefix}/.claude/skills/`];
    });
    writeSection(infraExclude, SKILLS_SECTION, patterns, copyNames);
    const check = await git(opts.worktree, ["check-ignore", "-q", "--no-index", ".codebuddy/skills"]);
    if (!check.ok) throw new Error("\u6392\u9664\u89C4\u5219\u6CA1\u6709\u751F\u6548\uFF08check-ignore \u4E0D\u8BA4\uFF09");
    for (const dest of destRoots) {
      for (const name of stale) fs9.rmSync(path10.join(dest, name), { recursive: true, force: true });
    }
    return { skills: toCopy, skipped, targets: destRoots, excludeFile: infraExclude };
  } catch (err) {
    for (const dest of destRoots) {
      for (const name of copyNames) fs9.rmSync(path10.join(dest, name), { recursive: true, force: true });
    }
    throw err;
  }
}
var WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
function sanitizeAttachmentName(raw) {
  const base = String(raw ?? "").split(/[\\/]+/).filter((seg) => seg.length > 0).pop() ?? "";
  let name = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/^\.+/, "_").trim().replace(/[. ]+$/, "");
  if (WINDOWS_RESERVED_NAME.test(name)) name = `_${name}`;
  return name || "attachment";
}
async function injectAttachments(opts) {
  const target = path10.join(opts.worktree, ATTACHMENTS_DIR);
  const excludeFile = await ensureExcludesInfra(opts.worktree);
  const prev = readManifestLine(excludeFile, ATTACH_SECTION);
  const skipped = [];
  const plan = [];
  const used = /* @__PURE__ */ new Set();
  for (const f of opts.files) {
    let display = sanitizeAttachmentName(f.name);
    for (let n = 2; used.has(display); n++) display = sanitizeAttachmentName(f.name).replace(/(\.[^.]*)?$/, (ext) => `-${n}${ext}`);
    used.add(display);
    const blob = path10.join(opts.stagingDir, f.id);
    if (!fs9.existsSync(blob)) {
      skipped.push({ name: f.name, reason: "\u9644\u4EF6\u526F\u672C\u5728\u6570\u636E\u76EE\u5F55\u91CC\u627E\u4E0D\u5230\u4E86\uFF08\u53EF\u80FD\u88AB\u624B\u52A8\u6E05\u7406\uFF09\uFF0C\u91CD\u65B0\u6DFB\u52A0\u4E00\u6B21\u5373\u53EF" });
      continue;
    }
    plan.push({ id: f.id, displayName: display, size: f.size });
  }
  for (const p of plan) {
    const rel = `${ATTACHMENTS_DIR}/${p.displayName}`;
    if ((await git(opts.worktree, ["ls-files", "--", rel])).stdout.trim()) {
      p.size = -1;
      skipped.push({ name: p.displayName, reason: "\u4E0E\u4ED3\u5E93\u91CC\u5DF2\u63D0\u4EA4\u7684\u540C\u540D\u6587\u4EF6\u51B2\u7A81\uFF0C\u4EE5\u4ED3\u5E93\u5185\u7248\u672C\u4E3A\u51C6" });
    }
  }
  const toCopy = plan.filter((p) => p.size >= 0);
  fs9.mkdirSync(target, { recursive: true });
  for (const p of toCopy) {
    fs9.rmSync(path10.join(target, p.displayName), { force: true });
    fs9.copyFileSync(path10.join(opts.stagingDir, p.id), path10.join(target, p.displayName));
  }
  try {
    writeSection(excludeFile, ATTACH_SECTION, [`/${ATTACHMENTS_DIR}/`], toCopy.map((p) => p.displayName));
    const check = await git(opts.worktree, ["check-ignore", "-q", "--no-index", ATTACHMENTS_DIR]);
    if (!check.ok) throw new Error("\u6392\u9664\u89C4\u5219\u6CA1\u6709\u751F\u6548\uFF08check-ignore \u4E0D\u8BA4\uFF09");
    for (const name of prev ?? []) {
      if (!toCopy.some((p) => p.displayName === name)) fs9.rmSync(path10.join(target, name), { force: true });
    }
    return { copied: toCopy.map((p) => ({ id: p.id, name: p.displayName, size: p.size })), skipped, target, excludeFile };
  } catch (err) {
    for (const p of toCopy) fs9.rmSync(path10.join(target, p.displayName), { force: true });
    throw err;
  }
}

// src/core/state/idea-machine.ts
var IDEA_TRANSITIONS = {
  inbox: ["scoping", "ready", "developing", "archived", "trash"],
  scoping: ["ready", "inbox", "archived", "trash"],
  ready: ["developing", "scoping", "archived", "trash"],
  developing: ["review", "blocked", "ready", "archived", "trash"],
  review: ["done", "developing", "ready", "blocked", "archived", "trash"],
  blocked: ["developing", "ready", "review", "archived", "trash"],
  done: ["archived", "review", "developing", "trash"],
  archived: ["inbox", "scoping", "ready", "developing", "review", "blocked", "done", "trash"],
  trash: ["inbox", "scoping", "ready", "developing", "review", "blocked", "done", "archived"]
};
function canTransition(from, to) {
  if (from === to) return true;
  return (IDEA_TRANSITIONS[from] ?? []).includes(to);
}
function ideaStatusForTask(status, current) {
  switch (status) {
    case "queued":
    case "running":
      return current === "developing" ? null : "developing";
    case "succeeded":
      return current === "review" ? null : "review";
    case "failed":
    case "cancelled":
      return current === "blocked" ? null : "blocked";
    default:
      return null;
  }
}
var ACTIVE_TASK_STATUSES = ["queued", "running"];
function isActiveTask(status) {
  return ACTIVE_TASK_STATUSES.includes(status);
}

// src/core/services/runner.ts
import fs10 from "node:fs";
import path11 from "node:path";
function engineName(adapterId, st) {
  if (adapterId === "cli") {
    const preset = resolveCliPreset(st.cli.profile, st.cli.command);
    const cmd = st.cli.command.trim();
    const who = preset.id === "generic" || preset.id === "custom" ? cmd || "\u81EA\u5B9A\u4E49\u547D\u4EE4" : preset.label;
    return st.cli.argsTemplate.trim() ? `${who}\uFF08\u81EA\u5B9A\u4E49\u6A21\u677F\uFF09` : who;
  }
  if (adapterId === "api") {
    const m = st.api.model.trim();
    return `HTTP API \xB7 ${st.api.provider === "anthropic" ? "Anthropic" : "OpenAI"}${m ? ` \xB7 ${m}` : ""}`;
  }
  return "Mock \u6F14\u793A\u5F15\u64CE";
}
var TaskRunner = class {
  constructor(store, workspaces, registry, hostSession = null) {
    this.store = store;
    this.workspaces = workspaces;
    this.registry = registry;
    this.hostSession = hostSession;
    this.maxConcurrent = store.getSettings().concurrency;
    try {
      for (const t of store.listTasks()) {
        if (t.sessionId) repairDshSessionById(t.sessionId);
      }
    } catch {
    }
    if (this.hostSession?.onSessionEvent) {
      this.unsubSessionEvent = this.hostSession.onSessionEvent((sessionId, event) => {
        if (!sessionId || !event) return;
        if (event.type === "turn/end" || event.type === "user/message" || event.type === "assistant/message") {
          void this.syncTaskBySessionId(sessionId);
        }
      });
    }
  }
  running = /* @__PURE__ */ new Map();
  pending = [];
  maxConcurrent = 2;
  syncingTasks = /* @__PURE__ */ new Set();
  followUpLocks = /* @__PURE__ */ new Set();
  unsubSessionEvent = null;
  dispose() {
    this.unsubSessionEvent?.();
    this.unsubSessionEvent = null;
  }
  /* -------------------- 队列 -------------------- */
  get stats() {
    return { running: this.running.size, queued: this.pending.length };
  }
  /** 启动一个开发任务（新会话） */
  async startTask(input) {
    const idea = this.store.getIdea(input.ideaId);
    if (!idea) throw new Error(`\u60F3\u6CD5\u4E0D\u5B58\u5728\uFF1A${input.ideaId}`);
    if (!idea.repoId) throw new Error("\u8BE5\u60F3\u6CD5\u8FD8\u6CA1\u7ED1\u5B9A\u4ED3\u5E93\uFF0C\u8BF7\u5148\u5728\u8BE6\u60C5\u91CC\u9009\u62E9\u4ED3\u5E93");
    const repo = this.store.getRepo(idea.repoId);
    if (!repo) throw new Error("\u7ED1\u5B9A\u7684\u4ED3\u5E93\u5DF2\u88AB\u5220\u9664\uFF0C\u8BF7\u91CD\u65B0\u9009\u62E9");
    if (!input.ignoreBlockedBy && Array.isArray(idea.blockedBy) && idea.blockedBy.length > 0) {
      const unresolved = idea.blockedBy.map((depId) => this.store.getIdea(depId)).filter((dep) => Boolean(dep && dep.status !== "done" && dep.status !== "trash"));
      if (unresolved.length > 0) {
        const names = unresolved.map((u) => `\u300A${u.title}\u300B`).join("\u3001");
        throw new Error(`\u8BE5\u60F3\u6CD5\u5B58\u5728\u672A\u5B8C\u6210\u7684\u524D\u7F6E\u4F9D\u8D56\uFF1A${names} \u2014\u2014 \u8BF7\u5148\u5B8C\u6210\u524D\u7F6E\u60F3\u6CD5\uFF0C\u6216\u5728\u300C\u5C5E\u6027\u300D\u9875\u79FB\u9664\u4F9D\u8D56\u540E\u518D\u5F00\u5DE5`);
      }
    }
    if (!input.allowParallelVariant) {
      const active = this.store.listTasks({ ideaId: idea.id }).find((t) => isActiveTask(t.status));
      if (active) throw new Error(`\u8BE5\u60F3\u6CD5\u5DF2\u6709\u8FDB\u884C\u4E2D\u7684\u4EFB\u52A1\uFF08${active.id}\uFF09\uFF0C\u5148\u505C\u6389\u5B83`);
    }
    const now = Date.now();
    const task = {
      id: safeId("t"),
      ideaId: idea.id,
      title: firstLine(input.instruction) || idea.title,
      kind: input.kind ?? "implement",
      status: "queued",
      adapterId: input.adapterId ?? this.store.getSettings().activeAdapter,
      sessionId: null,
      workspace: null,
      diffStat: null,
      commits: [],
      error: null,
      turns: 0,
      ...input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {},
      ...input.sourceRef ? { sourceRef: input.sourceRef } : {},
      createdAt: now,
      startedAt: null,
      endedAt: null,
      updatedAt: now
    };
    this.store.putTask(task);
    const msgImages = this.resolveMessageImages(idea, {
      attachmentIds: input.attachmentIds,
      images: input.images,
      autoIncludeAllIdeaImages: true
    });
    await this.appendMessage({
      ideaId: idea.id,
      taskId: task.id,
      role: "user",
      content: input.instruction,
      ...msgImages.length ? { images: msgImages } : {}
    });
    this.setStatus(idea, "developing");
    this.enqueue(task.id);
    return task;
  }
  /**
   * 多轮指导：往已有任务追加一条指令，复用同一 worktree 与引擎会话。
   * - 当 `opts.retryTurn` 为 true 或 `instruction` 为空时：作为「重试本轮」直接复用线程末尾尚未得到
   *   assistant 回复的最后一条 user 指令，不再追加重复消息；
   * - 当用户重发与末尾未响应 user 指令完全相同的内容时（例如此前因写锁冲突点了两次继续），自动折叠去重（Point 4）。
   */
  async followUp(taskId, instruction = "", opts) {
    if (opts?.syncOnly) {
      const synced = await this.syncTaskSession(taskId);
      if (!synced) throw new Error("\u4EFB\u52A1\u4E0D\u5B58\u5728");
      return synced;
    }
    const task = this.store.getTask(taskId);
    if (!task) throw new Error("\u4EFB\u52A1\u4E0D\u5B58\u5728");
    if (isActiveTask(task.status) || this.followUpLocks.has(taskId)) {
      throw new Error("\u8BE5\u4EFB\u52A1\u6B63\u5728\u6267\u884C\u4E2D\uFF0C\u8BF7\u7B49\u5B83\u505C\u4E0B\u6765\u6216\u5148\u4E2D\u65AD");
    }
    if (!task.workspace) throw new Error("\u4EFB\u52A1\u8FD8\u6CA1\u6709\u5DE5\u4F5C\u76EE\u5F55\uFF0C\u65E0\u6CD5\u7EE7\u7EED");
    const idea = this.store.getIdea(task.ideaId);
    const repo = this.store.getRepo(idea?.repoId ?? "");
    if (!repo) throw new Error("\u4ED3\u5E93\u7F3A\u5931");
    this.followUpLocks.add(taskId);
    try {
      await this.repairHistoricalWriterHeldIfNeeded(taskId);
      const freshTask = this.store.getTask(taskId) ?? task;
      const freshIdea = this.store.getIdea(freshTask.ideaId) ?? idea;
      const msgImages = freshIdea ? this.resolveMessageImages(freshIdea, {
        attachmentIds: opts?.attachmentIds,
        images: opts?.images,
        autoIncludeAllIdeaImages: false
      }) : opts?.images ?? [];
      const trimmed = (instruction ?? "").trim();
      const existing = await this.store.listMessages(freshTask.ideaId);
      const deduped = collapseTrailingDuplicateUserMessages(existing, taskId);
      if (deduped.length !== existing.length) {
        await this.store.rewriteThread(freshTask.ideaId, deduped);
      }
      const lastTaskMsg = [...deduped].reverse().find((m) => m.taskId === taskId);
      const hasUnansweredTrailingUser = lastTaskMsg?.role === "user";
      if (opts?.retryTurn || !trimmed && msgImages.length === 0) {
        if (!hasUnansweredTrailingUser && !deduped.some((m) => m.taskId === taskId && m.role === "user")) {
          throw new Error("\u6CA1\u6709\u53EF\u91CD\u8BD5\u7684\u672C\u8F6E\u7528\u6237\u6307\u4EE4");
        }
      } else if (hasUnansweredTrailingUser && lastTaskMsg.content.trim() === trimmed && msgImages.length === 0) {
      } else {
        await this.appendMessage({
          ideaId: freshTask.ideaId,
          taskId,
          role: "user",
          content: instruction || "\uFF08\u8BF7\u67E5\u770B\u672C\u8F6E\u9644\u5E26\u7684\u56FE\u7247\uFF09",
          source: "panel",
          ...msgImages.length ? { images: msgImages } : {},
          meta: { taskId, source: "panel" }
        });
      }
      const ws = await this.workspaces.prepare(repo, {
        taskId: freshTask.id,
        ideaTitle: this.store.getIdea(freshTask.ideaId)?.title ?? freshTask.title,
        baseRef: freshTask.workspace.baseRef,
        allowDirty: true
      });
      const next = {
        ...freshTask,
        status: "queued",
        error: null,
        errorCode: null,
        retryable: false,
        // 保留原 mergedAt 到 execute 真正跑通前（若遇 writer-held 锁冲突，execute 会原样回滚）
        workspace: { ...ws, mergedAt: freshTask.workspace.mergedAt ?? null },
        updatedAt: Date.now()
      };
      this.store.putTask(next);
      this.setStatus(this.store.getIdea(freshTask.ideaId), "developing");
      this.enqueue(freshTask.id);
      return next;
    } finally {
      this.followUpLocks.delete(taskId);
    }
  }
  enqueue(taskId) {
    this.pending.push(taskId);
    void this.pump();
  }
  /** 把排队中的任务重新推起来（改并发数、重启后恢复队列都用它） */
  resumeQueue() {
    for (const t of this.store.listTasks({ status: "queued" })) {
      if (!this.pending.includes(t.id) && !this.running.has(t.id)) this.pending.push(t.id);
    }
    void this.pump();
    return { started: this.pending.length };
  }
  async pump() {
    while (this.pending.length && this.running.size < this.maxConcurrent) {
      const id = this.pending.shift();
      if (!id || this.running.has(id)) continue;
      const task = this.store.getTask(id);
      if (!task || task.status !== "queued") continue;
      void this.execute(task);
    }
  }
  /* -------------------- 执行 -------------------- */
  async execute(task) {
    const state = {
      taskId: task.id,
      controller: new AbortController(),
      seq: 0,
      buffer: [],
      flushTimer: null,
      liveText: "",
      persistedAssistant: false,
      ideaId: task.ideaId
    };
    this.running.set(task.id, state);
    this.maxConcurrent = this.store.getSettings().concurrency;
    let current = task;
    const prevTurns = current.turns;
    const prevMergedAt = current.workspace?.mergedAt ?? null;
    const emit = (kind, payload) => this.emitEvent(current, state, kind, payload);
    let turnStat = null;
    const stamp2 = (ok2) => turnStat ? {
      turnStats: [...current.turnStats ?? [], { ...turnStat, ok: ok2, endedAt: Date.now() }],
      usage: addUsage(current.usage, turnStat.usage)
    } : {};
    try {
      const idea = this.store.getIdea(current.ideaId);
      if (!idea) throw new Error("\u60F3\u6CD5\u5DF2\u88AB\u5220\u9664");
      const repo = this.store.getRepo(idea.repoId ?? "");
      if (!repo) throw new Error("\u4ED3\u5E93\u672A\u914D\u7F6E");
      emit("status", { state: "running", phase: "workspace" });
      current = this.store.putTask({ ...current, status: "running", startedAt: current.startedAt ?? Date.now(), error: null, updatedAt: Date.now() });
      this.publishTaskStatus(current);
      this.setStatus(idea, "developing");
      const headBefore = current.workspace ? current.workspace : await this.workspaces.prepare(repo, {
        taskId: current.id,
        ideaTitle: idea.title,
        baseRef: repo.defaultBranch,
        allowDirty: repo.allowDirty,
        // 空仓库会被补上首个提交，那种"面板替你动了仓库"的事必须写在流水里
        note: (t) => emit("log", { stream: "system", text: t })
      });
      let attachmentRefs = [];
      const ideaDir = (idea.workDir ?? "").trim() || null;
      const agentCwd = ideaDir ? path11.join(headBefore.path, ideaDir) : headBefore.path;
      if (ideaDir) {
        fs10.mkdirSync(agentCwd, { recursive: true });
        emit("log", { stream: "system", text: `\u60F3\u6CD5\u76EE\u5F55\uFF1A${ideaDir}/ \u2014\u2014 AI \u53EA\u5728\u8FD9\u4E0B\u9762\u52A8\u624B\uFF0C\u6821\u9A8C\u547D\u4EE4\u4E5F\u5728\u8FD9\u91CC\u8DD1` });
        const ignored = await git(headBefore.path, ["check-ignore", "-q", "--no-index", ideaDir]);
        if (ignored.ok) {
          emit("log", { stream: "system", text: `\u6CE8\u610F\uFF1A${ideaDir}/ \u88AB .gitignore \u547D\u4E2D\uFF0C\u8FD9\u4E00\u8F6E\u7684\u6539\u52A8\u63D0\u4EA4\u4E0D\u4E86\u3001\u4E5F\u5C31\u5408\u4E0D\u56DE\u57FA\u7EBF \u2014\u2014 \u6362\u4E2A\u76EE\u5F55\u540D\u6216\u6539 .gitignore` });
        }
      }
      const skillsSource = repo.skillsDir?.trim();
      if (skillsSource) {
        if (!fs10.existsSync(skillsSource)) {
          emit("log", { stream: "system", level: "warn", text: `\u6280\u80FD\u6E90\u76EE\u5F55\u4E0D\u5B58\u5728\uFF1A${skillsSource} \u2014\u2014 \u672C\u8F6E\u6CA1\u6709\u6CE8\u5165\u6280\u80FD\uFF08\u8DEF\u5F84\u914D\u7F6E\u5728\u300C\u4ED3\u5E93 \u2192 \u7F16\u8F91\u300D\uFF09` });
        } else if (!discoverSkills(skillsSource).length) {
          emit("log", { stream: "system", text: `\u6280\u80FD\u6E90\u76EE\u5F55\u91CC\u6CA1\u6709\u6280\u80FD\uFF1A${skillsSource}\uFF08\u6BCF\u4E2A\u6280\u80FD\u9700\u4E3A\u542B SKILL.md \u7684\u5B50\u76EE\u5F55\uFF09` });
        } else {
          try {
            const injection = await injectSkills({ sourceDir: skillsSource, worktree: headBefore.path, ideaDir });
            const where = ideaDir ? `worktree \u6839\u4E0E\u60F3\u6CD5\u76EE\u5F55 ${ideaDir}/` : "worktree \u6839";
            const skippedNote = injection.skipped.length ? `\uFF1B\u8DF3\u8FC7 ${injection.skipped.length} \u4E2A\uFF08${injection.skipped.map((x) => x.name).join("\u3001")}\uFF09\uFF1A${injection.skipped[0].reason}` : "";
            emit(
              "log",
              {
                stream: "system",
                text: `\u5DF2\u6CE8\u5165 ${injection.skills.length} \u4E2A\u6280\u80FD\uFF1A${injection.skills.map((x) => x.name).join("\u3001") || "\uFF08\u65E0\uFF09"} \u2192 ${where} \u7684 .codebuddy/skills/ \u4E0E .claude/skills/\uFF08claude / codebuddy \u4F1A\u6309\u9700\u81EA\u52A8\u52A0\u8F7D\uFF1B\u5DF2\u6309 worktree \u6392\u9664\u51FA git\uFF0C\u4E0D\u8FDB diff\u3001\u4E0D\u4F1A\u88AB\u63D0\u4EA4\uFF09${skippedNote}`
              }
            );
          } catch (err) {
            emit("log", { stream: "system", level: "warn", text: `\u6280\u80FD\u6CE8\u5165\u5931\u8D25\uFF08\u4E0D\u5F71\u54CD\u4EFB\u52A1\uFF09\uFF1A${err.message}` });
          }
        }
      }
      const ideaAttachments = idea.attachments ?? [];
      if (ideaAttachments.length) {
        try {
          const attRes = await injectAttachments({ stagingDir: paths.attachmentBlobDir(idea.id), files: ideaAttachments, worktree: headBefore.path });
          const refOf = (name) => (ideaDir ? `../${ATTACHMENTS_DIR}/${name}` : `${ATTACHMENTS_DIR}/${name}`).replaceAll(path11.sep, "/");
          attachmentRefs = attRes.copied.map((c) => ({ path: refOf(c.name), name: c.name, size: c.size }));
          const skippedNote = attRes.skipped.length ? `\uFF1B\u8DF3\u8FC7 ${attRes.skipped.length} \u4E2A\uFF08${attRes.skipped.map((x) => x.name).join("\u3001")}\uFF09\uFF1A${attRes.skipped[0].reason}` : "";
          emit("log", {
            stream: "system",
            text: `\u5DF2\u653E\u5165 ${attRes.copied.length} \u4E2A\u53C2\u8003\u9644\u4EF6 \u2192 ${ATTACHMENTS_DIR}/\uFF08\u53EA\u8BFB\u80CC\u666F\u8D44\u6599\uFF0C\u5DF2\u6392\u9664\u51FA git\uFF1A\u4E0D\u8FDB diff\u3001\u4E0D\u4F1A\u88AB\u63D0\u4EA4\uFF09${skippedNote}`
          });
        } catch (err) {
          emit("log", { stream: "system", level: "warn", text: `\u9644\u4EF6\u6CE8\u5165\u5931\u8D25\uFF08\u4E0D\u5F71\u54CD\u4EFB\u52A1\uFF09\uFF1A${err.message}` });
        }
      }
      current = this.store.putTask({
        ...current,
        workspace: { ...headBefore, mergedAt: null, discarded: false },
        turns: current.turns + 1,
        updatedAt: Date.now()
      });
      const messages = await this.store.listMessages(current.ideaId);
      const adapter = this.registry.get(current.adapterId || this.store.getSettings().activeAdapter);
      const turnSettings = this.store.getSettings();
      const permPlan = adapter.id === "cli" ? resolvePermissionPlan(repo, turnSettings) : null;
      if (permPlan?.kind === "inert") emit("log", { stream: "system", text: `\u4ED3\u5E93\u6743\u9650\u6863\u4F4D\u6CA1\u6709\u751F\u6548\uFF1A${permPlan.reason}` });
      if (permPlan?.kind === "allowlist")
        emit("log", { stream: "system", text: `\u5DF2\u6309\u9A8C\u8BC1\u547D\u4EE4\u6D3E\u751F\u767D\u540D\u5355\u5E76\u9644\u52A0\u5230\u542F\u52A8\u53C2\u6570\uFF1A${permPlan.tools.join("\u3001")}\uFF08\u6A21\u578B\u987B\u9010\u5B57\u6267\u884C\uFF0C\u6539\u5199\u5C31\u5931\u914D\uFF09` });
      if (permPlan?.kind === "full")
        emit("log", {
          stream: "system",
          level: "warn",
          text: `\u5168\u5F00\u6863\u4F4D\uFF08bypassPermissions\uFF09\u5DF2\u9644\u52A0\u7981\u63A8\u62A4\u680F\uFF1A${permPlan.deny.join("\u3001")}\u3002\u9664\u62A4\u680F\u5916\u4EFB\u4F55\u547D\u4EE4\u90FD\u4F1A\u76F4\u63A5\u6267\u884C\uFF08\u5168\u5F00 = \u80FD\u6539\u80FD\u5220\u80FD\u8054\u7F51\uFF1Bworktree \u4E0E\u4E3B\u4ED3\u5E93\u5171\u4EAB .git\uFF0Cdeny \u662F\u524D\u7F00\u5339\u914D\u3001\u95F4\u63A5\u5199\u6CD5\u62E6\u4E0D\u4F4F\uFF0C\u522B\u5F53\u5B89\u5168\u8FB9\u754C\uFF09`
        });
      const commandsBlocked = (adapter.id === "cli" ? cliCommandsBlocked(turnSettings, Boolean(current.sessionId), permPlan ?? void 0) : null) ?? void 0;
      const runContext = {
        ideaTitle: idea.title,
        description: idea.description,
        spec: idea.spec,
        priorMessages: messages,
        ideaDir,
        commandsBlocked,
        verifyCommand: repo.verifyCommand,
        ...permPlan?.kind === "allowlist" ? { allowedTools: permPlan.tools, allowedCommands: permPlan.commands } : {},
        ...permPlan?.kind === "full" ? { fullOpenDeny: permPlan.deny } : {},
        ...attachmentRefs.length ? { attachments: attachmentRefs } : {}
      };
      const rawUserInst = lastUserInstruction(messages, current.turns);
      const instruction = buildInstruction({
        taskId: current.id,
        ideaId: current.id,
        repoName: repo.name,
        workspacePath: headBefore.path,
        instruction: rawUserInst,
        rawInstruction: rawUserInst,
        context: runContext,
        resumeSessionId: current.sessionId,
        signal: state.controller.signal,
        emit,
        settings: this.store.getSettings()
      });
      const turnEngine = engineName(adapter.id, turnSettings);
      state.engine = turnEngine;
      state.adapterId = adapter.id;
      state.denied = 0;
      state.model = adapter.id === "api" ? turnSettings.api.model.trim() || null : adapter.id === "mock" ? "mock" : state.model ?? null;
      emit("status", { state: "running", phase: "agent", adapter: adapter.id, engine: turnEngine, workspace: agentCwd });
      const turnStartedAt = Date.now();
      const runInput = {
        taskId: current.id,
        ideaId: current.id,
        repoName: repo.name,
        workspacePath: agentCwd,
        instruction,
        rawInstruction: rawUserInst,
        context: runContext,
        resumeSessionId: current.sessionId,
        signal: state.controller.signal,
        emit,
        settings: this.store.getSettings(),
        ...permPlan ? { permission: permPlan } : {}
      };
      let result;
      try {
        result = await adapter.run(runInput);
      } catch (err) {
        if (!await this.retryAuthFailureOnce(err, emit, state)) throw err;
        try {
          result = await adapter.run(runInput);
        } catch (err2) {
          if (isAbort(err2) || state.controller.signal.aborted) throw err2;
          throw new Error(`\u81EA\u52A8\u91CD\u8BD5\u4E00\u6B21\u540E\u4ECD\u7136\u5931\u8D25\uFF1A${err2 instanceof Error ? err2.message : String(err2)}`);
        }
      }
      turnStat = {
        round: current.turns,
        adapterId: adapter.id,
        engine: turnEngine,
        // 模型名：CLI 报的优先（它可能自己换了），API 用配置里那个，mock 就说自己是 mock
        model: result.model ?? (adapter.id === "api" ? turnSettings.api.model.trim() || null : adapter.id === "mock" ? "mock" : null),
        startedAt: turnStartedAt,
        endedAt: Date.now(),
        resumed: result.resumed === true,
        ok: true,
        usage: state.usage,
        filesChanged: result.filesChanged.length
      };
      if (state.denied) {
        emit("log", { stream: "system", level: "warn", text: permissionDenyNotice(state.denied, repo.verifyCommand) });
        emit("hint", { hint: "permission", denied: state.denied, repoId: repo.id });
      }
      const settings = this.store.getSettings();
      let commitHashes = current.commits;
      if (settings.autoCommit) {
        const hash = await this.workspaces.commitAll(
          current.workspace,
          `${commitPrefix(current)}: ${idea.title} (turn ${current.turns})

\u7531 ai-tasks-mgr \u5728\u4EFB\u52A1 ${current.id} \u4E2D\u63D0\u4EA4\u3002
${truncate2(result.summary, 900)}`
        );
        if (hash) {
          commitHashes = [.../* @__PURE__ */ new Set([...commitHashes, hash])];
          emit("result", { ok: true, commit: hash, summary: "\u5DF2\u63D0\u4EA4\u5230\u4EFB\u52A1\u5206\u652F" });
        }
      }
      let checksOk = true;
      let checksOut = "";
      if (repo.verifyCommand) {
        emit("status", { state: "running", phase: "checks", command: repo.verifyCommand });
        const checks = await this.workspaces.runChecks(repo, current.workspace, 6e5, ideaDir ? agentCwd : void 0);
        checksOk = checks.ok;
        checksOut = checks.output;
        emit("tool_result", { name: "verify", ok: checks.ok, summary: truncate2(checks.output, 2500) });
        const verifiedHead = await git(current.workspace.path, ["rev-parse", "HEAD"]);
        const verifiedBase = await git(repo.path, ["rev-parse", current.workspace.baseRef]);
        current = this.store.putTask({
          ...current,
          verify: {
            ok: checksOk,
            at: Date.now(),
            note: checksOk ? `\u901A\u8FC7\uFF1A${repo.verifyCommand}` : `\u672A\u901A\u8FC7\uFF1A${firstLine(checksOut) || "\u9A8C\u8BC1\u547D\u4EE4\u975E\u96F6\u9000\u51FA"}`,
            head: verifiedHead.ok ? verifiedHead.stdout.trim() : null,
            base: verifiedBase.ok ? verifiedBase.stdout.trim() : null
          },
          updatedAt: Date.now()
        });
      }
      const diffStat = await this.workspaces.diffStat(current.workspace);
      const head = await git(headBefore.path, ["rev-parse", "HEAD"]);
      const allowedRounds = repo.autoFixRounds ?? 0;
      const usedRounds = current.autoFixRound ?? 0;
      if (!checksOk && allowedRounds > 0 && usedRounds < allowedRounds && current.workspace) {
        emit("status", { state: "running", phase: "autofix", round: usedRounds + 1, of: allowedRounds });
        const contextLines = buildAutofixContextLines(diffStat, result.filesChanged, checksOut);
        const feedback = [
          `\u3010\u9762\u677F\u81EA\u52A8\u56DE\u704C ${usedRounds + 1}/${allowedRounds}\u3011\`${repo.verifyCommand}\` \u6CA1\u901A\u8FC7\uFF0C\u8BF7\u5728\u5F53\u524D\u5206\u652F\u91CC\u4FEE\u5230\u901A\u8FC7\u3002`,
          ...contextLines.length ? ["", ...contextLines] : [],
          "",
          "\u5931\u8D25\u8F93\u51FA\u672B\u5C3E\uFF1A",
          "```",
          tailLines(checksOut, 60),
          "```",
          "",
          "\u53EA\u6539\u4E0E\u5931\u8D25\u76F8\u5173\u7684\u90E8\u5206\uFF1B\u4E0D\u8981\u4E3A\u4E86\u8BA9\u6821\u9A8C\u901A\u8FC7\u800C\u5220\u6D4B\u8BD5\u6216\u628A\u65AD\u8A00\u653E\u5BBD\u3002"
        ].join("\n");
        await this.appendMessage({
          ideaId: current.ideaId,
          taskId: current.id,
          role: "system",
          content: feedback,
          meta: { taskId: current.id, phase: "autofix", round: usedRounds + 1 }
        });
        const requeued = {
          ...current,
          status: "queued",
          error: null,
          autoFixRound: usedRounds + 1,
          diffStat,
          endedAt: null,
          updatedAt: Date.now(),
          ...stamp2(false)
        };
        this.store.putTask(requeued);
        this.publishTaskStatus(requeued);
        emit("result", { ok: false, summary: `\u6821\u9A8C\u672A\u901A\u8FC7\uFF0C\u81EA\u52A8\u56DE\u704C\u7B2C ${usedRounds + 1}/${allowedRounds} \u8F6E` });
        if (!this.pending.includes(current.id)) this.pending.push(current.id);
        return;
      }
      const finalSessionId = result.sessionId ?? current.sessionId;
      let nextImportedSeq = current.lastImportedSeq;
      if (finalSessionId && this.hostSession?.observeSession) {
        try {
          const obs = await this.hostSession.observeSession(finalSessionId, current.lastImportedSeq ?? -1);
          if (obs && typeof obs.cursor === "number") nextImportedSeq = obs.cursor;
        } catch {
        }
      }
      current = this.store.putTask({
        ...current,
        status: checksOk ? "succeeded" : "failed",
        error: checksOk ? null : `\u9A8C\u8BC1\u547D\u4EE4\u672A\u901A\u8FC7${usedRounds > 0 ? `\uFF08\u5DF2\u81EA\u52A8\u56DE\u704C ${usedRounds} \u8F6E\u4ECD\u672A\u901A\u8FC7\uFF09` : ""}\uFF1A${truncate2(checksOut, 900)}`,
        errorCode: null,
        retryable: false,
        writerState: finalSessionId && this.hostSession?.hasLiveAgent?.(finalSessionId) ? "dsh-gui" : "idle",
        ...typeof nextImportedSeq === "number" ? { lastImportedSeq: nextImportedSeq } : {},
        sessionId: finalSessionId,
        diffStat,
        commits: [.../* @__PURE__ */ new Set([...commitHashes, ...result.commits])],
        workspace: { ...current.workspace, headCommit: head.ok ? head.stdout : current.workspace.headCommit },
        endedAt: Date.now(),
        updatedAt: Date.now(),
        ...stamp2(checksOk)
      });
      if (!state.persistedAssistant) {
        await this.appendMessage({
          ideaId: current.ideaId,
          taskId: current.id,
          role: "assistant",
          content: result.summary,
          meta: { taskId: current.id, phase: "result", engine: turnStat?.engine, model: turnStat?.model ?? null }
        });
      }
      const finalIdea = this.store.getIdea(current.ideaId);
      this.setStatus(finalIdea, checksOk ? "review" : "blocked");
      this.publishTaskStatus(current);
      this.notifyWebhook(
        checksOk ? "review" : "blocked",
        finalIdea,
        current,
        checksOk ? truncate2(result.summary, 200) : current.error ?? void 0
      );
      const diag = diagnoseTaskBudgetAndSpin(current, { taskTokenBudget: settings.taskTokenBudget ?? 0 });
      if (diag.overBudget) {
        this.notifyWebhook(
          "budget",
          finalIdea,
          current,
          `\u5355\u4EFB\u52A1\u7D2F\u8BA1 Token (${diag.totalTokens}) \u5DF2\u8FBE\u5230/\u8D85\u8FC7\u9884\u7B97\u8F6F\u4E0A\u9650 (${diag.budgetTokens})`
        );
      }
    } catch (err) {
      const aborted = isAbort(err) || state.controller.signal.aborted;
      const errMsg = err?.message ?? String(err ?? "\u672A\u77E5\u9519\u8BEF");
      const held = err instanceof WriterHeldError ? { held: true, sessionId: err.sessionId ?? current.sessionId } : looksLikeWriterHeldError(errMsg, current.sessionId);
      const isWriterHeld = !aborted && held.held;
      if (!state.persistedAssistant && state.liveText.trim()) {
        await this.appendMessage({
          ideaId: current.ideaId,
          taskId: current.id,
          role: "assistant",
          content: `${state.liveText.trim()}

> ${aborted ? "\uFF08\u88AB\u4E2D\u65AD\uFF0C\u4EE5\u4E0A\u662F\u5DF2\u5B8C\u6210\u90E8\u5206\uFF09" : `\uFF08\u5F02\u5E38\u4E2D\u65AD\uFF1A${errMsg}\uFF09`}`,
          streaming: false,
          meta: { taskId: current.id, error: !aborted }
        });
      }
      const failed = {
        ...current,
        status: aborted ? "cancelled" : "failed",
        error: aborted ? "\u5DF2\u53D6\u6D88" : errMsg,
        errorCode: isWriterHeld ? "writer-held" : null,
        retryable: isWriterHeld,
        ...isWriterHeld ? {
          // P0.4：写锁冲突未实际进入会话执行 —— 不虚增轮次、不冲掉已合并标记、不落空轮统计
          turns: prevTurns,
          writerState: "dsh-gui",
          workspace: current.workspace ? { ...current.workspace, mergedAt: prevMergedAt } : null
        } : stamp2(false),
        endedAt: Date.now(),
        updatedAt: Date.now()
      };
      this.store.putTask(failed);
      emit("error", {
        message: failed.error ?? "\u672A\u77E5\u9519\u8BEF",
        aborted,
        ...isWriterHeld ? { code: "writer-held", retryable: true, sessionId: held.sessionId } : {}
      });
      const hintRepoId = this.store.getIdea(current.ideaId)?.repoId;
      if (!aborted && !isWriterHeld && hintRepoId && (state.denied ?? 0) >= 1) {
        emit("hint", { hint: "permission", denied: state.denied, repoId: hintRepoId });
      }
      const idea = this.store.getIdea(current.ideaId);
      if (idea) {
        this.setStatus(idea, aborted ? "ready" : "blocked");
        if (!aborted && !isWriterHeld) {
          this.notifyWebhook("blocked", idea, failed, failed.error ?? void 0);
        }
      }
      this.publishTaskStatus(failed);
      current = failed;
    } finally {
      await this.flushEvents(state);
      if (state.flushTimer) clearTimeout(state.flushTimer);
      this.running.delete(current.id);
      setImmediate(() => void this.pump());
    }
  }
  /* -------------------- 中断 / 验收 -------------------- */
  cancel(taskId) {
    const st = this.running.get(taskId);
    if (st) {
      st.controller.abort();
      return { ok: true };
    }
    const idx = this.pending.indexOf(taskId);
    if (idx >= 0) this.pending.splice(idx, 1);
    const task = this.store.getTask(taskId);
    if (task && isActiveTask(task.status)) {
      this.store.putTask({ ...task, status: "cancelled", error: "\u5DF2\u53D6\u6D88", endedAt: Date.now(), updatedAt: Date.now() });
      this.publishTaskStatus({ ...task, status: "cancelled" });
      return { ok: true };
    }
    return { ok: false };
  }
  /** 接受本轮成果：合并回基线分支，可选清理 worktree */
  /**
   * 把任务分支推到远端，并（若配了 PR 命令）开一个 PR。
   * 只有在仓库里显式打开 allowPush 才允许 —— 面板默认永远不碰远端。
   */
  async publish(taskId, opts = {}) {
    const task = this.store.getTask(taskId);
    if (!task?.workspace) throw new Error("\u4EFB\u52A1\u6CA1\u6709\u5DE5\u4F5C\u76EE\u5F55\uFF0C\u65E0\u6CD5\u63A8\u9001");
    const idea = this.store.getIdea(task.ideaId);
    if (!idea) throw new Error("\u60F3\u6CD5\u4E0D\u5B58\u5728");
    const repo = this.store.getRepo(idea.repoId ?? "");
    if (!repo) throw new Error("\u4ED3\u5E93\u7F3A\u5931");
    if (!repo.allowPush) {
      throw withHint(
        "\u8BE5\u4ED3\u5E93\u6CA1\u5141\u8BB8\u9762\u677F\u63A8\u9001",
        "\u5728\u300C\u8BBE\u7F6E \u2192 \u4ED3\u5E93 \u2192 \u5141\u8BB8\u628A\u4EFB\u52A1\u5206\u652F\u63A8\u5230\u8FDC\u7AEF\u300D\u91CC\u6253\u5F00\u540E\u518D\u6765\uFF1B\u9762\u677F\u9ED8\u8BA4\u4E0D\u4F1A\u78B0\u4F60\u7684\u8FDC\u7AEF\u3002"
      );
    }
    if (!fs10.existsSync(task.workspace.path)) {
      throw withHint("worktree \u5DF2\u88AB\u6E05\u7406\uFF0C\u65E0\u6CD5\u63A8\u9001", "\u91CD\u65B0\u8DD1\u4E00\u8F6E\uFF08\u4F1A\u590D\u7528\u540C\u4E00\u5206\u652F\uFF09\u540E\u518D\u63A8\uFF0C\u6216\u4ECE\u4EFB\u52A1\u8BE6\u60C5\u91CC\u624B\u52A8\u63A8\u3002");
    }
    const remote = (repo.remote || "origin").trim() || "origin";
    const branch = task.workspace.branch;
    const remoteUrl = await git(repo.path, ["remote", "get-url", remote]);
    if (!remoteUrl.ok) {
      throw withHint(`\u4ED3\u5E93\u91CC\u6CA1\u6709\u8FDC\u7AEF \`${remote}\``, "\u5148\u5728\u4ED3\u5E93\u91CC `git remote add origin <url>`\uFF0C\u6216\u5728\u8BBE\u7F6E\u91CC\u6539\u8FDC\u7AEF\u540D\u3002");
    }
    const push = await git(task.workspace.path, ["push", "-u", remote, branch], { timeout: 24e4 });
    if (!push.ok) {
      throw new Error(`\u63A8\u9001 ${remote}/${branch} \u5931\u8D25\uFF1A${truncate2(push.stderr || push.stdout || String(push.code), 500)}`);
    }
    let prUrl = null;
    let note = null;
    const cmd = this.store.getSettings().prCommand.trim();
    if (opts.pr !== false && cmd) {
      const [cmdBin, ...cmdPrefix] = splitCommand(cmd);
      try {
        const dir = path11.join(paths.root(), "scratch", "pr");
        await fs10.promises.mkdir(dir, { recursive: true });
        const bodyFile = path11.join(dir, `${taskId}.md`);
        await fs10.promises.writeFile(bodyFile, await this.buildPrBody(task, idea, repo), "utf8");
        const { execFile: execFile3 } = await import("node:child_process");
        const { promisify: promisify3 } = await import("node:util");
        const plan = await planExec(
          cmdBin,
          [
            ...cmdPrefix,
            "pr",
            "create",
            "--base",
            task.workspace.baseRef,
            "--head",
            branch,
            "--title",
            `feat(ai): ${idea.title}`,
            "--body-file",
            bodyFile
          ]
        );
        const out = await promisify3(execFile3)(plan.file, plan.args, {
          cwd: repo.path,
          timeout: 12e4,
          windowsHide: true,
          maxBuffer: 4 * 1024 * 1024,
          windowsVerbatimArguments: plan.windowsVerbatimArguments
        });
        prUrl = out.stdout.trim().split("\n").filter(Boolean).pop() ?? null;
        await fs10.promises.rm(bodyFile, { force: true }).catch(() => void 0);
      } catch (err) {
        const e = err;
        note = e.code === "ENOENT" ? `\u672C\u673A\u6CA1\u6709 ${cmd}\uFF0C\u53EA\u63A8\u4E86\u5206\u652F\u6CA1\u5EFA PR` : `${cmd} pr create \u5931\u8D25\uFF1A${truncate2(e.stderr || e.message || "", 300)}`;
      }
    } else if (opts.pr !== false) {
      note = "\u6CA1\u914D PR \u547D\u4EE4\uFF0C\u53EA\u63A8\u4E86\u5206\u652F";
    }
    const ref = { remote, branch, prUrl, at: Date.now(), note };
    this.store.putTask({ ...task, published: ref, updatedAt: Date.now() });
    await this.appendMessage({
      ideaId: task.ideaId,
      taskId,
      role: "system",
      content: prUrl ? `\u{1F680} \u5DF2\u63A8\u9001 \`${remote}/${branch}\` \u5E76\u5F00 PR\uFF1A${prUrl}` : `\u{1F680} \u5DF2\u63A8\u9001 \`${remote}/${branch}\`${note ? `\uFF08${note}\uFF09` : ""}`,
      meta: { taskId, phase: "publish" }
    });
    this.publishTaskStatus(this.store.getTask(taskId));
    return ref;
  }
  /** PR 正文：把想法、spec、每轮 AI 结论、改动统计、提交列一遍 */
  async buildPrBody(task, idea, repo) {
    const messages = await this.store.listMessages(idea.id);
    const turns = messages.filter((m) => m.role === "assistant" && m.meta?.taskId === task.id);
    const parts = [
      `## \u60F3\u6CD5`,
      "",
      idea.spec ? idea.spec.trim() : idea.description.trim() || idea.title,
      "",
      `## AI \u4EA4\u4ED8\u6458\u8981\uFF08${task.turns} \u8F6E\uFF09`,
      "",
      ...turns.length ? turns.map((m, i) => `${i + 1}. ${truncate2(m.content.replace(/\s+/g, " "), 700)}`) : ["\uFF08\u672C\u8F6E\u6CA1\u6709\u7559\u4E0B\u6458\u8981\uFF09"],
      "",
      `## \u6539\u52A8\u7EDF\u8BA1`,
      "",
      ...task.diffStat ? [
        `\`${task.diffStat.files}\` \u4E2A\u6587\u4EF6\uFF0C+${task.diffStat.additions} / -${task.diffStat.deletions}`,
        "",
        ...task.diffStat.entries.map((e) => `- \`${e.path}\` +${e.additions}/-${e.deletions}`)
      ] : ["\uFF08\u65E0 diff\uFF09"],
      "",
      `## \u5206\u652F\u4E0E\u63D0\u4EA4`,
      "",
      `- \u5206\u652F \`${task.workspace?.branch ?? "-"}\`\uFF08\u57FA\u7EBF \`${task.workspace?.baseRef ?? repo.defaultBranch}\`\uFF09`,
      ...task.commits.length ? task.commits.map((c) => `- \`${c.slice(0, 7)}\``) : [],
      "",
      "---",
      "",
      "\u7531 AI \u4EFB\u52A1\u53F0\u751F\u6210 \xB7 \u4EFB\u52A1 " + task.id
    ];
    return parts.join("\n");
  }
  async accept(taskId, opts = {}) {
    const task = this.store.getTask(taskId);
    if (!task?.workspace) throw new Error("\u4EFB\u52A1\u6CA1\u6709\u5DE5\u4F5C\u76EE\u5F55");
    const idea = this.store.getIdea(task.ideaId);
    const repo = this.store.getRepo(idea.repoId ?? "");
    if (!repo) throw new Error("\u4ED3\u5E93\u7F3A\u5931");
    const pending = await git(task.workspace.path, ["status", "--porcelain=v1"]);
    if (pending.ok && pending.stdout.trim()) {
      await this.workspaces.commitAll(task.workspace, `${commitPrefix(task)}: ${idea.title}\uFF08\u9762\u677F\u515C\u5E95\u63D0\u4EA4\uFF09`);
    }
    const merge = opts.merge !== false;
    let detail = "\u5DF2\u6807\u8BB0\u4E3A\u5DF2\u9A8C\u6536\uFF08\u672A\u5408\u5E76\uFF09";
    let verify = task.verify ?? null;
    if (merge) {
      const baseRev = await git(repo.path, ["rev-parse", task.workspace.baseRef]);
      const baseNow = baseRev.ok ? baseRev.stdout.trim() : null;
      if (await this.workspaces.isMergedInto(repo, task.workspace, task.commits)) {
        detail = `\u6210\u679C\u5DF2\u5728 \`${task.workspace.baseRef}\` \u91CC\uFF1A\u8DF3\u8FC7\u5408\u5E76\uFF0C\u53EA\u8865\u8BB0\u5F55`;
      } else {
        let verifyReused = false;
        if ((repo.verifyCommand ?? "").trim()) {
          const headRev = await git(task.workspace.path, ["rev-parse", "HEAD"]);
          const headNow = headRev.ok ? headRev.stdout.trim() : null;
          if (verify && verify.head === headNow && verify.base === baseNow) {
            verifyReused = true;
          } else {
            const checks = await this.workspaces.runChecks(repo, task.workspace, 6e5);
            verify = {
              ok: checks.ok,
              at: Date.now(),
              note: checks.ok ? `\u901A\u8FC7\uFF1A${repo.verifyCommand}` : `\u672A\u901A\u8FC7\uFF1A${firstLine(checks.output) || "\u9A8C\u8BC1\u547D\u4EE4\u975E\u96F6\u9000\u51FA"}`,
              head: headNow,
              base: baseNow
            };
            this.store.putTask({ ...task, verify, updatedAt: Date.now() });
          }
        }
        if (verify && !verify.ok && !opts.acknowledgeVerifyFailure) {
          return {
            ok: false,
            detail: `\u9A8C\u8BC1\u6CA1\u8FC7\uFF0C\u6CA1\u6709\u5408\u5E76\uFF1A${verify.note}\u3002\u786E\u8BA4\u8FD9\u4EFD\u6539\u52A8\u53EF\u4EE5\u5408\uFF0C\u5C31\u52FE\u4E0A\u300C\u9A8C\u8BC1\u6CA1\u8FC7\u4E5F\u8981\u5408\u300D\u518D\u70B9\u4E00\u6B21\u3002`
          };
        }
        const res = await this.workspaces.mergeToBase(repo, task.workspace, `feat(ai): ${idea.title}

\u4EFB\u52A1 ${task.id}\uFF0C${task.turns} \u8F6E AI \u8FED\u4EE3\u3002`);
        if (!res.ok) return { ok: false, detail: res.detail };
        detail = verifyReused ? `${res.detail}\uFF08\u9A8C\u8BC1\u7528\u4EFB\u52A1\u8DD1\u5B8C\u65F6\u7684\u7ED3\u679C\uFF0C\u672A\u91CD\u8DD1\uFF09` : res.detail;
      }
    }
    this.store.putTask({
      ...task,
      // 只有真合并了才写 mergedAt —— 它是「成果已经在基线里」的唯一凭据
      // （变更页的「已合并」药丸与仓库页的回收判定都读它）
      workspace: merge ? { ...task.workspace, mergedAt: Date.now() } : task.workspace,
      // 这里必须把（可能刚现跑的）验证结果带上：展开的是开头读到的 task，不带就把新记录冲掉了
      verify,
      status: "succeeded",
      error: null,
      updatedAt: Date.now()
    });
    this.setStatus(idea, "done");
    await this.appendMessage({
      ideaId: task.ideaId,
      taskId: task.id,
      role: "system",
      content: merge ? `\u2705 \u5DF2\u5408\u5E76\u5230 \`${task.workspace.baseRef}\`\uFF1A${detail}` : `\u5DF2\u6807\u8BB0\u9A8C\u6536\uFF1A${detail}`,
      meta: { taskId: task.id, phase: "accept" }
    });
    if (opts.cleanup) {
      try {
        await this.workspaces.cleanup(repo, task.workspace, { deleteBranch: merge });
        this.store.putTask({
          ...task,
          workspace: {
            ...task.workspace,
            discarded: true,
            mergedAt: merge ? task.workspace.mergedAt ?? Date.now() : task.workspace.mergedAt
          },
          // 同上：别把验证结果冲掉
          verify
        });
      } catch (err) {
        detail += `\uFF1B\u6E05\u7406\u672A\u5B8C\u5168\u6210\u529F\uFF1A${err.message}`;
      }
    } else if (merge) {
      const st = this.store.getSettings();
      if (st.autoCleanMergedWorktrees) {
        const keepN = Math.max(0, st.worktreeKeepRecent ?? 3);
        const mergedTasks = this.store.listTasks().filter(
          (t) => t.workspace && t.workspace.repoId === repo.id && !t.workspace.discarded && t.workspace.mergedAt != null && !isActiveTask(t.status)
        ).sort((a, b) => (b.workspace?.mergedAt ?? b.updatedAt) - (a.workspace?.mergedAt ?? a.updatedAt));
        const toClean = mergedTasks.slice(keepN);
        let autoCleaned = 0;
        for (const oldTask of toClean) {
          if (!oldTask.workspace || !fs10.existsSync(oldTask.workspace.path)) continue;
          try {
            await this.workspaces.cleanup(repo, oldTask.workspace, { deleteBranch: true });
            this.store.putTask({
              ...oldTask,
              workspace: { ...oldTask.workspace, discarded: true },
              updatedAt: Date.now()
            });
            autoCleaned += 1;
          } catch {
          }
        }
        if (autoCleaned > 0) {
          detail += `\uFF08\u5DF2\u6309\u81EA\u52A8 GC \u7B56\u7565\u6E05\u7406 ${autoCleaned} \u4E2A\u65E7 worktree\uFF0C\u4FDD\u7559\u6700\u8FD1 ${keepN} \u4E2A\uFF09`;
        }
      }
    }
    if (this.store.getSettings().autoStartUnblocked ?? true) {
      const dependents = this.store.listIdeas().filter(
        (candidate) => candidate.id !== idea.id && candidate.status === "ready" && Boolean(candidate.repoId) && Array.isArray(candidate.blockedBy) && candidate.blockedBy.includes(idea.id)
      );
      const startedTitles = [];
      for (const depIdea of dependents) {
        const unresolved = (depIdea.blockedBy ?? []).map((depId) => this.store.getIdea(depId)).filter((d) => Boolean(d && d.status !== "done" && d.status !== "trash"));
        if (unresolved.length > 0) continue;
        const hasActive = this.store.listTasks({ ideaId: depIdea.id }).some((t) => isActiveTask(t.status));
        if (hasActive) continue;
        try {
          await this.startTask({
            ideaId: depIdea.id,
            instruction: `\u524D\u7F6E\u4F9D\u8D56\u60F3\u6CD5\u300A${idea.title}\u300B\u5DF2\u9A8C\u6536\u5408\u5E76\uFF0C\u8BF7\u57FA\u4E8E\u6700\u65B0\u57FA\u7EBF\u5206\u652F\u6309\u672C\u60F3\u6CD5\u89C4\u683C\u4E0E\u6B63\u6587\u5F00\u59CB\u5B9E\u73B0\u3002`
          });
          startedTitles.push(`\u300A${depIdea.title}\u300B`);
        } catch {
        }
      }
      if (startedTitles.length > 0) {
        detail += `\uFF08\u5DF2\u81EA\u52A8\u63A5\u529B\u5F00\u5DE5\u540E\u7EED\u4F9D\u8D56\u60F3\u6CD5\uFF1A${startedTitles.join("\u3001")}\uFF09`;
      }
    }
    this.notifyWebhook("done", idea, this.store.getTask(taskId) ?? task, detail);
    this.publishTaskStatus(this.store.getTask(taskId));
    return { ok: true, detail };
  }
  notifyWebhook(event, idea, task, summary, detail) {
    const st = this.store.getSettings();
    const url = (st.webhookUrl ?? "").trim();
    const enabledEvents = st.webhookEvents ?? ["review", "blocked"];
    if (!url || !enabledEvents.includes(event)) return;
    void sendWebhookNotification({
      url,
      event,
      ideaTitle: idea.title,
      ideaId: idea.id,
      taskId: task.id,
      summary,
      detail
    }).catch(() => void 0);
  }
  /** 驳回 / 放弃本任务：支持保留 worktree 复盘或一键回收 worktree 并把想法打回 ready */
  async reject(taskId, reason, opts = {}) {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error("\u4EFB\u52A1\u4E0D\u5B58\u5728");
    if (isActiveTask(task.status)) {
      try {
        this.cancel(taskId);
      } catch {
      }
    }
    const freshTask = this.store.getTask(taskId) ?? task;
    const idea = this.store.getIdea(freshTask.ideaId);
    if (opts.discard && freshTask.workspace) {
      const repo = this.store.getRepo(idea?.repoId ?? "");
      if (repo) {
        await this.workspaces.cleanup(repo, freshTask.workspace, { deleteBranch: true, unmergedOk: true }).catch(() => {
        });
      }
    }
    this.store.putTask({
      ...freshTask,
      status: "cancelled",
      error: `\u9A73\u56DE\uFF1A${reason}`,
      ...opts.discard && freshTask.workspace ? { workspace: { ...freshTask.workspace, discarded: true } } : {},
      updatedAt: Date.now()
    });
    if (idea) {
      this.setStatus(idea, "ready");
    }
    await this.appendMessage({
      ideaId: freshTask.ideaId,
      taskId: freshTask.id,
      role: "system",
      content: `\u26D4\uFE0F \u5DF2\u9A73\u56DE\uFF1A${reason}${opts.discard ? "\uFF08worktree \u4E0E\u5206\u652F\u5DF2\u4E22\u5F03\uFF09" : "\uFF08\u5206\u652F\u4FDD\u7559\uFF0C\u53EF\u7EE7\u7EED\u590D\u76D8\uFF09"}`,
      meta: { taskId: freshTask.id, phase: "reject" }
    });
    return { ok: true };
  }
  /**
   * 轮次回退：在保留 worktree 的前提下，将任务分支 git reset --hard 回退上一轮提交（或回退到指定提交），
   * 并同步刷新 commits、diffStat、turns 与验证状态。
   */
  async rollbackTurn(taskId, targetCommit) {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error("\u4EFB\u52A1\u4E0D\u5B58\u5728");
    if (isActiveTask(task.status) || this.followUpLocks.has(taskId)) {
      throw new Error("\u4EFB\u52A1\u6B63\u5728\u6267\u884C\u4E2D\uFF0C\u8BF7\u5148\u7B49\u5F85\u7ED3\u675F\u6216\u4E2D\u65AD\u540E\u518D\u56DE\u9000");
    }
    if (!task.workspace || !fs10.existsSync(task.workspace.path)) {
      throw new Error("\u4EFB\u52A1\u5DE5\u4F5C\u76EE\u5F55\u4E0D\u5B58\u5728\uFF0C\u65E0\u6CD5\u56DE\u9000");
    }
    if (task.workspace.mergedAt) {
      throw new Error("\u8BE5\u4EFB\u52A1\u6539\u52A8\u5DF2\u5408\u5E76\u56DE\u57FA\u7EBF\u5206\u652F\uFF0C\u65E0\u6CD5\u76F4\u63A5\u56DE\u9000\u4EFB\u52A1\u5206\u652F\u63D0\u4EA4");
    }
    const beforeLog = await this.workspaces.log(task.workspace);
    if (beforeLog.length === 0) {
      throw new Error("\u5F53\u524D\u5206\u652F\u6CA1\u6709\u4EFB\u4F55\u63D0\u4EA4\u53EF\u56DE\u9000");
    }
    const baseTarget = task.workspace.baseCommit ?? task.workspace.baseRef;
    const rawTarget = (targetCommit ?? "").trim();
    let resetRef;
    if (!rawTarget) {
      resetRef = beforeLog.length === 1 ? baseTarget : "HEAD~1";
    } else if (rawTarget === "base" || rawTarget === task.workspace.baseRef || rawTarget === task.workspace.baseCommit) {
      resetRef = baseTarget;
    } else {
      const matched = beforeLog.find((c) => c.hash.startsWith(rawTarget) || rawTarget.startsWith(c.hash));
      if (!matched) {
        throw new Error(`\u76EE\u6807\u63D0\u4EA4 ${rawTarget} \u4E0D\u5728\u5F53\u524D\u4EFB\u52A1\u5206\u652F\u5386\u53F2\u4E2D`);
      }
      if (matched.hash === beforeLog[0]?.hash) {
        throw new Error("\u5F53\u524D\u5DF2\u7ECF\u5904\u4E8E\u8BE5\u6700\u65B0\u63D0\u4EA4\uFF0C\u65E0\u9700\u56DE\u9000");
      }
      resetRef = matched.hash;
    }
    const resetRes = await git(task.workspace.path, ["reset", "--hard", resetRef]);
    if (!resetRes.ok) {
      throw new Error(`\u56DE\u9000\u5931\u8D25\uFF1A${resetRes.stderr || resetRes.stdout}`);
    }
    const headRes = await git(task.workspace.path, ["rev-parse", "--short", "HEAD"]);
    const rolledBackTo = headRes.ok ? headRes.stdout.trim() : resetRef;
    const afterLog = await this.workspaces.log(task.workspace);
    const removedCommits = Math.max(1, beforeLog.length - afterLog.length);
    const nextDiffStat = await this.workspaces.diffStat(task.workspace);
    const nextTurns = Math.max(0, task.turns - removedCommits);
    const nextTurnStats = task.turnStats ? task.turnStats.slice(0, Math.max(0, task.turnStats.length - removedCommits)) : void 0;
    const updated = {
      ...task,
      commits: afterLog.map((c) => c.hash),
      diffStat: nextDiffStat,
      turns: nextTurns,
      ...nextTurnStats !== void 0 ? { turnStats: nextTurnStats } : {},
      workspace: {
        ...task.workspace,
        headCommit: rolledBackTo
      },
      verify: null,
      error: null,
      errorCode: null,
      retryable: false,
      updatedAt: Date.now()
    };
    this.store.putTask(updated);
    const idea = this.store.getIdea(task.ideaId);
    if (idea) {
      this.setStatus(idea, afterLog.length > 0 ? "review" : "ready");
    }
    const detail = `\u5DF2\u56DE\u9000\u5230 ${rolledBackTo}\uFF08\u64A4\u56DE ${removedCommits} \u4E2A\u63D0\u4EA4\uFF09`;
    await this.appendMessage({
      ideaId: task.ideaId,
      taskId: task.id,
      role: "system",
      content: `\u23EA ${detail}\uFF0C\u5DE5\u4F5C\u533A\u5DF2\u56DE\u5230\u8BE5\u63D0\u4EA4\u73B0\u573A\uFF0C\u53EF\u7EE7\u7EED\u4E0B\u8FBE\u8FD4\u5DE5\u6216\u65B0\u6307\u4EE4\u3002`,
      meta: { taskId: task.id, phase: "rollback" }
    });
    this.publishTaskStatus(updated);
    return { task: updated, rolledBackTo, removedCommits, detail };
  }
  /** 重启后把上次残留的 running 标记为中断，并修复历史版本中因写锁冲突被虚增轮次/冲掉 mergedAt 的任务账面 */
  recover() {
    let n = 0;
    for (const t of this.store.listTasks({ status: ["running", "waiting_input"] })) {
      this.store.putTask({
        ...t,
        status: "failed",
        error: "\u5E94\u7528\u91CD\u542F\u5BFC\u81F4\u4E2D\u65AD\uFF1Bworktree \u4ECD\u5728\uFF0C\u53EF\u76F4\u63A5\u7EE7\u7EED\u5BF9\u8BDD",
        endedAt: Date.now(),
        updatedAt: Date.now()
      });
      this.publishTaskStatus(this.store.getTask(t.id));
      n += 1;
    }
    for (const t of this.store.listTasks({ status: "failed" })) {
      if (looksLikeWriterHeldError(t.error ?? void 0, t.sessionId).held) {
        void this.repairHistoricalWriterHeldIfNeeded(t.id).catch(() => void 0);
      }
    }
    return { interrupted: n };
  }
  /**
   * 修复旧版在遇到单写者锁冲突时留下的受损账面（例如 Appendix B 中的 `turns=3` 但 `turnStats` 只有 1 条、
   * `workspace.mergedAt` 被置空、以及线程末尾连续两条重复 user 消息）。
   */
  async repairHistoricalWriterHeldIfNeeded(taskId) {
    const task = this.store.getTask(taskId);
    if (!task) return;
    const held = task.errorCode === "writer-held" || looksLikeWriterHeldError(task.error ?? void 0, task.sessionId).held;
    if (!held) return;
    const msgs = await this.store.listMessages(task.ideaId);
    const deduped = collapseTrailingDuplicateUserMessages(msgs, task.id);
    if (deduped.length !== msgs.length) {
      await this.store.rewriteThread(task.ideaId, deduped);
    }
    const statsLen = task.turnStats?.length ?? 0;
    const repairedTurns = statsLen > 0 && task.turns > statsLen ? statsLen : task.turns;
    let repairedMergedAt = task.workspace?.mergedAt ?? null;
    if (task.workspace && repairedMergedAt === null) {
      const acceptMsg = [...deduped].reverse().find((m) => m.taskId === task.id && m.role === "system" && (m.meta?.phase === "accept" || /已合并/.test(m.content)));
      if (acceptMsg) {
        repairedMergedAt = acceptMsg.createdAt;
      }
    }
    if (task.errorCode !== "writer-held" || task.retryable !== true || repairedTurns !== task.turns || repairedMergedAt !== (task.workspace?.mergedAt ?? null)) {
      this.store.putTask({
        ...task,
        errorCode: "writer-held",
        retryable: true,
        turns: repairedTurns,
        ...task.workspace ? { workspace: { ...task.workspace, mergedAt: repairedMergedAt } } : {}
      });
    }
  }
  setConcurrency(n) {
    this.maxConcurrent = Math.max(1, Math.min(8, Math.round(n)));
    void this.pump();
  }
  /* -------------------- 事件与持久化 -------------------- */
  /**
   * 401 类失败要不要自动重试：一个任务只补一次；取消/引擎没装/判不出认证的不重试。
   * 等待期间可取消（signal 一响就抛 AbortError，任务照常走取消路径）。
   */
  async retryAuthFailureOnce(err, emit, state) {
    if (state.authRetried) return false;
    if (isAbort(err) || state.controller.signal.aborted) return false;
    if (err instanceof AgentUnavailableError) return false;
    const ms = authRetryMs();
    if (ms <= 0) return false;
    const message = err instanceof Error ? err.message : String(err);
    if (!looksLikeAuthError(message)) return false;
    state.authRetried = true;
    emit("log", {
      stream: "system",
      level: "warn",
      text: `${state.engine ?? "\u5F15\u64CE"} \u8BA4\u8BC1\u5931\u8D25\uFF08401 \u7C7B\uFF09\u3002\u6709\u4E9B\u662F\u4EE3\u7406\u6296\u52A8\u6216\u4EE4\u724C\u5237\u65B0\u7684\u77AC\u65F6\u6545\u969C\uFF0C${Math.round(ms / 1e3)}s \u540E\u81EA\u52A8\u91CD\u8BD5\u4E00\u6B21\uFF1B\u82E5\u4ECD\u5931\u8D25\uFF0C\u8BF7\u5728\u7EC8\u7AEF\u91CD\u65B0\u767B\u5F55\uFF08\u5982 codebuddy /login\uFF09\u540E\u518D\u7EE7\u7EED\u2014\u2014\u9762\u677F\u65E0\u6CD5\u4EE3\u767B\u5F55\u3002`
    });
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      const onAbort = () => {
        clearTimeout(t);
        reject(new AbortError());
      };
      if (state.controller.signal.aborted) {
        clearTimeout(t);
        return reject(new AbortError());
      }
      state.controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    emit("log", { stream: "system", text: "\u5F00\u59CB\u81EA\u52A8\u91CD\u8BD5\uFF08\u540C\u4E00\u6307\u4EE4\u3001\u540C\u4E00 worktree \u7684\u7B2C 2 \u6B21\u5C1D\u8BD5\uFF09\u2026" });
    return true;
  }
  emitEvent(task, state, kind, payload) {
    const ev = { taskId: task.id, ideaId: task.ideaId, seq: state.seq += 1, ts: Date.now(), kind, payload };
    state.buffer.push(ev);
    if (kind === "text_delta" && typeof payload.text === "string") state.liveText += payload.text;
    if (kind === "usage") state.usage = addUsage(state.usage, readUsage(payload));
    if (state.adapterId === "cli" && kind === "tool_result" && looksLikePermissionDenyStrong(typeof payload.summary === "string" ? payload.summary : void 0)) {
      state.denied = (state.denied ?? 0) + 1;
    }
    if (state.adapterId === "cli" && kind === "log" && typeof payload.denials === "number") {
      state.denied = Math.max(state.denied ?? 0, payload.denials);
    }
    if (kind === "status" && typeof payload.model === "string" && payload.model) state.model = payload.model;
    if (kind === "assistant_message" && typeof payload.content === "string") {
      state.persistedAssistant = true;
      void this.appendMessage({
        ideaId: task.ideaId,
        taskId: task.id,
        role: "assistant",
        content: payload.content,
        meta: {
          taskId: task.id,
          phase: typeof payload.phase === "string" ? payload.phase : void 0,
          // 署名跟着结论走：翻对话时才知道每条是谁写的
          engine: state.engine,
          model: state.model ?? null
        }
      });
    }
    this.store.bus.publish({ type: "agent", event: ev });
    if (state.buffer.length >= 24) void this.flushEvents(state);
    else if (!state.flushTimer) {
      state.flushTimer = setTimeout(() => {
        state.flushTimer = null;
        void this.flushEvents(state);
      }, 400);
      state.flushTimer.unref?.();
    }
    this.appendRawLog(task.id, ev).catch(() => void 0);
  }
  async flushEvents(state) {
    if (!state.buffer.length) return;
    const batch = state.buffer.splice(0, state.buffer.length);
    await this.store.appendEvents(batch);
  }
  /** 同时写一份人读的流水文本，方便在编辑器里 tail -f */
  async appendRawLog(taskId, ev) {
    const fsp9 = await import("node:fs/promises");
    const line = `${new Date(ev.ts).toISOString()} #${ev.seq} ${ev.kind} ${JSON.stringify(ev.payload)}
`;
    await fsp9.appendFile(paths.rawLog(taskId), line, "utf8").catch(() => void 0);
  }
  async appendMessage(msg) {
    const full = {
      id: safeId("m"),
      createdAt: Date.now(),
      streaming: false,
      ...msg
    };
    await this.store.appendMessages(full.ideaId, [full]);
    return full;
  }
  /**
   * 解析本条消息要关联的图片列表：
   * - 支持显式传入 `images` 或 `attachmentIds`；
   * - 首轮开工（`autoIncludeAllIdeaImages: true`）且未显式指定时，自动把当前想法上的图片类参考附件挂入首条用户消息气泡。
   */
  resolveMessageImages(idea, opts) {
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    const add = (im) => {
      const key = im.attachmentId ? `id:${im.attachmentId}` : `name:${im.name}:${im.dataUrl ?? ""}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(im);
    };
    for (const im of opts?.images ?? []) {
      if (im && im.name) add(im);
    }
    const atts = idea.attachments ?? [];
    if (opts?.attachmentIds && opts.attachmentIds.length > 0) {
      const idSet = new Set(opts.attachmentIds);
      for (const a of atts) {
        if (idSet.has(a.id) && isImageLikeAttachment(a)) {
          add({ attachmentId: a.id, name: a.name, mime: a.mime, size: a.size });
        }
      }
    } else if (opts?.autoIncludeAllIdeaImages && out.length === 0) {
      for (const a of atts) {
        if (isImageLikeAttachment(a)) {
          add({ attachmentId: a.id, name: a.name, mime: a.mime, size: a.size });
        }
      }
    }
    return out;
  }
  /**
   * 将 DSH 会话事件里提取出的图片块（base64 / data URI / 本地路径 / URL）落盘到该想法的附件目录并去重，
   * 返回可挂到 `ChatMessage.images` 上的条目。
   */
  persistSessionImages(ideaId, rawImages, worktreePath) {
    if (!rawImages?.length) return [];
    let idea = this.store.getIdea(ideaId);
    if (!idea) return [];
    const out = [];
    const seenKeys = /* @__PURE__ */ new Set();
    for (let idx = 0; idx < rawImages.length; idx += 1) {
      const item = rawImages[idx];
      let blob = null;
      let mime = (item.mime ?? "").trim();
      let rawName = (item.name ?? "").trim();
      if (item.dataBase64) {
        try {
          blob = Buffer.from(item.dataBase64.replace(/\s+/g, ""), "base64");
        } catch {
          blob = null;
        }
      } else if (item.filePath) {
        const candidate = path11.isAbsolute(item.filePath) ? item.filePath : worktreePath ? path11.resolve(worktreePath, item.filePath) : "";
        if (candidate && fs10.existsSync(candidate)) {
          try {
            const st = fs10.statSync(candidate);
            if (st.isFile() && st.size > 0 && st.size <= 30 * 1024 * 1024) {
              blob = fs10.readFileSync(candidate);
              if (!rawName) rawName = path11.basename(candidate);
            }
          } catch {
            blob = null;
          }
        }
      }
      if (blob && blob.length > 0 && blob.length <= 30 * 1024 * 1024) {
        if (!mime || !mime.startsWith("image/")) {
          mime = inferImageMime(blob, rawName);
        }
        const ext = extForImageMime(mime, rawName);
        const baseName = sanitizeImageFileName(rawName || `dsh-image-${idx + 1}${ext}`, ext);
        const existingList = idea.attachments ?? [];
        let matched;
        for (const a of existingList) {
          if (a.size !== blob.length) continue;
          const p = paths.attachmentBlob(idea.id, a.id);
          if (fs10.existsSync(p)) {
            try {
              const diskBuf = fs10.readFileSync(p);
              if (Buffer.compare(diskBuf, blob) === 0) {
                matched = a;
                break;
              }
            } catch {
            }
          }
        }
        if (matched) {
          const key = `att:${matched.id}`;
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            out.push({
              attachmentId: matched.id,
              name: matched.name,
              mime: matched.mime,
              size: matched.size
            });
          }
          continue;
        }
        if (existingList.length < 50) {
          const existingNames = new Set(existingList.map((a) => a.name));
          let finalName = baseName;
          if (existingNames.has(finalName)) {
            const dotExt = path11.extname(finalName);
            const stem = dotExt ? finalName.slice(0, -dotExt.length) : finalName;
            let n = 2;
            while (existingNames.has(`${stem}-${n}${dotExt}`)) n += 1;
            finalName = `${stem}-${n}${dotExt}`;
          }
          const att = {
            id: safeId("att"),
            name: finalName,
            size: blob.length,
            mime,
            addedAt: Date.now()
          };
          try {
            fs10.mkdirSync(paths.attachmentBlobDir(idea.id), { recursive: true });
            fs10.writeFileSync(paths.attachmentBlob(idea.id, att.id), blob);
            idea = this.store.putIdea({
              ...idea,
              attachments: [...existingList, att],
              updatedAt: Date.now()
            });
            const key = `att:${att.id}`;
            if (!seenKeys.has(key)) {
              seenKeys.add(key);
              out.push({
                attachmentId: att.id,
                name: att.name,
                mime: att.mime,
                size: att.size
              });
            }
            continue;
          } catch {
          }
        }
        const inlineUrl = `data:${mime};base64,${blob.toString("base64")}`;
        out.push({ name: baseName, mime, dataUrl: inlineUrl, size: blob.length });
        continue;
      }
      if (item.url) {
        const key = `url:${item.url}`;
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          out.push({
            name: rawName || `dsh-image-${idx + 1}.png`,
            mime: mime || "image/png",
            dataUrl: item.url
          });
        }
      }
    }
    return out;
  }
  setStatus(idea, status) {
    if (idea.status === status) return;
    if (!canTransition(idea.status, status)) return;
    const next = { ...idea, status, updatedAt: Date.now(), closedAt: status === "done" ? Date.now() : null };
    this.store.putIdea(next);
  }
  publishTaskStatus(task) {
    this.store.bus.publish({ type: "task_status", taskId: task.id, ideaId: task.ideaId, status: task.status });
  }
  /** 期望的状态联动（供外部直接改任务状态时使用） */
  ideaStatusFor(taskStatus, current) {
    return ideaStatusForTask(taskStatus, current);
  }
  /* -------------------- P1：DSH 会话只读镜像与自动提交 -------------------- */
  /** 按 sessionId 触发关联任务的只读镜像同步 */
  async syncTaskBySessionId(sessionId) {
    if (!sessionId) return;
    const matched = this.store.listTasks().filter((t) => t.sessionId === sessionId);
    for (const t of matched) {
      await this.syncTaskSession(t.id).catch(() => void 0);
    }
  }
  /** 打开想法详情前同步该想法下所有绑定了 DSH sessionId 的任务会话（含修复历史 writer-held 受损账面） */
  async syncIdeaSessions(ideaId) {
    const tasks = this.store.listTasks({ ideaId });
    for (const t of tasks) {
      await this.repairHistoricalWriterHeldIfNeeded(t.id).catch(() => void 0);
    }
    if (!this.hostSession?.observeSession) return;
    for (const t of tasks.filter((x) => Boolean(x.sessionId))) {
      await this.syncTaskSession(t.id).catch(() => void 0);
    }
  }
  /**
   * P1 只读镜像 + 有文件改动即自动 commit 切回 review（Point 2）：
   * - 通过 `hostSession.observeSession(sessionId, lastImportedSeq)` 只读拉取 DSH 会话增量事件（不调 follow/promote，绝不抢写锁）；
   * - 过滤 `runtime-context` 注入与面板自身发起的轮次（`rpcId: 'aitm:...'` 或已计入 `turnStats` 的历史轮次）；
   * - 对每个在 DSH 桌面版完成的轮次（`turn/end` `completed`）：
   *   1) 把用户消息与 AI 回复追加到 `threads/<ideaId>.jsonl`（带 `source: 'dsh-gui'` 与 `sessionSeq` 幂等水位）；
   *   2) 检查 worktree 是否有未提交改动或新增 commit：
   *      - 若有改动（且 `autoCommit` 开启时自动 `commitAll` 到任务分支 `ai/...`），刷新 `diffStat`、`commits`、`turns`，
   *        将 `workspace.mergedAt` 清回 `null`、任务置 `succeeded`、想法切回 **`review`（待验收）**；
   *      - 若纯问答无文件改动，只记消息与推进 `lastImportedSeq`，不产生空 commit、不改任务/想法状态。
   */
  async syncTaskSession(taskId) {
    const task = this.store.getTask(taskId);
    if (!task) return null;
    if (!task.sessionId || !this.hostSession?.observeSession) return task;
    if (this.running.has(task.id) || this.syncingTasks.has(task.id)) return task;
    this.syncingTasks.add(task.id);
    try {
      const watermark = typeof task.lastImportedSeq === "number" ? task.lastImportedSeq : -1;
      const obs = await this.hostSession.observeSession(task.sessionId, watermark);
      if (!obs) return this.store.getTask(taskId) ?? task;
      const live = this.hostSession.hasLiveAgent?.(task.sessionId) ?? false;
      const writerState = live ? "dsh-gui" : "idle";
      const panelTurns = task.turnStats?.length ?? 0;
      const turns = extractSessionTurns(obs.events ?? [], {
        watermark,
        hadWatermark: typeof task.lastImportedSeq === "number",
        panelTurns
      });
      let current = this.store.getTask(taskId) ?? task;
      const existingMsgs = await this.store.listMessages(current.ideaId);
      const seenSeqs = /* @__PURE__ */ new Set();
      for (const m of existingMsgs) {
        if (typeof m.sessionSeq === "number") seenSeqs.add(m.sessionSeq);
        if (typeof m.meta?.sessionSeq === "number") seenSeqs.add(m.meta.sessionSeq);
      }
      let maxImportedSeq = watermark;
      for (const t of turns) {
        if (!t.completed) continue;
        if (t.panelOwned) {
          maxImportedSeq = Math.max(maxImportedSeq, t.endSeq);
          continue;
        }
        const userImages = this.persistSessionImages(current.ideaId, t.userImages, current.workspace?.path);
        if ((t.userText || userImages.length > 0) && !seenSeqs.has(t.userSeq)) {
          seenSeqs.add(t.userSeq);
          await this.appendMessage({
            ideaId: current.ideaId,
            taskId: current.id,
            role: "user",
            content: t.userText || "\uFF08\u53D1\u9001\u4E86\u56FE\u7247\uFF09",
            createdAt: t.userTime || Date.now(),
            source: "dsh-gui",
            sessionSeq: t.userSeq,
            ...userImages.length ? { images: userImages } : {},
            meta: { taskId: current.id, source: "dsh-gui", sessionSeq: t.userSeq }
          });
        }
        let hasFileChanges = false;
        let commitHashes = current.commits;
        let nextDiffStat = current.diffStat;
        let nextHead = current.workspace?.headCommit ?? "";
        if (current.workspace && fs10.existsSync(current.workspace.path)) {
          const idea = this.store.getIdea(current.ideaId);
          const porcelain = await git(current.workspace.path, ["status", "--porcelain=v1"]);
          const dirty = porcelain.ok && porcelain.stdout.trim().length > 0;
          let newHash = null;
          if (dirty && this.store.getSettings().autoCommit) {
            newHash = await this.workspaces.commitAll(
              current.workspace,
              `${commitPrefix(current)}: ${idea?.title ?? current.title} (turn ${current.turns + 1}, via DSH)

\u7531 DSH \u684C\u9762\u7248\u4F1A\u8BDD ${current.sessionId} \u7EED\u804A\u5E76\u81EA\u52A8\u63D0\u4EA4\u3002
${truncate2(t.assistantText || t.userText, 900)}`
            );
            if (newHash) {
              commitHashes = [.../* @__PURE__ */ new Set([...commitHashes, newHash])];
            }
          }
          const headRes = await git(current.workspace.path, ["rev-parse", "HEAD"]);
          nextHead = headRes.ok ? headRes.stdout.trim() : nextHead;
          hasFileChanges = Boolean(newHash) || dirty || Boolean(nextHead) && Boolean(current.workspace.headCommit) && nextHead !== current.workspace.headCommit;
          if (hasFileChanges) {
            nextDiffStat = await this.workspaces.diffStat(current.workspace);
          }
        }
        const assistantImages = this.persistSessionImages(current.ideaId, t.assistantImages, current.workspace?.path);
        if ((t.assistantText || assistantImages.length > 0) && !seenSeqs.has(t.assistantSeq)) {
          seenSeqs.add(t.assistantSeq);
          await this.appendMessage({
            ideaId: current.ideaId,
            taskId: current.id,
            role: "assistant",
            content: t.assistantText || "\uFF08\u8FD4\u56DE\u4E86\u56FE\u7247\uFF09",
            createdAt: t.endTime || Date.now(),
            source: "dsh-gui",
            sessionSeq: t.assistantSeq,
            countsAsTurn: hasFileChanges,
            ...assistantImages.length ? { images: assistantImages } : {},
            meta: {
              taskId: current.id,
              phase: "result",
              source: "dsh-gui",
              engine: "DSH \u684C\u9762\u7248",
              sessionSeq: t.assistantSeq,
              ...hasFileChanges ? { round: current.turns + 1 } : {}
            }
          });
        }
        maxImportedSeq = Math.max(maxImportedSeq, t.endSeq);
        if (hasFileChanges && current.workspace) {
          const idea = this.store.getIdea(current.ideaId);
          const repo = idea?.repoId ? this.store.getRepo(idea.repoId) : null;
          let checksOk = true;
          let checksOut = "";
          let nextVerify = current.verify;
          if (repo?.verifyCommand) {
            const ideaDir = (idea?.workDir ?? "").trim() || null;
            const agentCwd = ideaDir ? path11.join(current.workspace.path, ideaDir) : current.workspace.path;
            const checks = await this.workspaces.runChecks(repo, current.workspace, 6e5, ideaDir ? agentCwd : void 0);
            checksOk = checks.ok;
            checksOut = checks.output;
            const verifiedHead = await git(current.workspace.path, ["rev-parse", "HEAD"]);
            const verifiedBase = await git(repo.path, ["rev-parse", current.workspace.baseRef]);
            nextVerify = {
              ok: checksOk,
              at: Date.now(),
              note: checksOk ? `\u901A\u8FC7\uFF1A${repo.verifyCommand}` : `\u672A\u901A\u8FC7\uFF1A${firstLine(checksOut) || "\u9A8C\u8BC1\u547D\u4EE4\u975E\u96F6\u9000\u51FA"}`,
              head: verifiedHead.ok ? verifiedHead.stdout.trim() : null,
              base: verifiedBase.ok ? verifiedBase.stdout.trim() : null
            };
            if (!checksOk) {
              await this.appendMessage({
                ideaId: current.ideaId,
                taskId: current.id,
                role: "system",
                content: `\u26A0\uFE0F DSH \u684C\u9762\u7248\u7EED\u804A\u6539\u52A8\u672A\u901A\u8FC7\u9A8C\u8BC1\u547D\u4EE4 \`${repo.verifyCommand}\`\uFF1A
\`\`\`
${tailLines(checksOut, 40)}
\`\`\``,
                meta: { taskId: current.id, phase: "autofix" }
              });
            }
          }
          current = this.store.putTask({
            ...current,
            status: checksOk ? "succeeded" : "failed",
            error: checksOk ? null : `\u9A8C\u8BC1\u547D\u4EE4\u672A\u901A\u8FC7\uFF08DSH \u7EED\u804A\uFF09\uFF1A${truncate2(checksOut, 900)}`,
            errorCode: null,
            retryable: false,
            turns: current.turns + 1,
            commits: commitHashes,
            diffStat: nextDiffStat,
            ...nextVerify !== void 0 ? { verify: nextVerify } : {},
            workspace: { ...current.workspace, headCommit: nextHead || current.workspace.headCommit, mergedAt: null },
            lastImportedSeq: maxImportedSeq,
            writerState,
            endedAt: Date.now(),
            updatedAt: Date.now()
          });
          if (idea) this.setStatus(idea, checksOk ? "review" : "blocked");
          this.publishTaskStatus(current);
        } else {
          const clearWriterHeld = current.errorCode === "writer-held";
          current = this.store.putTask({
            ...current,
            ...clearWriterHeld ? { status: "succeeded", error: null, errorCode: null, retryable: false } : {},
            lastImportedSeq: maxImportedSeq,
            writerState,
            updatedAt: Date.now()
          });
          if (clearWriterHeld) {
            const idea = this.store.getIdea(current.ideaId);
            if (idea && idea.status === "blocked") {
              this.setStatus(idea, current.workspace?.mergedAt ? "done" : "review");
            }
            this.publishTaskStatus(current);
          }
        }
      }
      if (maxImportedSeq > (current.lastImportedSeq ?? -1) || current.writerState !== writerState) {
        current = this.store.putTask({
          ...current,
          ...maxImportedSeq >= 0 ? { lastImportedSeq: maxImportedSeq } : {},
          writerState
        });
      }
      return current;
    } finally {
      this.syncingTasks.delete(task.id);
    }
  }
};
function authRetryMs() {
  const raw = Number(process.env.AITM_AUTH_RETRY_MS ?? 3e4);
  return Number.isFinite(raw) && raw >= 0 ? raw : 3e4;
}
function tailLines(text, n) {
  const lines = String(text ?? "").replace(/\r/g, "").split("\n").filter((l) => l.trim());
  if (!lines.length) return "(\u65E0\u8F93\u51FA)";
  const cut = lines.length > n ? lines.slice(lines.length - n) : lines;
  return cut.join("\n");
}
function withHint(message, hint) {
  const err = new Error(message);
  err.hint = hint;
  return err;
}
function firstLine(s) {
  return (s ?? "").split("\n")[0].replace(/^#+\s*/, "").slice(0, 80).trim();
}
function truncate2(s, n) {
  if (!s) return "";
  return s.length > n ? `${s.slice(0, n)}\u2026` : s;
}
function commitPrefix(task) {
  switch (task.kind) {
    case "fix":
      return "fix(ai)";
    case "refactor":
      return "refactor(ai)";
    case "review":
      return "docs(ai-review)";
    case "explore":
      return "docs(ai-spike)";
    default:
      return "feat(ai)";
  }
}
function lastUserInstruction(messages, turn) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role === "user") return m.content;
    if (m.role === "system" && m.meta?.phase === "autofix") return m.content;
  }
  return turn === 0 ? "\u6309\u4E0A\u9762\u7684\u60F3\u6CD5\u539F\u6587\u5B9E\u73B0\u6700\u5C0F\u53EF\u7528\u7248\u672C\u3002" : "\u7EE7\u7EED\u4E0A\u4E00\u8F6E\uFF0C\u628A\u5269\u4E0B\u7684\u505A\u5B8C\u3002";
}
function collapseTrailingDuplicateUserMessages(messages, taskId) {
  if (messages.length < 2) return messages;
  const out = messages.slice();
  while (out.length >= 2) {
    const last = out[out.length - 1];
    const prev = out[out.length - 2];
    if (last.taskId === taskId && prev.taskId === taskId && last.role === "user" && prev.role === "user" && last.content.trim() === prev.content.trim()) {
      out.pop();
    } else {
      break;
    }
  }
  return out;
}
function isImageLikeAttachment(a) {
  const mime = (a.mime ?? "").toLowerCase();
  if (mime.startsWith("image/")) return true;
  return /\.(png|jpe?g|webp|gif|svg|bmp)$/i.test(a.name ?? "");
}
function inferImageMime(blob, name) {
  if (blob.length >= 8 && blob[0] === 137 && blob[1] === 80 && blob[2] === 78 && blob[3] === 71) {
    return "image/png";
  }
  if (blob.length >= 3 && blob[0] === 255 && blob[1] === 216 && blob[2] === 255) {
    return "image/jpeg";
  }
  if (blob.length >= 12 && blob.subarray(0, 4).toString("ascii") === "RIFF" && blob.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  if (blob.length >= 4 && blob.subarray(0, 4).toString("ascii") === "GIF8") {
    return "image/gif";
  }
  const ext = path11.extname(name).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".bmp") return "image/bmp";
  return "image/png";
}
function extForImageMime(mime, name) {
  const existingExt = path11.extname(name);
  if (/\.(png|jpe?g|webp|gif|svg|bmp)$/i.test(existingExt)) return existingExt;
  const m = (mime ?? "").toLowerCase();
  if (m === "image/jpeg" || m === "image/jpg") return ".jpg";
  if (m === "image/webp") return ".webp";
  if (m === "image/gif") return ".gif";
  if (m === "image/svg+xml") return ".svg";
  if (m === "image/bmp") return ".bmp";
  return ".png";
}
function sanitizeImageFileName(rawName, fallbackExt) {
  const base = path11.basename(rawName).replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").trim();
  if (!base) return `dsh-image${fallbackExt}`;
  if (!path11.extname(base)) return `${base}${fallbackExt}`;
  return base;
}
function parseDataUrlImage(str) {
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(str.trim());
  if (!m) return null;
  return { mime: m[1].toLowerCase(), dataBase64: m[2].replace(/\s+/g, "") };
}
function extractMessageImages(raw) {
  const out = [];
  const visit = (node) => {
    if (!node) return;
    if (typeof node === "string") {
      const parsed = parseDataUrlImage(node);
      if (parsed) {
        out.push({ mime: parsed.mime, dataBase64: parsed.dataBase64 });
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node !== "object") return;
    const obj = node;
    const type = typeof obj.type === "string" ? obj.type.toLowerCase() : "";
    const rawName = typeof obj.name === "string" ? obj.name : typeof obj.filename === "string" ? obj.filename : void 0;
    const rawMime = typeof obj.mime === "string" ? obj.mime : typeof obj.mimeType === "string" ? obj.mimeType : typeof obj.media_type === "string" ? obj.media_type : typeof obj.mediaType === "string" ? obj.mediaType : void 0;
    if (type === "image" || type === "input_image" || type === "image_url") {
      if (obj.source && typeof obj.source === "object") {
        const src = obj.source;
        const srcMime = typeof src.media_type === "string" ? src.media_type : typeof src.mimeType === "string" ? src.mimeType : rawMime;
        if (typeof src.data === "string" && src.data.trim()) {
          const dUrl = parseDataUrlImage(src.data);
          if (dUrl) {
            out.push({ name: rawName, mime: dUrl.mime, dataBase64: dUrl.dataBase64 });
          } else {
            out.push({ name: rawName, mime: srcMime || "image/png", dataBase64: src.data.replace(/\s+/g, "") });
          }
          return;
        }
        if (typeof src.url === "string" && src.url.trim()) {
          const dUrl = parseDataUrlImage(src.url);
          if (dUrl) {
            out.push({ name: rawName, mime: dUrl.mime, dataBase64: dUrl.dataBase64 });
          } else {
            out.push({ name: rawName, mime: srcMime, url: src.url.trim() });
          }
          return;
        }
        if (typeof src.path === "string" && src.path.trim()) {
          out.push({ name: rawName, mime: srcMime, filePath: src.path.trim() });
          return;
        }
      }
      if (obj.attachment && typeof obj.attachment === "object") {
        const att = obj.attachment;
        const attName = typeof att.name === "string" ? att.name : rawName;
        const attMime = typeof att.mediaType === "string" ? att.mediaType : typeof att.mimeType === "string" ? att.mimeType : typeof att.mime === "string" ? att.mime : rawMime;
        const attData = typeof att.data === "string" ? att.data : typeof att.dataBase64 === "string" ? att.dataBase64 : typeof att.base64 === "string" ? att.base64 : "";
        if (attData.trim()) {
          const dUrl = parseDataUrlImage(attData);
          if (dUrl) {
            out.push({ name: attName, mime: dUrl.mime, dataBase64: dUrl.dataBase64 });
          } else {
            out.push({ name: attName, mime: attMime || "image/png", dataBase64: attData.replace(/\s+/g, "") });
          }
          return;
        }
        const attPath = typeof att.filePath === "string" ? att.filePath : typeof att.path === "string" ? att.path : "";
        if (attPath.trim()) {
          out.push({ name: attName, mime: attMime, filePath: attPath.trim() });
          return;
        }
      }
      if (obj.image_url !== void 0) {
        const u = typeof obj.image_url === "string" ? obj.image_url : obj.image_url && typeof obj.image_url === "object" && typeof obj.image_url.url === "string" ? obj.image_url.url : "";
        if (u.trim()) {
          const dUrl = parseDataUrlImage(u);
          if (dUrl) {
            out.push({ name: rawName, mime: dUrl.mime, dataBase64: dUrl.dataBase64 });
          } else {
            out.push({ name: rawName, mime: rawMime, url: u.trim() });
          }
          return;
        }
      }
      const directData = typeof obj.data === "string" ? obj.data : typeof obj.base64 === "string" ? obj.base64 : typeof obj.dataBase64 === "string" ? obj.dataBase64 : typeof obj.dataUrl === "string" ? obj.dataUrl : "";
      if (directData.trim()) {
        const dUrl = parseDataUrlImage(directData);
        if (dUrl) {
          out.push({ name: rawName, mime: dUrl.mime, dataBase64: dUrl.dataBase64 });
        } else {
          out.push({ name: rawName, mime: rawMime || "image/png", dataBase64: directData.replace(/\s+/g, "") });
        }
        return;
      }
      const directUrl = typeof obj.url === "string" ? obj.url : "";
      if (directUrl.trim()) {
        const dUrl = parseDataUrlImage(directUrl);
        if (dUrl) {
          out.push({ name: rawName, mime: dUrl.mime, dataBase64: dUrl.dataBase64 });
        } else {
          out.push({ name: rawName, mime: rawMime, url: directUrl.trim() });
        }
        return;
      }
      const directPath = typeof obj.path === "string" ? obj.path : typeof obj.filePath === "string" ? obj.filePath : "";
      if (directPath.trim()) {
        out.push({ name: rawName, mime: rawMime, filePath: directPath.trim() });
        return;
      }
    }
    const looksLikeImg = rawMime && rawMime.toLowerCase().startsWith("image/") || rawName && /\.(png|jpe?g|webp|gif|svg|bmp)$/i.test(rawName);
    if (looksLikeImg && !obj.content && !obj.message) {
      const b64 = typeof obj.dataBase64 === "string" ? obj.dataBase64 : typeof obj.base64 === "string" ? obj.base64 : typeof obj.data === "string" ? obj.data : typeof obj.dataUrl === "string" ? obj.dataUrl : "";
      if (b64.trim()) {
        const dUrl = parseDataUrlImage(b64);
        if (dUrl) {
          out.push({ name: rawName, mime: dUrl.mime, dataBase64: dUrl.dataBase64 });
        } else {
          out.push({ name: rawName, mime: rawMime || "image/png", dataBase64: b64.replace(/\s+/g, "") });
        }
        return;
      }
      const p = typeof obj.filePath === "string" ? obj.filePath : typeof obj.path === "string" ? obj.path : "";
      if (p.trim()) {
        out.push({ name: rawName, mime: rawMime, filePath: p.trim() });
        return;
      }
      const u = typeof obj.url === "string" ? obj.url : "";
      if (u.trim()) {
        const dUrl = parseDataUrlImage(u);
        if (dUrl) {
          out.push({ name: rawName, mime: dUrl.mime, dataBase64: dUrl.dataBase64 });
        } else {
          out.push({ name: rawName, mime: rawMime, url: u.trim() });
        }
        return;
      }
    }
    if (obj.content !== void 0) visit(obj.content);
    if (obj.message !== void 0) visit(obj.message);
    if (obj.parts !== void 0) visit(obj.parts);
    if (obj.images !== void 0) visit(obj.images);
    if (obj.attachments !== void 0) visit(obj.attachments);
  };
  visit(raw);
  return out;
}
function extractMessageText(raw) {
  if (typeof raw === "string") return raw.trim();
  if (Array.isArray(raw)) {
    return raw.map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && typeof part.text === "string") {
        return part.text;
      }
      return "";
    }).filter(Boolean).join("\n").trim();
  }
  if (raw && typeof raw === "object") {
    const obj = raw;
    if (typeof obj.content === "string" || Array.isArray(obj.content)) return extractMessageText(obj.content);
    if (typeof obj.text === "string") return obj.text.trim();
  }
  return "";
}
function extractSessionTurns(events, opts) {
  const result = [];
  let cur = null;
  let inferredTurn = 0;
  for (const ev of events) {
    if (!ev || typeof ev.seq !== "number") continue;
    const data = ev.data ?? {};
    const src = data.source ?? {};
    const srcKind = typeof src.kind === "string" ? src.kind : "";
    const rpcId = typeof src.rpcId === "string" ? src.rpcId : "";
    if (ev.type === "turn/start") {
      inferredTurn += 1;
      const turnNum = typeof data.turn === "number" ? data.turn : inferredTurn;
      const byRpc = rpcId.startsWith("aitm:");
      const byCount = !opts.hadWatermark && turnNum <= opts.panelTurns;
      cur = {
        turn: turnNum,
        userSeq: ev.seq,
        userTime: ev.time ?? Date.now(),
        userText: "",
        userImages: [],
        assistantSeq: ev.seq,
        assistantParts: [],
        finalAssistantText: "",
        assistantImages: [],
        panelOwned: byRpc || byCount
      };
      continue;
    }
    if (ev.type === "user/message") {
      if (srcKind && srcKind !== "user") continue;
      const text = extractMessageText(data.content ?? data.message ?? data.text ?? data);
      const images = extractMessageImages(data);
      if (!text && images.length === 0) continue;
      if (!cur) {
        inferredTurn += 1;
        cur = {
          turn: inferredTurn,
          userSeq: ev.seq,
          userTime: ev.time ?? Date.now(),
          userText: "",
          userImages: [],
          assistantSeq: ev.seq,
          assistantParts: [],
          finalAssistantText: "",
          assistantImages: [],
          panelOwned: !opts.hadWatermark && inferredTurn <= opts.panelTurns
        };
      }
      if (rpcId.startsWith("aitm:") || text.startsWith("# \u4EFB\u52A1\n")) {
        cur.panelOwned = true;
      }
      cur.userSeq = ev.seq;
      cur.userTime = ev.time ?? cur.userTime;
      cur.userText = text;
      if (images.length > 0) cur.userImages.push(...images);
      continue;
    }
    if (!cur) continue;
    if (ev.type === "assistant/message") {
      const text = extractMessageText(data.content ?? data.message ?? data.text ?? data);
      const images = extractMessageImages(data);
      if (text) {
        cur.assistantSeq = ev.seq;
        cur.finalAssistantText = text;
      }
      if (images.length > 0) {
        cur.assistantSeq = ev.seq;
        cur.assistantImages.push(...images);
      }
      continue;
    }
    if (ev.type === "assistant/text" || ev.type === "assistant/delta" || ev.type === "text") {
      const text = extractMessageText(data.text ?? data.delta ?? data.content ?? data);
      if (text) {
        cur.assistantSeq = ev.seq;
        cur.assistantParts.push(text);
      }
      continue;
    }
    if (ev.type === "turn/end") {
      const status = typeof data.status === "string" ? data.status : "completed";
      const completed = status === "completed" || status === "ok" || status === "succeeded";
      const assistantText = (cur.finalAssistantText || cur.assistantParts.join("")).trim();
      if (ev.seq > opts.watermark) {
        result.push({
          turn: cur.turn,
          userSeq: cur.userSeq,
          userTime: cur.userTime,
          userText: cur.userText,
          ...cur.userImages.length ? { userImages: cur.userImages } : {},
          assistantSeq: cur.assistantSeq,
          assistantText,
          ...cur.assistantImages.length ? { assistantImages: cur.assistantImages } : {},
          endSeq: ev.seq,
          endTime: ev.time ?? Date.now(),
          completed,
          panelOwned: cur.panelOwned
        });
      }
      cur = null;
    }
  }
  return result;
}
function buildAutofixContextLines(diffStat, filesChanged, checksOut) {
  const lines = [];
  const changed = diffStat && Array.isArray(diffStat.entries) && diffStat.entries.length > 0 ? diffStat.entries.slice(0, 15).map((e) => `- \`${e.path}\` (+${e.additions}/-${e.deletions})`) : Array.isArray(filesChanged) && filesChanged.length > 0 ? filesChanged.slice(0, 15).map((f) => `- \`${f}\``) : [];
  if (changed.length > 0) {
    lines.push("\u672C\u8F6E\u5DF2\u6539\u52A8\u6587\u4EF6\uFF1A", ...changed);
  }
  const locRe = /(?:^|[\s(])((?:src|tests|test|packages|apps|scripts|dsh-plugin)\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+(?::\d+(?::\d+)?)?)/gm;
  const locs = [];
  let m;
  while (m = locRe.exec(checksOut ?? "")) {
    const ref = m[1]?.trim();
    if (ref && !locs.includes(ref)) {
      locs.push(ref);
      if (locs.length >= 10) break;
    }
  }
  if (locs.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("\u62A5\u9519\u8F93\u51FA\u5B9A\u4F4D\u5230\u7684\u76F8\u5173\u4F4D\u7F6E\uFF1A", ...locs.map((l) => `- \`${l}\``));
  }
  return lines;
}

// src/core/feed/service.ts
import fsp3 from "node:fs/promises";
import path12 from "node:path";

// src/core/feed/bilibili.ts
import crypto from "node:crypto";

// src/shared/feed-format.ts
var FEED_KIND_LABEL = {
  model: "\u6A21\u578B",
  tool: "\u5DE5\u5177",
  skill: "\u6280\u80FD",
  repo: "\u9879\u76EE",
  video: "\u89C6\u9891"
};
function compactNumber(n, opts = {}) {
  if (!Number.isFinite(n)) return "\u2014";
  if (opts.wan) {
    if (n >= 1e8) return `${(n / 1e8).toFixed(1)} \u4EBF`;
    if (n >= 1e4) return `${(n / 1e4).toFixed(1)} \u4E07`;
    return String(n);
  }
  return n.toLocaleString("en-US");
}
function metricText(item) {
  const m = item.metrics;
  const parts = [];
  if (item.source === "github") {
    if (m.stars != null) parts.push(`\u2605 ${compactNumber(m.stars)}`);
    if (m.starsToday != null) parts.push(`+${compactNumber(m.starsToday)}/\u65E5`);
    if (m.starsWeek != null) parts.push(`+${compactNumber(m.starsWeek)}/\u5468`);
    if (m.starsMonth != null) parts.push(`+${compactNumber(m.starsMonth)}/\u6708`);
    if (m.forks != null) parts.push(`\u2442 ${compactNumber(m.forks)}`);
  } else {
    if (m.views != null) parts.push(`\u64AD\u653E ${compactNumber(m.views, { wan: true })}`);
    if (m.likes != null) parts.push(`\u8D5E ${compactNumber(m.likes, { wan: true })}`);
    if (m.danmaku != null) parts.push(`\u5F39\u5E55 ${compactNumber(m.danmaku, { wan: true })}`);
  }
  return parts.join(" \xB7 ");
}
function trendText(item) {
  const t = item.trend;
  if (!t || !t.ready) return null;
  const bits = [`\u4E0A\u699C ${Math.round(t.appearRatio * 100)}%`];
  if (t.avgRank != null) bits.push(`\u5747\u540D #${t.avgRank}`);
  if (t.starVelocity != null) bits.push(`+${compactNumber(Math.round(t.starVelocity))}/\u65E5`);
  return bits.join(" \xB7 ");
}
function feedIdeaTitle(item) {
  const t = item.title.replace(/\s+/g, " ").trim();
  return t.length > 80 ? `${t.slice(0, 79)}\u2026` : t || "\uFF08\u65E0\u6807\u9898\uFF09";
}
function feedIdeaDescription(item, now = Date.now()) {
  const lines = [];
  lines.push(`\u6765\u6E90\uFF1A${item.source === "github" ? "GitHub \u70ED\u699C" : "B\u7AD9\u70ED\u699C"} \xB7 [${item.title}](${item.url})`);
  const bits = [FEED_KIND_LABEL[item.kind], item.subtitle].filter(Boolean);
  if (bits.length) lines.push(`${item.source === "github" ? "\u8BED\u8A00" : "UP\u4E3B / \u5206\u533A"}\uFF1A${bits.join(" \xB7 ")}`);
  const metrics = metricText(item);
  if (metrics) lines.push(`\u6570\u636E\uFF1A${metrics}`);
  if (item.publishedAt) lines.push(`\u53D1\u5E03\u65F6\u95F4\uFF1A${new Date(item.publishedAt).toLocaleString("zh-CN", { hour12: false })}`);
  if (item.rank != null) lines.push(`\u699C\u5355\u540D\u6B21\uFF1A#${item.rank}`);
  const trend = trendText(item);
  if (trend) lines.push(`\u8D8B\u52BF\uFF1A${trend}`);
  if (item.summary) {
    lines.push("");
    lines.push("\u7B80\u4ECB\uFF1A");
    lines.push(`> ${item.summary.split("\n").slice(0, 6).join("\n> ")}`);
  }
  lines.push("");
  lines.push(`\u6293\u53D6\u65F6\u95F4\uFF1A${new Date(item.fetchedAt || now).toLocaleString("zh-CN", { hour12: false })}`);
  return lines.join("\n");
}
function feedIdeaTags(item) {
  const out = ["\u8D44\u8BAF", item.source === "github" ? "GitHub" : "B\u7AD9"];
  for (const t of item.tags) {
    if (out.includes(t)) continue;
    out.push(t);
    if (out.length >= 6) break;
  }
  return out;
}

// src/core/feed/github.ts
var UA = "Mozilla/5.0 (compatible; AI-Tasks-Manager/0.1; +https://github.com/)";
var TRENDING_BASE = "https://github.com/trending";
var SEARCH_API = "https://api.github.com/search/repositories";
function describeFetchError(err, what) {
  const e = err;
  if (e?.name === "AbortError") return `${what}\uFF1A\u8BF7\u6C42\u8D85\u65F6\uFF0815 \u79D2\uFF09`;
  const code = e?.cause?.code ?? e?.cause?.message ?? "";
  const msg = e?.message ?? String(err);
  if (code === "ENOTFOUND") return `${what}\uFF1A\u57DF\u540D\u89E3\u6790\u5931\u8D25\uFF08\u68C0\u67E5\u7F51\u7EDC / DNS / \u4EE3\u7406\uFF09`;
  if (code === "ECONNRESET" || code === "ECONNREFUSED" || code === "ETIMEDOUT") return `${what}\uFF1A\u8FDE\u63A5\u88AB\u62D2\u7EDD\u6216\u91CD\u7F6E\uFF08${code}\uFF1B\u4EE3\u7406 / \u9632\u706B\u5899 / \u5730\u533A\u7F51\u7EDC\u90FD\u53EF\u80FD\uFF09`;
  return `${what}\uFF1A${msg}${code ? `\uFF08${code}\uFF09` : ""}`;
}
function textOf2(html) {
  return html.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
}
function toNum(s) {
  if (!s) return null;
  const m = s.replace(/,/g, "").match(/\d+/);
  return m ? Number(m[0]) : null;
}
function pickCount(row, path19) {
  const re = new RegExp(`href="[^"]*\\/${path19}"[\\s\\S]*?<\\/svg>\\s*([\\d,]+)\\s*<\\/a>`, "i");
  const m = row.match(re);
  return m ? toNum(m[1]) : null;
}
function parseTrending(html) {
  const out = [];
  const chunks = html.split(/<article class="Box-row"/).slice(1);
  for (const [i, row] of chunks.entries()) {
    const repo = row.match(/<h2[^>]*>\s*<a[^>]*href="\/([^"?#]+)"/)?.[1];
    if (!repo) continue;
    const descRaw = row.match(/<p class="col-9[^"]*">([\s\S]*?)<\/p>/)?.[1] ?? "";
    const gain = row.match(/([\d,]+)\s*stars?\s*(today|this week|this month)/i);
    out.push({
      repo,
      description: textOf2(descRaw),
      language: row.match(/itemprop="programmingLanguage">([^<]+)</)?.[1]?.trim() ?? null,
      stars: pickCount(row, "stargazers"),
      forks: pickCount(row, "forks"),
      gained: gain ? toNum(gain[1]) : null,
      gainedLabel: gain ? gain[2].toLowerCase().includes("today") ? "today" : gain[2].toLowerCase().includes("week") ? "week" : "month" : null,
      rank: i + 1
    });
  }
  return out;
}
async function fetchTrending(since, fetchImpl = fetch, timeoutMs = 15e3) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${TRENDING_BASE}?since=${since}`, {
      headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", Accept: "text/html" },
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error(`GitHub trending \u8FD4\u56DE HTTP ${res.status}`);
    const html = await res.text();
    const rows = parseTrending(html);
    if (!rows.length) throw new Error("GitHub trending \u9875\u9762\u89E3\u6790\u4E0D\u5230\u6761\u76EE\uFF08\u9875\u9762\u7ED3\u6784\u53EF\u80FD\u53D8\u4E86\uFF09");
    return rows;
  } catch (err) {
    throw new Error(describeFetchError(err, "GitHub trending"));
  } finally {
    clearTimeout(timer);
  }
}
async function fetchNewRepos(token, days, fetchImpl = fetch, timeoutMs = 15e3) {
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const url = `${SEARCH_API}?q=${encodeURIComponent(`created:>=${since} stars:>50`)}&sort=stars&order=desc&per_page=30`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = { "User-Agent": UA, Accept: "application/vnd.github+json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetchImpl(url, { headers, signal: ctrl.signal });
    if (!res.ok) {
      const hint = res.status === 403 || res.status === 429 ? "\uFF08\u9650\u989D\uFF1A\u672A\u767B\u5F55 10 \u6B21/\u5206\u949F\uFF0C\u53EF\u5728\u8BBE\u7F6E\u91CC\u586B GitHub Token\uFF09" : "";
      throw new Error(`GitHub \u641C\u7D22\u63A5\u53E3 HTTP ${res.status}${hint}`);
    }
    const json = await res.json();
    return (json.items ?? []).map((it) => ({
      repo: String(it.full_name ?? ""),
      description: String(it.description ?? ""),
      language: it.language ? String(it.language) : null,
      stars: Number(it.stargazers_count ?? 0),
      forks: Number(it.forks_count ?? 0),
      createdAt: Date.parse(String(it.created_at ?? "")) || Date.now(),
      topics: Array.isArray(it.topics) ? it.topics.map(String) : []
    })).filter((r) => r.repo.includes("/"));
  } catch (err) {
    if (err.message?.startsWith("GitHub \u641C\u7D22\u63A5\u53E3")) throw err;
    throw new Error(describeFetchError(err, "GitHub \u641C\u7D22"));
  } finally {
    clearTimeout(timer);
  }
}
function classifyRepo(text, kw) {
  const model = matchKeywords(text, kw.model);
  const tool = matchKeywords(text, kw.tool);
  const skill = matchKeywords(text, kw.skill);
  const ranked = [
    ["skill", skill],
    ["model", model],
    ["tool", tool]
  ];
  ranked.sort((a, b) => b[1].length - a[1].length);
  const best = ranked[0];
  const tags = [.../* @__PURE__ */ new Set([...model, ...tool, ...skill])].slice(0, 6);
  return { kind: best[1].length ? best[0] : "repo", tags };
}
function buildGithubItems(rows, opts) {
  const out = [];
  for (const row of rows) {
    const text = `${row.repo} ${row.description}`;
    if (matchKeywords(text, opts.keywords.exclude).length) continue;
    const { kind, tags } = classifyRepo(text, opts.keywords);
    if (kind === "repo") continue;
    const metrics = {};
    if (row.stars != null) metrics.stars = row.stars;
    if (row.forks != null) metrics.forks = row.forks;
    if (row.gained != null) {
      if (row.gainedLabel === "week") metrics.starsWeek = row.gained;
      else if (row.gainedLabel === "month") metrics.starsMonth = row.gained;
      else metrics.starsToday = row.gained;
    }
    out.push({
      key: `gh:${row.repo}`,
      source: "github",
      kind,
      title: row.repo,
      subtitle: row.language ?? "GitHub",
      url: `https://github.com/${row.repo}`,
      summary: row.description,
      tags: ["github", FEED_KIND_LABEL[kind], ...tags].slice(0, 8),
      metrics,
      lists: [opts.list],
      rank: row.rank,
      publishedAt: null,
      fetchedAt: opts.fetchedAt
    });
  }
  return out;
}

// src/core/feed/bilibili.ts
var UA2 = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
var REFERER = "https://www.bilibili.com/";
function normalizeCookie(raw) {
  let s = raw.trim().replace(/^cookie\s*:\s*/i, "").trim();
  if (s.length > 1 && (s.startsWith('"') && s.endsWith('"') || s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  if (!s) return "";
  return /^[A-Za-z0-9_.\-]+=/.test(s) ? s : `SESSDATA=${s}`;
}
var RISK_PATTERNS = [/code=-352\b/, /code=-799\b/, /code=-509\b/, /code=-412\b/, /HTTP 412\b/, /request was banned/i, /风控/];
function isRiskControlError(message) {
  return RISK_PATTERNS.some((re) => re.test(message));
}
var RISK_ADVICE = "\u7B49 5\u201310 \u5206\u949F\u518D\u8BD5\uFF0C\u522B\u8FDE\u70B9\u300C\u5237\u65B0 / \u8FDE\u63A5\u6D4B\u8BD5\u300D\uFF1B\u5728\u8BBE\u7F6E\u91CC\u586B\u300C\u6574\u6761 Cookie\u300D\uFF08\u6D4F\u89C8\u5668 F12 \u2192 Network \u2192 \u4EFB\u4E00 api.bilibili.com \u8BF7\u6C42 \u2192 Request Headers \u91CC\u7684 cookie \u6574\u884C\u590D\u5236\uFF0C\u542B buvid3\uFF09\u4F1A\u7A33\u5F88\u591A";
var DEFAULT_BILI_GAP_MS = 2e3;
var biliGapMs = DEFAULT_BILI_GAP_MS;
var lastRequestAt = 0;
var WBI_TTL_MS = 30 * 6e4;
var wbiCache = null;
async function throttleBili() {
  if (biliGapMs <= 0) return;
  const wait = lastRequestAt + biliGapMs - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}
async function biliGet(path19, cookie, fetchImpl, timeoutMs = 15e3, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = { "User-Agent": UA2, Referer: REFERER, Accept: "application/json" };
    const c = normalizeCookie(cookie);
    if (c) headers.cookie = c;
    await throttleBili();
    const res = await fetchImpl(`https://api.bilibili.com${path19}`, { headers, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`B\u7AD9\u63A5\u53E3 HTTP ${res.status}${text ? `\uFF1A${text.slice(0, 120)}` : ""}`);
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`B\u7AD9\u63A5\u53E3\u8FD4\u56DE\u7684\u4E0D\u662F JSON\uFF08\u524D 120 \u5B57\uFF09\uFF1A${text.slice(0, 120)}`);
    }
    if (json.code !== 0 && !opts.allowAnyCode) {
      const msg = `B\u7AD9\u63A5\u53E3 code=${json.code} ${json.message ?? ""}`;
      const hint = isRiskControlError(msg) ? `\uFF08${RISK_ADVICE}\uFF09` : "";
      throw new Error(`${msg}${hint}`);
    }
    return opts.allowAnyCode ? json : json.data;
  } catch (err) {
    if (err.message?.startsWith("B\u7AD9\u63A5\u53E3")) throw err;
    throw new Error(describeFetchError(err, "B\u7AD9\u63A5\u53E3"));
  } finally {
    clearTimeout(timer);
  }
}
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function normalizeVideo(raw, fallbackRank) {
  if (!raw || typeof raw !== "object") return null;
  const v = raw;
  const bvid = String(v.bvid ?? "");
  if (!bvid) return null;
  const stat = v.stat ?? {};
  const owner = v.owner ?? {};
  return {
    bvid,
    title: String(v.title ?? "").trim(),
    up: String(owner.name ?? "").trim(),
    tid: num(v.tid),
    tname: String(v.tname ?? "").trim(),
    desc: String(v.desc ?? "").trim(),
    durationSec: num(v.duration),
    // 接口没给 pubdate 就留 0（=未知）。以前这里 `|| Date.now()`：数据层看不出来，
    // 但卡片一旦把发布时间显示出来，「未知」就会伪装成「刚刚发布」——宁可不显示，不编。
    pubdate: num(v.pubdate) * 1e3,
    view: num(stat.view),
    like: num(stat.like),
    danmaku: num(stat.danmaku),
    favorite: num(stat.favorite),
    rank: fallbackRank
  };
}
function parseVideoList(data) {
  const obj = data;
  const list = obj?.list ?? obj?.data?.list;
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const [i, raw] of list.entries()) {
    const v = normalizeVideo(raw, i + 1);
    if (v) out.push(v);
  }
  return out;
}
async function fetchPopular(fetchImpl = fetch, cookie = "", ps = 50, timeoutMs = 15e3) {
  const data = await biliGet(`/x/web-interface/popular?ps=${ps}&pn=1`, cookie, fetchImpl, timeoutMs);
  return parseVideoList(data);
}
async function fetchZoneRanking(fetchImpl = fetch, tid, cookie = "", timeoutMs = 15e3) {
  const data = await biliGet(`/x/web-interface/ranking/v2?rid=${tid}&type=all`, cookie, fetchImpl, timeoutMs);
  return parseVideoList(data);
}
function biliAiHits(v, keywords) {
  return matchKeywords(`${v.title} ${v.desc}`, keywords);
}
function dedupeVideos(videos) {
  const map = /* @__PURE__ */ new Map();
  for (const v of videos) {
    const cur = map.get(v.bvid);
    if (!cur || v.rank < cur.rank) map.set(v.bvid, v);
  }
  return [...map.values()];
}
function buildBiliItems(videos, list, fetchedAt, limit, extraTags = []) {
  return videos.slice(0, limit).map((v) => {
    const metrics = { views: v.view, likes: v.like, danmaku: v.danmaku };
    return {
      key: `bili:${v.bvid}`,
      source: "bilibili",
      kind: "video",
      title: v.title,
      subtitle: v.up || v.tname,
      url: `https://www.bilibili.com/video/${v.bvid}`,
      summary: v.desc,
      tags: [...new Set(["bilibili", v.tname, ...extraTags].filter(Boolean))],
      metrics,
      lists: [list],
      rank: v.rank,
      publishedAt: v.pubdate || null,
      // 0（接口没给）→ null：卡片据此决定显不显示
      fetchedAt
    };
  });
}
var MIXIN_KEY_ENC_TAB = [
  46,
  47,
  18,
  2,
  53,
  8,
  23,
  32,
  15,
  50,
  10,
  31,
  58,
  3,
  45,
  35,
  27,
  43,
  5,
  49,
  33,
  9,
  42,
  19,
  29,
  28,
  14,
  39,
  12,
  38,
  41,
  13,
  37,
  48,
  7,
  16,
  24,
  55,
  40,
  61,
  26,
  17,
  0,
  1,
  60,
  51,
  30,
  4,
  22,
  25,
  54,
  21,
  56,
  59,
  6,
  63,
  57,
  62,
  11,
  36,
  20,
  34,
  44,
  52
];
function mixinKey(imgKey, subKey) {
  const raw = `${imgKey}${subKey}`;
  return MIXIN_KEY_ENC_TAB.map((i) => raw[i] ?? "").join("").slice(0, 32);
}
function signWbi(params, imgKey, subKey, wts = Math.round(Date.now() / 1e3)) {
  const all = { ...params, wts };
  const query = Object.keys(all).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(all[k]).replace(/[!'()*]/g, ""))}`).join("&");
  const rid = crypto.createHash("md5").update(`${query}${mixinKey(imgKey, subKey)}`).digest("hex");
  return `${query}&w_rid=${rid}`;
}
async function getWbiKeys(cookie, fetchImpl, timeoutMs = 15e3) {
  const now = Date.now();
  if (wbiCache && wbiCache.cookie === cookie && now - wbiCache.at < WBI_TTL_MS) return wbiCache.keys;
  const envelope = await biliGet("/x/web-interface/nav", cookie, fetchImpl, timeoutMs, { allowAnyCode: true });
  const data = envelope?.data;
  const pick = (u) => u ? (u.split("/").pop() ?? "").split(".")[0] : "";
  const imgKey = pick(data?.wbi_img?.img_url);
  const subKey = pick(data?.wbi_img?.sub_url);
  if (!imgKey || !subKey) throw new Error("\u62FF\u4E0D\u5230 WBI \u53E3\u4EE4\uFF08nav \u56DE\u5305\u91CC\u6CA1\u6709 wbi_img\uFF09\u2014\u2014\u8FC7\u4E00\u4F1A\u513F\u518D\u8BD5");
  wbiCache = { cookie, at: now, keys: { imgKey, subKey } };
  return { imgKey, subKey };
}
function lengthToSec(len) {
  const parts = String(len ?? "").split(":").map((n) => Number.parseInt(n, 10));
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}
function parseSpaceVideos(data) {
  const obj = data;
  const vlist = obj?.list?.vlist ?? obj?.data?.list?.vlist;
  if (!Array.isArray(vlist)) return [];
  const out = [];
  for (const [i, raw] of vlist.entries()) {
    if (!raw || typeof raw !== "object") continue;
    const v = raw;
    const bvid = String(v.bvid ?? "");
    if (!bvid) continue;
    out.push({
      bvid,
      title: String(v.title ?? "").trim(),
      up: String(v.author ?? "").trim(),
      tid: num(v.typeid),
      tname: String(v.typename ?? v.tname ?? "").trim(),
      desc: String(v.description ?? "").trim(),
      durationSec: num(v.length) || lengthToSec(v.length),
      pubdate: num(v.created) * 1e3,
      // 同上：没给就 0（未知），不冒充此刻
      view: num(v.play) || num(v.stat?.view),
      like: num(v.stat?.like),
      danmaku: num(v.video_review) || num(v.stat?.danmaku),
      favorite: num(v.favorites),
      rank: i + 1
    });
  }
  return out;
}
async function probeBiliLogin(cookie, fetchImpl = fetch, timeoutMs = 8e3) {
  const envelope = await biliGet("/x/web-interface/nav", cookie, fetchImpl, timeoutMs, { allowAnyCode: true });
  const d = envelope?.data ?? {};
  return { isLogin: Boolean(d.isLogin), uname: String(d.uname ?? ""), mid: Number(d.mid ?? 0), code: Number(envelope?.code ?? 0) };
}
async function fetchUpVideos(mid, cookie, fetchImpl = fetch, limit = 10, timeoutMs = 15e3) {
  const base = { mid, ps: String(Math.min(Math.max(limit, 1), 30)), pn: "1", order: "pubdate", tid: "0", platform: "web", web_location: "1550101" };
  const attempts = [];
  let keys = null;
  try {
    keys = await getWbiKeys(cookie, fetchImpl, timeoutMs);
  } catch (err) {
    attempts.push(`WBI \u53E3\u4EE4\uFF1A${err.message}`);
  }
  if (keys) {
    try {
      const query = signWbi(base, keys.imgKey, keys.subKey);
      const data = await biliGet(`/x/space/wbi/arc/search?${query}`, cookie, fetchImpl, timeoutMs);
      const videos = parseSpaceVideos(data);
      if (!videos.length) throw new Error("\u63A5\u53E3\u53EF\u7528\u4F46\u8FD9\u6761\u6CA1\u6709\u6295\u7A3F");
      return { mid, name: videos[0].up || mid, videos, via: "wbi" };
    } catch (err) {
      const msg = err.message;
      attempts.push(`WBI \u63A5\u53E3\uFF1A${msg}`);
      if (isRiskControlError(msg)) {
        throw new Error(`WBI \u63A5\u53E3\uFF1A${msg}\uFF1B\u5DF2\u8DF3\u8FC7\u65E0\u7B7E\u540D\u515C\u5E95\uFF08\u88AB\u98CE\u63A7\u65F6\u6362\u63A5\u53E3\u91CD\u8BD5\u53EA\u4F1A\u66F4\u7CDF\uFF09\u3002${RISK_ADVICE}`);
      }
    }
  }
  try {
    const qs = new URLSearchParams(base).toString();
    const data = await biliGet(`/x/space/arc/search?${qs}`, cookie, fetchImpl, timeoutMs);
    const videos = parseSpaceVideos(data);
    if (!videos.length) throw new Error("\u63A5\u53E3\u53EF\u7528\u4F46\u8FD9\u6761\u6CA1\u6709\u6295\u7A3F");
    return { mid, name: videos[0].up || mid, videos, via: "plain" };
  } catch (err) {
    attempts.push(`\u65E0\u7B7E\u540D\u63A5\u53E3\uFF1A${err.message}`);
  }
  throw new Error(attempts.join("\uFF1B"));
}
function buildUpItems(videos, mid, name, fetchedAt, limit) {
  return videos.slice(0, limit).map((v) => ({
    key: `bili:${v.bvid}`,
    source: "bilibili",
    kind: "video",
    title: v.title,
    subtitle: name || v.up || mid,
    url: `https://www.bilibili.com/video/${v.bvid}`,
    summary: v.desc,
    tags: [...new Set(["bilibili", name, "\u5173\u6CE8UP"].filter(Boolean))],
    metrics: { views: v.view, danmaku: v.danmaku },
    lists: [`up:${mid}`],
    rank: void 0,
    publishedAt: v.pubdate || null,
    fetchedAt
  }));
}

// src/core/feed/trend.ts
var MIN_SAMPLES = 3;
var MIN_DAYS = 3;
function snapshotFromGithub(items, ts) {
  const ranks = {};
  const stars = {};
  for (const it of items) {
    if (it.source !== "github") continue;
    if (it.rank != null) ranks[it.key] = Math.min(ranks[it.key] ?? 999, it.rank);
    if (it.metrics.stars != null) stars[it.key] = Math.max(stars[it.key] ?? 0, it.metrics.stars);
  }
  return { ts, source: "github", ranks, stars };
}
var clamp01 = (n) => Math.max(0, Math.min(1, n));
function rankScore(avgRank) {
  return clamp01(1 - (avgRank - 1) / 24);
}
function velocityScore(v) {
  return v == null ? null : clamp01(v / 200);
}
function computeTrends(snaps, windowDays, now = Date.now(), minSamples = MIN_SAMPLES) {
  const from = now - windowDays * 864e5;
  const win = snaps.filter((s) => s.ts >= from && s.ts <= now).sort((a, b) => a.ts - b.ts);
  const out = /* @__PURE__ */ new Map();
  if (!win.length) return out;
  const keys = /* @__PURE__ */ new Set();
  for (const s of win) for (const k of Object.keys(s.ranks)) keys.add(k);
  const distinctDays = new Set(win.map((s) => new Date(s.ts).toISOString().slice(0, 10))).size;
  const readyByTime = win.length >= minSamples && distinctDays >= MIN_DAYS;
  for (const key of keys) {
    const ranks = [];
    let first = null;
    let last = null;
    for (const s of win) {
      const r = s.ranks[key];
      if (typeof r === "number") ranks.push(r);
      const st = s.stars[key];
      if (typeof st === "number") {
        if (!first) first = { ts: s.ts, stars: st };
        last = { ts: s.ts, stars: st };
      }
    }
    if (!ranks.length) continue;
    const appearRatio = ranks.length / win.length;
    const avgRank = ranks.reduce((a, b) => a + b, 0) / ranks.length;
    const bestRank = Math.min(...ranks);
    let starVelocity = null;
    if (first && last && last.ts > first.ts && last.stars >= first.stars) {
      const days = (last.ts - first.ts) / 864e5;
      if (days >= 0.5) starVelocity = (last.stars - first.stars) / days;
    }
    const vScore = velocityScore(starVelocity);
    const weights = vScore == null ? { a: 0.4, r: 0.3, v: 0 } : { a: 0.4, r: 0.3, v: 0.3 };
    const denom = weights.a + weights.r + weights.v;
    const score = (weights.a * appearRatio + weights.r * rankScore(avgRank) + weights.v * (vScore ?? 0)) / denom;
    out.set(key, {
      windowDays,
      samples: win.length,
      ready: readyByTime,
      appearRatio: Number(appearRatio.toFixed(3)),
      avgRank: Number(avgRank.toFixed(2)),
      bestRank,
      starVelocity: starVelocity == null ? null : Number(starVelocity.toFixed(1)),
      score: Number(score.toFixed(4))
    });
  }
  return out;
}
function sortByTrend(trends) {
  return [...trends.entries()].filter(([, t]) => t.ready).sort((a, b) => b[1].score - a[1].score).map(([k]) => k);
}

// src/core/feed/service.ts
var ITEM_KEEP_DAYS = 45;
var UP_COOLDOWN_MIN = 10;
var SNAPSHOT_KEEP_DAYS = 400;
var emptySource = (source) => ({
  source,
  ok: false,
  fetchedAt: null,
  refreshing: false,
  lastAttemptAt: null,
  error: null,
  hint: null,
  failCount: 0,
  nextRetryAt: null,
  items: 0,
  trendDays: 0
});
function normalizeSourceArg(input) {
  const raw = input && typeof input === "object" && !Array.isArray(input) ? input.source : input;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const valid = [...new Set(list.filter((s) => s === "github" || s === "bilibili"))];
  return valid.length ? valid : ["github", "bilibili"];
}
var BACKOFF_MIN = [5, 15, 45];
function backoffMs(failCount) {
  const idx = Math.min(Math.max(failCount, 1), BACKOFF_MIN.length) - 1;
  return BACKOFF_MIN[idx] * 6e4;
}
var emptySnapshot = () => ({
  github: { today: [], week: [], month: [], newRepos: [] },
  bilibili: { hot: [], zones: [], ai: [], ups: [] },
  favorites: [],
  hidden: [],
  sources: { github: emptySource("github"), bilibili: emptySource("bilibili") },
  updatedAt: 0,
  refreshing: false
});
var dayOf = (ts) => new Date(ts).toISOString().slice(0, 10);
var FeedService = class {
  constructor(store, deps = {}) {
    this.store = store;
    this.injectedFetch = deps.fetchImpl;
    this.now = deps.now ?? (() => Date.now());
  }
  snapshot = emptySnapshot();
  state = { recorded: {}, sources: {} };
  snapshots = [];
  /** 收藏：key → 条目全文快照 + 收藏时间（持久化到 data/feed/favorites.json） */
  favorites = /* @__PURE__ */ new Map();
  /** 「不看它」：key → 条目全文 + 隐藏时间（持久化到 data/feed/hidden.json），全局不再出现在任何视图里 */
  hidden = /* @__PURE__ */ new Map();
  /** 「关注 UP」的风控冷却截止时间（仅内存：重启就是新的一轮，没必要把封禁状态写盘） */
  upCooldownUntil = 0;
  /** 正在跑的那一轮刷新：promise + 它覆盖的源（后者用于「要不要再补一轮」的判断） */
  inflight = null;
  timer = null;
  disposed = false;
  /** 注入的 fetch（测试用）；不注入时在调用点取全局 fetch —— 别在构造时抓，测试会 stub 不到 */
  injectedFetch;
  now;
  get net() {
    return this.injectedFetch ?? fetch;
  }
  /* ------------------------------ 生命周期 ------------------------------ */
  async init() {
    const now = this.now();
    const raw = await readJson(paths.feedState(), null);
    this.state = { recorded: raw?.recorded ?? {}, sources: raw?.sources ?? {} };
    const rawSnaps = await readJsonl(paths.feedSnapshots());
    this.snapshots = rawSnaps.filter((s) => s && typeof s.ts === "number" && s.source === "github").map((s) => ({ ts: s.ts, source: "github", ranks: s.ranks ?? {}, stars: s.stars ?? {} }));
    const g = await this.readLatest("github");
    const b = await this.readLatest("bilibili");
    if (g) {
      this.snapshot.github = g.github;
      this.snapshot.sources.github = {
        ...emptySource("github"),
        ...this.state.sources.github ?? {},
        ok: this.state.sources.github?.ok ?? true,
        items: countItems(g.github),
        fetchedAt: g.fetchedAt
      };
    } else if (this.state.sources.github) {
      this.snapshot.sources.github = { ...emptySource("github"), ...this.state.sources.github };
    }
    if (b) {
      this.snapshot.bilibili = b.bilibili;
      this.snapshot.sources.bilibili = {
        ...emptySource("bilibili"),
        ...this.state.sources.bilibili ?? {},
        ok: this.state.sources.bilibili?.ok ?? true,
        items: countBili(b.bilibili),
        fetchedAt: b.fetchedAt
      };
    } else if (this.state.sources.bilibili) {
      this.snapshot.sources.bilibili = { ...emptySource("bilibili"), ...this.state.sources.bilibili };
    }
    this.snapshot.updatedAt = Math.max(g?.fetchedAt ?? 0, b?.fetchedAt ?? 0);
    this.favorites = await this.loadFavorites();
    this.hidden = await this.loadHidden();
    this.syncStashView();
    this.applyTrends();
    this.decorateRecorded();
    void this.housekeep(now);
    this.startTimer();
  }
  dispose() {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  /**
   * 从磁盘重读（恢复/导入备份后调）：清掉内存快照再跑一遍 init。
   * init 幂等，且 startTimer 有「已有定时器就不重复起」的护栏。
   */
  async reload() {
    this.snapshot = emptySnapshot();
    this.state = { recorded: {}, sources: {} };
    this.snapshots = [];
    this.inflight = null;
    this.upCooldownUntil = 0;
    await this.init();
  }
  /* ------------------------------ 对外接口 ------------------------------ */
  async get(opts = {}) {
    if (opts.refresh) return this.refresh(opts.source);
    const stale = this.staleSources();
    if (stale.length) void this.refresh(stale).catch(() => void 0);
    return this.snapshot;
  }
  /**
   * 手动/自动刷新：单飞，两个源一起刷（传 source 就只刷一个）。
   * 每个源在**开抓前**就打一条 start 事件、并把 refreshing 标记写进快照 ——
   * 抓一次要好几秒，界面必须能立刻显示「正在抓」，否则用户以为程序坏了。
   */
  /**
   * 刷新。省略 source = 两源都刷（手动「刷新」永远走这条：用户点了就得真去抓，不受退避限制）。
   *
   * 单飞改成「串行 + 覆盖判断」：正在跑的那轮没覆盖你要的源时，等它结束再补一轮，
   * 而不是把请求直接吞掉 —— 只吞的话，「后台恰好只补刷了 B站，用户点刷新」就会看着像没反应。
   */
  async refresh(source) {
    const settings = this.store.snapshot().settings;
    if (!settings.feed.enabled) return this.snapshot;
    const want = normalizeSourceArg(source);
    if (!want.length) return this.snapshot;
    const running = this.inflight;
    if (running) {
      const missing = want.filter((s) => !running.sources.includes(s));
      const done = await running.promise.catch(() => this.snapshot);
      if (!missing.length) return done;
      return this.refresh(missing);
    }
    const promise = this.runRefresh(settings, want);
    this.inflight = { promise, sources: want };
    try {
      return await promise;
    } finally {
      if (this.inflight?.promise === promise) this.inflight = null;
    }
  }
  async runRefresh(settings, started) {
    this.snapshot = { ...this.snapshot, refreshing: true };
    for (const src of started) this.markRefreshing(src, true);
    const tasks = [];
    if (started.includes("github")) tasks.push(this.refreshGithub(settings));
    if (started.includes("bilibili")) tasks.push(this.refreshBilibili(settings));
    await Promise.allSettled(tasks);
    for (const src of started) if (this.snapshot.sources[src].refreshing) this.markRefreshing(src, false);
    this.snapshot = { ...this.snapshot, refreshing: false, updatedAt: this.now() };
    await this.saveState();
    return this.snapshot;
  }
  /** 自动刷新该动哪些源：过期、没在刷、且不在失败退避里 */
  staleSources() {
    const cfg = this.store.snapshot().settings.feed;
    if (!cfg.enabled || !cfg.autoRefresh) return [];
    const now = this.now();
    const out = [];
    const consider = (src, ttlMin) => {
      const st = this.snapshot.sources[src];
      if (st.refreshing) return;
      if (st.nextRetryAt && now < st.nextRetryAt) return;
      if (st.fetchedAt == null || now - st.fetchedAt > ttlMin * 6e4) out.push(src);
    };
    consider("github", cfg.githubTtlMin);
    consider("bilibili", cfg.biliTtlMin);
    return out;
  }
  /** 改某源的状态位并广播一条进度事件（UI 收到就局部刷新） */
  markRefreshing(source, refreshing) {
    const cur = this.snapshot.sources[source] ?? emptySource(source);
    this.snapshot = {
      ...this.snapshot,
      sources: {
        ...this.snapshot.sources,
        [source]: { ...cur, refreshing, lastAttemptAt: refreshing ? this.now() : cur.lastAttemptAt }
      }
    };
    this.store.bus.publish({
      type: "feed",
      source,
      phase: refreshing ? "start" : "done",
      fetchedAt: this.now(),
      ok: cur.ok
    });
  }
  /** 「以此内容记录想法」：找不到条目就报错，已记录过保持幂等（若已掉出热榜但在收藏夹里也认） */
  item(key) {
    const all = [
      ...this.snapshot.github.today,
      ...this.snapshot.github.week,
      ...this.snapshot.github.month,
      ...this.snapshot.github.newRepos,
      ...this.snapshot.bilibili.hot,
      ...this.snapshot.bilibili.ai,
      ...this.snapshot.bilibili.zones.flatMap((z) => z.items),
      ...(this.snapshot.bilibili.ups ?? []).flatMap((u) => u.items)
    ];
    return all.find((i) => i.key === key) ?? this.favorites.get(key)?.item;
  }
  async markRecorded(key, ideaId) {
    this.state.recorded[key] = ideaId;
    this.decorateRecorded();
    this.syncStashView();
    await this.saveState();
  }
  /* ------------------------------ 收藏 ------------------------------ */
  /**
   * 收藏一条（或更新已收藏条目的备注 note）：存**全文快照**（不是只存 key）。
   * 热榜每轮都会换，只存 key 的话，「以后还找得到」这个承诺就不成立。
   * 条目不在当前快照里时给出人话（比如想收藏一条已经被刷掉的历史条目）。
   */
  async star(key, note) {
    const existing = this.favorites.get(key);
    const item = this.item(key) ?? existing?.item;
    if (!item) {
      throw new Error("\u8FD9\u6761\u5DF2\u7ECF\u4E0D\u5728\u5F53\u524D\u70ED\u699C\u91CC\u4E86\uFF08\u53EF\u80FD\u88AB\u65B0\u4E00\u8F6E\u5237\u65B0\u66FF\u6362\uFF09\u2014\u2014\u5148\u7528\u300C\u8BB0\u5F55\u60F3\u6CD5\u300D\u628A\u5185\u5BB9\u7559\u4E0B\u6765\uFF0C\u6216\u518D\u5237\u65B0\u4E00\u6B21\u770B\u770B");
    }
    const nextNote = note !== void 0 ? note.trim().slice(0, 500) || void 0 : existing?.note;
    if (!existing || note !== void 0) {
      this.favorites.set(key, {
        item: { ...item, starred: true },
        savedAt: existing?.savedAt ?? this.now(),
        ...nextNote ? { note: nextNote } : {}
      });
      await this.saveFavorites();
    }
    this.decorateRecorded();
    this.syncStashView();
    return this.snapshot;
  }
  /** 取消收藏：不在收藏里也不报错（幂等，界面可能连点） */
  async unstar(key) {
    if (this.favorites.delete(key)) await this.saveFavorites();
    this.decorateRecorded();
    this.syncStashView();
    return this.snapshot;
  }
  /* ------------------------------ 不看它（隐藏） ------------------------------ */
  /**
   * 「不看它」：这条从**所有**视图里拿掉（GitHub/B站热榜、关注 UP、收藏）。
   * 存全文 + 时间，落 data/feed/hidden.json，不设期限；恢复在设置页（或 feed.unhide）。
   * 落在收藏里的条目也允许隐藏 —— 所以查找顺序是「当前快照 → 收藏」，
   * 刚收藏完又掉出热榜的条目照样藏得掉。
   */
  async hide(key) {
    const item = this.item(key) ?? this.favorites.get(key)?.item;
    if (!item && !this.hidden.has(key)) {
      throw new Error("\u8FD9\u6761\u5DF2\u7ECF\u4E0D\u5728\u5F53\u524D\u70ED\u699C\u91CC\u4E86\uFF08\u53EF\u80FD\u88AB\u65B0\u4E00\u8F6E\u5237\u65B0\u66FF\u6362\uFF09\u2014\u2014\u5237\u65B0\u540E\u518D\u8BD5\uFF0C\u6216\u5148\u7528\u300C\u8BB0\u5F55\u60F3\u6CD5\u300D\u628A\u5185\u5BB9\u7559\u4E0B\u6765");
    }
    if (item && !this.hidden.has(key)) {
      this.hidden.set(key, { item: { ...item }, hiddenAt: this.now() });
      await this.saveHidden();
    }
    this.decorateRecorded();
    this.syncStashView();
    return this.snapshot;
  }
  /**
   * 恢复：从隐藏列表里移除。**顺便从磁盘重读一次热榜**——
   * 隐藏时条目已经被剔出内存快照了，不重读的话「恢复」了却看不见任何东西（要等下次刷新），
   * 看起来就像按钮没生效。磁盘上一直存着完整数据，重读是免费的。
   */
  async unhide(key) {
    const changed = this.hidden.delete(key);
    if (changed) {
      await this.saveHidden();
      const g = await this.readLatest("github");
      const b = await this.readLatest("bilibili");
      if (g) this.snapshot.github = g.github;
      if (b) this.snapshot.bilibili = b.bilibili;
      this.applyTrends();
    }
    this.decorateRecorded();
    this.syncStashView();
    return this.snapshot;
  }
  /** 已隐藏列表：按隐藏时间倒序（最近藏的在前） */
  listHidden() {
    return [...this.hidden.values()].sort((a, b) => b.hiddenAt - a.hiddenAt);
  }
  async loadHidden() {
    const raw = await readJson(paths.feedHidden(), null);
    const out = /* @__PURE__ */ new Map();
    if (!Array.isArray(raw)) return out;
    for (const entry of raw) {
      const e = entry;
      const item = e?.item;
      if (!item?.key) continue;
      out.set(item.key, { item, hiddenAt: Number(e?.hiddenAt) || 0 });
    }
    return out;
  }
  async saveHidden() {
    await writeJsonAtomic(paths.feedHidden(), this.listHidden());
  }
  /** 收藏 / 已隐藏两块「仓库」一起同步进快照（收藏视图里也要滤掉已隐藏的，并同步注入 ideaId） */
  syncStashView() {
    this.snapshot = {
      ...this.snapshot,
      favorites: this.listFavorites().filter((f) => !this.hidden.has(f.item.key)).map((f) => {
        const ideaId = this.state.recorded[f.item.key];
        const { ideaId: _staleIdea, ...restItem } = f.item;
        void _staleIdea;
        return {
          ...f,
          item: { ...restItem, starred: true, ...ideaId ? { ideaId } : {} }
        };
      }),
      hidden: this.listHidden()
    };
  }
  /** 收藏列表：按收藏时间倒序（最近收藏的在最前） */
  listFavorites() {
    return [...this.favorites.values()].sort((a, b) => b.savedAt - a.savedAt);
  }
  async loadFavorites() {
    const raw = await readJson(paths.feedFavorites(), null);
    const out = /* @__PURE__ */ new Map();
    if (!Array.isArray(raw)) return out;
    for (const entry of raw) {
      const e = entry;
      const item = e?.item;
      if (!item?.key) continue;
      const note = typeof e?.note === "string" && e.note.trim() ? e.note.trim().slice(0, 500) : void 0;
      out.set(item.key, {
        item: { ...item, starred: true },
        savedAt: Number(e?.savedAt) || 0,
        ...note ? { note } : {}
      });
    }
    return out;
  }
  async saveFavorites() {
    await writeJsonAtomic(paths.feedFavorites(), this.listFavorites());
  }
  /**
   * 设置页「连接测试」：只做最小只读请求，把原始错误带回去。
   * 传 source 就只测那一源 —— 设置页逐源调用，这样每一源的结果一到就能先显示，
   * 不用等另一个源（B站超时最长）拖到最后才一次性出结果。
   * 测试专用超时 8 秒（比常规抓取短）：测试的用途是快速给出「通 / 不通」，不该让人干等 30 秒。
   */
  async testSources(only) {
    const settings = this.store.snapshot().settings;
    const out = [];
    if (!only || only === "github") {
      try {
        const rows = await fetchTrending("daily", this.net, 8e3);
        out.push({ source: "github", ok: true, detail: `trending \u9875\u9762\u53EF\u7528\uFF0C\u89E3\u6790\u5230 ${rows.length} \u6761\uFF08\u5F53\u65E5\u699C\uFF09` });
      } catch (err) {
        out.push({ source: "github", ok: false, detail: err.message });
      }
      if (settings.feed.githubToken) {
        try {
          const rows = await fetchNewRepos(settings.feed.githubToken, 7, this.net, 8e3);
          out.push({ source: "github", ok: true, detail: `Search API \u53EF\u7528\uFF08\u6700\u8FD1 7 \u5929\u65B0\u9879\u76EE ${rows.length} \u6761\uFF09` });
        } catch (err) {
          out.push({ source: "github", ok: false, detail: `Search API\uFF1A${err.message}` });
        }
      }
    }
    if (!only || only === "bilibili") {
      if (settings.feed.biliCookie) {
        try {
          const who = await probeBiliLogin(settings.feed.biliCookie, this.net, 8e3);
          out.push(
            who.isLogin ? { source: "bilibili", ok: true, detail: `\u767B\u5F55\u6001\u6B63\u5E38\uFF1A${who.uname || "\uFF08\u672A\u8FD4\u56DE\u7528\u6237\u540D\uFF09"}\uFF08mid ${who.mid}\uFF09` } : {
              source: "bilibili",
              ok: false,
              detail: `Cookie \u6CA1\u767B\u5F55\u4E0A\uFF08nav \u56DE code=${who.code}\uFF09\uFF1ASESSDATA \u53EF\u80FD\u5DF2\u8FC7\u671F\u6216\u88AB\u622A\u65AD \u2014\u2014 \u91CD\u65B0\u767B\u5F55 B\u7AD9 \u540E\u590D\u5236\u4E00\u6B21\u300C\u6574\u6761 Cookie\u300D\uFF08\u542B buvid3\uFF09\u518D\u8BD5`
            }
          );
        } catch (err) {
          out.push({ source: "bilibili", ok: false, detail: `\u767B\u5F55\u6001\u68C0\u67E5\u5931\u8D25\uFF1A${err.message}` });
        }
      } else {
        out.push({ source: "bilibili", ok: true, detail: "\u672A\u586B Cookie\uFF1A\u533F\u540D\u8BF7\u6C42\u66F4\u5BB9\u6613\u88AB\u98CE\u63A7\uFF08\u9047\u5230 -352 \u5C31\u628A\u6574\u6761 Cookie \u586B\u4E0A\uFF09" });
      }
      try {
        const videos = await fetchPopular(this.net, settings.feed.biliCookie, 1, 8e3);
        out.push({ source: "bilibili", ok: true, detail: `\u7EFC\u5408\u70ED\u95E8\u53EF\u7528\uFF08\u6837\u4F8B\uFF1A${videos[0]?.title ?? "\u65E0\u6807\u9898"}\uFF09` });
      } catch (err) {
        out.push({ source: "bilibili", ok: false, detail: err.message });
      }
      const mids = settings.feed.upMids ?? [];
      const probe = mids.slice(0, 5);
      let stopped = false;
      for (const mid of probe) {
        const known = this.snapshot.bilibili.ups?.find((u) => u.mid === mid)?.name || mid;
        if (stopped) {
          out.push({ source: "bilibili", ok: false, detail: `\u5173\u6CE8 UP\u300C${known}\u300D\uFF1A\u672C\u8F6E\u8DF3\u8FC7 \u2014\u2014 \u524D\u9762\u521A\u88AB\u98CE\u63A7\uFF0C\u7EE7\u7EED\u6D4B\u53EA\u4F1A\u66F4\u7CDF\uFF08\u7B49\u51E0\u5206\u949F\u518D\u70B9\u8FDE\u63A5\u6D4B\u8BD5\uFF09` });
          continue;
        }
        try {
          const up = await fetchUpVideos(mid, settings.feed.biliCookie, this.net, 1, 8e3);
          out.push({ source: "bilibili", ok: true, detail: `\u5173\u6CE8 UP\u300C${up.name}\u300D\uFF08mid ${mid}\uFF09\u53EF\u7528\uFF08\u8D70 ${up.via === "wbi" ? "WBI \u7B7E\u540D" : "\u65E0\u7B7E\u540D"}\uFF1B\u6700\u65B0\uFF1A${up.videos[0]?.title ?? "\u2014"}\uFF09` });
        } catch (err) {
          const msg = err.message;
          out.push({ source: "bilibili", ok: false, detail: `\u5173\u6CE8 UP\u300C${known}\u300D\uFF1A${msg}` });
          if (isRiskControlError(msg)) stopped = true;
        }
      }
      if (mids.length > probe.length) {
        out.push({ source: "bilibili", ok: true, detail: `\uFF08\u5171 ${mids.length} \u4E2A\u5173\u6CE8 UP\uFF0C\u672C\u6B21\u53EA\u6D4B\u524D ${probe.length} \u4E2A \u2014\u2014 \u514D\u5F97\u300C\u6D4B\u4E00\u6B21\u8FDE\u63A5\u300D\u5C31\u628A\u98CE\u63A7\u62DB\u6765\uFF09` });
      }
    }
    return out;
  }
  /* ------------------------------ GitHub ------------------------------ */
  async refreshGithub(settings) {
    const now = this.now();
    const fetchedAt = now;
    const kw = settings.feed.keywords;
    try {
      const [daily, weekly, monthly] = await Promise.all([
        fetchTrending("daily", this.net),
        fetchTrending("weekly", this.net).catch(() => []),
        fetchTrending("monthly", this.net).catch(() => [])
      ]);
      const todayItems = buildGithubItems(daily, { keywords: kw, list: "daily", fetchedAt });
      const github = { today: todayItems, week: [], month: [], newRepos: [] };
      const snap = snapshotFromGithub(todayItems, fetchedAt);
      await appendJsonl(paths.feedSnapshots(), [snap]);
      this.snapshots.push(snap);
      const byKey = /* @__PURE__ */ new Map();
      for (const it of todayItems) byKey.set(it.key, it);
      const weekRows = buildGithubItems(weekly, { keywords: kw, list: "weekly", fetchedAt });
      const monthRows = buildGithubItems(monthly, { keywords: kw, list: "monthly", fetchedAt });
      for (const it of [...weekRows, ...monthRows]) if (!byKey.has(it.key)) byKey.set(it.key, it);
      const trend = computeTrends(this.snapshots, 7, now);
      const trend30 = computeTrends(this.snapshots, 30, now);
      for (const it of byKey.values()) {
        const t7 = trend.get(it.key);
        if (t7) it.trend = t7;
      }
      const topN = settings.feed.trendTopN;
      const pickTrend = (map, fallback, shown2) => {
        const keys = sortByTrend(map).slice(0, topN * 2);
        if (keys.length >= Math.min(3, topN)) {
          const byTrendKey = /* @__PURE__ */ new Map();
          for (const it of [...fallback, ...byKey.values()]) {
            const cur = byTrendKey.get(it.key);
            if (!cur || (it.rank ?? 999) < (cur.rank ?? 999)) byTrendKey.set(it.key, it);
          }
          const picked = keys.map((k) => byTrendKey.get(k)).filter((x) => Boolean(x) && !shown2.has(x.key)).slice(0, topN);
          if (picked.length) return { items: picked, trendReady: true };
        }
        return { items: fallback.slice(0, topN), trendReady: false };
      };
      const shown = new Set(todayItems.map((i) => i.key));
      const weekPick = pickTrend(trend, weekRows, shown);
      github.week = weekPick.items;
      for (const it of github.week) shown.add(it.key);
      github.month = pickTrend(trend30, monthRows, shown).items;
      let hint = null;
      if (settings.feed.githubNewRepos) {
        try {
          const fresh = await fetchNewRepos(settings.feed.githubToken, 7, this.net);
          const seen = /* @__PURE__ */ new Set([...byKey.keys()]);
          github.newRepos = buildGithubItems(
            fresh.map((r, i) => ({
              repo: r.repo,
              description: `${r.description} ${r.topics.join(" ")}`.trim(),
              language: r.language,
              stars: r.stars,
              forks: r.forks,
              gained: null,
              gainedLabel: null,
              rank: i + 1
            })),
            { keywords: kw, list: "new", fetchedAt }
          ).filter((it) => !seen.has(it.key));
        } catch (err) {
          hint = err.message;
        }
      }
      const file = { source: "github", fetchedAt, date: dayOf(fetchedAt), github };
      await writeJsonAtomic(this.itemsFile("github", dayOf(fetchedAt)), file);
      this.snapshot.github = github;
      this.applyTrends();
      this.patchSource("github", {
        ok: true,
        fetchedAt,
        refreshing: false,
        error: null,
        hint,
        items: countItems(github),
        trendDays: this.trendDayCount(),
        // 成功即清空退避，下次照常按 TTL 走
        failCount: 0,
        nextRetryAt: null
      });
    } catch (err) {
      const message = err.message;
      const fails = (this.snapshot.sources.github.failCount ?? 0) + 1;
      this.patchSource("github", {
        ok: false,
        refreshing: false,
        error: message,
        failCount: fails,
        nextRetryAt: this.now() + backoffMs(fails)
      });
    }
    this.emitDone("github");
  }
  /* ------------------------------ B站 ------------------------------ */
  async refreshBilibili(settings) {
    const now = this.now();
    const fetchedAt = now;
    const cfg = settings.feed;
    const zones = [];
    const errors = [];
    let hot = [];
    const collected = [];
    if (cfg.biliIncludePopular) {
      try {
        const popular = await fetchPopular(this.net, cfg.biliCookie, 50);
        collected.push(...popular);
        hot = buildBiliItems(popular, "hot", fetchedAt, cfg.perZoneLimit);
      } catch (err) {
        errors.push(`\u7EFC\u5408\u70ED\u95E8\uFF1A${err.message}`);
      }
    }
    for (const tid of cfg.biliZones) {
      const name = BILI_ZONE_NAME.get(tid) ?? `\u5206\u533A${tid}`;
      try {
        const videos = await fetchZoneRanking(this.net, tid, cfg.biliCookie);
        collected.push(...videos);
        zones.push({ tid, name, items: buildBiliItems(videos, `zone:${tid}`, fetchedAt, cfg.perZoneLimit) });
      } catch (err) {
        errors.push(`${name}\uFF1A${err.message}`);
      }
    }
    let ai = [];
    if (cfg.biliAiVirtual) {
      const hits = dedupeVideos(collected).filter((v) => biliAiHits(v, BILI_AI_KEYWORDS).length > 0);
      ai = buildBiliItems(hits, "ai", fetchedAt, cfg.perZoneLimit, ["AI \u76F8\u5173"]);
    }
    const ups = [];
    const coolingFor = this.upCooldownUntil - this.now();
    let skipNote = coolingFor > 0 ? `\u8DF3\u8FC7\u672C\u8F6E\uFF1A\u521A\u88AB B\u7AD9 \u98CE\u63A7/\u9650\u9891\uFF0C\u7EA6 ${Math.max(1, Math.round(coolingFor / 6e4))} \u5206\u949F\u540E\u518D\u5237\u65B0` : null;
    for (const mid of cfg.upMids ?? []) {
      const prev = this.snapshot.bilibili.ups?.find((u) => u.mid === mid);
      if (skipNote) {
        ups.push({ mid, name: prev?.name ?? "", items: prev?.items ?? [], error: skipNote, fetchedAt: prev?.fetchedAt ?? null });
        continue;
      }
      try {
        const up = await fetchUpVideos(mid, cfg.biliCookie, this.net, 10);
        ups.push({ mid, name: up.name, items: buildUpItems(up.videos, mid, up.name, fetchedAt, 10), error: null, fetchedAt });
      } catch (err) {
        const msg = err.message;
        errors.push(`\u5173\u6CE8 UP ${prev?.name || mid}\uFF1A${msg}`);
        ups.push({ mid, name: prev?.name ?? "", items: prev?.items ?? [], error: msg, fetchedAt: prev?.fetchedAt ?? null });
        if (isRiskControlError(msg)) {
          this.upCooldownUntil = this.now() + UP_COOLDOWN_MIN * 6e4;
          skipNote = `\u8DF3\u8FC7\u672C\u8F6E\uFF1A\u521A\u88AB B\u7AD9 \u98CE\u63A7/\u9650\u9891\uFF0C\u5269\u4E0B\u7684\u8BA2\u9605\u7B49 ${UP_COOLDOWN_MIN} \u5206\u949F\u540E\u518D\u5237\u65B0`;
        }
      }
    }
    const bilibili = { hot, zones, ai, ups };
    const hasData = hot.length + zones.reduce((a, z) => a + z.items.length, 0) + ai.length + ups.reduce((a, u) => a + u.items.length, 0) > 0;
    if (hasData) {
      const file = { source: "bilibili", fetchedAt, date: dayOf(fetchedAt), bilibili };
      await writeJsonAtomic(this.itemsFile("bilibili", dayOf(fetchedAt)), file);
      this.snapshot.bilibili = bilibili;
      this.decorateRecorded();
    } else if (ups.length) {
      this.snapshot.bilibili = { ...this.snapshot.bilibili, ups };
      this.decorateRecorded();
    }
    const biliFails = (this.snapshot.sources.bilibili.failCount ?? 0) + 1;
    this.patchSource("bilibili", {
      ok: hasData,
      // 失败时不覆盖上次成功时间（界面据此显示「上次成功」），成功才推进
      ...hasData ? { fetchedAt } : {},
      refreshing: false,
      error: hasData ? null : errors.join("\uFF1B") || "B\u7AD9\u6CA1\u6709\u8FD4\u56DE\u4EFB\u4F55\u6761\u76EE",
      hint: errors.length && hasData ? errors.join("\uFF1B") : null,
      items: countBili(bilibili),
      trendDays: 0,
      ...hasData ? { failCount: 0, nextRetryAt: null } : { failCount: biliFails, nextRetryAt: this.now() + backoffMs(biliFails) }
    });
    this.emitDone("bilibili");
  }
  /* ------------------------------ 内部 ------------------------------ */
  itemsFile(source, date) {
    return paths.feedItemsFile(source, date);
  }
  /** 近 7 天里有几天留下过快照（界面显示「趋势分积累中（第 N/7 天）」） */
  trendDayCount() {
    const from = this.now() - 7 * 864e5;
    return new Set(this.snapshots.filter((s) => s.ts >= from).map((s) => dayOf(s.ts))).size;
  }
  async readLatest(source) {
    const dir = paths.feedItemsDir();
    let names;
    try {
      names = await fsp3.readdir(dir);
    } catch {
      return null;
    }
    const mine = names.filter((n) => n.startsWith(`${source}-`) && n.endsWith(".json")).sort().reverse();
    for (const n of mine.slice(0, 3)) {
      const val = await readJson(path12.join(dir, n), null);
      if (val && typeof val.fetchedAt === "number") return val;
    }
    return null;
  }
  applyTrends() {
    const now = this.now();
    const t7 = computeTrends(this.snapshots, 7, now);
    const t30 = computeTrends(this.snapshots, 30, now);
    const decorate = (list) => list.map((it) => {
      const trend = t30.get(it.key) ?? t7.get(it.key);
      return trend ? { ...it, trend } : it;
    });
    this.snapshot.github = {
      ...this.snapshot.github,
      today: decorate(this.snapshot.github.today),
      week: decorate(this.snapshot.github.week),
      month: decorate(this.snapshot.github.month),
      newRepos: decorate(this.snapshot.github.newRepos)
    };
    this.snapshot.sources.github = { ...this.snapshot.sources.github, trendDays: this.trendDayCount() };
  }
  decorateRecorded() {
    const mark = (list) => list.filter((it) => !this.hidden.has(it.key)).map((it) => {
      const ideaId = this.state.recorded[it.key];
      const starred = this.favorites.has(it.key);
      const { ideaId: _staleIdea, starred: _staleStar, ...rest } = it;
      void _staleIdea;
      void _staleStar;
      return { ...rest, ...ideaId ? { ideaId } : {}, ...starred ? { starred: true } : {} };
    });
    this.snapshot.github = {
      today: mark(this.snapshot.github.today),
      week: mark(this.snapshot.github.week),
      month: mark(this.snapshot.github.month),
      newRepos: mark(this.snapshot.github.newRepos)
    };
    this.snapshot.bilibili = {
      hot: mark(this.snapshot.bilibili.hot),
      ai: mark(this.snapshot.bilibili.ai),
      zones: this.snapshot.bilibili.zones.map((z) => ({ ...z, items: mark(z.items) })),
      ups: (this.snapshot.bilibili.ups ?? []).map((u) => ({ ...u, items: mark(u.items) }))
    };
  }
  /** 改某源的状态（不广播；广播时机由调用方决定：done 在整源收尾时发一次） */
  patchSource(source, patch) {
    this.snapshot = {
      ...this.snapshot,
      sources: { ...this.snapshot.sources, [source]: { ...this.snapshot.sources[source], source, ...patch } }
    };
  }
  emitDone(source) {
    const st = this.snapshot.sources[source];
    this.store.bus.publish({ type: "feed", source, phase: "done", fetchedAt: this.now(), ok: st.ok });
  }
  async saveState() {
    this.state.sources = {
      github: pickState(this.snapshot.sources.github),
      bilibili: pickState(this.snapshot.sources.bilibili)
    };
    await writeJsonAtomic(paths.feedState(), this.state);
  }
  startTimer() {
    if (this.timer || this.disposed) return;
    this.timer = setInterval(() => {
      const stale = this.staleSources();
      if (stale.length) void this.refresh(stale).catch(() => void 0);
    }, 10 * 6e4);
    this.timer.unref?.();
  }
  /** 清理陈旧文件：items 留 45 天、snapshots 留 400 天（自动，不打扰用户） */
  async housekeep(now) {
    try {
      const dir = paths.feedItemsDir();
      const names = await fsp3.readdir(dir);
      const keepFrom = now - ITEM_KEEP_DAYS * 864e5;
      for (const n of names) {
        const m = n.match(/^(github|bilibili)-(\d{4}-\d{2}-\d{2})\.json$/);
        if (!m) continue;
        const ts = Date.parse(`${m[2]}T00:00:00Z`);
        if (Number.isFinite(ts) && ts < keepFrom) await fsp3.rm(path12.join(dir, n), { force: true });
      }
      const snaps = await readJsonl(paths.feedSnapshots());
      const keep = snaps.filter((s) => s.ts >= now - SNAPSHOT_KEEP_DAYS * 864e5);
      if (keep.length !== snaps.length) {
        await writeJsonAtomic(paths.feedSnapshots(), keep);
      }
      this.snapshots = keep;
    } catch {
    }
  }
};
function pickState(s) {
  return { fetchedAt: s.fetchedAt, ok: s.ok, error: s.error, hint: s.hint, trendDays: s.trendDays, failCount: s.failCount, nextRetryAt: s.nextRetryAt };
}
function countItems(g) {
  return g.today.length + g.week.length + g.month.length + g.newRepos.length;
}
function countBili(b) {
  return b.hot.length + b.ai.length + b.zones.reduce((a, z) => a + z.items.length, 0) + (b.ups ?? []).reduce((a, u) => a + u.items.length, 0);
}

// src/core/backup/service.ts
import fsp8 from "node:fs/promises";
import path15 from "node:path";

// src/core/backup/cas.ts
import { createHash } from "node:crypto";
import fs11 from "node:fs";
import fsp4 from "node:fs/promises";
import path13 from "node:path";
import { createReadStream, createWriteStream } from "node:fs";
import { createGunzip, createGzip } from "node:zlib";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
var CasStore = class {
  constructor(dir) {
    this.dir = dir;
  }
  objectPath(sha) {
    return path13.join(this.dir, sha.slice(0, 2), `${sha}.gz`);
  }
  async has(sha) {
    try {
      await fsp4.access(this.objectPath(sha));
      return true;
    } catch {
      return false;
    }
  }
  /** 把文件流式压缩进对象库；返回 sha 与对象大小。已存在同内容对象时直接复用 */
  async putFile(file) {
    const tmpDir = path13.join(this.dir, "tmp");
    await fsp4.mkdir(tmpDir, { recursive: true });
    const tmp = path13.join(tmpDir, `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.gz`);
    const hash = createHash("sha256");
    let raw = 0;
    let gz = 0;
    const meter = new Transform({
      transform(chunk, _enc, cb) {
        hash.update(chunk);
        raw += chunk.length;
        cb(null, chunk);
      }
    });
    try {
      await pipeline(createReadStream(file), meter, createGzip({ level: 6 }), createWriteStream(tmp));
      gz = (await fsp4.stat(tmp)).size;
    } catch (err) {
      await fsp4.rm(tmp, { force: true });
      throw new Error(`\u8BFB\u53D6\u6587\u4EF6\u5931\u8D25\uFF08${file}\uFF09\uFF1A${err.message}`);
    }
    const sha = hash.digest("hex");
    const dest = this.objectPath(sha);
    await fsp4.mkdir(path13.dirname(dest), { recursive: true });
    try {
      await fsp4.access(dest);
      await fsp4.rm(tmp, { force: true });
      return { sha, gz, raw, existed: true };
    } catch {
      await fsp4.rename(tmp, dest);
      return { sha, gz, raw, existed: false };
    }
  }
  /** 把内容流式解压到目标文件（先写 tmp 再 rename，保证不留半个文件） */
  async extract(sha, dest) {
    const src = this.objectPath(sha);
    await fsp4.mkdir(path13.dirname(dest), { recursive: true });
    const tmp = `${dest}.${process.pid}.${Date.now()}.restore.tmp`;
    let size = 0;
    const meter = new Transform({
      transform(chunk, _enc, cb) {
        size += chunk.length;
        cb(null, chunk);
      }
    });
    try {
      await pipeline(createReadStream(src), createGunzip(), meter, createWriteStream(tmp));
      await fsp4.rename(tmp, dest);
      return size;
    } catch (err) {
      await fsp4.rm(tmp, { force: true });
      throw new Error(`\u5BF9\u8C61 ${sha.slice(0, 12)}\u2026 \u89E3\u538B\u5931\u8D25\uFF1A${err.message}`);
    }
  }
  /** 校验对象：解压后重算 sha256，与地址一致才算好 */
  async verify(sha) {
    try {
      const hash = createHash("sha256");
      let size = 0;
      const meter = new Transform({
        transform(chunk, _enc, cb) {
          hash.update(chunk);
          size += chunk.length;
          cb(null, chunk);
        }
      });
      await pipeline(createReadStream(this.objectPath(sha)), createGunzip(), meter, async (src) => {
        for await (const _chunk of src) void _chunk;
      });
      return { ok: hash.digest("hex") === sha, size };
    } catch {
      return { ok: false, size: 0 };
    }
  }
  /** 流式计算磁盘上某文件的 sha256（预览差异时用，别整文件读内存） */
  static async hashFile(file) {
    const hash = createHash("sha256");
    await pipeline(createReadStream(file), async (src) => {
      for await (const chunk of src) hash.update(chunk);
    });
    return hash.digest("hex");
  }
  /** 库里全部对象 sha */
  async list() {
    const out = [];
    let prefixes = [];
    try {
      prefixes = await fsp4.readdir(this.dir);
    } catch {
      return out;
    }
    for (const p of prefixes) {
      if (!/^[0-9a-f]{2}$/.test(p)) continue;
      try {
        for (const f of await fsp4.readdir(path13.join(this.dir, p))) {
          if (/^[0-9a-f]{64}\.gz$/.test(f)) out.push(f.slice(0, 64));
        }
      } catch {
      }
    }
    return out;
  }
  async remove(sha) {
    await fsp4.rm(this.objectPath(sha), { force: true });
  }
  async bytes() {
    let total = 0;
    let files = 0;
    for (const sha of await this.list()) {
      files += 1;
      try {
        total += (await fsp4.stat(this.objectPath(sha))).size;
      } catch {
      }
    }
    return { total, files };
  }
  /** 对象文件的 mtime（宽限期回收用） */
  async mtime(sha) {
    try {
      return (await fsp4.stat(this.objectPath(sha))).mtimeMs;
    } catch {
      return 0;
    }
  }
  /** 清理写了一半的临时对象（进程被杀留下的） */
  async sweepTmp() {
    const tmpDir = path13.join(this.dir, "tmp");
    let names = [];
    try {
      names = await fsp4.readdir(tmpDir);
    } catch {
      return;
    }
    for (const n of names) {
      const abs = path13.join(tmpDir, n);
      try {
        const st = await fsp4.stat(abs);
        if (Date.now() - st.mtimeMs > 36e5) await fs11.promises.rm(abs, { force: true });
      } catch {
      }
    }
  }
};

// src/core/backup/scope.ts
import fsp5 from "node:fs/promises";
import path14 from "node:path";
var NEVER = /* @__PURE__ */ new Set(["backups", "worktrees", "logs"]);
function topLevelAllowed(name, opts) {
  if (NEVER.has(name)) return false;
  if (name === "data") return true;
  if (name === "attachments") return opts.mode === "full" && opts.includeAttachments;
  if (name === "events") return opts.mode === "full" && opts.includeEvents;
  return false;
}
var SKIP_FILE = /(^|\/)(\.DS_Store|Thumbs\.db)$|\.tmp$|\.restore\.tmp$/;
async function collectScope(root, opts) {
  const out = [];
  let tops = [];
  try {
    tops = await fsp5.readdir(root);
  } catch {
    return out;
  }
  for (const top of tops.sort()) {
    if (!topLevelAllowed(top, opts)) continue;
    await walk(path14.join(root, top), root, out);
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
async function walk(dir, root, out) {
  let entries = [];
  try {
    entries = await fsp5.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = path14.join(dir, e.name);
    const rel = path14.relative(root, abs).split(path14.sep).join("/");
    if (SKIP_FILE.test(rel)) continue;
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      await walk(abs, root, out);
      continue;
    }
    if (!e.isFile()) continue;
    try {
      const st = await fsp5.stat(abs);
      out.push({ path: rel, abs, size: st.size });
    } catch {
    }
  }
}
function safeRelPath(rel) {
  const n = String(rel ?? "").replace(/\\/g, "/");
  if (!n || n.startsWith("/") || /^[a-zA-Z]:/.test(n)) return null;
  const parts = n.split("/");
  if (parts.some((p) => !p || p === "." || p === "..")) return null;
  if (NEVER.has(parts[0])) return null;
  if (parts[0] !== "data" && parts[0] !== "attachments" && parts[0] !== "events") return null;
  return parts.join("/");
}

// src/core/backup/crypto.ts
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { createReadStream as createReadStream2, createWriteStream as createWriteStream2 } from "node:fs";
import fsp6 from "node:fs/promises";
import { pipeline as pipeline2 } from "node:stream/promises";
import { Buffer as Buffer2 } from "node:buffer";
var MAGIC = Buffer2.from("AITMBK01", "utf8");
var SALT_LEN = 16;
var IV_LEN = 12;
var TAG_LEN = 16;
var KEY_LEN = 32;
function deriveKey(passphrase, salt) {
  return scryptSync(passphrase, salt, KEY_LEN, { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 });
}
function isEncryptedPackage(buf) {
  return buf.length >= MAGIC.length + SALT_LEN + IV_LEN && buf.subarray(0, MAGIC.length).equals(MAGIC);
}
async function looksEncrypted(file) {
  const fh = await fsp6.open(file, "r");
  try {
    const head = Buffer2.alloc(MAGIC.length + SALT_LEN + IV_LEN);
    const { bytesRead } = await fh.read(head, 0, head.length, 0);
    return bytesRead >= MAGIC.length && isEncryptedPackage(head);
  } finally {
    await fh.close();
  }
}
async function encryptFile(src, dest, passphrase) {
  if (!passphrase) throw new Error("\u5F00\u4E86\u52A0\u5BC6\u5C31\u5FC5\u987B\u7ED9\u53E3\u4EE4\uFF08\u53E3\u4EE4\u4E0D\u4F1A\u5B58\u8FDB\u8BBE\u7F6E\u91CC\uFF0C\u4E22\u4E86\u5C31\u6253\u4E0D\u5F00\u5907\u4EFD\u5305\uFF0C\u8BF7\u81EA\u5DF1\u8BB0\u7262\uFF09");
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);
  const out = createWriteStream2(dest);
  out.write(Buffer2.concat([MAGIC, salt, iv]));
  await pipeline2(createReadStream2(src), cipher, out, { end: true });
  const tag = cipher.getAuthTag();
  await fsp6.appendFile(dest, tag);
  return (await fsp6.stat(dest)).size;
}
async function decryptFile(src, dest, passphrase) {
  const fh = await fsp6.open(src, "r");
  try {
    const { size } = await fh.stat();
    if (size < MAGIC.length + SALT_LEN + IV_LEN + TAG_LEN) throw new Error("\u8FD9\u4E0D\u662F\u4E00\u4E2A\u5B8C\u6574\u7684\u52A0\u5BC6\u5907\u4EFD\u5305\uFF08\u6587\u4EF6\u592A\u77ED\uFF09");
    const head = Buffer2.alloc(MAGIC.length + SALT_LEN + IV_LEN);
    await fh.read(head, 0, head.length, 0);
    if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("\u8FD9\u4E0D\u662F\u9762\u677F\u5BFC\u51FA\u7684\u52A0\u5BC6\u5907\u4EFD\u5305");
    const salt = head.subarray(MAGIC.length, MAGIC.length + SALT_LEN);
    const iv = head.subarray(MAGIC.length + SALT_LEN);
    const tag = Buffer2.alloc(TAG_LEN);
    await fh.read(tag, 0, TAG_LEN, size - TAG_LEN);
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);
    decipher.setAuthTag(tag);
    try {
      await pipeline2(
        createReadStream2(src, { start: head.length, end: size - TAG_LEN - 1 }),
        decipher,
        createWriteStream2(dest)
      );
    } catch {
      await fsp6.rm(dest, { force: true });
      throw new Error("\u53E3\u4EE4\u4E0D\u5BF9\uFF0C\u6216\u5907\u4EFD\u5305\u88AB\u6539\u574F\u8FC7\uFF08AES-GCM \u6821\u9A8C\u6CA1\u8FC7\uFF09\u3002\u53E3\u4EE4\u5FD8\u4E86\u5C31\u6CA1\u6CD5\u6062\u590D\uFF0C\u53EA\u80FD\u627E\u56DE\u539F\u53E3\u4EE4");
    }
  } finally {
    await fh.close();
  }
  return (await fsp6.stat(dest)).size;
}

// src/core/backup/zip.ts
import fsp7 from "node:fs/promises";
import { createReadStream as createReadStream3, createWriteStream as createWriteStream3 } from "node:fs";
import { createDeflateRaw, inflateRawSync } from "node:zlib";
import { pipeline as pipeline3 } from "node:stream/promises";
import { Transform as Transform2, Writable } from "node:stream";
import { Buffer as Buffer3 } from "node:buffer";
var LOCAL_SIG = 67324752;
var DESCRIPTOR_SIG = 134695760;
var CENTRAL_SIG = 33639248;
var EOCD_SIG = 101010256;
var CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf, seed = 0) {
  let c = (seed ^ 4294967295) >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ c >>> 8;
  return (c ^ 4294967295) >>> 0;
}
function dosDateTime(ts) {
  const d = new Date(ts);
  const time = (d.getHours() & 31) << 11 | (d.getMinutes() & 63) << 5 | d.getSeconds() / 2 & 31;
  const date = (d.getFullYear() - 1980 & 127) << 9 | (d.getMonth() + 1 & 15) << 5 | d.getDate() & 31;
  return { time, date };
}
function assertSafeZipName(name) {
  const n = name.replace(/\\/g, "/");
  if (!n || n.startsWith("/") || /^[a-zA-Z]:/.test(n) || n.split("/").includes("..")) {
    throw new Error(`\u5907\u4EFD\u5305\u91CC\u7684\u8DEF\u5F84\u4E0D\u5408\u6CD5\uFF1A${name}`);
  }
}
async function writeZip(outFile, entries) {
  await fsp7.mkdir(require_dir(outFile), { recursive: true });
  const chunks = [];
  let offset = 0;
  let rawBytes = 0;
  const out = createWriteStream3(outFile);
  const write = (buf) => new Promise((resolve, reject) => {
    if (!out.write(buf)) out.once("drain", () => resolve());
    else resolve();
    out.once("error", reject);
  });
  for (const e of entries) {
    const name = e.name.replace(/\\/g, "/");
    assertSafeZipName(name);
    const stat = await fsp7.stat(e.file);
    if (stat.size >= 4294967295) throw new Error(`\u6587\u4EF6\u592A\u5927\uFF0C\u5355\u4E2A\u6587\u4EF6\u9700\u5C0F\u4E8E 4GB\uFF1A${name}`);
    const nameBuf = Buffer3.from(name, "utf8");
    const { time, date } = dosDateTime(e.mtime ?? stat.mtimeMs);
    const localOffset = offset;
    const header = Buffer3.alloc(30 + nameBuf.length);
    header.writeUInt32LE(LOCAL_SIG, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(8 | 2048, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(0, 14);
    header.writeUInt32LE(0, 18);
    header.writeUInt32LE(0, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);
    nameBuf.copy(header, 30);
    await write(header);
    offset += header.length;
    let crc = 0;
    let raw = 0;
    let comp = 0;
    const meter = new Transform2({
      transform(chunk, _enc, cb) {
        crc = crc32(chunk, crc);
        raw += chunk.length;
        cb(null, chunk);
      }
    });
    const sink = new Writable({
      write(chunk, _enc, cb) {
        comp += chunk.length;
        if (out.write(chunk)) cb();
        else out.once("drain", () => cb());
      }
    });
    await pipeline3(createReadStream3(e.file), meter, createDeflateRaw({ level: 6 }), sink);
    offset += comp;
    const desc = Buffer3.alloc(16);
    desc.writeUInt32LE(DESCRIPTOR_SIG, 0);
    desc.writeUInt32LE(crc >>> 0, 4);
    desc.writeUInt32LE(comp, 8);
    desc.writeUInt32LE(raw, 12);
    await write(desc);
    offset += desc.length;
    if (offset > 4294967295) throw new Error("\u5907\u4EFD\u5305\u8D85\u8FC7 4GB\uFF0C\u8BF7\u6539\u7528\u300C\u5168\u91CF\u5907\u4EFD\u300D\u91CC\u66F4\u5C0F\u7684\u8303\u56F4\uFF08\u53D6\u6D88\u52FE\u9009\u9644\u4EF6/\u4E8B\u4EF6\uFF09");
    const central = Buffer3.alloc(46 + nameBuf.length);
    central.writeUInt32LE(CENTRAL_SIG, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8 | 2048, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(comp, 20);
    central.writeUInt32LE(raw, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(33188 << 16 >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    nameBuf.copy(central, 46);
    chunks.push(central);
    rawBytes += raw;
  }
  const centralBuf = Buffer3.concat(chunks);
  await write(centralBuf);
  const cdOffset = offset;
  offset += centralBuf.length;
  const eocd = Buffer3.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);
  await write(eocd);
  offset += eocd.length;
  await new Promise((resolve, reject) => out.end((err) => err ? reject(err) : resolve()));
  return { bytes: offset, files: entries.length, rawBytes };
}
async function readCentralDir(zipFile) {
  const fh = await fsp7.open(zipFile, "r");
  try {
    const { size } = await fh.stat();
    if (size < 22) throw new Error("\u8FD9\u4E0D\u662F\u4E00\u4E2A\u6709\u6548\u7684 zip\uFF08\u6587\u4EF6\u592A\u5C0F\uFF09");
    const tailLen = Math.min(size, 66e3);
    const tail = Buffer3.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error("\u8FD9\u4E0D\u662F\u4E00\u4E2A\u6709\u6548\u7684 zip\uFF08\u627E\u4E0D\u5230\u7ED3\u5C3E\u8BB0\u5F55\uFF09");
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    const cd = Buffer3.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);
    const out = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (cd.readUInt32LE(p) !== CENTRAL_SIG) throw new Error("\u5907\u4EFD\u5305\u7684\u4E2D\u592E\u76EE\u5F55\u635F\u574F");
      const comp = cd.readUInt32LE(p + 20);
      const uncomp = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const name = cd.toString("utf8", p + 46, p + 46 + nameLen);
      if (!name.endsWith("/")) out.push({ name, size: uncomp, compressedSize: comp, localOffset: cd.readUInt32LE(p + 42) });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  } finally {
    await fh.close();
  }
}
async function extractZip(zipFile, destDir) {
  const entries = await readCentralDir(zipFile);
  const fh = await fsp7.open(zipFile, "r");
  const out = [];
  try {
    for (const e of entries) {
      assertSafeZipName(e.name);
      if (e.compressedSize > 512 * 1024 * 1024) throw new Error(`\u5907\u4EFD\u5305\u91CC\u7684\u5355\u4E2A\u6587\u4EF6\u592A\u5927\uFF08${Math.round(e.compressedSize / 1024 / 1024)}MB\uFF09\uFF1A${e.name}`);
      const local = Buffer3.alloc(30);
      await fh.read(local, 0, 30, e.localOffset);
      if (local.readUInt32LE(0) !== LOCAL_SIG) throw new Error(`\u5907\u4EFD\u5305\u6761\u76EE\u635F\u574F\uFF1A${e.name}`);
      const dataOffset = e.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      const comp = Buffer3.alloc(e.compressedSize);
      if (comp.length) await fh.read(comp, 0, comp.length, dataOffset);
      const raw = inflateRawSync(comp);
      if (raw.length !== e.size) throw new Error(`\u89E3\u538B\u540E\u5927\u5C0F\u4E0D\u7B26\uFF1A${e.name}`);
      const dest = joinSafe(destDir, e.name);
      await fsp7.mkdir(require_dir(dest), { recursive: true });
      await fsp7.writeFile(dest, raw);
      out.push({ name: e.name, size: raw.length, path: dest });
    }
    return out;
  } finally {
    await fh.close();
  }
}
function require_dir(file) {
  const i = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
  return i <= 0 ? "." : file.slice(0, i);
}
function joinSafe(root, name) {
  const parts = name.split("/").filter((p) => p && p !== ".");
  return [root, ...parts].join("/");
}

// src/core/backup/service.ts
var SNAPSHOT_KIND = "aitm-snapshot";
var PACKAGE_KIND = "aitm-backup-package";
var OBJECT_GRACE_MS = 7 * 864e5;
var emptyIndex = () => ({
  version: 1,
  snapshots: [],
  objectsBytes: 0,
  objects: 0,
  manifestsBytes: 0,
  lastVerify: null,
  auto: { enabled: false, lastAt: null, lastId: null },
  lastPrune: null
});
var stamp = (ts) => {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
var BackupService = class {
  constructor(store, deps = {}) {
    this.store = store;
    this.root = deps.root ?? paths.root();
    this.cas = new CasStore(paths.backupObjects());
    this.now = deps.now ?? (() => Date.now());
    this.appVersion = deps.appVersion ?? null;
    this.debounceMs = deps.autoDebounceMs ?? 9e4;
  }
  root;
  cas;
  now;
  appVersion;
  debounceMs;
  index = emptyIndex();
  inflight = null;
  autoTimer = null;
  lastAutoAt = 0;
  unsubscribe = null;
  disposed = false;
  /* ------------------------------ 生命周期 ------------------------------ */
  async init() {
    await Promise.all([
      fsp8.mkdir(paths.backupObjects(), { recursive: true }),
      fsp8.mkdir(paths.backupSnapshots(), { recursive: true }),
      fsp8.mkdir(paths.backupExports(), { recursive: true }),
      fsp8.mkdir(paths.backupTmp(), { recursive: true })
    ]);
    const raw = await readJson(paths.backupIndex(), emptyIndex());
    this.index = {
      ...emptyIndex(),
      ...raw,
      snapshots: Array.isArray(raw?.snapshots) ? raw.snapshots.filter((s) => s && typeof s.id === "string") : []
    };
    const lastAuto = this.index.snapshots.find((s) => s.reason === "auto");
    this.lastAutoAt = lastAuto?.createdAt ?? 0;
    await this.cas.sweepTmp();
    this.unsubscribe = this.store.bus.subscribe((ev) => {
      if (ev.type === "entity") this.scheduleAuto();
    });
  }
  dispose() {
    this.disposed = true;
    if (this.autoTimer) clearTimeout(this.autoTimer);
    this.autoTimer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
  /* ------------------------------ 对外接口 ------------------------------ */
  settings() {
    return this.store.snapshot().settings.backup;
  }
  scopeOpts(mode) {
    const s = this.settings();
    return { mode, includeAttachments: s.includeAttachments, includeEvents: s.includeEvents };
  }
  /** 快照列表 + 对象库实况（每次现算，避免索引里的统计过期） */
  async list() {
    const { total, files } = await this.cas.bytes();
    const settings = this.settings();
    let manifestsBytes = 0;
    for (const s of this.index.snapshots) {
      try {
        manifestsBytes += (await fsp8.stat(paths.backupManifest(s.id))).size;
      } catch {
      }
    }
    const latest = this.index.snapshots[0] ?? null;
    return {
      ...this.index,
      objectsBytes: total,
      objects: files,
      manifestsBytes,
      auto: { enabled: settings.enabled && settings.autoOnChange, lastAt: this.lastAutoAt || null, lastId: latest?.reason === "auto" ? latest.id : this.index.auto.lastId }
    };
  }
  /** 立即做一份快照；reason=auto 且与上一份内容完全一致时跳过（返回上一份，带 deduped 标记） */
  async create(input = {}) {
    if (this.inflight) return this.inflight;
    const reason = input.reason ?? "manual";
    const mode = input.mode ?? this.settings().defaultMode;
    this.inflight = (async () => {
      const now = this.now();
      this.publish({ phase: "start", id: null, reason, ok: true });
      try {
        await this.store.flush();
        const files = await collectScope(this.root, this.scopeOpts(mode));
        const entries = [];
        let newBytes = 0;
        let rawBytes = 0;
        for (const f of files) {
          const put = await this.cas.putFile(f.abs);
          entries.push({ path: f.path, size: put.raw, sha256: put.sha, gz: put.gz });
          rawBytes += put.raw;
          if (!put.existed) newBytes += put.gz;
        }
        const latest = this.index.snapshots[0] ?? null;
        if (latest && reason === "auto") {
          const prev = await this.readManifest(latest.id).catch(() => null);
          if (prev && sameFileSet(prev.files, entries)) {
            const entry2 = { ...latest, deduped: true };
            this.publish({ phase: "done", id: latest.id, reason, ok: true });
            return entry2;
          }
        }
        const id = `snap_${now.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
        const manifest = {
          kind: SNAPSHOT_KIND,
          version: 1,
          id,
          createdAt: now,
          reason,
          label: input.label?.trim() || defaultLabel(reason),
          mode,
          parentId: latest?.id ?? null,
          appVersion: this.appVersion,
          files: entries,
          rawBytes,
          bytes: newBytes
        };
        await writeJsonAtomic(paths.backupManifest(id), manifest);
        const entry = {
          id,
          createdAt: now,
          reason,
          label: manifest.label,
          mode,
          parentId: manifest.parentId,
          files: entries.length,
          rawBytes,
          bytes: newBytes,
          retention: "recent",
          appVersion: this.appVersion
        };
        this.index.snapshots.unshift(entry);
        this.index.auto = { ...this.index.auto, lastAt: this.lastAutoAt || null };
        await this.saveIndex();
        this.publish({ phase: "done", id, reason, ok: true });
        const cap = this.settings().maxBytesMb;
        if (cap > 0) {
          const used = this.index.snapshots.reduce((a, s) => a + s.bytes, 0);
          if (used > cap * 1024 * 1024) {
            const pruned = await this.prune({ apply: true });
            if (pruned.removed.length) console.log(`[backup] \u8D85\u8FC7\u4E0A\u9650 ${cap}MB\uFF0C\u6E05\u7406 ${pruned.removed.length} \u4EFD\u65E7\u5FEB\u7167\uFF0C\u91CA\u653E ${Math.round(pruned.freedBytes / 1024)}KB`);
          }
        }
        return entry;
      } catch (err) {
        const msg = err.message ?? String(err);
        this.publish({ phase: "done", id: null, reason, ok: false, error: msg });
        throw err;
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }
  /** 与当前磁盘比对：新增（快照有磁盘没有）/ 变更 / 未变 / 多出（磁盘有快照没有） */
  async preview(id) {
    const manifest = await this.readManifest(id);
    return this.diffAgainst(manifest);
  }
  /** 恢复：先自动安全快照，再逐文件写回（跳过内容一致的），绝不删磁盘上多出来的文件 */
  async restore(input) {
    const manifest = await this.readManifest(input.id);
    const diff = await this.diffAgainst(manifest);
    if (input.dryRun) {
      return { id: manifest.id, dryRun: true, safetyId: null, restored: 0, unchanged: diff.same, bytes: 0, extra: diff.extra.length, diff, reloaded: false };
    }
    const writable = [...diff.added, ...diff.changed];
    const missing = [];
    for (const f of writable) if (!await this.cas.has(f.sha256)) missing.push(f.path);
    if (missing.length) {
      throw new Error(
        `\u8FD9\u4EFD\u5FEB\u7167\u7F3A ${missing.length} \u4E2A\u6570\u636E\u5BF9\u8C61\uFF08\u5BF9\u8C61\u5E93\u88AB\u6E05\u7406\u8FC7\uFF09\uFF0C\u65E0\u6CD5\u5B8C\u6574\u6062\u590D\uFF1A${missing.slice(0, 3).join("\u3001")}${missing.length > 3 ? " \u7B49" : ""}\u3002\u8BF7\u6362\u4E00\u4EFD\u66F4\u65B0\u7684\u5FEB\u7167\uFF0C\u6216\u7528\u5BFC\u51FA\u7684\u5907\u4EFD\u5305\u5BFC\u5165\u3002`
      );
    }
    const safety = await this.create({ reason: "pre-restore", label: `\u6062\u590D ${manifest.id} \u4E4B\u524D`, mode: manifest.mode });
    let restored = 0;
    let bytes = 0;
    for (const f of writable) {
      const rel = safeRelPath(f.path);
      if (!rel) continue;
      await this.cas.extract(f.sha256, path15.join(this.root, rel));
      restored += 1;
      bytes += f.size;
    }
    return { id: manifest.id, dryRun: false, safetyId: safety.id, restored, unchanged: diff.same, bytes, extra: diff.extra.length, diff, reloaded: false };
  }
  /** 校验：对象解压后重算 sha256 与清单比；full=false 时抽样 */
  async verify(input = {}) {
    const id = input.id ?? this.index.snapshots[0]?.id;
    if (!id) throw new Error("\u8FD8\u6CA1\u6709\u4EFB\u4F55\u5FEB\u7167\uFF0C\u5148\u505A\u4E00\u6B21\u300C\u7ACB\u5373\u5907\u4EFD\u300D\u518D\u6821\u9A8C");
    const manifest = await this.readManifest(id);
    const full = input.full ?? true;
    const list = full ? manifest.files : sample(manifest.files, 12);
    const bad = [];
    const missing = [];
    let checked = 0;
    for (const f of list) {
      if (!await this.cas.has(f.sha256)) {
        missing.push(f.path);
        continue;
      }
      const r = await this.cas.verify(f.sha256);
      checked += 1;
      if (!r.ok) bad.push(f.path);
    }
    const at = this.now();
    const result = { id, ok: !bad.length && !missing.length, checked, total: manifest.files.length, bad, missing, at };
    this.index.lastVerify = { id, at, ok: result.ok, checked, bad: [...bad, ...missing] };
    await this.saveIndex();
    return result;
  }
  /** 导出成单个 zip（可选口令加密）；不指定 id 就导出最新快照（没有则先建一份） */
  async export(input = {}) {
    let entry = input.id ? this.index.snapshots.find((s) => s.id === input.id) : this.index.snapshots[0];
    if (input.id && !entry) throw new Error(`\u627E\u4E0D\u5230\u5FEB\u7167 ${input.id}\uFF08\u53EF\u80FD\u5DF2\u88AB\u6E05\u7406\uFF09`);
    if (!entry) entry = await this.create({ reason: "export", mode: input.mode });
    const manifest = await this.readManifest(entry.id);
    const encrypted = Boolean(input.passphrase);
    const target = await this.resolveExportPath(input.path, entry.id, encrypted);
    await fsp8.mkdir(paths.backupTmp(), { recursive: true });
    const staging = await fsp8.mkdtemp(path15.join(paths.backupTmp(), "export-"));
    try {
      const zipEntries = [];
      let rawBytes = 0;
      for (const f of manifest.files) {
        const rel = safeRelPath(f.path);
        if (!rel) continue;
        if (!await this.cas.has(f.sha256)) throw new Error(`\u5FEB\u7167\u7F3A\u6570\u636E\u5BF9\u8C61\uFF0C\u5BFC\u51FA\u4E2D\u6B62\uFF08\u672A\u5199\u4EFB\u4F55\u6587\u4EF6\uFF09\uFF1A${f.path}`);
        const staged = path15.join(staging, "files", rel);
        await this.cas.extract(f.sha256, staged);
        zipEntries.push({ name: `files/${rel}`, file: staged, mtime: manifest.createdAt });
        rawBytes += f.size;
      }
      const pkg = {
        kind: PACKAGE_KIND,
        version: 1,
        createdAt: this.now(),
        appVersion: this.appVersion,
        mode: manifest.mode,
        source: { id: manifest.id, createdAt: manifest.createdAt, reason: manifest.reason, label: manifest.label },
        files: manifest.files,
        rawBytes
      };
      const pkgFile = path15.join(staging, "aitm-backup.json");
      await writeJsonAtomic(pkgFile, pkg);
      zipEntries.unshift({ name: "aitm-backup.json", file: pkgFile, mtime: manifest.createdAt });
      if (encrypted) {
        const tmpZip = path15.join(staging, "package.zip");
        await writeZip(tmpZip, zipEntries);
        await encryptFile(tmpZip, target, input.passphrase);
      } else {
        await writeZip(target, zipEntries);
      }
      const bytes = (await fsp8.stat(target)).size;
      return { path: target, bytes, files: manifest.files.length, encrypted, snapshotId: manifest.id, mode: manifest.mode };
    } finally {
      await fsp8.rm(staging, { recursive: true, force: true });
    }
  }
  /** 导入备份包：dryRun 只预览差异；正式导入前自动做安全快照，只写不删 */
  async import(input) {
    const src = path15.resolve(input.path);
    try {
      await fsp8.access(src);
    } catch {
      throw new Error(`\u627E\u4E0D\u5230\u5907\u4EFD\u5305\uFF1A${src}\uFF08\u628A\u5BFC\u51FA\u65F6\u7684\u5B8C\u6574\u8DEF\u5F84\u8D34\u8FC7\u6765\uFF0C\u6216\u5728\u684C\u9762\u7AEF\u70B9\u300C\u9009\u62E9\u5907\u4EFD\u5305\u300D\uFF09`);
    }
    let zipPath = src;
    let decrypted = null;
    await fsp8.mkdir(paths.backupTmp(), { recursive: true });
    const staging = await fsp8.mkdtemp(path15.join(paths.backupTmp(), "import-"));
    try {
      if (await looksEncrypted(src)) {
        if (!input.passphrase) throw new Error("\u8FD9\u662F\u4E00\u4E2A\u52A0\u5BC6\u5907\u4EFD\u5305\uFF0C\u8BF7\u5148\u586B\u300C\u5BFC\u51FA\u65F6\u7684\u53E3\u4EE4\u300D\u518D\u8BD5");
        decrypted = path15.join(staging, "decrypted.zip");
        await decryptFile(src, decrypted, input.passphrase);
        zipPath = decrypted;
      }
      const files = await extractZip(zipPath, path15.join(staging, "unpacked"));
      const pkgEntry = files.find((f) => f.name === "aitm-backup.json");
      if (!pkgEntry) throw new Error("\u8FD9\u4E0D\u662F\u9762\u677F\u5BFC\u51FA\u7684\u5907\u4EFD\u5305\uFF08\u91CC\u9762\u6CA1\u6709 aitm-backup.json \u6E05\u5355\uFF09");
      let pkg;
      try {
        pkg = JSON.parse(await fsp8.readFile(pkgEntry.path, "utf8"));
      } catch {
        throw new Error("\u5907\u4EFD\u5305\u91CC\u7684 aitm-backup.json \u89E3\u6790\u5931\u8D25\uFF08\u6587\u4EF6\u53EF\u80FD\u635F\u574F\uFF09");
      }
      if (pkg?.kind !== PACKAGE_KIND || !Array.isArray(pkg.files)) throw new Error("\u5907\u4EFD\u5305\u6E05\u5355\u683C\u5F0F\u4E0D\u5BF9\uFF08kind \u4E0D\u662F aitm-backup-package\uFF09");
      const mode = pkg.mode === "full" ? "full" : "lean";
      const added = [];
      const changed = [];
      const extra = [];
      const inPkg = /* @__PURE__ */ new Set();
      let same = 0;
      for (const f of pkg.files) {
        const rel = safeRelPath(f.path);
        if (!rel) continue;
        inPkg.add(rel);
        const staged = path15.join(staging, "unpacked", "files", rel);
        let stagedSha;
        try {
          stagedSha = await CasStore.hashFile(staged);
        } catch {
          throw new Error(`\u5907\u4EFD\u5305\u91CC\u7F3A\u6587\u4EF6\u5185\u5BB9\uFF1A${rel}\uFF08\u6E05\u5355\u91CC\u6709\u3001\u538B\u7F29\u5305\u91CC\u6CA1\u6709\uFF0C\u53EF\u80FD\u6CA1\u4E0B\u5B8C\uFF09`);
        }
        if (stagedSha !== f.sha256) throw new Error(`\u5907\u4EFD\u5305\u5185\u5BB9\u4E0E\u6E05\u5355\u4E0D\u7B26\uFF08${rel}\uFF09\uFF0C\u5DF2\u4E2D\u6B62\u5BFC\u5165\uFF0C\u8BF7\u91CD\u65B0\u5BFC\u51FA`);
        const cur = await safeHash(path15.join(this.root, rel));
        const item = { path: rel, size: f.size, sha256: f.sha256 };
        if (cur == null) added.push(item);
        else if (cur !== f.sha256) changed.push(item);
        else same += 1;
      }
      for (const f of await collectScope(this.root, this.scopeOpts(mode))) {
        if (!inPkg.has(f.path)) {
          const sha = await safeHash(f.abs);
          if (sha) extra.push({ path: f.path, size: f.size, sha256: sha });
        }
      }
      if (input.dryRun) {
        return {
          dryRun: true,
          sourcePath: src,
          snapshotId: pkg.source?.id ?? "unknown",
          sourceCreatedAt: pkg.source?.createdAt ?? pkg.createdAt,
          files: pkg.files.length,
          added,
          changed,
          same,
          extra,
          imported: 0,
          bytes: 0,
          safetyId: null,
          reloaded: false
        };
      }
      const safety = await this.create({ reason: "pre-import", label: `\u5BFC\u5165 ${path15.basename(src)} \u4E4B\u524D`, mode });
      let imported = 0;
      let bytes = 0;
      for (const f of [...added, ...changed]) {
        const rel = safeRelPath(f.path);
        const staged = path15.join(staging, "unpacked", "files", rel);
        const dest = path15.join(this.root, rel);
        await fsp8.mkdir(path15.dirname(dest), { recursive: true });
        const tmp = `${dest}.${process.pid}.${Date.now()}.import.tmp`;
        await fsp8.copyFile(staged, tmp);
        await fsp8.rename(tmp, dest);
        imported += 1;
        bytes += f.size;
      }
      return {
        dryRun: false,
        sourcePath: src,
        snapshotId: pkg.source?.id ?? "unknown",
        sourceCreatedAt: pkg.source?.createdAt ?? pkg.createdAt,
        files: pkg.files.length,
        added,
        changed,
        same,
        extra,
        imported,
        bytes,
        safetyId: safety.id,
        reloaded: false
      };
    } finally {
      await fsp8.rm(staging, { recursive: true, force: true });
    }
  }
  /** GFS 保留：最近 N 份逐点 → 每日 → 每周 → 每月；对象按引用计数 + 7 天宽限期回收 */
  async prune(input = {}) {
    const apply = Boolean(input.apply);
    const s = this.settings();
    const snaps = [...this.index.snapshots].sort((a, b) => b.createdAt - a.createdAt);
    const keep = selectRetention(snaps, s);
    const capBytes = s.maxBytesMb > 0 ? s.maxBytesMb * 1024 * 1024 : 0;
    if (capBytes) {
      const recentIds = new Set(snaps.slice(0, s.keepRecent).map((x) => x.id));
      let used = snaps.filter((x) => keep.has(x.id)).reduce((a, x) => a + x.bytes, 0);
      for (const x of [...snaps].reverse()) {
        if (used <= capBytes) break;
        if (!keep.has(x.id) || recentIds.has(x.id)) continue;
        keep.delete(x.id);
        used -= x.bytes;
      }
    }
    const removed = snaps.filter((x) => !keep.has(x.id));
    let objectsRemoved = 0;
    let objectsHeld = 0;
    let freedBytes = 0;
    if (apply) {
      const keptSnaps = snaps.filter((x) => keep.has(x.id));
      for (const x of removed) await fsp8.rm(paths.backupManifest(x.id), { force: true });
      this.index.snapshots = keptSnaps.map((x) => ({ ...x, retention: retentionOf(x, snaps, s) }));
      await this.saveIndex();
      const referenced = /* @__PURE__ */ new Set();
      for (const x of keptSnaps) {
        const m = await this.readManifest(x.id).catch(() => null);
        for (const f of m?.files ?? []) referenced.add(f.sha256);
      }
      for (const sha of await this.cas.list()) {
        if (referenced.has(sha)) {
          objectsHeld += 1;
          continue;
        }
        const age = this.now() - await this.cas.mtime(sha);
        if (age < OBJECT_GRACE_MS) {
          objectsHeld += 1;
          continue;
        }
        try {
          freedBytes += (await fsp8.stat(this.cas.objectPath(sha))).size;
        } catch {
        }
        await this.cas.remove(sha);
        objectsRemoved += 1;
      }
      this.index.lastPrune = { at: this.now(), removed: removed.length, freedBytes };
      await this.saveIndex();
    } else {
      for (const x of removed) freedBytes += x.bytes;
    }
    return { apply, removed: removed.map((x) => x.id), kept: snaps.length - removed.length, freedBytes, objectsRemoved, objectsHeld };
  }
  /** 退出时抓一份（失败只记日志：不能因为备份把退出流程卡住） */
  async captureOnExit() {
    const s = this.settings();
    if (!s.enabled || !s.captureOnExit) return;
    try {
      const latest = this.index.snapshots[0];
      if (latest && this.now() - latest.createdAt < 6e4) return;
      await this.create({ reason: "exit", label: "\u9000\u51FA\u65F6\u81EA\u52A8\u5FEB\u7167" });
    } catch (err) {
      console.error("[backup] \u9000\u51FA\u5FEB\u7167\u5931\u8D25\uFF1A", err);
    }
  }
  /* ------------------------------ 内部实现 ------------------------------ */
  async diffAgainst(manifest) {
    const added = [];
    const changed = [];
    const extra = [];
    const inSnap = /* @__PURE__ */ new Set();
    let same = 0;
    for (const f of manifest.files) {
      const rel = safeRelPath(f.path);
      if (!rel) continue;
      inSnap.add(rel);
      const cur = await safeHash(path15.join(this.root, rel));
      const item = { path: rel, size: f.size, sha256: f.sha256 };
      if (cur == null) added.push(item);
      else if (cur !== f.sha256) changed.push(item);
      else same += 1;
    }
    for (const f of await collectScope(this.root, this.scopeOpts(manifest.mode))) {
      if (inSnap.has(f.path)) continue;
      const sha = await safeHash(f.abs);
      if (sha) extra.push({ path: f.path, size: f.size, sha256: sha });
    }
    return { id: manifest.id, createdAt: manifest.createdAt, added, changed, same, extra };
  }
  async readManifest(id) {
    const m = await readJson(paths.backupManifest(id), null);
    if (!m || m.kind !== SNAPSHOT_KIND || !Array.isArray(m.files)) {
      throw new Error(`\u5FEB\u7167 ${id} \u7684\u6E05\u5355\u8BFB\u4E0D\u51FA\u6765\u6216\u5DF2\u635F\u574F\uFF08\u53EF\u80FD\u5728\u78C1\u76D8\u4E0A\u624B\u5220\u4E86\uFF09\uFF1B\u5217\u8868\u91CC\u5176\u5B83\u5FEB\u7167\u4E0D\u53D7\u5F71\u54CD`);
    }
    return m;
  }
  async saveIndex() {
    const { total, files } = await this.cas.bytes();
    let manifestsBytes = 0;
    for (const s of this.index.snapshots) {
      try {
        manifestsBytes += (await fsp8.stat(paths.backupManifest(s.id))).size;
      } catch {
      }
    }
    this.index = { ...this.index, objectsBytes: total, objects: files, manifestsBytes };
    await writeJsonAtomic(paths.backupIndex(), this.index);
  }
  async resolveExportPath(input, id, encrypted) {
    const ext = encrypted ? "aitmenc" : "zip";
    const name = `aitm-backup-${stamp(this.now())}-${id.slice(-4)}.${ext}`;
    let target = input?.trim() ? path15.resolve(input.trim()) : path15.join(paths.backupExports(), name);
    let isDir = false;
    try {
      isDir = (await fsp8.stat(target)).isDirectory();
    } catch {
      isDir = false;
    }
    if (isDir || /[\\/]$/.test(input?.trim() ?? "")) target = path15.join(target, name);
    else if (!path15.extname(target)) target = `${target}.${ext}`;
    await fsp8.mkdir(path15.dirname(target), { recursive: true });
    return target;
  }
  publish(ev) {
    this.store.bus.publish({ type: "backup", ...ev });
  }
  /** 数据变了 → 去抖后自动快照（受最小间隔与开关约束） */
  scheduleAuto() {
    if (this.disposed) return;
    const s = this.settings();
    if (!s.enabled || !s.autoOnChange) return;
    if (this.autoTimer) clearTimeout(this.autoTimer);
    this.autoTimer = setTimeout(() => {
      this.autoTimer = null;
      void this.maybeAuto();
    }, this.debounceMs);
    this.autoTimer.unref?.();
  }
  async maybeAuto() {
    if (this.disposed) return;
    const s = this.settings();
    if (!s.enabled || !s.autoOnChange) return;
    if (this.now() - this.lastAutoAt < s.minIntervalMin * 6e4) return;
    try {
      const entry = await this.create({ reason: "auto", label: "\u81EA\u52A8\u5FEB\u7167", mode: s.defaultMode });
      this.lastAutoAt = this.now();
      this.index.auto = { enabled: true, lastAt: this.lastAutoAt, lastId: entry.id };
      await this.saveIndex();
    } catch (err) {
      console.error("[backup] \u81EA\u52A8\u5FEB\u7167\u5931\u8D25\uFF1A", err);
    }
  }
  /** 测试用：把去抖后的动作立刻跑一遍 */
  async runAutoNow() {
    if (this.autoTimer) {
      clearTimeout(this.autoTimer);
      this.autoTimer = null;
    }
    const before = this.index.snapshots[0]?.id ?? null;
    await this.maybeAuto();
    const now = this.index.snapshots[0]?.id ?? null;
    return now && now !== before ? this.index.snapshots[0] : null;
  }
};
function defaultLabel(reason) {
  switch (reason) {
    case "manual":
      return "\u624B\u52A8\u5907\u4EFD";
    case "auto":
      return "\u81EA\u52A8\u5FEB\u7167";
    case "exit":
      return "\u9000\u51FA\u65F6\u81EA\u52A8\u5FEB\u7167";
    case "pre-restore":
      return "\u6062\u590D\u524D\u5B89\u5168\u5FEB\u7167";
    case "pre-import":
      return "\u5BFC\u5165\u524D\u5B89\u5168\u5FEB\u7167";
    case "pre-gc":
      return "\u6E05\u7406 worktree \u524D";
    case "pre-delete":
      return "\u5220\u9664\u524D\u5B89\u5168\u5FEB\u7167";
    case "export":
      return "\u5BFC\u51FA\u524D\u5FEB\u7167";
  }
}
function sameFileSet(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].path !== b[i].path || a[i].sha256 !== b[i].sha256) return false;
  }
  return true;
}
async function safeHash(file) {
  try {
    await fsp8.access(file);
  } catch {
    return null;
  }
  try {
    return await CasStore.hashFile(file);
  } catch {
    return null;
  }
}
function sample(arr, n) {
  if (arr.length <= n) return arr;
  const step = Math.ceil(arr.length / n);
  const out = [];
  for (let i = 0; i < arr.length; i += step) out.push(arr[i]);
  return out;
}
function selectRetention(snaps, s) {
  const keep = /* @__PURE__ */ new Set();
  const sorted = [...snaps].sort((a, b) => b.createdAt - a.createdAt);
  for (const x of sorted.slice(0, s.keepRecent)) keep.add(x.id);
  const bucket = (keyFn, limit) => {
    if (limit <= 0) return;
    const first = /* @__PURE__ */ new Map();
    for (const x of sorted) {
      const k = keyFn(x.createdAt);
      if (!first.has(k)) first.set(k, x.id);
    }
    [...first.values()].slice(0, limit).forEach((id) => keep.add(id));
  };
  bucket((ts) => new Date(ts).toISOString().slice(0, 10), s.keepDaily);
  bucket(isoWeek, s.keepWeekly);
  bucket((ts) => new Date(ts).toISOString().slice(0, 7), s.keepMonthly);
  return keep;
}
function retentionOf(x, snaps, s) {
  const sorted = [...snaps].sort((a, b) => b.createdAt - a.createdAt);
  if (sorted.slice(0, s.keepRecent).some((y) => y.id === x.id)) return "recent";
  const at = (keyFn, limit) => {
    if (limit <= 0) return false;
    const first = /* @__PURE__ */ new Map();
    for (const y of sorted) {
      const k = keyFn(y.createdAt);
      if (!first.has(k)) first.set(k, y.id);
    }
    return [...first.values()].slice(0, limit).includes(x.id);
  };
  if (at((ts) => new Date(ts).toISOString().slice(0, 10), s.keepDaily)) return "daily";
  if (at(isoWeek, s.keepWeekly)) return "weekly";
  if (at((ts) => new Date(ts).toISOString().slice(0, 7), s.keepMonthly)) return "monthly";
  return "none";
}
function isoWeek(ts) {
  const d = new Date(ts);
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 864e5 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// src/core/feishu/service.ts
import { createHash as createHash2 } from "node:crypto";

// src/core/feishu/client.ts
var BASE_BY_SITE = {
  feishu: "https://open.feishu.cn/open-apis",
  lark: "https://open.larksuite.com/open-apis"
};
var BATCH_LIMIT = 500;
var MIN_GAP_MS = 250;
var TOKEN_SKEW_MS = 10 * 6e4;
var FeishuError = class extends Error {
  constructor(message, code = null, raw) {
    super(message);
    this.code = code;
    this.raw = raw;
    this.name = "FeishuError";
  }
};
function describeFeishuError(code, msg, httpStatus) {
  const raw = `code=${code ?? "\u2014"}${msg ? ` msg=${msg}` : ""}${httpStatus ? ` HTTP ${httpStatus}` : ""}`;
  switch (code) {
    case 99991663:
    case 99991661:
    case 99991664:
      return `\u5E94\u7528\u51ED\u636E\u4E0D\u5BF9\uFF08App ID / App Secret \u68C0\u67E5\u4E00\u4E0B\uFF09\uFF1A${raw}`;
    case 1254005:
      return `app_token \u4E0D\u5BF9\uFF08\u6D4F\u89C8\u5668\u5730\u5740\u680F /base/<app_token> \u91CC\u90A3\u4E00\u6BB5\uFF09\uFF1A${raw}`;
    case 1254006:
    case 1254007:
      return `table_id \u4E0D\u5BF9\u6216\u8868\u4E0D\u5B58\u5728\uFF08\u5730\u5740\u680F ?table=<table_id> \u91CC\u90A3\u4E00\u6BB5\uFF09\uFF1A${raw}`;
    case 10003:
    case 10005:
    case 99991543:
      return `App ID \u4E0D\u5BF9\u6216\u5E94\u7528\u4E0D\u5B58\u5728\uFF08\u53BB\u5F00\u53D1\u8005\u540E\u53F0\u786E\u8BA4\u662F\u54EA\u4E2A\u5E94\u7528\uFF0C\u6574\u6BB5\u590D\u5236 cli_ \u5F00\u5934\u7684 App ID\uFF09\uFF1A${raw}`;
    case 10012:
    case 10013:
    case 10014:
      return `\u5E94\u7528\u4E0D\u53EF\u7528\u6216\u51ED\u636E\u4E0D\u5BF9\uFF08\u68C0\u67E5\u5E94\u7528\u662F\u5426\u88AB\u505C\u7528\u3001\u662F\u5426\u5DF2\u521B\u5EFA\u5E76\u53D1\u5E03\u7248\u672C\uFF09\uFF1A${raw}`;
    case 10015:
      return `App Secret \u4E0D\u5BF9\uFF08wrong app secret\uFF09\u2014\u2014\u6574\u6BB5\u590D\u5236\u5F53\u524D\u5E94\u7528\u7684 Secret\uFF1B\u6539\u8FC7/\u91CD\u7F6E\u8FC7\u7684\u8BDD\uFF0C\u65E7 Secret \u7ACB\u523B\u5931\u6548\uFF1A${raw}`;
    case 99991400:
      return `\u88AB\u98DE\u4E66\u9650\u6D41\uFF08\u8BF7\u6C42\u8FC7\u4E8E\u9891\u7E41\uFF09\uFF0C\u7B49\u4E00\u4F1A\u513F\u518D\u540C\u6B65\uFF1A${raw}`;
    case 91403:
    case 1254302:
    case 1254303:
      return `\u5E94\u7528\u6CA1\u6709\u8FD9\u5F20\u8868\u7684\u6743\u9650\uFF1A\u628A\u5E94\u7528\u300C\u6DFB\u52A0\u4E3A\u534F\u4F5C\u8005\u300D\u5E76\u7ED9\u300C\u53EF\u7F16\u8F91\u300D\uFF0C\u518D\u786E\u8BA4\u5F00\u653E\u5E73\u53F0\u91CC\u5F00\u4E86 bitable:app \u5E76\u53D1\u5E03\u4E86\u7248\u672C\uFF1A${raw}`;
    case 1254045:
      return `\u5B57\u6BB5\u4E0D\u5339\u914D\uFF08\u53EF\u80FD\u8868\u91CC\u7F3A\u5217\uFF0C\u70B9\u300C\u8865\u5168\u5B57\u6BB5\u300D\u518D\u540C\u6B65\uFF09\uFF1A${raw}`;
    case 1254291:
      return `\u5199\u5165\u88AB\u9650\u6D41\uFF08\u98DE\u4E66\u4FA7 QPS \u5230\u9876\uFF09\uFF0C\u7B49\u4E00\u4F1A\u513F\u518D\u540C\u6B65\uFF1A${raw}`;
    default:
      if (httpStatus && httpStatus >= 500) return `\u98DE\u4E66\u670D\u52A1\u7AEF\u62A5\u9519\uFF08HTTP ${httpStatus}\uFF09\uFF0C\u7A0D\u540E\u91CD\u8BD5\uFF1A${raw}`;
      if (httpStatus === 404) return `\u63A5\u53E3\u8DEF\u5F84\u4E0D\u5BF9\uFF08HTTP 404\uFF09\u2014\u2014\u591A\u534A\u662F app_token/table_id \u6284\u6F0F\u4E86\uFF1A${raw}`;
      return `\u98DE\u4E66\u8FD4\u56DE\u9519\u8BEF\uFF1A${raw}`;
  }
}
function contentTypeOf(res) {
  const h = res.headers;
  return h?.get?.("content-type") ?? "";
}
function htmlTitle(text) {
  const m = /<title[^>]*>([\s\S]{0,120}?)<\/title>/i.exec(text);
  const t = m?.[1]?.replace(/\s+/g, " ").trim();
  return t || null;
}
function describeBadBody(status, contentType, text) {
  const ct = contentType ? ` content-type: ${contentType}` : "";
  const head = text.replace(/\s+/g, " ").trim().slice(0, 160);
  const raw = `HTTP ${status}${ct} body=${JSON.stringify(text.slice(0, 240))}`;
  if (!text.trim()) {
    return {
      message: `\u98DE\u4E66\u56DE\u4E86\u7A7A\u5305\uFF08HTTP ${status}${ct}\uFF09\u2014\u2014\u591A\u534A\u662F\u4EE3\u7406/\u7F51\u5173\u628A\u54CD\u5E94\u541E\u4E86\uFF1B\u6362\u4E2A\u7F51\u7EDC\uFF08\u624B\u673A\u70ED\u70B9\u6700\u7701\u4E8B\uFF09\u518D\u8BD5`,
      raw
    };
  }
  if (text.trim().startsWith("<")) {
    const title = htmlTitle(text);
    return {
      message: `\u98DE\u4E66\u56DE\u5305\u662F HTML \u9875\u9762\u800C\u4E0D\u662F JSON\uFF08HTTP ${status}${ct}${title ? `\uFF1B\u9875\u9762\u6807\u9898\u300C${title}\u300D` : ""}\uFF1B\u5F00\u5934\uFF1A${head}\uFF09\u2014\u2014\u5178\u578B\u7684\u4E09\u5F20\u8138\uFF1A\u516C\u53F8\u4EE3\u7406/\u7F51\u5173\u7684\u62E6\u622A\u9875\u3001\u9152\u5E97\u6216\u673A\u573A WiFi \u7684\u767B\u5F55\u9875\u3001\u5730\u533A\u9650\u5236\u9875\u3002\u5148\u5728\u6D4F\u89C8\u5668\u91CC\u6253\u5F00 https://open.feishu.cn \u770B\u4F1A\u4E0D\u4F1A\u8DF3\u767B\u5F55/\u62E6\u622A\u9875\uFF1B\u6362\u624B\u673A\u70ED\u70B9\u6700\u5FEB\u80FD\u9A8C\u8BC1\u662F\u4E0D\u662F\u7F51\u7EDC\u7684\u4E8B\u3002\u5982\u679C\u4F60\u7528\u7684\u662F Lark\uFF08\u56FD\u9645\u7248\uFF09\uFF0C\u628A\u5361\u7247\u7684\u300C\u7AD9\u70B9\u300D\u5207\u6210 Lark \u518D\u6D4B\u3002`,
      raw
    };
  }
  return {
    message: `\u98DE\u4E66\u56DE\u5305\u4E0D\u662F JSON\uFF08HTTP ${status}${ct}\uFF1B\u5F00\u5934\uFF1A${head}\uFF09\u2014\u2014\u57DF\u540D\u88AB\u52AB\u6301\u6216\u4EE3\u7406\u6539\u5199\u4E86\u54CD\u5E94\uFF1B\u6362\u4E2A\u7F51\u7EDC\u518D\u8BD5\uFF0C\u4ECD\u4E0D\u884C\u628A\u8FD9\u53E5\u8FDE\u540C\u4E0B\u9762\u7684 raw \u4E00\u8D77\u53D1\u6211`,
    raw
  };
}
var FeishuClient = class {
  cfg;
  tokenCache = null;
  lastRequestAt = 0;
  injected;
  now;
  throttleMs;
  constructor(cfg, deps = {}) {
    this.cfg = {
      ...cfg,
      appId: (cfg.appId ?? "").trim(),
      appSecret: (cfg.appSecret ?? "").trim(),
      appToken: (cfg.appToken ?? "").trim(),
      tableId: (cfg.tableId ?? "").trim()
    };
    this.injected = deps.fetchImpl;
    this.now = deps.now ?? (() => Date.now());
    this.throttleMs = deps.throttleMs ?? MIN_GAP_MS;
  }
  get net() {
    return this.injected ?? fetch;
  }
  get base() {
    return BASE_BY_SITE[this.cfg.site === "lark" ? "lark" : "feishu"];
  }
  get table() {
    return `/bitable/v1/apps/${encodeURIComponent(this.cfg.appToken)}/tables/${encodeURIComponent(this.cfg.tableId)}`;
  }
  /** 每个请求前串行排队（单实例内），保证平均 ≤4 QPS */
  async waitTurn() {
    const wait = this.lastRequestAt + this.throttleMs - this.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait + Math.random() * 30));
    this.lastRequestAt = this.now();
  }
  async request(path19, init = {}, opts = {}) {
    const auth = opts.auth ?? true;
    if (auth && !this.cfg.appId) throw new FeishuError("\u8FD8\u6CA1\u586B App ID / App Secret\uFF08\u8BBE\u7F6E \u2192 \u98DE\u4E66\u540C\u6B65 \u91CC\u6309\u5411\u5BFC\u586B\uFF09");
    if (/^https?:\/\//i.test(path19)) {
      throw new FeishuError(`\u5185\u90E8\u9519\u8BEF\uFF1Arequest() \u53EA\u63A5\u53D7\u76F8\u5BF9\u8DEF\u5F84\uFF0C\u6536\u5230\u7684\u662F\u5B8C\u6574 URL\uFF08${path19.slice(0, 80)}\uFF09\u2014\u2014\u89C1 DESIGN-NOTES\u300Cbase \u62FC\u4E24\u6B21\u300D`);
    }
    await this.waitTurn();
    const headers = {
      "content-type": "application/json; charset=utf-8",
      accept: "application/json"
    };
    if (auth) headers.authorization = `Bearer ${await this.token()}`;
    const url = `${this.base}${path19}`;
    let res;
    try {
      res = await this.net(url, {
        method: init.method ?? "GET",
        headers,
        body: init.body === void 0 ? void 0 : JSON.stringify(init.body)
      });
    } catch (err) {
      const cause = err.cause;
      throw new FeishuError(`\u8FDE\u4E0D\u4E0A open.feishu.cn\uFF08${cause?.code ?? err.message}\uFF09\u2014\u2014\u68C0\u67E5\u7F51\u7EDC/\u4EE3\u7406\uFF0C\u6216\u4F01\u4E1A\u9632\u706B\u5899\u662F\u5426\u653E\u884C\u4E86\u98DE\u4E66`);
    }
    let text;
    try {
      text = await res.text();
    } catch (err) {
      throw new FeishuError(
        `\u98DE\u4E66\u56DE\u5305\u8BFB\u4E86\u4E00\u534A\u5C31\u65AD\u4E86\uFF08HTTP ${res.status}\uFF1B${err.message}\uFF09\u2014\u2014\u7F51\u7EDC/\u4EE3\u7406\u4E0D\u7A33\u5B9A\uFF0C\u91CD\u8BD5\u4E00\u6B21\uFF1B\u53CD\u590D\u51FA\u73B0\u5C31\u6362\u4E2A\u7F51\u7EDC`,
        null,
        `HTTP ${res.status}`
      );
    }
    const clean = text.replace(/^\uFEFF/, "").trim();
    let payload = null;
    try {
      payload = JSON.parse(clean);
    } catch {
      const bad = describeBadBody(res.status, contentTypeOf(res), text);
      throw new FeishuError(bad.message, null, bad.raw);
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      const bad = describeBadBody(res.status, contentTypeOf(res), text);
      throw new FeishuError(`\u98DE\u4E66\u56DE\u5305\u4E0D\u662F\u4E00\u4E2A JSON \u5BF9\u8C61\uFF1A${bad.message}`, null, bad.raw);
    }
    const code = typeof payload?.code === "number" ? payload.code : null;
    if (code !== 0) {
      const msg = String(payload?.error?.msg ?? payload?.msg ?? "");
      const errCode = payload?.error?.code ?? code;
      const raw = `code=${errCode ?? "\u2014"}${msg ? ` msg=${msg}` : ""} HTTP ${res.status}`;
      throw new FeishuError(describeFeishuError(errCode ?? null, msg, res.status), errCode ?? null, raw);
    }
    return opts.raw ? payload : payload?.data;
  }
  /** 取（并缓存）tenant_access_token */
  async token() {
    const cached = this.tokenCache;
    if (cached && cached.expiresAt - TOKEN_SKEW_MS > this.now()) return cached.token;
    const payload = await this.request(
      "/auth/v3/tenant_access_token/internal",
      { method: "POST", body: { app_id: this.cfg.appId, app_secret: this.cfg.appSecret } },
      { auth: false, raw: true }
    );
    const token = payload?.tenant_access_token ?? payload?.data?.tenant_access_token;
    if (!token) {
      const shape = payload && typeof payload === "object" ? Object.keys(payload).join(" / ") || "\uFF08\u7A7A\u5BF9\u8C61\uFF09" : typeof payload;
      throw new FeishuError(
        `\u98DE\u4E66\u8FD4\u56DE\u6210\u529F\u4F46\u6CA1\u7ED9 tenant_access_token\uFF08\u5B9E\u9645\u5B57\u6BB5\uFF1A${shape}\uFF09\u2014\u2014App ID/Secret \u4E0E\u5F00\u653E\u5E73\u53F0\u57DF\u540D\u8981\u914D\u5957\uFF1A\u98DE\u4E66\uFF08\u56FD\u5185\uFF09\u662F open.feishu.cn\uFF0CLark\uFF08\u56FD\u9645\u7248\uFF09\u662F open.larksuite.com`
      );
    }
    const expireSec = Number(payload?.expire ?? payload?.data?.expire) || 7200;
    this.tokenCache = { token, expiresAt: this.now() + expireSec * 1e3 };
    return token;
  }
  async listFields(pageSize = 100) {
    const data = await this.request(
      `${this.table}/fields?page_size=${pageSize}`
    );
    return data?.items ?? [];
  }
  async createField(field) {
    await this.request(`${this.table}/fields`, { method: "POST", body: field });
  }
  /** 拉回全部记录（按页翻，field_names 只取需要的列，省流量） */
  async searchAll(fieldNames, maxRecords = 2e4) {
    const out = [];
    let pageToken;
    for (; ; ) {
      const query = new URLSearchParams({ page_size: String(BATCH_LIMIT) });
      if (pageToken) query.set("page_token", pageToken);
      const data = await this.request(
        `${this.table}/records/search?${query.toString()}`,
        { method: "POST", body: { field_names: fieldNames } }
      );
      out.push(...data?.items ?? []);
      if (!data?.has_more || out.length >= maxRecords) break;
      const next = data.page_token;
      if (!next || next === pageToken) break;
      pageToken = next;
    }
    return out;
  }
  /** 批量新建（自动按 500 切片） */
  async batchCreate(records) {
    for (let i = 0; i < records.length; i += BATCH_LIMIT) {
      const slice = records.slice(i, i + BATCH_LIMIT);
      if (!slice.length) continue;
      await this.request(`${this.table}/records/batch_create`, { method: "POST", body: { records: slice } });
    }
  }
  /** 批量更新（自动按 500 切片） */
  async batchUpdate(records) {
    for (let i = 0; i < records.length; i += BATCH_LIMIT) {
      const slice = records.slice(i, i + BATCH_LIMIT);
      if (!slice.length) continue;
      await this.request(`${this.table}/records/batch_update`, { method: "POST", body: { records: slice } });
    }
  }
  /** 新建一批并回填 record_id（batch_create 的响应里有每条记录） */
  async batchCreateWithIds(records) {
    const ids = [];
    for (let i = 0; i < records.length; i += BATCH_LIMIT) {
      const slice = records.slice(i, i + BATCH_LIMIT);
      if (!slice.length) continue;
      const data = await this.request(`${this.table}/records/batch_create`, {
        method: "POST",
        body: { records: slice }
      });
      for (const r of data?.records ?? []) ids.push(r.record_id);
    }
    return ids;
  }
  /** 测试连接用：只读一次字段列表（不写任何数据） */
  async ping() {
    const fields = await this.listFields();
    return { fields: fields.length, names: fields.slice(0, 6).map((f) => f.field_name) };
  }
};

// src/core/feishu/service.ts
var MAP_VERSION = 1;
var FEISHU_FIELDS = [
  { field_name: "\u60F3\u6CD5ID", type: 1 },
  { field_name: "\u6807\u9898", type: 1 },
  { field_name: "\u5185\u5BB9", type: 1 },
  { field_name: "\u89C4\u683C", type: 1 },
  { field_name: "\u72B6\u6001", type: 3, property: { options: IDEA_STATUSES.map((v) => ({ name: v })) } },
  { field_name: "\u770B\u677F\u5217", type: 3, property: { options: IDEA_STATUSES.map((v) => ({ name: v })) } },
  { field_name: "\u770B\u677F\u4F4D\u7F6E", type: 2, property: { formatter: "0" } },
  { field_name: "\u4F18\u5148\u7EA7", type: 3, property: { options: IDEA_PRIORITIES.map((v) => ({ name: v })) } },
  { field_name: "\u6807\u7B7E", type: 4 },
  { field_name: "\u4ED3\u5E93", type: 1 },
  { field_name: "\u76EE\u5F55", type: 1 },
  { field_name: "\u661F\u6807", type: 7 },
  { field_name: "\u521B\u5EFA\u65F6\u95F4", type: 5 },
  { field_name: "\u66F4\u65B0\u65F6\u95F4", type: 5 },
  { field_name: "\u5185\u5BB9\u54C8\u5E0C", type: 1 },
  { field_name: "\u5DF2\u5220\u9664", type: 7 }
];
function contentHash(idea, repoName) {
  const payload = [
    idea.title,
    idea.description,
    idea.spec ?? "",
    [...idea.tags].sort(),
    idea.priority,
    repoName ?? "",
    idea.workDir ?? "",
    idea.starred,
    idea.createdAt
  ];
  return createHash2("sha256").update(JSON.stringify(payload)).digest("hex");
}
function positionHash(status, position) {
  return createHash2("sha256").update(`${status}:${position}`).digest("hex");
}
function boardPositions(ideas) {
  const counters = /* @__PURE__ */ new Map();
  const out = /* @__PURE__ */ new Map();
  for (const idea of ideas) {
    const n = (counters.get(idea.status) ?? 0) + 1;
    counters.set(idea.status, n);
    out.set(idea.id, { column: idea.status, position: n });
  }
  return out;
}
var emptyMap = () => ({ version: MAP_VERSION, records: {}, lastSyncAt: null, lastReport: null, lastError: null });
var FeishuService = class {
  constructor(store, deps = {}) {
    this.store = store;
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
  }
  map = emptyMap();
  autoTimer = null;
  unsubscribe = null;
  disposed = false;
  now;
  deps;
  get settings() {
    return this.store.snapshot().settings.feishu;
  }
  async init() {
    this.map = await readJson(paths.feishuMap(), emptyMap());
    if (!this.map?.records || typeof this.map.records !== "object") this.map = emptyMap();
    this.unsubscribe = this.store.bus.subscribe((ev) => {
      if (ev.type === "entity" && ev.entity === "idea") this.scheduleAuto();
    });
  }
  dispose() {
    this.disposed = true;
    if (this.autoTimer) clearTimeout(this.autoTimer);
    this.autoTimer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
  client() {
    return new FeishuClient(this.settings, {
      ...this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {},
      now: this.now,
      ...this.deps.throttleMs != null ? { throttleMs: this.deps.throttleMs } : {}
    });
  }
  configured(cfg = this.settings) {
    return Boolean(cfg.appId && cfg.appSecret && cfg.appToken && cfg.tableId);
  }
  requireConfig(cfg = this.settings) {
    if (!this.configured(cfg)) {
      throw new Error("\u98DE\u4E66\u8FD8\u6CA1\u914D\u597D\uFF08\u7F3A App ID / App Secret / app_token / table_id \u4E4B\u4E00\uFF09\u2014\u2014\u8BBE\u7F6E \u2192 \u98DE\u4E66\u540C\u6B65 \u91CC\u6309 1\u20134 \u6B65\u8865\u9F50\uFF0C\u518D\u70B9\u300C\u6D4B\u8BD5\u8FDE\u63A5\u300D");
    }
  }
  /* ------------------------------ 状态 / 测试 / 表头 ------------------------------ */
  async status() {
    const cfg = this.settings;
    return {
      enabled: cfg.enabled,
      configured: this.configured(cfg),
      lastSyncAt: this.map.lastSyncAt,
      lastReport: this.map.lastReport,
      localIdeas: this.store.listIdeas().length,
      mapped: Object.keys(this.map.records).length,
      lastError: this.map.lastError
    };
  }
  /** 只读测试：拿 token + 查一次字段列表，不写任何数据 */
  async test() {
    const cfg = this.settings;
    if (!this.configured(cfg)) {
      return { ok: false, detail: "\u56DB\u4E2A\u53C2\u6570\u8FD8\u6CA1\u586B\u5168\uFF08App ID / App Secret / app_token / table_id\uFF09\u2014\u2014\u6309\u5361\u7247\u91CC\u7684 1\u20134 \u6B65\u8865\u9F50" };
    }
    try {
      const p = await this.client().ping();
      return { ok: true, detail: `\u8FDE\u63A5\u6B63\u5E38\uFF1A\u8FD9\u5F20\u8868\u6709 ${p.fields} \u4E2A\u5B57\u6BB5\uFF08${p.names.join("\u3001")}${p.fields > p.names.length ? " \u2026" : ""}\uFF09` };
    } catch (err) {
      const e = err;
      return { ok: false, detail: e.message, raw: e.raw };
    }
  }
  /** 补全字段：按 FEISHU_FIELDS 建缺的列；已有列一律不动（不删不改） */
  async setupFields() {
    this.requireConfig();
    const existing = await this.client().listFields();
    const byName = /* @__PURE__ */ new Map();
    for (const f of existing) byName.set(f.field_name, f);
    const plan = { existing: [], created: [], failed: [] };
    for (const spec of FEISHU_FIELDS) {
      const hit = byName.get(spec.field_name);
      if (hit) {
        plan.existing.push(spec.field_name);
        if (hit.type !== spec.type) plan.failed.push(`${spec.field_name}\uFF08\u5DF2\u6709\u5217\u7C7B\u578B\u4E0D\u662F ${spec.type}\uFF0C\u6CA1\u6562\u52A8\u5B83\u2014\u2014\u8BF7\u624B\u52A8\u6539\u6210\u5BF9\u5E94\u7C7B\u578B\uFF09`);
        continue;
      }
      try {
        await this.client().createField(spec);
        plan.created.push(spec.field_name);
      } catch (err) {
        plan.failed.push(`${spec.field_name}\uFF1A${err.message}`);
      }
    }
    return plan;
  }
  /* ------------------------------ 同步 ------------------------------ */
  async sync(input = {}) {
    const cfg = this.settings;
    this.requireConfig(cfg);
    const startedAt = this.now();
    this.publish({ phase: "start", ok: true });
    try {
      const ideas = this.store.listIdeas();
      const positions = boardPositions(ideas);
      const repos = new Map(this.store.listRepos().map((r) => [r.id, r.name]));
      const remoteIds = input.full ? await this.remoteIdSet() : null;
      const creates = [];
      const updates = [];
      const moves = [];
      let skipped = 0;
      let reconciled = 0;
      for (const idea of ideas) {
        const pos = positions.get(idea.id) ?? { column: idea.status, position: 1 };
        const hash = contentHash(idea, idea.repoId ? repos.get(idea.repoId) ?? null : null);
        const posHash = positionHash(idea.status, pos.position);
        const known = this.map.records[idea.id];
        const remoteHas = remoteIds ? remoteIds.has(idea.id) : true;
        if (!known?.recordId || !remoteHas) {
          if (known?.recordId && !remoteHas) reconciled += 1;
          creates.push({ idea, fields: this.fullFields(idea, pos, hash, repos), hash, posHash });
        } else if (known.hash !== hash) {
          updates.push({ idea, recordId: known.recordId, fields: this.fullFields(idea, pos, hash, repos), hash, posHash });
        } else if (known.posHash !== posHash) {
          moves.push({ idea, recordId: known.recordId, posHash });
        } else {
          skipped += 1;
        }
      }
      const tombstones = this.tombstoneTargets(ideas);
      const report = {
        at: startedAt,
        durationMs: 0,
        full: Boolean(input.full),
        created: 0,
        updated: 0,
        moved: 0,
        skipped,
        tombstoned: 0,
        failed: 0,
        errors: [],
        reconciled
      };
      if (creates.length) {
        const createdIds = await this.client().batchCreateWithIds(creates.map((c) => ({ fields: c.fields }))).catch((err) => this.failBatch(report, creates.length, err));
        if (createdIds) {
          creates.forEach((c, i) => {
            const recordId = createdIds[i];
            if (!recordId) return;
            this.map.records[c.idea.id] = { recordId, hash: c.hash, posHash: c.posHash, syncedAt: this.now(), deleted: false };
            report.created += 1;
          });
        }
      }
      if (updates.length) {
        await this.client().batchUpdate(updates.map((u) => ({ record_id: u.recordId, fields: u.fields }))).then(() => {
          for (const u of updates) {
            this.map.records[u.idea.id] = { recordId: u.recordId, hash: u.hash, posHash: u.posHash, syncedAt: this.now() };
            report.updated += 1;
          }
        }).catch((err) => this.failBatch(report, updates.length, err));
      }
      if (moves.length) {
        await this.client().batchUpdate(
          moves.map((m) => {
            const pos = positions.get(m.idea.id);
            return { record_id: m.recordId, fields: { \u72B6\u6001: m.idea.status, \u770B\u677F\u5217: pos.column, \u770B\u677F\u4F4D\u7F6E: pos.position } };
          })
        ).then(() => {
          for (const m of moves) {
            const rec = this.map.records[m.idea.id];
            if (rec) rec.posHash = m.posHash;
            report.moved += 1;
          }
        }).catch((err) => this.failBatch(report, moves.length, err));
      }
      if (tombstones.length) {
        await this.client().batchUpdate(tombstones.map((t) => ({ record_id: t.recordId, fields: { \u5DF2\u5220\u9664: true } }))).then(() => {
          for (const t of tombstones) {
            const rec = this.map.records[t.ideaId];
            if (rec) {
              rec.syncedAt = this.now();
              rec.deleted = true;
            }
            report.tombstoned += 1;
          }
        }).catch((err) => this.failBatch(report, tombstones.length, err));
      }
      report.durationMs = this.now() - startedAt;
      this.map.lastSyncAt = this.now();
      this.map.lastReport = report;
      this.map.lastError = report.failed ? report.errors[0] ?? "\u6709\u6279\u6B21\u5931\u8D25" : null;
      await this.saveMap();
      this.publish({ phase: "done", ok: report.failed === 0, created: report.created, updated: report.updated, failed: report.failed, error: this.map.lastError });
      return report;
    } catch (err) {
      const msg = err.message;
      this.map.lastError = msg;
      this.map.lastReport = null;
      await this.saveMap().catch(() => void 0);
      this.publish({ phase: "done", ok: false, error: msg });
      throw err;
    }
  }
  /** 完整对账：远端有记录的 想法ID 集合（只取这一列，流量小） */
  async remoteIdSet() {
    const records = await this.client().searchAll(["\u60F3\u6CD5ID"]);
    return new Set(records.map((r) => String(textOf3(r.fields["\u60F3\u6CD5ID"]) ?? "")).filter(Boolean));
  }
  /* ------------------------------ 从飞书补洞 ------------------------------ */
  async restoreMissing(input = {}) {
    const cfg = this.settings;
    this.requireConfig(cfg);
    const records = await this.client().searchAll(["\u60F3\u6CD5ID", "\u6807\u9898", "\u5185\u5BB9", "\u72B6\u6001", "\u6807\u7B7E", "\u4F18\u5148\u7EA7", "\u89C4\u683C", "\u521B\u5EFA\u65F6\u95F4", "\u5DF2\u5220\u9664"]);
    const local = new Set(this.store.listIdeas().map((i) => i.id));
    const candidates = [];
    let skippedDeleted = 0;
    for (const r of records) {
      const id = String(textOf3(r.fields["\u60F3\u6CD5ID"]) ?? "").trim();
      if (!id || local.has(id)) continue;
      if (boolOf(r.fields["\u5DF2\u5220\u9664"])) {
        skippedDeleted += 1;
        continue;
      }
      candidates.push({ id, fields: r.fields });
    }
    const titles = candidates.slice(0, 10).map((c) => String(textOf3(c.fields["\u6807\u9898"]) ?? "(\u65E0\u6807\u9898)"));
    if (input.dryRun || !candidates.length) {
      return { dryRun: Boolean(input.dryRun), missing: candidates.length, imported: 0, safetyId: null, titles, skippedDeleted };
    }
    const safety = await this.deps.backup?.create({ reason: "pre-import", label: "\u4ECE\u98DE\u4E66\u8865\u6D1E\u4E4B\u524D" });
    let imported = 0;
    for (const c of candidates) {
      const now = this.now();
      const status = IDEA_STATUSES.includes(String(textOf3(c.fields["\u72B6\u6001"]))) ? String(textOf3(c.fields["\u72B6\u6001"])) : "inbox";
      const pri = IDEA_PRIORITIES.includes(String(textOf3(c.fields["\u4F18\u5148\u7EA7"]))) ? String(textOf3(c.fields["\u4F18\u5148\u7EA7"])) : "p2";
      const createdAt = numOf(c.fields["\u521B\u5EFA\u65F6\u95F4"]) ?? now;
      const idea = {
        id: c.id,
        title: String(textOf3(c.fields["\u6807\u9898"]) ?? "").trim() || "\uFF08\u4ECE\u98DE\u4E66\u8865\u56DE\u6765\u7684\u60F3\u6CD5\uFF09",
        description: String(textOf3(c.fields["\u5185\u5BB9"]) ?? ""),
        tags: arrOf(c.fields["\u6807\u7B7E"]),
        priority: pri,
        status,
        repoId: null,
        workDir: null,
        estimate: null,
        spec: String(textOf3(c.fields["\u89C4\u683C"]) ?? "") || null,
        starred: false,
        createdAt,
        updatedAt: now,
        closedAt: null
      };
      this.store.putIdea(idea);
      const rec = records.find((r) => String(textOf3(r.fields["\u60F3\u6CD5ID"])) === c.id);
      if (rec) {
        this.map.records[c.id] = { recordId: rec.record_id, hash: contentHash(idea, null), posHash: "", syncedAt: now, deleted: false };
      }
      imported += 1;
    }
    const positions = boardPositions(this.store.listIdeas());
    for (const c of candidates) {
      const rec = this.map.records[c.id];
      if (!rec) continue;
      const pos = positions.get(c.id);
      if (pos) rec.posHash = positionHash(pos.column, pos.position);
    }
    await this.saveMap();
    return { dryRun: false, missing: candidates.length, imported, safetyId: safety?.id ?? null, titles, skippedDeleted };
  }
  /* ------------------------------ 双向拉取（从飞书同步修改与新增，带墓碑防删除环） ------------------------------ */
  async pullUpdates(input = {}) {
    const cfg = this.settings;
    this.requireConfig(cfg);
    const records = await this.client().searchAll([
      "\u60F3\u6CD5ID",
      "\u6807\u9898",
      "\u5185\u5BB9",
      "\u72B6\u6001",
      "\u6807\u7B7E",
      "\u4F18\u5148\u7EA7",
      "\u89C4\u683C",
      "\u661F\u6807",
      "\u521B\u5EFA\u65F6\u95F4",
      "\u66F4\u65B0\u65F6\u95F4",
      "\u5DF2\u5220\u9664"
    ]);
    const localMap = new Map(this.store.listIdeas().map((i) => [i.id, i]));
    const repos = new Map(this.store.listRepos().map((r) => [r.id, r.name]));
    const toCreate = [];
    const toUpdate = [];
    let skippedDeleted = 0;
    let unchanged = 0;
    for (const r of records) {
      const id = String(textOf3(r.fields["\u60F3\u6CD5ID"]) ?? "").trim();
      if (!id) continue;
      const mapped = this.map.records[id];
      if (boolOf(r.fields["\u5DF2\u5220\u9664"]) || mapped?.deleted) {
        skippedDeleted += 1;
        continue;
      }
      const existing = localMap.get(id);
      const now2 = this.now();
      if (!existing) {
        const status = IDEA_STATUSES.includes(String(textOf3(r.fields["\u72B6\u6001"]))) ? String(textOf3(r.fields["\u72B6\u6001"])) : "inbox";
        const pri = IDEA_PRIORITIES.includes(String(textOf3(r.fields["\u4F18\u5148\u7EA7"]))) ? String(textOf3(r.fields["\u4F18\u5148\u7EA7"])) : "p2";
        const createdAt = numOf(r.fields["\u521B\u5EFA\u65F6\u95F4"]) ?? now2;
        const idea = {
          id,
          title: String(textOf3(r.fields["\u6807\u9898"]) ?? "").trim() || "\uFF08\u4ECE\u98DE\u4E66\u540C\u6B65\u7684\u60F3\u6CD5\uFF09",
          description: String(textOf3(r.fields["\u5185\u5BB9"]) ?? ""),
          tags: arrOf(r.fields["\u6807\u7B7E"]),
          priority: pri,
          status,
          repoId: null,
          workDir: null,
          estimate: null,
          spec: String(textOf3(r.fields["\u89C4\u683C"]) ?? "") || null,
          starred: r.fields["\u661F\u6807"] !== void 0 ? boolOf(r.fields["\u661F\u6807"]) : false,
          createdAt,
          updatedAt: now2,
          closedAt: status === "done" ? now2 : null
        };
        toCreate.push({ idea, recordId: r.record_id });
      } else {
        const remoteTitle = String(textOf3(r.fields["\u6807\u9898"]) ?? "").trim() || existing.title;
        const remoteDesc = r.fields["\u5185\u5BB9"] !== void 0 ? String(textOf3(r.fields["\u5185\u5BB9"]) ?? "") : existing.description;
        const remoteSpec = r.fields["\u89C4\u683C"] !== void 0 ? String(textOf3(r.fields["\u89C4\u683C"]) ?? "") || null : existing.spec;
        const remoteStatus = IDEA_STATUSES.includes(String(textOf3(r.fields["\u72B6\u6001"]))) ? String(textOf3(r.fields["\u72B6\u6001"])) : existing.status;
        const remotePri = IDEA_PRIORITIES.includes(String(textOf3(r.fields["\u4F18\u5148\u7EA7"]))) ? String(textOf3(r.fields["\u4F18\u5148\u7EA7"])) : existing.priority;
        const remoteTags = r.fields["\u6807\u7B7E"] !== void 0 ? arrOf(r.fields["\u6807\u7B7E"]) : existing.tags;
        const remoteStarred = r.fields["\u661F\u6807"] !== void 0 ? boolOf(r.fields["\u661F\u6807"]) : existing.starred;
        const tagsChanged = remoteTags.length !== existing.tags.length || remoteTags.some((t, idx) => t !== existing.tags[idx]);
        const changed = remoteTitle !== existing.title || remoteDesc !== existing.description || remoteSpec !== existing.spec || remoteStatus !== existing.status || remotePri !== existing.priority || remoteStarred !== existing.starred || tagsChanged;
        if (!changed) {
          unchanged += 1;
          continue;
        }
        const nextIdea = {
          ...existing,
          title: remoteTitle,
          description: remoteDesc,
          spec: remoteSpec,
          status: remoteStatus,
          priority: remotePri,
          tags: remoteTags,
          starred: remoteStarred,
          updatedAt: now2,
          closedAt: remoteStatus === "done" ? existing.closedAt ?? now2 : existing.closedAt
        };
        toUpdate.push({ idea: nextIdea, recordId: r.record_id });
      }
    }
    const titles = [...toUpdate, ...toCreate].slice(0, 10).map((x) => x.idea.title);
    if (input.dryRun || toUpdate.length === 0 && toCreate.length === 0) {
      return {
        dryRun: Boolean(input.dryRun),
        checked: records.length,
        updated: toUpdate.length,
        created: toCreate.length,
        skippedDeleted,
        unchanged,
        safetyId: null,
        titles
      };
    }
    const safety = await this.deps.backup?.create({ reason: "pre-import", label: "\u4ECE\u98DE\u4E66\u53CC\u5411\u62C9\u53D6\u4E4B\u524D" });
    const now = this.now();
    for (const item of [...toCreate, ...toUpdate]) {
      this.store.putIdea(item.idea);
      const repoName = item.idea.repoId ? repos.get(item.idea.repoId) ?? null : null;
      this.map.records[item.idea.id] = {
        recordId: item.recordId,
        hash: contentHash(item.idea, repoName),
        posHash: "",
        syncedAt: now,
        deleted: false
      };
    }
    const positions = boardPositions(this.store.listIdeas());
    for (const item of [...toCreate, ...toUpdate]) {
      const rec = this.map.records[item.idea.id];
      const pos = positions.get(item.idea.id);
      if (rec && pos) rec.posHash = positionHash(pos.column, pos.position);
    }
    await this.saveMap();
    return {
      dryRun: false,
      checked: records.length,
      updated: toUpdate.length,
      created: toCreate.length,
      skippedDeleted,
      unchanged,
      safetyId: safety?.id ?? null,
      titles
    };
  }
  /* ------------------------------ 内部 ------------------------------ */
  fullFields(idea, pos, hash, repos) {
    return {
      \u60F3\u6CD5ID: idea.id,
      \u6807\u9898: idea.title,
      \u5185\u5BB9: idea.description ?? "",
      \u89C4\u683C: idea.spec ?? "",
      \u72B6\u6001: idea.status,
      \u770B\u677F\u5217: pos.column,
      \u770B\u677F\u4F4D\u7F6E: pos.position,
      \u4F18\u5148\u7EA7: idea.priority,
      \u6807\u7B7E: idea.tags,
      \u4ED3\u5E93: idea.repoId ? repos.get(idea.repoId) ?? "" : "",
      \u76EE\u5F55: idea.workDir ?? "",
      \u661F\u6807: Boolean(idea.starred),
      \u521B\u5EFA\u65F6\u95F4: idea.createdAt,
      \u66F4\u65B0\u65F6\u95F4: idea.updatedAt,
      \u5185\u5BB9\u54C8\u5E0C: hash,
      \u5DF2\u5220\u9664: false
    };
  }
  /** 本地已删、且映射里还有记录的想法（墓碑）；关掉墓碑开关就跳过 */
  tombstoneTargets(localIdeas) {
    if (!this.settings.tombstone) return [];
    const alive = new Set(localIdeas.map((i) => i.id));
    const out = [];
    for (const [ideaId, rec] of Object.entries(this.map.records)) {
      if (alive.has(ideaId) || !rec.recordId || rec.deleted) continue;
      out.push({ ideaId, recordId: rec.recordId });
    }
    return out;
  }
  /** 一批失败：记前 5 条原因，并把这些条目标成失败（不写映射，下次还能重试） */
  failBatch(report, count, err) {
    report.failed += count;
    if (report.errors.length < 5) {
      const e = err;
      report.errors.push(count > 1 ? `${count} \u6761\u4E00\u6279\u5931\u8D25\uFF1A${e.message}` : e.message);
    }
    return void 0;
  }
  async saveMap() {
    await writeJsonAtomic(paths.feishuMap(), { ...this.map, version: MAP_VERSION });
  }
  publish(ev) {
    this.store.bus.publish({ type: "feishu", ...ev });
  }
  /** 数据变了 → 去抖后自动同步（受开关与最小间隔约束） */
  scheduleAuto() {
    if (this.disposed) return;
    const cfg = this.settings;
    if (!cfg.enabled || !cfg.autoSync || !this.configured(cfg)) return;
    if (this.autoTimer) clearTimeout(this.autoTimer);
    this.autoTimer = setTimeout(() => {
      this.autoTimer = null;
      void this.maybeAuto();
    }, this.deps.autoDebounceMs ?? 9e4);
    this.autoTimer.unref?.();
  }
  async maybeAuto() {
    if (this.disposed) return;
    const cfg = this.settings;
    if (!cfg.enabled || !cfg.autoSync || !this.configured(cfg)) return;
    if (this.map.lastSyncAt && this.now() - this.map.lastSyncAt < cfg.minIntervalMin * 6e4) return;
    try {
      await this.sync();
    } catch (err) {
      console.error("[feishu] \u81EA\u52A8\u540C\u6B65\u5931\u8D25\uFF1A", err.message);
    }
  }
  /** 测试用：把去抖后的动作立刻跑一遍 */
  async runAutoNow() {
    if (this.autoTimer) {
      clearTimeout(this.autoTimer);
      this.autoTimer = null;
    }
    const before = this.map.lastSyncAt;
    await this.maybeAuto();
    return this.map.lastSyncAt !== before ? this.map.lastReport : null;
  }
};
function textOf3(v) {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    const parts = v.map((x) => textOf3(x) ?? "").filter(Boolean);
    return parts.length ? parts.join("") : null;
  }
  if (typeof v === "object") {
    const o = v;
    if (typeof o.text === "string") return o.text;
    if (typeof o.name === "string") return o.name;
    if (typeof o.value === "string" || typeof o.value === "number") return String(o.value);
  }
  return null;
}
function numOf(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const t = textOf3(v);
  if (t == null) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
function boolOf(v) {
  if (typeof v === "boolean") return v;
  const t = textOf3(v);
  return t === "true" || t === "1";
}
function arrOf(v) {
  if (Array.isArray(v)) {
    const out = [];
    for (const x of v) {
      const t2 = textOf3(x);
      if (t2) out.push(t2);
    }
    return [...new Set(out)];
  }
  const t = textOf3(v);
  return t ? [t] : [];
}

// src/core/bridge.ts
var MAX_BRIDGE_TITLE_LENGTH = 200;
var MAX_BRIDGE_KEY_LENGTH = 256;
var BridgeApiError = class extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = "BridgeApiError";
  }
  toEnvelope() {
    return {
      protocol: BRIDGE_PROTOCOL_VERSION,
      ok: false,
      error: {
        code: this.code,
        message: this.message
      }
    };
  }
};
var KeyedMutex = class {
  chains = /* @__PURE__ */ new Map();
  async run(key, fn) {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.catch(() => void 0).then(fn);
    this.chains.set(key, next);
    try {
      return await next;
    } finally {
      if (this.chains.get(key) === next) {
        this.chains.delete(key);
      }
    }
  }
};
function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function assertProtocolVersion(body) {
  if (body.protocol !== void 0 && body.protocol !== BRIDGE_PROTOCOL_VERSION) {
    throw new BridgeApiError(
      400,
      "incompatible",
      `\u4E0D\u652F\u6301\u7684\u6865\u63A5\u534F\u8BAE\u7248\u672C\uFF1A${String(body.protocol)}\uFF08\u5F53\u524D\u4EC5\u652F\u6301 protocol=${BRIDGE_PROTOCOL_VERSION}\uFF09`
    );
  }
}
function normalizeSourceRef(raw) {
  if (!isPlainObject(raw)) {
    throw new BridgeApiError(400, "invalid-source-ref", "\u7F3A\u5C11\u6709\u6548\u7684 sourceRef\uFF08\u9700\u5305\u542B plugin \u4E0E taskId\uFF09");
  }
  const plugin = typeof raw.plugin === "string" ? raw.plugin.trim() : "";
  const taskId = typeof raw.taskId === "string" ? raw.taskId.trim() : typeof raw.taskId === "number" && Number.isFinite(raw.taskId) ? String(raw.taskId) : "";
  if (!plugin || plugin.length > 64 || !taskId || taskId.length > 128) {
    throw new BridgeApiError(400, "invalid-source-ref", "sourceRef.plugin \u4E0E sourceRef.taskId \u5FC5\u987B\u4E3A\u975E\u7A7A\u5B57\u7B26\u4E32");
  }
  return { plugin, taskId };
}
function normalizeBridgeTitle(raw) {
  if (typeof raw !== "string") {
    throw new BridgeApiError(400, "invalid-task", "\u60F3\u6CD5\u6807\u9898\u5FC5\u987B\u4E3A\u5B57\u7B26\u4E32");
  }
  const title = raw.replace(/\s+/g, " ").trim();
  if (!title) {
    throw new BridgeApiError(400, "invalid-task", "\u60F3\u6CD5\u6807\u9898\u4E0D\u80FD\u4E3A\u7A7A");
  }
  if (title.length > MAX_BRIDGE_TITLE_LENGTH) {
    throw new BridgeApiError(400, "invalid-task", `\u60F3\u6CD5\u6807\u9898\u4E0D\u80FD\u8D85\u8FC7 ${MAX_BRIDGE_TITLE_LENGTH} \u4E2A\u5B57\u7B26`);
  }
  return title;
}
function normalizeBridgeTags(raw) {
  if (raw === void 0 || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new BridgeApiError(400, "invalid-task", "tags \u5FC5\u987B\u4E3A\u5B57\u7B26\u4E32\u6570\u7EC4");
  }
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const item of raw) {
    if (typeof item !== "string") {
      throw new BridgeApiError(400, "invalid-task", "tags \u4E2D\u7684\u6BCF\u4E00\u9879\u5FC5\u987B\u4E3A\u5B57\u7B26\u4E32");
    }
    const t = item.trim().slice(0, 32);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 12) break;
  }
  return out;
}
function buildBridgeDescription(note, due) {
  const parts = [];
  const trimmedNote = note.trim();
  if (trimmedNote) parts.push(trimmedNote);
  if (due) parts.push(`\u622A\u6B62\u65E5\u671F\uFF1A${due}`);
  return parts.join("\n\n");
}
function buildDefaultInstruction(idea, customInstruction) {
  const custom = customInstruction?.trim();
  if (custom) return custom;
  const lines = [`\u5B9E\u73B0\u60F3\u6CD5\uFF1A${idea.title}`];
  if (idea.description.trim()) {
    lines.push(idea.description.trim());
  }
  if (idea.spec?.trim()) {
    lines.push(`\u53C2\u8003\u5DF2\u68B3\u7406\u89C4\u683C\uFF1A
${idea.spec.trim()}`);
  }
  return lines.join("\n\n");
}
var BridgeService = class {
  constructor(store, registry, runner, appVersion) {
    this.store = store;
    this.registry = registry;
    this.runner = runner;
    this.appVersion = appVersion;
  }
  mutex = new KeyedMutex();
  discovery(extra) {
    return {
      protocol: BRIDGE_PROTOCOL_VERSION,
      ok: true,
      service: BRIDGE_SERVICE_ID,
      version: this.appVersion,
      apiRev: API_REV,
      ...extra?.base ? { base: extra.base } : {},
      capabilities: [...BRIDGE_CAPABILITIES]
    };
  }
  async createIdea(rawInput, opts = {}) {
    if (!isPlainObject(rawInput)) {
      throw new BridgeApiError(400, "bad-request", "\u8BF7\u6C42\u4F53\u5FC5\u987B\u4E3A JSON \u5BF9\u8C61");
    }
    assertProtocolVersion(rawInput);
    const sourceRef = normalizeSourceRef(rawInput.sourceRef);
    const title = normalizeBridgeTitle(rawInput.title);
    if (rawInput.note !== void 0 && rawInput.note !== null && typeof rawInput.note !== "string") {
      throw new BridgeApiError(400, "invalid-task", "note \u5FC5\u987B\u4E3A\u5B57\u7B26\u4E32");
    }
    const note = typeof rawInput.note === "string" ? rawInput.note.slice(0, 2e4) : "";
    if (rawInput.due !== void 0 && rawInput.due !== null && typeof rawInput.due !== "string") {
      throw new BridgeApiError(400, "invalid-task", "due \u5FC5\u987B\u4E3A\u5B57\u7B26\u4E32\u6216 null");
    }
    const due = typeof rawInput.due === "string" && rawInput.due.trim() ? rawInput.due.trim().slice(0, 64) : null;
    const tags = normalizeBridgeTags(rawInput.tags);
    const priority = IDEA_PRIORITIES.includes(String(rawInput.priority ?? "")) ? rawInput.priority : "p2";
    const idempotencyKey = typeof opts.idempotencyKey === "string" ? opts.idempotencyKey.trim() : "";
    if (idempotencyKey.length > MAX_BRIDGE_KEY_LENGTH) {
      throw new BridgeApiError(400, "bad-request", `Idempotency-Key \u957F\u5EA6\u4E0D\u80FD\u8D85\u8FC7 ${MAX_BRIDGE_KEY_LENGTH}`);
    }
    const lockKey = `idea:${sourceRef.plugin}:${sourceRef.taskId}`;
    return this.mutex.run(lockKey, async () => {
      if (idempotencyKey) {
        const byKey = this.store.findIdeaByBridgeKey(idempotencyKey);
        if (byKey && byKey.sourceRef && (byKey.sourceRef.plugin !== sourceRef.plugin || byKey.sourceRef.taskId !== sourceRef.taskId)) {
          throw new BridgeApiError(409, "idempotency-conflict", "Idempotency-Key \u5DF2\u88AB\u5176\u4ED6\u6765\u6E90\u4EFB\u52A1\u5360\u7528");
        }
      }
      const existing = this.store.findIdeaBySourceRef(sourceRef);
      if (existing) {
        return {
          protocol: BRIDGE_PROTOCOL_VERSION,
          ok: true,
          ideaId: existing.id,
          created: false
        };
      }
      const now = Date.now();
      const defaultRepoId = this.store.listRepos()[0]?.id ?? null;
      const created = this.store.putIdea({
        id: safeId("i"),
        title,
        description: buildBridgeDescription(note, due),
        tags,
        priority,
        status: "inbox",
        repoId: defaultRepoId,
        workDir: null,
        estimate: null,
        spec: null,
        starred: false,
        sourceRef,
        due,
        ...idempotencyKey ? { bridgeIdempotencyKey: idempotencyKey } : {},
        createdAt: now,
        updatedAt: now,
        closedAt: null
      });
      await this.store.flush();
      return {
        protocol: BRIDGE_PROTOCOL_VERSION,
        ok: true,
        ideaId: created.id,
        created: true
      };
    });
  }
  async previewStart(ideaIdRaw, rawInput = {}) {
    const ideaId = typeof ideaIdRaw === "string" ? ideaIdRaw.trim() : "";
    if (!ideaId) {
      throw new BridgeApiError(400, "invalid-idea", "\u7F3A\u5C11\u60F3\u6CD5 ID");
    }
    if (rawInput !== void 0 && rawInput !== null) {
      if (!isPlainObject(rawInput)) {
        throw new BridgeApiError(400, "bad-request", "\u8BF7\u6C42\u4F53\u5FC5\u987B\u4E3A JSON \u5BF9\u8C61");
      }
      assertProtocolVersion(rawInput);
    }
    const body = isPlainObject(rawInput) ? rawInput : {};
    if (body.instruction !== void 0 && typeof body.instruction !== "string") {
      throw new BridgeApiError(400, "bad-request", "instruction \u5FC5\u987B\u4E3A\u5B57\u7B26\u4E32");
    }
    const { idea, repo, engine, model, instruction, sideEffects } = await this.resolveStartPlan(
      ideaId,
      typeof body.instruction === "string" ? body.instruction : void 0
    );
    const project = idea.workDir ? `${repo.name} (${idea.workDir})` : repo.name;
    return {
      protocol: BRIDGE_PROTOCOL_VERSION,
      ok: true,
      ideaId: idea.id,
      preview: {
        target: {
          project,
          engine,
          model
        },
        instruction,
        sideEffects
      }
    };
  }
  async startWork(ideaIdRaw, rawInput = {}, opts = {}) {
    const ideaId = typeof ideaIdRaw === "string" ? ideaIdRaw.trim() : "";
    if (!ideaId) {
      throw new BridgeApiError(400, "invalid-idea", "\u7F3A\u5C11\u60F3\u6CD5 ID");
    }
    if (rawInput !== void 0 && rawInput !== null) {
      if (!isPlainObject(rawInput)) {
        throw new BridgeApiError(400, "bad-request", "\u8BF7\u6C42\u4F53\u5FC5\u987B\u4E3A JSON \u5BF9\u8C61");
      }
      assertProtocolVersion(rawInput);
    }
    const body = isPlainObject(rawInput) ? rawInput : {};
    if (body.instruction !== void 0 && typeof body.instruction !== "string") {
      throw new BridgeApiError(400, "bad-request", "instruction \u5FC5\u987B\u4E3A\u5B57\u7B26\u4E32");
    }
    const reqSourceRef = body.sourceRef !== void 0 ? normalizeSourceRef(body.sourceRef) : void 0;
    const idempotencyKey = typeof opts.idempotencyKey === "string" ? opts.idempotencyKey.trim() : "";
    if (!idempotencyKey) {
      throw new BridgeApiError(400, "missing-idempotency-key", "\u542F\u52A8\u64CD\u4F5C\u5FC5\u987B\u63D0\u4F9B Idempotency-Key \u8BF7\u6C42\u5934");
    }
    if (idempotencyKey.length > MAX_BRIDGE_KEY_LENGTH) {
      throw new BridgeApiError(400, "bad-request", `Idempotency-Key \u957F\u5EA6\u4E0D\u80FD\u8D85\u8FC7 ${MAX_BRIDGE_KEY_LENGTH}`);
    }
    return this.mutex.run(
      `start-key:${idempotencyKey}`,
      () => this.mutex.run(`start-idea:${ideaId}`, async () => {
        const existingByKey = this.store.findTaskByIdempotencyKey(idempotencyKey);
        if (existingByKey) {
          if (existingByKey.ideaId !== ideaId) {
            throw new BridgeApiError(409, "idempotency-conflict", "\u8BE5 Idempotency-Key \u5DF2\u7ED1\u5B9A\u5230\u53E6\u4E00\u6761\u60F3\u6CD5");
          }
          return {
            protocol: BRIDGE_PROTOCOL_VERSION,
            ok: true,
            started: true,
            taskId: existingByKey.id,
            deduplicated: true
          };
        }
        const { idea, repo, instruction } = await this.resolveStartPlan(
          ideaId,
          typeof body.instruction === "string" ? body.instruction : void 0
        );
        if (reqSourceRef && idea.sourceRef && (idea.sourceRef.plugin !== reqSourceRef.plugin || idea.sourceRef.taskId !== reqSourceRef.taskId)) {
          throw new BridgeApiError(409, "conflict", "\u60F3\u6CD5\u7684 sourceRef \u4E0E\u8BF7\u6C42\u4E0D\u5339\u914D");
        }
        if (!idea.repoId) {
          this.store.putIdea({
            ...idea,
            repoId: repo.id,
            updatedAt: Date.now()
          });
        }
        const task = await this.runner.startTask({
          ideaId: idea.id,
          instruction,
          kind: "implement",
          idempotencyKey,
          sourceRef: reqSourceRef ?? idea.sourceRef ?? null
        });
        await this.store.flush();
        return {
          protocol: BRIDGE_PROTOCOL_VERSION,
          ok: true,
          started: true,
          taskId: task.id,
          deduplicated: false
        };
      })
    );
  }
  async resolveStartPlan(ideaId, customInstruction) {
    const idea = this.store.getIdea(ideaId);
    if (!idea || idea.status === "trash") {
      throw new BridgeApiError(404, "not-found", `\u60F3\u6CD5\u4E0D\u5B58\u5728\uFF1A${ideaId}`);
    }
    const repos = this.store.listRepos();
    const repoId = idea.repoId ?? repos[0]?.id ?? null;
    const repo = repoId ? this.store.getRepo(repoId) : void 0;
    if (!repo) {
      throw new BridgeApiError(409, "no-repo", "AI \u4EFB\u52A1\u53F0\u5C1A\u672A\u914D\u7F6E\u76EE\u6807\u4EE3\u7801\u4ED3\u5E93\uFF0C\u8BF7\u5148\u5728 AI \u4EFB\u52A1\u53F0\u6DFB\u52A0\u4ED3\u5E93");
    }
    if (Array.isArray(idea.blockedBy) && idea.blockedBy.length > 0) {
      const unresolved = idea.blockedBy.map((depId) => this.store.getIdea(depId)).filter((dep) => Boolean(dep && dep.status !== "done" && dep.status !== "trash"));
      if (unresolved.length > 0) {
        const names = unresolved.map((u) => `\u300A${u.title}\u300B`).join("\u3001");
        throw new BridgeApiError(409, "blocked", `\u8BE5\u60F3\u6CD5\u5B58\u5728\u672A\u5B8C\u6210\u7684\u524D\u7F6E\u4F9D\u8D56\uFF1A${names}`);
      }
    }
    const active = this.store.listTasks({ ideaId: idea.id }).find((t) => isActiveTask(t.status));
    if (active) {
      throw new BridgeApiError(409, "conflict", `\u8BE5\u60F3\u6CD5\u5DF2\u6709\u8FDB\u884C\u4E2D\u7684\u4EFB\u52A1\uFF08${active.id}\uFF09`);
    }
    const settings = this.store.getSettings();
    const adapter = this.registry.resolve(settings);
    const caps = await adapter.capabilities(settings);
    if (!caps.available) {
      throw new BridgeApiError(409, "engine-not-ready", caps.detail || "\u5F53\u524D\u914D\u7F6E\u7684 AI \u5F15\u64CE\u4E0D\u53EF\u7528");
    }
    const engine = engineName(settings.activeAdapter, settings);
    const model = settings.activeAdapter === "cli" ? settings.cli.model.trim() || "\u9ED8\u8BA4\u6A21\u578B" : settings.activeAdapter === "api" ? settings.api.model.trim() || "\u9ED8\u8BA4\u6A21\u578B" : "mock";
    const instruction = buildDefaultInstruction(idea, customInstruction);
    const sideEffects = [
      `\u5728\u4ED3\u5E93\u300C${repo.name}\u300D\u57FA\u4E8E\u5206\u652F ${repo.defaultBranch} \u521B\u5EFA\u72EC\u7ACB git worktree \u4E0E\u4EFB\u52A1\u5206\u652F`,
      `\u5C06\u60F3\u6CD5\u72B6\u6001\u63A8\u8FDB\u81F3\u300C\u5F00\u53D1\u4E2D\u300D\u5E76\u4F7F\u7528\u5F15\u64CE\u300C${engine}\u300D\u6267\u884C\u5F00\u53D1\u4EFB\u52A1`
    ];
    if (settings.autoCommit) {
      sideEffects.push("\u4EFB\u52A1\u5B8C\u6210\u540E\u81EA\u52A8\u63D0\u4EA4\u5DE5\u4F5C\u533A\u6539\u52A8\u5E76\u8F6C\u5165\u300C\u5F85\u9A8C\u6536\u300D");
    }
    return { idea, repo, engine, model, instruction, sideEffects };
  }
};

// src/shared/calendar.ts
function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// src/shared/calendar-export.ts
function toRows(ideas, favorites) {
  const rows = [];
  for (const i of ideas) {
    rows.push({
      id: i.id,
      date: dayKey(i.createdAt),
      type: "idea",
      title: i.title,
      status: i.status,
      tags: (i.tags ?? []).join(", "),
      priority: i.priority,
      link: "",
      source: "",
      ts: i.createdAt,
      body: i.description ?? ""
    });
  }
  for (const f of favorites) {
    rows.push({
      id: f.item.key,
      date: dayKey(f.savedAt),
      type: "news",
      title: f.item.title,
      status: "",
      tags: (f.item.tags ?? []).join(", "),
      priority: "",
      link: f.item.url,
      source: f.item.source,
      ts: f.savedAt,
      body: f.item.summary ?? ""
    });
  }
  rows.sort((a, b) => b.ts - a.ts);
  return rows;
}
function icsEscape(s) {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");
}
function foldLine(line) {
  const enc = new TextEncoder();
  const bytes = enc.encode(line);
  if (bytes.length <= 75) return line;
  const out = [];
  let start = 0;
  let first = true;
  while (start < bytes.length) {
    const limit = first ? 75 : 74;
    let end = Math.min(start + limit, bytes.length);
    while (end > start && end < bytes.length && (bytes[end] & 192) === 128) end--;
    const chunk = bytes.slice(start, end);
    out.push((first ? "" : " ") + new TextDecoder().decode(chunk));
    first = false;
    start = end;
  }
  return out.join("\r\n");
}
function icsDate(yyyymmdd) {
  return yyyymmdd.replace(/-/g, "");
}
function icsTimestamp(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}
function nextDay(yyyymmdd) {
  const [y, m, d] = yyyymmdd.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + 1);
  return dayKey(dt.getTime());
}
function uidOf(r) {
  const safe = String(r.id).replace(/[^A-Za-z0-9._-]/g, "-");
  return `${r.type}-${safe}@ai-tasks-mgr`;
}
function buildIcs(rows) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//ai-tasks-mgr//calendar//ZH",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH"
  ];
  const now = Date.now();
  for (const r of rows) {
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${uidOf(r)}`);
    lines.push(`DTSTAMP:${icsTimestamp(now)}`);
    lines.push(`DTSTART;VALUE=DATE:${icsDate(r.date)}`);
    lines.push(`DTEND;VALUE=DATE:${icsDate(nextDay(r.date))}`);
    const summary = r.type === "news" ? `[\u6536\u85CF] ${r.title}` : r.title;
    lines.push(`SUMMARY:${icsEscape(summary)}`);
    const descParts = [];
    if (r.body) descParts.push(r.body);
    if (r.status) descParts.push(`\u72B6\u6001\uFF1A${r.status}`);
    if (r.tags) descParts.push(`\u6807\u7B7E\uFF1A${r.tags}`);
    if (r.priority) descParts.push(`\u4F18\u5148\u7EA7\uFF1A${r.priority}`);
    if (r.link) descParts.push(`\u94FE\u63A5\uFF1A${r.link}`);
    if (r.source) descParts.push(`\u6765\u6E90\uFF1A${r.source}`);
    if (descParts.length) lines.push(`DESCRIPTION:${icsEscape(descParts.join("\n"))}`);
    if (r.link) lines.push(`URL:${r.link}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}
var BOM = "\uFEFF";
function csvField(s) {
  return '"' + s.replace(/"/g, '""') + '"';
}
function neutralize(s) {
  if (/^[=+\-@]/.test(s)) return "'" + s;
  return s;
}
var CSV_HEADER = ["\u65E5\u671F", "\u7C7B\u578B", "\u6807\u9898", "\u72B6\u6001", "\u6807\u7B7E", "\u4F18\u5148\u7EA7", "\u94FE\u63A5", "\u6765\u6E90"];
function buildCsv(rows) {
  const lines = [CSV_HEADER.map(csvField).join(",")];
  for (const r of rows) {
    const cells = [
      r.date,
      r.type === "idea" ? "\u60F3\u6CD5" : "\u65B0\u95FB",
      r.title,
      r.status,
      r.tags,
      r.priority,
      r.link,
      r.source
    ];
    lines.push(cells.map((c) => csvField(neutralize(c))).join(","));
  }
  return BOM + lines.join("\r\n") + "\r\n";
}

// src/core/api.ts
var SCRATCH_KIND_NOTE = "\u60F3\u6CD5\u68B3\u7406\uFF08\u65E0 git \u5DE5\u4F5C\u533A\uFF0C\u4EA7\u51FA\u5199\u5165 idea.spec\uFF09";
var AppApi = class _AppApi {
  constructor(store, workspaces, registry, runner, feed, backup, feishu, hooks, fetchImpl = fetch) {
    this.hooks = hooks;
    this.fetchImpl = fetchImpl;
    this.store = store;
    this.workspaces = workspaces;
    this.registry = registry;
    this.runner = runner;
    this.feed = feed;
    this.backup = backup;
    this.feishu = feishu;
    this.bridge = new BridgeService(store, registry, runner, hooks.version);
  }
  /**
   * 已实现的 action 名（形如 `idea.list`）。HTTP 白名单与自检都从这里取，
   * 免得「契约 / 实现 / 网关」三份清单各写各的、早晚对不上。
   */
  static get actions() {
    return Object.getOwnPropertyNames(_AppApi.prototype).filter((n) => /^[a-z]+\.[a-zA-Z][a-zA-Z.]*$/.test(n)).sort();
  }
  store;
  runner;
  workspaces;
  registry;
  feed;
  backup;
  feishu;
  bridge;
  static async create(hooks, deps = {}) {
    paths.ensure();
    const store = await Store.open();
    const registry = new AdapterRegistry({ spawn: deps.spawn ?? null, hostSession: deps.hostSession ?? null });
    const workspaces = new WorkspaceManager();
    const runner = new TaskRunner(store, workspaces, registry, deps.hostSession ?? null);
    const recovered = runner.recover();
    if (recovered.interrupted) console.log(`[core] \u6807\u8BB0 ${recovered.interrupted} \u4E2A\u88AB\u91CD\u542F\u6253\u65AD\u7684\u4EFB\u52A1`);
    const feed = new FeedService(store, deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {});
    await feed.init();
    const backup = new BackupService(store, hooks.version ? { appVersion: hooks.version } : {});
    await backup.init();
    const feishu = new FeishuService(store, { ...deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}, backup });
    await feishu.init();
    return new _AppApi(store, workspaces, registry, runner, feed, backup, feishu, hooks, deps.fetchImpl ?? fetch);
  }
  /** 统一入口：main 的 ipcMain.handle 与 http 的 POST 都调它 */
  async invoke(action, payload) {
    const handler = this[action];
    if (typeof handler !== "function") return { ok: false, error: `\u672A\u77E5\u63A5\u53E3\uFF1A${action}` };
    try {
      const data = await handler.call(this, payload);
      return { ok: true, data };
    } catch (err) {
      const e = err;
      return { ok: false, error: e.message ?? String(err), hint: e.hint };
    }
  }
  /* ------------------------------ overview ------------------------------ */
  async "overview.get"() {
    this.store.sweepAutoArchive();
    this.store.sweepAutoPurgeTrash();
    const allIdeas = this.store.listIdeas({ includeTrash: true });
    const ideas = allIdeas.filter((i) => i.status !== "trash" && i.status !== "archived");
    const tasks = this.store.listTasks();
    const counts = Object.fromEntries(
      ["inbox", "scoping", "ready", "developing", "review", "done", "blocked", "archived", "trash"].map(
        (s) => [s, allIdeas.filter((i) => i.status === s).length]
      )
    );
    const dayStart = /* @__PURE__ */ new Date();
    dayStart.setHours(0, 0, 0, 0);
    const changedFilesToday = tasks.filter((t) => t.updatedAt >= dayStart.getTime()).reduce((acc, t) => acc + (t.diffStat?.files ?? 0), 0);
    const activity = [];
    for (const t of tasks.slice(0, 30)) {
      const idea = this.store.getIdea(t.ideaId);
      activity.push({
        ts: t.endedAt ?? t.updatedAt,
        text: `\u4EFB\u52A1 ${t.title || t.id}${t.status === "succeeded" ? " \u5B8C\u6210" : t.status === "failed" ? " \u5931\u8D25" : t.status === "running" ? " \u8FDB\u884C\u4E2D" : ` ${t.status}`}${idea ? ` \xB7 ${idea.title}` : ""}`,
        kind: "task"
      });
    }
    for (const i of ideas.slice(0, 20)) {
      activity.push({ ts: i.updatedAt, text: `\u60F3\u6CD5\u300C${i.title}\u300D\u2192 ${i.status}`, kind: "idea" });
    }
    activity.sort((a, b) => b.ts - a.ts);
    return {
      counts,
      running: this.runner.stats.running,
      queued: this.runner.stats.queued,
      totalIdeas: ideas.length,
      totalTasks: tasks.length,
      changedFilesToday,
      activity: activity.slice(0, 14)
    };
  }
  /* ------------------------------ ideas ------------------------------ */
  async "idea.list"(f = {}) {
    this.store.sweepAutoArchive();
    this.store.sweepAutoPurgeTrash();
    return this.store.listIdeas(f ?? {});
  }
  async "idea.get"(id) {
    if (!this.store.getIdea(id)) throw new Error(`\u60F3\u6CD5\u4E0D\u5B58\u5728\uFF1A${id}`);
    await this.runner.syncIdeaSessions(id).catch(() => void 0);
    const idea = this.store.getIdea(id);
    const messages = await this.store.listMessages(id);
    return {
      idea,
      tasks: this.store.listTasks({ ideaId: id }),
      messages,
      repo: idea.repoId ? this.store.getRepo(idea.repoId) ?? null : null
    };
  }
  /**
   * 识别并抓取任意网页 / GitHub 仓库 / B站视频链接的标题、简介与标签供 ⌘K 速记预填（#8）。
   */
  async "idea.fetchUrlMeta"(input) {
    const raw = (typeof input === "string" ? input : input?.url ?? "").trim();
    const urlMatch = /https?:\/\/[^\s<>"'`)\]]+/i.exec(raw);
    const targetUrl = urlMatch ? urlMatch[0] : raw;
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch {
      throw new Error("\u8BF7\u8F93\u5165\u6709\u6548\u7684 http:// \u6216 https:// \u7F51\u9875\u94FE\u63A5");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("\u4EC5\u652F\u6301 http:// \u6216 https:// \u94FE\u63A5");
    }
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const ghMatch = host === "github.com" ? /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/|$)/.exec(parsed.pathname) : null;
    const bvMatch = /(BV[0-9A-Za-z]{10})/i.exec(parsed.pathname + parsed.search);
    const fetchWithTimeout = async (u, headers = {}) => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 6500);
      try {
        return await this.fetchImpl(u, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; AI-Tasks-Mgr/1.0)",
            Accept: "text/html,application/json;q=0.9,*/*;q=0.8",
            ...headers
          },
          signal: ac.signal
        });
      } finally {
        clearTimeout(timer);
      }
    };
    if (ghMatch && !["trending", "topics", "search", "settings", "orgs", "users"].includes(ghMatch[1].toLowerCase())) {
      const owner = ghMatch[1];
      const repo = ghMatch[2].replace(/\.git$/i, "");
      const fullName = `${owner}/${repo}`;
      const canonicalUrl = `https://github.com/${fullName}`;
      try {
        const token = (this.store.getSettings().feed?.githubToken ?? "").trim();
        const res = await fetchWithTimeout(`https://api.github.com/repos/${fullName}`, {
          Accept: "application/vnd.github+json",
          ...token ? { Authorization: `Bearer ${token}` } : {}
        });
        if (res.ok) {
          const data = await res.json();
          const desc = (data.description ?? "").trim();
          const stars = typeof data.stargazers_count === "number" ? `\u2B50 ${data.stargazers_count}` : "";
          const lang = (data.language ?? "").trim();
          const metaLine = [stars, lang ? `\u8BED\u8A00\uFF1A${lang}` : ""].filter(Boolean).join(" \xB7 ");
          const tags = normalizeTags([
            "\u8D44\u8BAF",
            "GitHub",
            ...lang ? [lang] : [],
            ...Array.isArray(data.topics) ? data.topics.slice(0, 3) : []
          ]);
          return {
            url: canonicalUrl,
            title: desc ? `${fullName}\uFF1A${desc.slice(0, 70)}` : fullName,
            description: [`\u6765\u6E90\uFF1A[${fullName}](${canonicalUrl})`, metaLine ? `\u6570\u636E\uFF1A${metaLine}` : "", desc ? `
${desc}` : ""].filter(Boolean).join("\n"),
            tags,
            source: "github"
          };
        }
      } catch {
      }
    }
    if ((host.endsWith("bilibili.com") || host === "b23.tv") && bvMatch) {
      const bvid = bvMatch[1];
      try {
        const res = await fetchWithTimeout(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, {
          Accept: "application/json"
        });
        if (res.ok) {
          const json = await res.json();
          if (json?.code === 0 && json.data?.title) {
            const vTitle = json.data.title.trim();
            const vDesc = (json.data.desc ?? "").trim();
            const author = (json.data.owner?.name ?? "").trim();
            const tname = (json.data.tname ?? "").trim();
            const canonicalUrl = `https://www.bilibili.com/video/${bvid}`;
            return {
              url: canonicalUrl,
              title: vTitle,
              description: [
                `\u6765\u6E90\uFF1A[${vTitle}](${canonicalUrl})`,
                author ? `UP \u4E3B\uFF1A${author}` : "",
                vDesc ? `
${vDesc}` : ""
              ].filter(Boolean).join("\n"),
              tags: normalizeTags(["\u8D44\u8BAF", "B\u7AD9", ...tname ? [tname] : []]),
              source: "bilibili"
            };
          }
        }
      } catch {
      }
    }
    const ytId = host === "youtu.be" ? parsed.pathname.split("/").filter(Boolean)[0] : host.endsWith("youtube.com") ? parsed.searchParams.get("v") || /^\/(?:shorts|embed|live)\/([^/?#]+)/.exec(parsed.pathname)?.[1] : null;
    if (ytId) {
      for (const oembedUrl of [
        `https://www.youtube.com/oembed?url=${encodeURIComponent(parsed.toString())}&format=json`,
        `https://noembed.com/embed?url=${encodeURIComponent(parsed.toString())}`
      ]) {
        try {
          const res = await fetchWithTimeout(oembedUrl, { Accept: "application/json" });
          if (res.ok) {
            const data = await res.json();
            if (data?.title?.trim()) {
              const vTitle = data.title.trim();
              const author = (data.author_name ?? "").trim();
              return {
                url: parsed.toString(),
                title: vTitle,
                description: [`\u6765\u6E90\uFF1A[${vTitle}](${parsed.toString()})`, author ? `\u4F5C\u8005/\u9891\u9053\uFF1A${author}` : ""].filter(Boolean).join("\n"),
                tags: normalizeTags(["\u7F51\u9875\u901F\u8BB0", "YouTube"]),
                source: "web"
              };
            }
          }
        } catch {
        }
      }
    }
    let pageTitle = "";
    let pageDesc = "";
    try {
      const res = await fetchWithTimeout(parsed.toString());
      if (res.ok) {
        const html = (await res.text()).slice(0, 12e4);
        pageTitle = extractHtmlMeta(html, "og:title") || extractHtmlMeta(html, "twitter:title") || extractHtmlTitle(html);
        if (/^(youtube| - youtube|google|just a moment\.\.\.)$/i.test(pageTitle.trim())) {
          pageTitle = "";
        }
        pageDesc = extractHtmlMeta(html, "og:description") || extractHtmlMeta(html, "description") || extractHtmlMeta(html, "twitter:description");
      }
    } catch {
    }
    const lastSeg = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || "");
    const isGenericSeg = /^(watch|video|videos|view|article|post|p|index\.html?)$/i.test(lastSeg);
    const fallbackTitle = ghMatch ? `${ghMatch[1]}/${ghMatch[2].replace(/\.git$/i, "")}` : ytId ? `YouTube \u89C6\u9891 (${ytId})` : !lastSeg || isGenericSeg ? `${host}${parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : ""}${parsed.search ? parsed.search.slice(0, 32) : ""}` : lastSeg;
    const finalTitle = normalizeTitle(pageTitle || fallbackTitle) || host;
    const sourceKind = ghMatch ? "github" : host.endsWith("bilibili.com") || host === "b23.tv" ? "bilibili" : "web";
    const baseTags = sourceKind === "github" ? ["\u8D44\u8BAF", "GitHub"] : sourceKind === "bilibili" ? ["\u8D44\u8BAF", "B\u7AD9"] : ["\u7F51\u9875\u901F\u8BB0", host.split(".")[0] || "web"];
    return {
      url: parsed.toString(),
      title: finalTitle,
      description: [`\u6765\u6E90\uFF1A[${finalTitle}](${parsed.toString()})`, pageDesc ? `
${pageDesc.trim()}` : ""].filter(Boolean).join("\n"),
      tags: normalizeTags(baseTags),
      source: sourceKind
    };
  }
  async "idea.create"(input) {
    const title = normalizeTitle(input.title);
    if (!title) throw new Error("\u81F3\u5C11\u8981\u5199\u4E2A\u6807\u9898");
    const now = Date.now();
    const id = safeId("i");
    const blockedBy = normalizeBlockedBy(input.blockedBy, id);
    const created = this.store.putIdea({
      id,
      title,
      description: (input.description ?? "").trim(),
      tags: normalizeTags(input.tags),
      priority: input.priority ?? "p2",
      status: "inbox",
      repoId: input.repoId ?? null,
      workDir: normalizeWorkDir(input.workDir),
      estimate: null,
      spec: null,
      starred: false,
      ...blockedBy.length ? { blockedBy } : {},
      createdAt: now,
      updatedAt: now,
      closedAt: null
    });
    if (input.feedKey && typeof input.feedKey === "string" && input.feedKey.trim()) {
      await this.feed.markRecorded(input.feedKey.trim(), created.id);
    }
    return created;
  }
  async "idea.update"(patch) {
    const cur = this.store.getIdea(patch.id);
    if (!cur) throw new Error("\u60F3\u6CD5\u4E0D\u5B58\u5728");
    const next = {
      ...cur,
      ...patch,
      // 标题是多行输入框（写着舒服），但存的时候归一成一行 —— 看板卡片、详情标题、分支名都用它
      ...patch.title !== void 0 ? { title: normalizeTitle(patch.title) } : {},
      // 目录名单独校验：非法值（绝对路径、..、.git）在这里就挡掉，不留到跑任务时
      ...patch.workDir !== void 0 ? { workDir: normalizeWorkDir(patch.workDir) } : {},
      ...patch.blockedBy !== void 0 ? { blockedBy: normalizeBlockedBy(patch.blockedBy, cur.id) } : {},
      tags: patch.tags ? normalizeTags(patch.tags) : cur.tags,
      id: cur.id,
      createdAt: cur.createdAt,
      updatedAt: Date.now()
    };
    if (!next.title) throw new Error("\u6807\u9898\u4E0D\u80FD\u4E3A\u7A7A");
    if (patch.status && patch.status !== cur.status && !canTransition(cur.status, patch.status)) {
      throw new Error(`\u4E0D\u5141\u8BB8\u7684\u72B6\u6001\u8DF3\u8F6C\uFF1A${cur.status} \u2192 ${patch.status}`);
    }
    if (patch.status === "trash" && cur.status !== "trash") {
      for (const t of this.store.listTasks({ ideaId: cur.id })) {
        if (t.workspace && isActive(t)) this.runner.cancel(t.id);
      }
      next.previousStatus = cur.status;
      next.trashedAt = Date.now();
    } else if (patch.status === "archived" && cur.status !== "archived") {
      next.previousStatus = cur.status !== "trash" ? cur.status : cur.previousStatus ?? "done";
      next.archivedAt = Date.now();
      next.closedAt = cur.closedAt ?? Date.now();
    } else if (patch.status && patch.status !== "trash" && patch.status !== "archived") {
      if (cur.status === "trash") {
        next.previousStatus = null;
        next.trashedAt = null;
      } else if (cur.status === "archived") {
        next.previousStatus = null;
        next.archivedAt = null;
      }
    }
    return this.store.putIdea(next);
  }
  permanentlyDeleteIdeaById(id) {
    for (const t of this.store.listTasks({ ideaId: id })) {
      if (t.workspace && isActive(t)) this.runner.cancel(t.id);
    }
    this.store.deleteIdea(id);
    fs12.rmSync(paths.attachmentBlobDir(id), { recursive: true, force: true });
  }
  async "idea.delete"(input) {
    if (typeof input === "string") {
      this.permanentlyDeleteIdeaById(input);
      return { ok: true, deleted: 1 };
    }
    const mode = input?.mode ?? "permanent";
    if (mode === "empty") {
      const trashed = this.store.listIdeas({ status: "trash" });
      for (const idea of trashed) {
        this.permanentlyDeleteIdeaById(idea.id);
      }
      return { ok: true, deleted: trashed.length };
    }
    const id = String(input?.id ?? "").trim();
    if (!id) throw new Error("\u7F3A\u5C11\u60F3\u6CD5 id");
    if (mode === "permanent") {
      this.permanentlyDeleteIdeaById(id);
      return { ok: true, deleted: 1 };
    }
    const cur = this.store.getIdea(id);
    if (!cur) throw new Error("\u60F3\u6CD5\u4E0D\u5B58\u5728");
    if (mode === "trash") {
      for (const t of this.store.listTasks({ ideaId: id })) {
        if (t.workspace && isActive(t)) this.runner.cancel(t.id);
      }
      const now = Date.now();
      const updated = this.store.putIdea({
        ...cur,
        status: "trash",
        previousStatus: cur.status !== "trash" ? cur.status : cur.previousStatus ?? "inbox",
        trashedAt: now,
        updatedAt: now
      });
      return { ok: true, idea: updated };
    }
    if (mode === "restore") {
      const target = cur.previousStatus && cur.previousStatus !== "trash" && canTransition("trash", cur.previousStatus) ? cur.previousStatus : "inbox";
      const now = Date.now();
      const updated = this.store.putIdea({
        ...cur,
        status: target,
        previousStatus: null,
        trashedAt: null,
        updatedAt: now,
        closedAt: target === "done" ? cur.closedAt ?? now : null
      });
      return { ok: true, idea: updated };
    }
    throw new Error(`\u672A\u77E5\u5220\u9664\u6A21\u5F0F\uFF1A${String(mode)}`);
  }
  /**
   * 批量管理想法（多选后一键归档 / 取消归档 / 移入回收站 / 还原 / 彻底删除 / 改状态 / 改优先级）
   */
  async "idea.batch"(input) {
    const ids = Array.isArray(input?.ids) ? [...new Set(input.ids.map((x) => String(x ?? "").trim()).filter(Boolean))] : [];
    const action = input?.action;
    if (!ids.length) return { ok: true, count: 0, skipped: 0 };
    let count = 0;
    let skipped = 0;
    const now = Date.now();
    for (const id of ids) {
      if (action === "permanentDelete") {
        if (!this.store.getIdea(id)) {
          skipped += 1;
          continue;
        }
        this.permanentlyDeleteIdeaById(id);
        count += 1;
        continue;
      }
      const cur = this.store.getIdea(id);
      if (!cur) {
        skipped += 1;
        continue;
      }
      if (action === "archive") {
        if (cur.status === "archived") {
          skipped += 1;
          continue;
        }
        this.store.putIdea({
          ...cur,
          status: "archived",
          previousStatus: cur.status !== "trash" ? cur.status : cur.previousStatus ?? "done",
          archivedAt: now,
          closedAt: cur.closedAt ?? now,
          updatedAt: now
        });
        count += 1;
      } else if (action === "unarchive") {
        const target = cur.previousStatus && cur.previousStatus !== "archived" && cur.previousStatus !== "trash" ? cur.previousStatus : "done";
        this.store.putIdea({
          ...cur,
          status: target,
          previousStatus: null,
          archivedAt: null,
          updatedAt: now,
          closedAt: target === "done" ? cur.closedAt ?? now : null
        });
        count += 1;
      } else if (action === "trash") {
        if (cur.status === "trash") {
          skipped += 1;
          continue;
        }
        for (const t of this.store.listTasks({ ideaId: id })) {
          if (t.workspace && isActive(t)) this.runner.cancel(t.id);
        }
        this.store.putIdea({
          ...cur,
          status: "trash",
          previousStatus: cur.status,
          trashedAt: now,
          updatedAt: now
        });
        count += 1;
      } else if (action === "restore") {
        const target = cur.previousStatus && cur.previousStatus !== "trash" && canTransition("trash", cur.previousStatus) ? cur.previousStatus : "inbox";
        this.store.putIdea({
          ...cur,
          status: target,
          previousStatus: null,
          trashedAt: null,
          updatedAt: now,
          closedAt: target === "done" ? cur.closedAt ?? now : null
        });
        count += 1;
      } else if (action === "setStatus") {
        const st = input.status;
        if (!st || cur.status === st || !canTransition(cur.status, st)) {
          skipped += 1;
          continue;
        }
        this.store.putIdea({
          ...cur,
          status: st,
          previousStatus: st === "archived" || st === "trash" ? cur.status : null,
          archivedAt: st === "archived" ? now : null,
          trashedAt: st === "trash" ? now : null,
          closedAt: st === "done" ? cur.closedAt ?? now : null,
          updatedAt: now
        });
        count += 1;
      } else if (action === "setPriority") {
        const pri = input.priority;
        if (!pri || cur.priority === pri) {
          skipped += 1;
          continue;
        }
        this.store.putIdea({
          ...cur,
          priority: pri,
          updatedAt: now
        });
        count += 1;
      } else {
        throw new Error(`\u672A\u77E5\u6279\u91CF\u52A8\u4F5C\uFF1A${String(action)}`);
      }
    }
    return { ok: true, count, skipped };
  }
  /** 仓库技能源目录里的技能名列表（composer 的「技能」点选用；没配/读不了就空） */
  async "repo.skills"(input) {
    const repo = this.store.getRepo(input.repoId);
    const dir = repo?.skillsDir?.trim();
    if (!repo || !dir || !fs12.existsSync(dir)) return { names: [] };
    return { names: discoverSkills(dir).map((s) => s.name) };
  }
  /** 检索仓库内受 git 跟踪的文件列表（供指令输入框 `@` 文件引用自动补全 A2） */
  async "repo.files"(input) {
    const repoId = typeof input === "string" ? input.trim() : String(input?.repoId ?? "").trim();
    const q = typeof input === "string" ? "" : String(input?.q ?? "");
    const limit = typeof input === "string" ? 40 : Number(input?.limit ?? 40);
    const repo = this.store.getRepo(repoId);
    if (!repo || !fs12.existsSync(repo.path)) return [];
    return this.workspaces.listRepoFiles(repo, q, limit);
  }
  /**
   * 加参考附件：blob 落数据目录，元数据挂到想法上。任务启动（每轮）时复制进 worktree
   * 并排除出 git —— 用途与边界见 IdeaAttachment 注释。base64 走 IPC/HTTP 都没压力，
   * 上限卡在这里（单文件 30MB、单想法 50 个 / 200MB），超了给明确文案。
   */
  async "attachment.add"(input) {
    const idea = this.store.getIdea(input.ideaId);
    if (!idea) throw new Error("\u60F3\u6CD5\u4E0D\u5B58\u5728");
    let name = path16.basename(String(input.name ?? "")).replace(/[\u0000-\u001f]/g, "").trim();
    if (!name) throw new Error("\u9644\u4EF6\u540D\u4E0D\u80FD\u4E3A\u7A7A");
    if (name.length > 200) throw new Error("\u9644\u4EF6\u540D\u592A\u957F\uFF08>200 \u5B57\u7B26\uFF09\uFF0C\u5148\u6539\u4E2A\u77ED\u540D\u5B57");
    const existingNames = new Set((idea.attachments ?? []).map((a) => a.name));
    if (existingNames.has(name)) {
      if (input.dedupeName) {
        const ext = path16.extname(name);
        const stem = ext ? name.slice(0, -ext.length) : name;
        let idx = 2;
        while (existingNames.has(`${stem}-${idx}${ext}`)) idx += 1;
        name = `${stem}-${idx}${ext}`;
      } else {
        throw new Error(`\u5DF2\u6709\u540C\u540D\u9644\u4EF6\u300C${name}\u300D\uFF0C\u5148\u5220\u6389\u5B83\u6216\u6539\u4E2A\u540D\u5B57`);
      }
    }
    const raw = String(input.dataBase64 ?? "");
    if (raw.trim() === "") throw new Error("\u9644\u4EF6\u5185\u5BB9\u662F\u7A7A\u7684");
    if (!/^[A-Za-z0-9+/=\s]+$/.test(raw)) throw new Error("\u9644\u4EF6\u5185\u5BB9\u4E0D\u662F\u5408\u6CD5\u7684 base64");
    const blob = Buffer.from(raw, "base64");
    const MAX_FILE = 30 * 1024 * 1024;
    if (blob.length === 0) throw new Error("\u9644\u4EF6\u5185\u5BB9\u4E0D\u662F\u5408\u6CD5\u7684 base64\uFF08\u89E3\u4E0D\u51FA\u6765\uFF09");
    if (blob.length > MAX_FILE) throw new Error(`\u9644\u4EF6\u592A\u5927\uFF1A${(blob.length / 1024 / 1024).toFixed(1)} MB\uFF0C\u5355\u4E2A\u4E0A\u9650 30 MB\uFF08\u5927\u6587\u4EF6\u76F4\u63A5\u653E\u4ED3\u5E93\u6216\u6307\u4EE4\u91CC\u5199\u8DEF\u5F84\uFF09`);
    const list = idea.attachments ?? [];
    if (list.length >= 50) throw new Error("\u8FD9\u6761\u60F3\u6CD5\u7684\u9644\u4EF6\u592A\u591A\u4E86\uFF08\u4E0A\u9650 50 \u4E2A\uFF09\uFF0C\u5148\u6E05\u7406\u51E0\u4E2A");
    const total = list.reduce((n, a) => n + a.size, 0) + blob.length;
    if (total > 200 * 1024 * 1024) throw new Error("\u8FD9\u6761\u60F3\u6CD5\u7684\u9644\u4EF6\u603B\u91CF\u8D85\u8FC7 200 MB\uFF0C\u5148\u6E05\u7406\u51E0\u4E2A");
    const att = {
      id: safeId("att"),
      name,
      size: blob.length,
      mime: String(input.mime ?? "").trim() || "application/octet-stream",
      addedAt: Date.now()
    };
    fs12.mkdirSync(paths.attachmentBlobDir(idea.id), { recursive: true });
    fs12.writeFileSync(paths.attachmentBlob(idea.id, att.id), blob);
    const updated = this.store.putIdea({ ...idea, attachments: [...list, att], updatedAt: Date.now() });
    return { idea: updated, attachment: att };
  }
  /** 附件内容（远程/手机端看图用；与上传同走 JSON+base64，鉴权由承载层管） */
  async "attachment.get"(input) {
    const idea = this.store.getIdea(input.ideaId);
    const att = idea?.attachments?.find((a) => a.id === input.id);
    if (!idea || !att) throw new Error("\u9644\u4EF6\u4E0D\u5B58\u5728\uFF08\u53EF\u80FD\u5DF2\u88AB\u5220\u9664\uFF09");
    const blob = fs12.readFileSync(paths.attachmentBlob(idea.id, att.id));
    return { name: att.name, mime: att.mime, size: att.size, dataBase64: blob.toString("base64") };
  }
  async "attachment.remove"(input) {
    const idea = this.store.getIdea(input.ideaId);
    if (!idea) throw new Error("\u60F3\u6CD5\u4E0D\u5B58\u5728");
    const list = idea.attachments ?? [];
    const gone = list.find((a) => a.id === input.id);
    if (!gone) throw new Error("\u9644\u4EF6\u4E0D\u5B58\u5728\uFF08\u53EF\u80FD\u5DF2\u88AB\u5220\u9664\uFF09");
    fs12.rmSync(paths.attachmentBlob(idea.id, gone.id), { force: true });
    const updated = this.store.putIdea({ ...idea, attachments: list.filter((a) => a.id !== input.id), updatedAt: Date.now() });
    return { idea: updated };
  }
  async "idea.setStatus"(input) {
    const cur = this.store.getIdea(input.id);
    if (!cur) throw new Error("\u60F3\u6CD5\u4E0D\u5B58\u5728");
    if (!canTransition(cur.status, input.status)) {
      throw new Error(`\u4E0D\u5141\u8BB8\u7684\u72B6\u6001\u8DF3\u8F6C\uFF1A${cur.status} \u2192 ${input.status}`);
    }
    const now = Date.now();
    if (input.status === "trash" && cur.status !== "trash") {
      for (const t of this.store.listTasks({ ideaId: cur.id })) {
        if (t.workspace && isActive(t)) this.runner.cancel(t.id);
      }
      return this.store.putIdea({
        ...cur,
        status: "trash",
        previousStatus: cur.status,
        trashedAt: now,
        updatedAt: now
      });
    }
    if (input.status === "archived" && cur.status !== "archived") {
      return this.store.putIdea({
        ...cur,
        status: "archived",
        previousStatus: cur.status !== "trash" ? cur.status : cur.previousStatus ?? "done",
        archivedAt: now,
        closedAt: cur.closedAt ?? now,
        updatedAt: now
      });
    }
    return this.store.putIdea({
      ...cur,
      status: input.status,
      ...cur.status === "trash" ? { previousStatus: null, trashedAt: null } : {},
      ...cur.status === "archived" ? { previousStatus: null, archivedAt: null } : {},
      updatedAt: now,
      closedAt: input.status === "done" ? cur.closedAt ?? now : null
    });
  }
  async "idea.toggleStar"(id) {
    const cur = this.store.getIdea(id);
    if (!cur) throw new Error("\u60F3\u6CD5\u4E0D\u5B58\u5728");
    return this.store.putIdea({ ...cur, starred: !cur.starred, updatedAt: Date.now() });
  }
  /** 导出单想法完整复盘报告 Markdown（C9） */
  async "idea.exportReport"(input) {
    const id = typeof input === "string" ? input.trim() : String(input?.id ?? "").trim();
    const idea = this.store.getIdea(id);
    if (!idea) throw new Error("\u60F3\u6CD5\u4E0D\u5B58\u5728");
    const repo = idea.repoId ? this.store.getRepo(idea.repoId) : null;
    const tasks = this.store.listTasks({ ideaId: idea.id });
    const messages = await this.store.listMessages(idea.id);
    const deps = (idea.blockedBy ?? []).map((depId) => this.store.getIdea(depId)).filter((d) => Boolean(d));
    const fmtTs = (ts) => ts ? new Date(ts).toISOString().replace("T", " ").slice(0, 19) : "-";
    const lines = [
      `# ${idea.title}`,
      "",
      `> \u7531 AI \u4EFB\u52A1\u53F0\u5BFC\u51FA \xB7 \u60F3\u6CD5 ID \`${idea.id}\` \xB7 \u5BFC\u51FA\u65F6\u95F4 ${fmtTs(Date.now())}`,
      "",
      "## 1. \u57FA\u672C\u4FE1\u606F",
      "",
      `- **\u72B6\u6001**\uFF1A${IDEA_LABEL[idea.status] ?? idea.status} (\`${idea.status}\`)`,
      `- **\u4F18\u5148\u7EA7**\uFF1A${PRIORITY_LABEL[idea.priority] ?? idea.priority} (\`${idea.priority}\`)`,
      `- **\u6807\u7B7E**\uFF1A${idea.tags.length ? idea.tags.map((t) => `\`#${t}\``).join(" ") : "\uFF08\u65E0\uFF09"}`,
      `- **\u7ED1\u5B9A\u4ED3\u5E93**\uFF1A${repo ? `${repo.name} (\`${repo.path}\`)` : "\uFF08\u672A\u7ED1\u5B9A\uFF09"}${idea.workDir ? ` \xB7 \u5B50\u76EE\u5F55 \`${idea.workDir}\`` : ""}`,
      ...deps.length ? [`- **\u524D\u7F6E\u4F9D\u8D56**\uFF1A${deps.map((d) => `\u300A${d.title}\u300B(\`${d.status}\`)`).join("\u3001")}`] : [],
      `- **\u521B\u5EFA\u65F6\u95F4**\uFF1A${fmtTs(idea.createdAt)}`,
      `- **\u66F4\u65B0\u65F6\u95F4**\uFF1A${fmtTs(idea.updatedAt)}`,
      ...idea.closedAt ? [`- **\u5B8C\u6210\u65F6\u95F4**\uFF1A${fmtTs(idea.closedAt)}`] : [],
      "",
      "## 2. \u60F3\u6CD5\u63CF\u8FF0",
      "",
      idea.description.trim() || "\uFF08\u65E0\u63CF\u8FF0\uFF09",
      ""
    ];
    if (idea.spec?.trim()) {
      lines.push("## 3. \u89C4\u683C\u8BF4\u660E\uFF08Spec\uFF09", "", idea.spec.trim(), "");
    }
    lines.push(`## ${idea.spec?.trim() ? "4" : "3"}. \u5F00\u53D1\u4EFB\u52A1\u6C47\u603B\uFF08\u5171 ${tasks.length} \u4E2A\uFF09`, "");
    if (tasks.length === 0) {
      lines.push("\uFF08\u6682\u65E0\u5F00\u53D1\u4EFB\u52A1\u8BB0\u5F55\uFF09", "");
    } else {
      for (const t of tasks) {
        const tok = viewUsage(t.usage)?.total ?? (t.turnStats ?? []).reduce((sum, s) => sum + (viewUsage(s.usage)?.total ?? 0), 0);
        lines.push(
          `### \u4EFB\u52A1 \`${t.id}\` \xB7 ${t.title}`,
          "",
          `- **\u72B6\u6001**\uFF1A\`${t.status}\` \xB7 **\u5F15\u64CE**\uFF1A\`${t.adapterId}\` \xB7 **\u8F6E\u6B21**\uFF1A${t.turns} \u8F6E${tok > 0 ? ` \xB7 **\u7D2F\u8BA1 Token**\uFF1A${tok.toLocaleString()}` : ""}`,
          ...t.workspace ? [
            `- **\u5206\u652F**\uFF1A\`${t.workspace.branch}\`\uFF08\u57FA\u7EBF \`${t.workspace.baseRef}\`\uFF09${t.workspace.mergedAt ? ` \xB7 \u5DF2\u5408\u5E76\u4E8E ${fmtTs(t.workspace.mergedAt)}` : ""}`
          ] : [],
          ...t.verify ? [`- **\u9A8C\u8BC1\u7ED3\u679C**\uFF1A${t.verify.ok ? "\u2705 \u901A\u8FC7" : "\u274C \u672A\u901A\u8FC7"}\uFF08${t.verify.note}\uFF09`] : [],
          ...t.diffStat ? [
            `- **\u6539\u52A8\u7EDF\u8BA1**\uFF1A${t.diffStat.files} \u4E2A\u6587\u4EF6\uFF0C+${t.diffStat.additions} / -${t.diffStat.deletions}`,
            ...t.diffStat.entries.slice(0, 20).map((e) => `  - \`${e.path}\` (+${e.additions}/-${e.deletions})`)
          ] : [],
          ...t.commits.length ? [`- **\u63D0\u4EA4\u8BB0\u5F55**\uFF1A${t.commits.map((c) => `\`${c.slice(0, 7)}\``).join(", ")}`] : [],
          ...t.error ? [`- **\u9519\u8BEF\u4FE1\u606F**\uFF1A${t.error}`] : [],
          ""
        );
      }
    }
    lines.push(`## ${idea.spec?.trim() ? "5" : "4"}. \u5BF9\u8BDD\u4E0E\u6267\u884C\u7EAA\u8981\uFF08\u5171 ${messages.length} \u6761\uFF09`, "");
    if (messages.length === 0) {
      lines.push("\uFF08\u6682\u65E0\u5BF9\u8BDD\u8BB0\u5F55\uFF09", "");
    } else {
      for (const m of messages) {
        const roleLabel = m.role === "user" ? "\u{1F464} \u7528\u6237\u6307\u4EE4" : m.role === "assistant" ? "\u{1F916} AI \u7ED3\u8BBA" : "\u2699\uFE0F \u7CFB\u7EDF\u4E8B\u4EF6";
        const imgNote = m.images?.length ? `

> \u{1F5BC} \u9644\u56FE\uFF1A${m.images.map((im) => `\`${im.name}\``).join("\u3001")}` : "";
        lines.push(`### ${roleLabel} \xB7 ${fmtTs(m.createdAt)}`, "", (m.content.trim() || "\uFF08\u7A7A\uFF09") + imgNote, "");
      }
    }
    const markdown = lines.join("\n");
    const safeTitle = slug(idea.title, 32) || idea.id;
    const fileName = `idea-report-${safeTitle}-${idea.id}.md`;
    const dir = paths.exports();
    fs12.mkdirSync(dir, { recursive: true });
    const savedPath = path16.join(dir, fileName);
    fs12.writeFileSync(savedPath, markdown, "utf8");
    return { ideaId: idea.id, title: idea.title, fileName, savedPath, markdown };
  }
  /**
   * 「AI 梳理」：不建 worktree、不碰 git，只让当前引擎把一句灵感扩写成可开发的规格，
   * 结果回填 idea.spec，并把状态从 inbox 推到 scoping/ready。
   */
  async "idea.specify"(input) {
    const id = typeof input === "string" ? input : String(input?.id ?? "");
    const wantTemplateId = typeof input === "string" ? void 0 : input?.templateId;
    const idea = this.store.getIdea(id);
    if (!idea) throw new Error("\u60F3\u6CD5\u4E0D\u5B58\u5728");
    const dir = path16.join(paths.root(), "scratch", slug(idea.id, 24));
    fs12.mkdirSync(dir, { recursive: true });
    const taskId = `spec_${idea.id}`;
    const abort = new AbortController();
    let seq = 0;
    const collected = [];
    const settings = this.store.getSettings();
    const emit = (kind, payload) => {
      const ev = { taskId, ideaId: idea.id, seq: seq += 1, ts: Date.now(), kind, payload };
      collected.push(ev);
      this.store.bus.publish({ type: "agent", event: ev });
    };
    const template = resolveSpecifyTemplate(settings.prompt?.specifyTemplates, wantTemplateId ?? settings.prompt?.specifyTemplateId);
    const instruction = [
      renderSpecifyInstruction(template, { title: idea.title, description: idea.description, spec: idea.spec }),
      "",
      // 运行环境说明与模板无关（它描述的是这个临时工作区本身），所以两种模板都要带上
      `\uFF08\u672C\u8F6E\u8FD0\u884C\u73AF\u5883\uFF1A${SCRATCH_KIND_NOTE}\uFF09`
    ].join("\n");
    const adapter = this.registry.resolve(settings);
    try {
      const res = await adapter.run({
        taskId,
        ideaId: idea.id,
        repoName: "(scratch)",
        workspacePath: dir,
        instruction,
        context: { ideaTitle: idea.title, description: idea.description, spec: idea.spec, priorMessages: [] },
        resumeSessionId: null,
        signal: abort.signal,
        emit,
        settings
      });
      const spec = res.summary.trim() || "\uFF08\u5F15\u64CE\u6CA1\u6709\u8FD4\u56DE\u5185\u5BB9\uFF09";
      const updated = this.store.putIdea({
        ...idea,
        spec,
        status: idea.status === "inbox" ? "scoping" : idea.status,
        updatedAt: Date.now()
      });
      emit("result", { ok: true, summary: `\u89C4\u683C\u5DF2\u56DE\u586B\u5230\u60F3\u6CD5\u8BE6\u60C5\uFF08\u6A21\u677F\uFF1A${template.name}\uFF09`, templateId: template.id });
      void updated;
      await this.store.appendEvents(collected);
      return { spec, summary: res.summary, templateId: template.id, templateName: template.name };
    } catch (err) {
      emit("error", { message: err.message });
      await this.store.appendEvents(collected);
      throw err;
    }
  }
  async "idea.messages"(id) {
    await this.runner.syncIdeaSessions(id).catch(() => void 0);
    return this.store.listMessages(id);
  }
  /* ------------------------------ tasks ------------------------------ */
  async "task.start"(input) {
    return this.runner.startTask({
      ideaId: input.ideaId,
      instruction: input.instruction,
      kind: input.kind,
      adapterId: input.adapterId ?? this.store.getSettings().activeAdapter,
      ignoreBlockedBy: input.ignoreBlockedBy,
      allowParallelVariant: input.allowParallelVariant,
      attachmentIds: input.attachmentIds,
      images: input.images
    });
  }
  async "task.followUp"(input) {
    return this.runner.followUp(input.taskId, input.instruction ?? "", {
      retryTurn: input.retryTurn,
      syncOnly: input.syncOnly,
      attachmentIds: input.attachmentIds,
      images: input.images
    });
  }
  async "task.list"(f = {}) {
    return this.store.listTasks(f ?? {});
  }
  async "task.get"(id) {
    const task = this.store.getTask(id);
    if (!task) return null;
    const idea = this.store.getIdea(task.ideaId) ?? null;
    const repo = idea?.repoId ? this.store.getRepo(idea.repoId) ?? null : null;
    return { task, idea, repo };
  }
  async "task.events"(input) {
    return this.store.listEvents(input.taskId, { afterSeq: input.afterSeq, tail: input.tail ?? 400 });
  }
  async "task.diff"(input) {
    const task = this.store.getTask(input.taskId);
    if (!task?.workspace) return { diff: "", stat: null, mergeCheck: null };
    const diff = await this.workspaces.diffText(task.workspace, input.path);
    const stat = await this.workspaces.diffStat(task.workspace);
    const mergeCheck = input.path ? void 0 : await this["task.mergeCheck"](input.taskId).catch(() => null);
    return { diff, stat, mergeCheck };
  }
  async "task.mergeCheck"(taskId) {
    const task = this.store.getTask(taskId);
    if (!task?.workspace || task.workspace.discarded) return null;
    const idea = this.store.getIdea(task.ideaId);
    const repo = (idea?.repoId ? this.store.getRepo(idea.repoId) : null) ?? this.store.getRepo(task.workspace.repoId);
    if (!repo) return null;
    return this.workspaces.checkMerge(repo, task.workspace, task.commits);
  }
  async "task.commits"(taskId) {
    const task = this.store.getTask(taskId);
    if (!task?.workspace) return [];
    return this.workspaces.log(task.workspace);
  }
  async "task.cancel"(taskId) {
    return this.runner.cancel(taskId);
  }
  /** 重跑：新开一个任务（新分支），保留历史任务记录 */
  async "task.retry"(taskId) {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error("\u4EFB\u52A1\u4E0D\u5B58\u5728");
    const messages = await this.store.listMessages(task.ideaId);
    const mine = messages.filter((m) => m.taskId === taskId && m.role === "user");
    const instruction = mine[0]?.content ?? "\u6309\u4E0A\u4E00\u8F6E\u7684\u6307\u4EE4\u91CD\u8DD1\u4E00\u6B21\u3002";
    return this.runner.startTask({ ideaId: task.ideaId, instruction, kind: task.kind, adapterId: task.adapterId });
  }
  async "task.accept"(input) {
    return this.runner.accept(input.taskId, {
      merge: input.merge,
      cleanup: input.cleanup,
      acknowledgeVerifyFailure: input.acknowledgeVerifyFailure
    });
  }
  async "task.reject"(input) {
    return this.runner.reject(input.taskId, input.reason, { discard: input.discard });
  }
  async "task.rollbackTurn"(input) {
    return this.runner.rollbackTurn(input.taskId, input.targetCommit);
  }
  async "task.resumeQueue"() {
    return this.runner.resumeQueue();
  }
  /* ------------------------------ repos ------------------------------ */
  async "repo.list"() {
    return this.store.listRepos();
  }
  async "repo.upsert"(input) {
    const abs = path16.resolve((input.path ?? "").trim());
    if (!abs || abs === ".") throw new Error("\u8BF7\u586B\u5199\u4ED3\u5E93\u7EDD\u5BF9\u8DEF\u5F84");
    if (!fs12.existsSync(abs)) throw new Error(`\u76EE\u5F55\u4E0D\u5B58\u5728\uFF1A${abs}`);
    const info = await repoInfo(abs);
    const existing = input.id ? this.store.getRepo(input.id) : this.store.listRepos().find((r) => r.path === info.root);
    const now = Date.now();
    const repo = {
      id: existing?.id ?? safeId("r"),
      name: (input.name ?? "").trim() || path16.basename(info.root),
      path: info.root,
      defaultBranch: (input.defaultBranch ?? "").trim() || info.defaultBranch,
      worktreeRoot: input.worktreeRoot ?? existing?.worktreeRoot ?? null,
      allowDirty: input.allowDirty ?? existing?.allowDirty ?? false,
      autoFixRounds: Math.max(0, Math.min(5, Math.round(Number(input.autoFixRounds ?? existing?.autoFixRounds ?? 0)) || 0)),
      allowPush: input.allowPush ?? existing?.allowPush ?? false,
      remote: (input.remote ?? existing?.remote ?? "origin").trim() || "origin",
      verifyCommand: input.verifyCommand !== void 0 ? input.verifyCommand : existing?.verifyCommand ?? null,
      skillsDir: input.skillsDir !== void 0 ? String(input.skillsDir ?? "").trim() || null : existing?.skillsDir ?? null,
      agentPermissions: "agentPermissions" in input ? normalizePerm(input.agentPermissions) : existing?.agentPermissions ?? void 0,
      createdAt: existing?.createdAt ?? now
    };
    return this.store.putRepo(repo);
  }
  async "repo.delete"(id) {
    for (const idea of this.store.listIdeas({ repoId: id, includeTrash: true })) {
      this.store.putIdea({ ...idea, repoId: null, updatedAt: Date.now() });
    }
    this.store.deleteRepo(id);
    return { ok: true };
  }
  async "repo.probe"(p) {
    return repoInfo(path16.resolve(p));
  }
  /**
   * worktree 体检 / 回收。默认只汇报不动手（apply: false），
   * 「还在跑」和「等验收」的永远不属于可回收范围，未合并的现场需要 includeUnmerged 才清。
   */
  async "workspace.gc"(input = {}) {
    const items = [];
    const errors = [];
    let removed = 0;
    let freedKb = 0;
    for (const repo of this.store.listRepos()) {
      if (input.repoId && repo.id !== input.repoId) continue;
      for (const w of await this.workspaces.listManaged(repo)) {
        const task = this.store.getTask(w.taskId) ?? null;
        const idea = task ? this.store.getIdea(task.ideaId) : null;
        const sizeKb = await dirSizeKb(w.path);
        let dirtyFiles = 0;
        if (fs12.existsSync(path16.join(w.path, ".git"))) {
          const st = await git(w.path, ["status", "--porcelain=v1"]);
          if (st.ok) dirtyFiles = st.stdout.split("\n").filter(Boolean).length;
        }
        let ageDays = 0;
        try {
          const stat = await fs12.promises.stat(w.path);
          ageDays = Math.max(0, Math.floor((Date.now() - stat.mtimeMs) / 864e5));
        } catch {
        }
        const merged = task?.workspace ? await this.workspaces.isMergedInto(repo, task.workspace, task.commits) : false;
        const discarded = Boolean(task?.workspace?.discarded);
        const active = Boolean(task && isActiveTask(task.status));
        let removable = false;
        let reason = "";
        if (active) {
          reason = "\u4EFB\u52A1\u8FD8\u5728\u8DD1\u6216\u6392\u961F\uFF0C\u4E0D\u52A8\u5B83";
        } else if (w.orphan) {
          removable = true;
          reason = "git \u5DF2\u7ECF\u4E0D\u8BA4\u8FD9\u4E2A\u76EE\u5F55\uFF08\u4E0A\u6B21\u5F02\u5E38\u9000\u51FA\u7684\u6B8B\u7559\uFF09";
        } else if (!task) {
          removable = true;
          reason = "\u627E\u4E0D\u5230\u5BF9\u5E94\u4EFB\u52A1\uFF08\u60F3\u6CD5\u6216\u4EFB\u52A1\u5DF2\u88AB\u5220\u9664\uFF09";
        } else if (merged) {
          removable = true;
          reason = "\u6210\u679C\u5DF2\u5408\u5E76\u56DE\u57FA\u7EBF";
        } else if (discarded) {
          removable = true;
          reason = "\u5DF2\u6807\u8BB0\u4E22\u5F03\uFF0C\u4F46\u76EE\u5F55\u8FD8\u7559\u7740";
        } else if (input.includeUnmerged) {
          removable = true;
          reason = `\u672A\u5408\u5E76\uFF08${task.status === "succeeded" ? "\u7B49\u9A8C\u6536" : task.status}\uFF09\uFF0C\u6309\u5F3A\u5236\u56DE\u6536\u5904\u7406`;
        } else if (task.status === "succeeded") {
          reason = "\u7B49\u9A8C\u6536\uFF08\u5408\u5E76\u5B8C\u518D\u6E05\uFF09";
        } else {
          reason = `\u672A\u5408\u5E76\uFF08${task.status}\uFF09\uFF0C\u4FDD\u7559\u73B0\u573A`;
        }
        items.push({
          repoId: repo.id,
          repoName: repo.name,
          taskId: w.taskId,
          path: w.path,
          branch: w.branch,
          orphan: w.orphan,
          taskStatus: task?.status ?? null,
          ideaTitle: idea?.title ?? null,
          merged,
          active,
          dirtyFiles,
          sizeKb,
          ageDays,
          removable,
          reason
        });
        if (!input.apply || !removable) continue;
        try {
          if (w.orphan || !w.branch) {
            await this.workspaces.removeOrphan(repo, w.path);
          } else {
            await this.workspaces.cleanup(
              repo,
              { ...task?.workspace ?? { path: w.path, branch: w.branch, baseRef: repo.defaultBranch, headCommit: null, mergedAt: null, discarded: true }, path: w.path, branch: w.branch },
              { deleteBranch: true, unmergedOk: !merged }
            );
          }
          if (task?.workspace) {
            this.store.putTask({ ...task, workspace: { ...task.workspace, discarded: true }, updatedAt: Date.now() });
          }
          removed += 1;
          freedKb += sizeKb;
        } catch (err) {
          errors.push(`${w.taskId}: ${err.message}`);
        }
      }
    }
    return { items, removed, freedKb, errors };
  }
  /** 把任务分支推到远端并（可选）开 PR —— 只有在仓库里显式允许推送时可用 */
  "task.publish"(input) {
    return this.runner.publish(input.taskId, { pr: input.pr !== false });
  }
  async "repo.worktrees"(repoId) {
    const repo = this.store.getRepo(repoId);
    if (!repo) throw new Error("\u4ED3\u5E93\u4E0D\u5B58\u5728");
    return this.workspaces.listWorktrees(repo);
  }
  /* ------------------------------ settings / engines ------------------------------ */
  async "settings.get"() {
    return this.store.getSettings();
  }
  async "settings.set"(patch) {
    const next = await this.store.setSettings(patch ?? {});
    this.runner.setConcurrency(next.concurrency);
    this.store.sweepAutoArchive();
    this.store.sweepAutoPurgeTrash();
    return next;
  }
  /** 导出脱敏配置包（自动剥离 API Key / 飞书密钥 / B站 Cookie / GitHub Token 等敏感凭据 B6） */
  async "settings.exportPreset"() {
    const cur = this.store.getSettings();
    const { githubToken: _gt, biliCookie: _bc, ...safeFeed } = cur.feed;
    void _gt;
    void _bc;
    return {
      version: 1,
      exportedAt: Date.now(),
      appVersion: this.hooks.version,
      settings: {
        concurrency: cur.concurrency,
        autoCommit: cur.autoCommit,
        autoArchiveDone: cur.autoArchiveDone ?? true,
        autoArchiveDays: cur.autoArchiveDays ?? 15,
        autoPurgeTrash: cur.autoPurgeTrash ?? false,
        autoPurgeTrashDays: cur.autoPurgeTrashDays ?? 30,
        autoCleanMergedWorktrees: cur.autoCleanMergedWorktrees ?? false,
        worktreeKeepRecent: cur.worktreeKeepRecent ?? 3,
        dailyTokenBudget: cur.dailyTokenBudget ?? 0,
        taskTokenBudget: cur.taskTokenBudget ?? 0,
        prCommand: cur.prCommand,
        theme: cur.theme,
        accent: cur.accent ?? "blue",
        prompt: {
          forbidQuestions: cur.prompt.forbidQuestions,
          carryOverChars: cur.prompt.carryOverChars,
          contextChars: cur.prompt.contextChars,
          specifyTemplateId: cur.prompt.specifyTemplateId,
          specifyTemplates: (cur.prompt.specifyTemplates ?? []).map((t) => ({ ...t }))
        },
        feed: {
          ...safeFeed,
          keywords: {
            model: [...cur.feed.keywords.model],
            tool: [...cur.feed.keywords.tool],
            skill: [...cur.feed.keywords.skill],
            exclude: [...cur.feed.keywords.exclude]
          },
          biliZones: [...cur.feed.biliZones],
          upMids: [...cur.feed.upMids]
        }
      },
      repoTemplates: this.store.listRepos().map((r) => ({
        name: r.name,
        defaultBranch: r.defaultBranch,
        verifyCommand: r.verifyCommand,
        autoFixRounds: r.autoFixRounds ?? 0,
        allowDirty: r.allowDirty,
        allowPush: r.allowPush ?? false,
        remote: r.remote ?? "origin",
        ...r.agentPermissions ? { agentPermissions: r.agentPermissions } : {},
        skillsDir: r.skillsDir ?? null
      }))
    };
  }
  /** 导入脱敏配置包（合并模板、关键词与安全偏好，保留本机敏感凭据 B6） */
  async "settings.importPreset"(bundle) {
    if (!bundle || typeof bundle !== "object") {
      throw new Error("\u914D\u7F6E\u5305\u683C\u5F0F\u65E0\u6548\uFF1A\u9700\u8981 JSON \u5BF9\u8C61");
    }
    const rawSettings = "settings" in bundle && bundle.settings && typeof bundle.settings === "object" ? bundle.settings : bundle;
    const cur = this.store.getSettings();
    const incomingPrompt = rawSettings.prompt && typeof rawSettings.prompt === "object" ? rawSettings.prompt : {};
    const incomingTemplates = Array.isArray(incomingPrompt.specifyTemplates) ? incomingPrompt.specifyTemplates.filter(
      (t) => t && typeof t.id === "string" && typeof t.name === "string" && (typeof t.instruction === "string" || typeof t.body === "string")
    ) : [];
    const mergedTemplatesMap = new Map(cur.prompt.specifyTemplates.map((t) => [t.id, t]));
    let importedTemplates = 0;
    for (const t of incomingTemplates) {
      mergedTemplatesMap.set(String(t.id), {
        id: String(t.id),
        name: String(t.name),
        instruction: String(t.instruction ?? t.body ?? "")
      });
      importedTemplates += 1;
    }
    const incomingFeed = rawSettings.feed && typeof rawSettings.feed === "object" ? rawSettings.feed : {};
    const rawKw = incomingFeed.keywords;
    const mergedKeywords = {
      model: [...cur.feed.keywords.model],
      tool: [...cur.feed.keywords.tool],
      skill: [...cur.feed.keywords.skill],
      exclude: [...cur.feed.keywords.exclude]
    };
    let importedKeywords = 0;
    if (Array.isArray(rawKw)) {
      const list = rawKw.map((k) => String(k).trim()).filter(Boolean);
      mergedKeywords.tool = [.../* @__PURE__ */ new Set([...mergedKeywords.tool, ...list])];
      importedKeywords = list.length;
    } else if (rawKw && typeof rawKw === "object") {
      const kwObj = rawKw;
      for (const bucket of ["model", "tool", "skill", "exclude"]) {
        if (Array.isArray(kwObj[bucket])) {
          const list = kwObj[bucket].map((k) => String(k).trim()).filter(Boolean);
          mergedKeywords[bucket] = [.../* @__PURE__ */ new Set([...mergedKeywords[bucket], ...list])];
          importedKeywords += list.length;
        }
      }
    }
    const incomingApi = rawSettings.api && typeof rawSettings.api === "object" ? { ...rawSettings.api } : {};
    delete incomingApi.apiKey;
    const safeFeed = {
      ...cur.feed,
      ...incomingFeed,
      keywords: mergedKeywords,
      githubToken: cur.feed.githubToken,
      biliCookie: cur.feed.biliCookie
    };
    delete safeFeed.bilibiliCookie;
    const patch = {
      ...typeof rawSettings.activeAdapter === "string" ? { activeAdapter: rawSettings.activeAdapter } : {},
      ...typeof rawSettings.concurrency === "number" ? { concurrency: rawSettings.concurrency } : {},
      ...typeof rawSettings.autoCommit === "boolean" ? { autoCommit: rawSettings.autoCommit } : {},
      ...typeof rawSettings.autoArchiveDone === "boolean" ? { autoArchiveDone: rawSettings.autoArchiveDone } : {},
      ...typeof rawSettings.autoArchiveDays === "number" ? { autoArchiveDays: rawSettings.autoArchiveDays } : {},
      ...typeof rawSettings.autoPurgeTrash === "boolean" ? { autoPurgeTrash: rawSettings.autoPurgeTrash } : {},
      ...typeof rawSettings.autoPurgeTrashDays === "number" ? { autoPurgeTrashDays: rawSettings.autoPurgeTrashDays } : {},
      ...typeof rawSettings.autoCleanMergedWorktrees === "boolean" ? { autoCleanMergedWorktrees: rawSettings.autoCleanMergedWorktrees } : {},
      ...typeof rawSettings.worktreeKeepRecent === "number" ? { worktreeKeepRecent: rawSettings.worktreeKeepRecent } : {},
      ...typeof rawSettings.taskTokenBudget === "number" ? { taskTokenBudget: rawSettings.taskTokenBudget } : {},
      ...typeof rawSettings.dailyTokenBudget === "number" ? { dailyTokenBudget: rawSettings.dailyTokenBudget } : {},
      ...Array.isArray(rawSettings.webhookEvents) ? { webhookEvents: rawSettings.webhookEvents } : {},
      ...typeof rawSettings.prCommand === "string" ? { prCommand: rawSettings.prCommand } : {},
      ...typeof rawSettings.theme === "string" ? { theme: rawSettings.theme } : {},
      ...typeof rawSettings.accent === "string" ? { accent: rawSettings.accent } : {},
      ...rawSettings.cli && typeof rawSettings.cli === "object" ? { cli: rawSettings.cli } : {},
      ...Object.keys(incomingApi).length ? { api: { ...cur.api, ...incomingApi } } : {},
      prompt: {
        forbidQuestions: typeof incomingPrompt.forbidQuestions === "boolean" ? incomingPrompt.forbidQuestions : cur.prompt.forbidQuestions,
        carryOverChars: typeof incomingPrompt.carryOverChars === "number" ? incomingPrompt.carryOverChars : cur.prompt.carryOverChars,
        contextChars: typeof incomingPrompt.contextChars === "number" ? incomingPrompt.contextChars : cur.prompt.contextChars,
        specifyTemplateId: typeof incomingPrompt.specifyTemplateId === "string" ? incomingPrompt.specifyTemplateId : cur.prompt.specifyTemplateId,
        specifyTemplates: [...mergedTemplatesMap.values()]
      },
      feed: safeFeed
    };
    const next = await this["settings.set"](patch);
    return { settings: next, importedTemplates, importedKeywords };
  }
  /** 发送一条测试 Webhook 通知（B5） */
  async "webhook.test"(input) {
    const url = (input?.url ?? this.store.getSettings().webhookUrl ?? "").trim();
    if (!url) return { ok: false, status: 0, detail: "\u8BF7\u5148\u586B\u5199 Webhook \u5730\u5740" };
    return sendWebhookNotification({
      url,
      event: "test",
      ideaTitle: "Webhook \u8FDE\u901A\u6027\u6D4B\u8BD5",
      summary: "\u5982\u679C\u4F60\u5728\u7FA4\u804A\u6216\u7AEF\u70B9\u6536\u5230\u672C\u6761\u6D88\u606F\uFF0C\u8BF4\u660E AI \u4EFB\u52A1\u53F0 Webhook \u901A\u77E5\u5DF2\u914D\u7F6E\u6210\u529F\u3002"
    });
  }
  async "engines.status"() {
    const settings = this.store.getSettings();
    const out = [];
    for (const a of this.registry.list()) {
      const caps = await a.capabilities(settings);
      out.push({
        id: a.id,
        label: a.label,
        streaming: caps.streaming,
        tools: caps.tools,
        resume: caps.resume,
        available: caps.available,
        detail: caps.detail ?? "",
        active: settings.activeAdapter === a.id
      });
    }
    return out;
  }
  /**
   * 扫一遍 PATH 看各家 CLI 装了哪些。**只查文件存在**，不跑 `--version`——
   * 有些 CLI 冷启动要几百毫秒到几秒，设置页不该为这个卡住。
   */
  async "engines.detect"() {
    const out = [];
    for (const p of CLI_PRESET_LIST) {
      const names = [p.command, ...p.aliases ?? []];
      let found = null;
      let used = p.command;
      for (const n of names) {
        const hit = await whichExecutable(n);
        if (hit) {
          found = hit;
          used = n;
          break;
        }
      }
      out.push({
        id: p.id,
        label: p.label,
        command: used,
        installed: Boolean(found),
        path: found,
        note: p.note,
        install: p.install,
        invocation: describeCliInvocation(p)
      });
    }
    return out;
  }
  async "engines.test"(id) {
    const settings = this.store.getSettings();
    if (id === "mock") return { ok: true, detail: "\u6F14\u793A\u5F15\u64CE\u59CB\u7EC8\u53EF\u7528\uFF08\u4F1A\u5728 worktree \u91CC\u771F\u7684\u843D\u76D8\uFF0C\u4FBF\u4E8E\u9A8C\u6536\u95ED\u73AF\uFF09" };
    if (id === "cli") {
      const bin = settings.cli.command.trim() || "claude";
      const preset = resolveCliPreset(settings.cli.profile, bin);
      const { execFile: execFile3 } = await import("node:child_process");
      const { promisify: promisify3 } = await import("node:util");
      const label = settings.cli.argsTemplate.trim() ? `${preset.label}\uFF08\u53C2\u6570\u7528\u81EA\u5B9A\u4E49\u6A21\u677F\uFF09` : preset.label;
      const plan = await planExec(bin, preset.versionArgs);
      if (!plan.resolved) {
        return {
          ok: false,
          detail: `PATH \u91CC\u627E\u4E0D\u5230 \`${bin}\`\uFF08${preset.install ? `\u6CA1\u88C5\uFF1A${preset.install}\uFF1B` : ""}\u88C5\u597D\u5E76\u767B\u5F55\u540E\u518D\u8BD5\uFF0C\u6216\u5728\u300C\u547D\u4EE4\u300D\u91CC\u586B\u7EDD\u5BF9\u8DEF\u5F84\uFF0C\u6216\u6539\u7528 API \u6A21\u5F0F\uFF09`
        };
      }
      try {
        const { stdout } = await promisify3(execFile3)(plan.file, plan.args, {
          timeout: 15e3,
          windowsVerbatimArguments: plan.windowsVerbatimArguments
        });
        return { ok: true, detail: `${label}\uFF1A${bin} ${preset.versionArgs.join(" ")} \u2192 ${stdout.trim().split("\n")[0] ?? "\u5DF2\u54CD\u5E94"}` };
      } catch (err) {
        const e = err;
        return { ok: false, detail: `${bin} ${preset.versionArgs.join(" ")} \u5931\u8D25\uFF1A${e.message}` };
      }
    }
    const api = settings.api;
    if (!api.apiKey.trim()) return { ok: false, detail: "\u8FD8\u6CA1\u586B API Key" };
    const base = api.baseUrl.replace(/\/+$/, "");
    try {
      if (api.provider === "anthropic") {
        const res2 = await fetch(`${base}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": api.apiKey, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({ model: api.model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] })
        });
        if (!res2.ok) return { ok: false, detail: `HTTP ${res2.status}\uFF1A${oneLine(await res2.text())}` };
        await res2.body?.cancel();
        return { ok: true, detail: `${api.model} \u8FDE\u901A\uFF08\u5DF2\u6536\u5230\u54CD\u5E94\u5934\uFF09` };
      }
      let res = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${api.apiKey}` } });
      if (res.status === 404) {
        res = await fetch(`${base}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${api.apiKey}` },
          body: JSON.stringify({ model: api.model, max_tokens: 1, messages: [{ role: "user", content: "ping" }], stream: false })
        });
        if (!res.ok) return { ok: false, detail: `HTTP ${res.status}\uFF1A${oneLine(await res.text())}` };
        await res.body?.cancel();
        return { ok: true, detail: `${api.model} \u8FDE\u901A\uFF08chat/completions \u6B63\u5E38\uFF09` };
      }
      if (!res.ok) return { ok: false, detail: `HTTP ${res.status}\uFF1A${oneLine(await res.text())}` };
      const j = await res.json();
      const names = (j.data ?? []).map((m) => m.id);
      const has = names.length === 0 || names.includes(api.model);
      return {
        ok: true,
        detail: `\u7AEF\u70B9\u53EF\u7528${names.length ? `\uFF0C\u53EF\u89C1 ${names.length} \u4E2A\u6A21\u578B${has ? "" : `\uFF08\u6CE8\u610F\uFF1A\u5217\u8868\u91CC\u6CA1\u6709 ${api.model}\uFF09`}` : ""}`
      };
    } catch (err) {
      return { ok: false, detail: `\u8BF7\u6C42\u5931\u8D25\uFF1A${err.message}` };
    }
  }
  /* ------------------------------ 新闻合集 ------------------------------ */
  async "feed.get"(input) {
    return this.feed.get(input ?? {});
  }
  async "feed.refresh"(input) {
    return this.feed.refresh(input?.source);
  }
  /**
   * 以此内容记录想法：条目 → 想法（标题/正文/标签都来自同一份事实），并登记 key→ideaId。
   * 幂等：同一条目已记录且想法还在 → 直接返回；想法被删了 → 允许重新记录。
   */
  async "feed.record"(input) {
    const item = this.feed.item(input.key);
    if (!item) throw new Error("\u8FD9\u6761\u5185\u5BB9\u5DF2\u4E0D\u5728\u5F53\u524D\u5408\u96C6\u91CC\uFF08\u53EF\u80FD\u88AB\u65B0\u4E00\u6279\u5237\u65B0\u6362\u6389\u4E86\uFF09\uFF0C\u5237\u65B0\u540E\u518D\u8BD5");
    if (item.ideaId && this.store.getIdea(item.ideaId)) {
      if (input.alsoSpecify) {
        void this["idea.specify"](item.ideaId).catch(() => void 0);
      }
      return { ideaId: item.ideaId, created: false };
    }
    const idea = await this["idea.create"]({
      title: feedIdeaTitle(item),
      description: feedIdeaDescription(item),
      tags: feedIdeaTags(item),
      priority: "p2",
      repoId: null,
      workDir: null
    });
    await this.feed.markRecorded(input.key, idea.id);
    if (input.alsoSpecify) {
      void this["idea.specify"](idea.id).catch(() => void 0);
    }
    return { ideaId: idea.id, created: true };
  }
  async "feed.star"(input) {
    return this.feed.star(input.key, input.note);
  }
  async "feed.unstar"(input) {
    return this.feed.unstar(input.key);
  }
  async "feed.hide"(input) {
    return this.feed.hide(input.key);
  }
  async "feed.unhide"(input) {
    return this.feed.unhide(input.key);
  }
  async "feed.sources.test"(input) {
    return this.feed.testSources(input?.source);
  }
  /* ------------------------------ 日历导出 ------------------------------ */
  /**
   * 把「某天 / 某月」记的想法与收藏的新闻导成 .ics + CSV。
   *
   * 分工：内容生成交给 shared 的纯函数（零依赖、可单测），这里只做
   * 取数 → 过滤 → 写盘 → 把文本一起回给前端。
   *
   * 为什么文本也回给前端：面板可能跑在 web 模式，那里 app.reveal 不可用
   * （src/web/l3.ts 不注入 hooks.reveal），"写盘 + 打开目录"这条路走不通，
   * 下载只能由前端用 Blob 触发。所以两样都给：下载是主动作，路径只展示/可复制。
   * 文件名同范围同名覆盖，反复导出不会在 exports/ 里堆 (1)(2)。
   */
  async "calendar.export"(input) {
    const scope = input?.scope === "day" ? "day" : "month";
    const month = String(input?.month ?? "").trim();
    if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("\u6708\u4EFD\u683C\u5F0F\u5E94\u4E3A YYYY-MM");
    const day = String(input?.day ?? "").trim() || dayKey(Date.now());
    if (scope === "day" && !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("\u65E5\u671F\u683C\u5F0F\u5E94\u4E3A YYYY-MM-DD");
    const formats = (input?.formats?.length ? input.formats : ["ics", "csv"]).filter(
      (f) => f === "ics" || f === "csv"
    );
    if (!formats.length) throw new Error("\u81F3\u5C11\u8981\u9009\u4E00\u79CD\u5BFC\u51FA\u683C\u5F0F");
    const key = scope === "day" ? day : month;
    const inScope = (ts) => dayKey(ts).startsWith(key);
    const ideas = this.store.listIdeas({}).filter((i) => inScope(i.createdAt));
    const favorites = this.feed.listFavorites().filter((f) => inScope(f.savedAt));
    const rows = toRows(ideas, favorites);
    const dir = paths.exports();
    fs12.mkdirSync(dir, { recursive: true });
    const files = [];
    for (const format of formats) {
      const content = format === "ics" ? buildIcs(rows) : buildCsv(rows);
      const filename = `ai-tasks-\u65E5\u5386-${key}.${format}`;
      const target = path16.join(dir, filename);
      fs12.writeFileSync(target, content, "utf8");
      files.push({
        format,
        filename,
        path: target,
        bytes: new TextEncoder().encode(content).length,
        content
      });
    }
    return { scope, key, files, counts: { ideas: ideas.length, news: favorites.length } };
  }
  /* ------------------------------ backup ------------------------------ */
  async "backup.list"() {
    return this.backup.list();
  }
  async "backup.create"(input) {
    return this.backup.create(input ?? {});
  }
  async "backup.preview"(input) {
    return this.backup.preview(input.id);
  }
  /** 恢复 = 恢复前自动安全快照 + 逐文件写回 + 内核重载（否则界面还是旧数据） */
  async "backup.restore"(input) {
    const result = await this.backup.restore(input);
    if (result.dryRun) return result;
    await this.reloadAfterRestore();
    return { ...result, reloaded: true };
  }
  async "backup.verify"(input) {
    return this.backup.verify(input ?? {});
  }
  async "backup.export"(input) {
    return this.backup.export(input ?? {});
  }
  async "backup.import"(input) {
    const result = await this.backup.import(input);
    if (result.dryRun) return result;
    await this.reloadAfterRestore();
    return { ...result, reloaded: true };
  }
  async "backup.prune"(input) {
    return this.backup.prune(input ?? {});
  }
  /** 恢复/导入之后：重读磁盘上的实体 + 让新闻合集也重读（文件可能是被恢复回来的） */
  async reloadAfterRestore() {
    await this.store.reload();
    await this.feed.reload();
  }
  /* ------------------------------ feishu ------------------------------ */
  async "feishu.status"() {
    return this.feishu.status();
  }
  async "feishu.test"() {
    return this.feishu.test();
  }
  async "feishu.setupFields"() {
    return this.feishu.setupFields();
  }
  async "feishu.sync"(input) {
    return this.feishu.sync(input ?? {});
  }
  async "feishu.restoreMissing"(input) {
    const result = await this.feishu.restoreMissing(input ?? {});
    if (!result.dryRun && result.imported > 0) {
      await this.store.flush();
      await this.reloadAfterRestore();
    }
    return result;
  }
  /** 从飞书双向拉取修改与新增（带墓碑防回环 B7） */
  async "feishu.pull"(input) {
    const result = await this.feishu.pullUpdates(input ?? {});
    if (!result.dryRun && (result.updated > 0 || result.created > 0)) {
      await this.store.flush();
      await this.reloadAfterRestore();
    }
    return result;
  }
  /* ------------------------------ app ------------------------------ */
  async "app.pickDir"() {
    if (!this.hooks.pickDirectory) throw new Error("\u6D4F\u89C8\u5668\u9884\u89C8\u6A21\u5F0F\u65E0\u6CD5\u5F39\u51FA\u76EE\u5F55\u9009\u62E9\u5668\uFF0C\u8BF7\u624B\u52A8\u586B\u5199\u7EDD\u5BF9\u8DEF\u5F84");
    return this.hooks.pickDirectory();
  }
  async "app.pickFile"(input) {
    if (!this.hooks.pickFile) throw new Error("\u6D4F\u89C8\u5668\u9884\u89C8\u6A21\u5F0F\u65E0\u6CD5\u5F39\u51FA\u6587\u4EF6\u9009\u62E9\u5668\uFF0C\u8BF7\u624B\u52A8\u586B\u5199\u5907\u4EFD\u5305\u7684\u7EDD\u5BF9\u8DEF\u5F84");
    return this.hooks.pickFile(input?.title);
  }
  async "app.reveal"(target) {
    if (!this.hooks.reveal) throw new Error("\u5F53\u524D\u6A21\u5F0F\u4E0D\u652F\u6301\u6253\u5F00\u6587\u4EF6\u7BA1\u7406\u5668");
    await this.hooks.reveal(path16.resolve(target));
    return { ok: true };
  }
  async "app.info"() {
    return {
      dataDir: paths.root(),
      version: this.hooks.version,
      platform: process.platform,
      mode: this.hooks.mode,
      buildAt: BUILD_AT,
      apiRev: API_REV
    };
  }
  async "app.reload"() {
    await this.store.flush();
    await this.reloadAfterRestore();
    if (this.hooks.reloadL3) {
      const r = await this.hooks.reloadL3();
      return {
        reloaded: r.reloaded,
        version: r.version,
        buildAt: r.buildAt,
        note: r.reloaded ? `\u8FDB\u7A0B\u5185 L3 \u5185\u6838\u5DF2\u70ED\u91CD\u8F7D\u81F3 v${r.version}` : `\u5185\u6838\u5DF2\u662F\u6700\u65B0\u72B6\u6001\uFF08v${r.version}\uFF09\uFF0C\u5DF2\u91CD\u8BFB\u672C\u5730\u6570\u636E`
      };
    }
    return {
      reloaded: true,
      version: this.hooks.version,
      buildAt: BUILD_AT,
      note: `\u5DF2\u91CD\u65B0\u52A0\u8F7D\u672C\u5730\u6570\u636E\u4E0E\u72B6\u6001\uFF08v${this.hooks.version}\uFF09`
    };
  }
  async shutdown() {
    for (const t of [...this.store.listTasks({ status: ["running", "queued"] })]) this.runner.cancel(t.id);
    await this.backup.captureOnExit().catch(() => void 0);
    this.runner.dispose();
    this.backup.dispose();
    this.feishu.dispose();
    this.feed.dispose();
    await this.store.close();
  }
};
function normalizePerm(v) {
  const mode = v?.mode;
  if (mode !== "allowlist" && mode !== "full") return void 0;
  const extraDeny = (v?.extraDeny ?? []).map((s) => String(s).trim()).filter(Boolean);
  return { mode, ...extraDeny.length ? { extraDeny } : {} };
}
function oneLine(s) {
  return (s ?? "").replace(/\s+/g, " ").trim().slice(0, 320);
}
function normalizeTitle(raw) {
  let out = String(raw ?? "").replace(/[ \t]+/g, " ");
  out = out.replace(/(\S) *\n+(\S)/g, (_m, a, b) => isWideChar(a) || isWideChar(b) ? `${a}${b}` : `${a} ${b}`);
  out = out.replace(/\s+/g, " ").trim();
  if (out.length > 200) out = `${out.slice(0, 199)}\u2026`;
  return out;
}
function isWideChar(ch) {
  return /[\u2e80-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff00-\uffef]/.test(ch);
}
function normalizeTags(tags) {
  if (!tags) return [];
  return [...new Set(tags.map((t) => t.trim()).filter(Boolean))].slice(0, 12);
}
function normalizeBlockedBy(blockedBy, selfId) {
  if (!Array.isArray(blockedBy)) return [];
  return [
    ...new Set(
      blockedBy.map((id) => String(id ?? "").trim()).filter((id) => Boolean(id) && id !== selfId)
    )
  ].slice(0, 20);
}
function isActive(t) {
  return t.status === "queued" || t.status === "running";
}
function decodeHtmlEntities(s) {
  return s.replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&nbsp;/gi, " ").replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n) || 32)).replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16) || 32)).trim();
}
function extractHtmlTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? decodeHtmlEntities(m[1].replace(/\s+/g, " ")) : "";
}
function extractHtmlMeta(html, nameOrProp) {
  const esc = nameOrProp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const r1 = new RegExp(`<meta[^>]+(?:property|name)=["']${esc}["'][^>]+content=["']([^"']*?)["']`, "i");
  const r2 = new RegExp(`<meta[^>]+content=["']([^"']*?)["'][^>]+(?:property|name)=["']${esc}["']`, "i");
  const m = r1.exec(html) ?? r2.exec(html);
  return m ? decodeHtmlEntities(m[1].replace(/\s+/g, " ")) : "";
}

// src/shared/version.ts
var APP_VERSION = "0.3.48";

// src/core/server/http.ts
import http from "node:http";
import crypto2 from "node:crypto";
import fs13 from "node:fs";
import path17 from "node:path";
import { Buffer as Buffer4 } from "node:buffer";
var BRIDGE_MAX_BODY_BYTES = 64 * 1024;
function isLoopbackHostname(hostname) {
  const h = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}
function verifyBridgeTokenConstantTime(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer4.from(provided, "utf8");
  const b = Buffer4.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto2.timingSafeEqual(a, b);
}
function extractBridgeTokenFromHeaders(headers) {
  const auth = typeof headers.authorization === "string" ? headers.authorization.trim() : "";
  if (/^bearer\s+/i.test(auth)) {
    return auth.replace(/^bearer\s+/i, "").trim();
  }
  const custom = headers["x-aitm-bridge-token"];
  if (typeof custom === "string") return custom.trim();
  return "";
}
function checkBridgeOriginAndHost(req, opts = {}) {
  const hostHeader = typeof req.headers.host === "string" ? req.headers.host.trim() : "";
  if (!opts.allowNonLoopbackHost && hostHeader) {
    let parsedHost = "";
    try {
      parsedHost = new URL(`http://${hostHeader}`).hostname;
    } catch {
      return { ok: false, status: 403, code: "forbidden-host", message: "\u975E\u6CD5\u7684 Host \u8BF7\u6C42\u5934" };
    }
    if (!isLoopbackHostname(parsedHost)) {
      return { ok: false, status: 403, code: "forbidden-host", message: "\u6865\u63A5\u63A5\u53E3\u4EC5\u5141\u8BB8\u56DE\u73AF\u5730\u5740\uFF08127.0.0.1 / localhost / ::1\uFF09\u8BBF\u95EE" };
    }
  }
  const secFetchSite = typeof req.headers["sec-fetch-site"] === "string" ? req.headers["sec-fetch-site"].trim().toLowerCase() : "";
  if (secFetchSite === "cross-site") {
    return { ok: false, status: 403, code: "forbidden-origin", message: "\u62D2\u7EDD\u8DE8\u7AD9\u8BF7\u6C42\uFF08Sec-Fetch-Site: cross-site\uFF09" };
  }
  const origin = typeof req.headers.origin === "string" ? req.headers.origin.trim() : "";
  if (origin) {
    if (origin === "null") {
      return { ok: false, status: 403, code: "forbidden-origin", message: "\u62D2\u7EDD\u6C99\u7BB1\u6216\u533F\u540D\u6E90\u8BF7\u6C42\uFF08Origin: null\uFF09" };
    }
    let originHost = "";
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      return { ok: false, status: 403, code: "forbidden-origin", message: "\u975E\u6CD5\u7684 Origin \u8BF7\u6C42\u5934" };
    }
    if (!hostHeader || originHost !== hostHeader.toLowerCase()) {
      return { ok: false, status: 403, code: "forbidden-origin", message: "\u62D2\u7EDD\u8DE8\u6E90\u8BF7\u6C42\uFF08Origin \u4E0E Host \u4E0D\u5339\u914D\uFF09" };
    }
  }
  return { ok: true };
}
async function handleBridgeRequest(req, res, url, bridge, bridgeToken, allowNonLoopbackHost) {
  const sendBridge = (status, body, extraHeaders = {}) => {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extraHeaders
    });
    res.end(JSON.stringify(body));
  };
  const fence = checkBridgeOriginAndHost(req, { allowNonLoopbackHost });
  if (!fence.ok) {
    sendBridge(fence.status, {
      protocol: BRIDGE_PROTOCOL_VERSION,
      ok: false,
      error: { code: fence.code, message: fence.message }
    });
    return;
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    });
    res.end();
    return;
  }
  const providedToken = extractBridgeTokenFromHeaders(req.headers);
  if (!verifyBridgeTokenConstantTime(providedToken, bridgeToken)) {
    sendBridge(
      401,
      {
        protocol: BRIDGE_PROTOCOL_VERSION,
        ok: false,
        error: { code: "unauthorized", message: "\u7F3A\u5C11\u6216\u65E0\u6548\u7684\u6865\u63A5\u8BA4\u8BC1\u4EE4\u724C" }
      },
      { "www-authenticate": 'Bearer realm="ai-tasks-mgr-bridge-v1"' }
    );
    return;
  }
  const prefix = url.pathname.startsWith("/api/bridge") ? "/api/bridge" : "/bridge";
  const subPath = url.pathname.slice(prefix.length) || "/";
  if (subPath !== "/v1" && !subPath.startsWith("/v1/")) {
    sendBridge(400, {
      protocol: BRIDGE_PROTOCOL_VERSION,
      ok: false,
      error: { code: "incompatible", message: `\u4E0D\u652F\u6301\u7684\u6865\u63A5\u534F\u8BAE\u8DEF\u5F84\uFF1A${subPath}\uFF08\u4EC5\u652F\u6301 /v1\uFF09` }
    });
    return;
  }
  const routePath = subPath.slice("/v1".length) || "/";
  const idempotencyKey = typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"].trim() : "";
  const readBridgeJson = async () => {
    let raw = "";
    try {
      raw = await readBody(req, BRIDGE_MAX_BODY_BYTES);
    } catch (err) {
      throw new BridgeApiError(413, "bad-request", err.message || "\u8BF7\u6C42\u4F53\u8FC7\u5927");
    }
    if (!raw.trim()) return {};
    try {
      return JSON.parse(raw);
    } catch {
      throw new BridgeApiError(400, "bad-request", "\u8BF7\u6C42\u4F53\u4E0D\u662F\u5408\u6CD5 JSON");
    }
  };
  try {
    if (routePath === "/discovery" || routePath === "/health") {
      if (req.method !== "GET") {
        throw new BridgeApiError(405, "method-not-allowed", `${routePath} \u4EC5\u652F\u6301 GET \u8BF7\u6C42`);
      }
      const data = bridge.discovery({ base: `${prefix}/v1` });
      sendBridge(200, data);
      return;
    }
    if (routePath === "/ideas") {
      if (req.method !== "POST") {
        throw new BridgeApiError(405, "method-not-allowed", "/ideas \u4EC5\u652F\u6301 POST \u8BF7\u6C42");
      }
      const body = await readBridgeJson();
      const data = await bridge.createIdea(body, { idempotencyKey });
      sendBridge(200, data);
      return;
    }
    const previewMatch = /^\/ideas\/([^/]+)\/start-preview$/.exec(routePath);
    if (previewMatch) {
      if (req.method !== "POST") {
        throw new BridgeApiError(405, "method-not-allowed", "/ideas/:ideaId/start-preview \u4EC5\u652F\u6301 POST \u8BF7\u6C42");
      }
      const ideaId = decodeURIComponent(previewMatch[1]);
      const body = await readBridgeJson();
      const data = await bridge.previewStart(ideaId, body);
      sendBridge(200, data);
      return;
    }
    const startMatch = /^\/ideas\/([^/]+)\/start$/.exec(routePath);
    if (startMatch) {
      if (req.method !== "POST") {
        throw new BridgeApiError(405, "method-not-allowed", "/ideas/:ideaId/start \u4EC5\u652F\u6301 POST \u8BF7\u6C42");
      }
      const ideaId = decodeURIComponent(startMatch[1]);
      const body = await readBridgeJson();
      const data = await bridge.startWork(ideaId, body, { idempotencyKey });
      sendBridge(200, data);
      return;
    }
    throw new BridgeApiError(404, "not-found", `\u672A\u5F00\u653E\u8BE5\u6865\u63A5\u7AEF\u70B9\uFF1A${routePath}\uFF08\u4EC5\u5F00\u653E\u53D7\u9650\u767D\u540D\u5355\u52A8\u4F5C\uFF09`);
  } catch (err) {
    if (err instanceof BridgeApiError) {
      sendBridge(err.status, err.toEnvelope());
      return;
    }
    sendBridge(500, {
      protocol: BRIDGE_PROTOCOL_VERSION,
      ok: false,
      error: {
        code: "internal-error",
        message: err?.message || "\u6865\u63A5\u670D\u52A1\u5185\u90E8\u9519\u8BEF"
      }
    });
  }
}
var ACTIONS = new Set(AppApi.actions);
async function startHttpApi(app, opts) {
  const bridgeToken = (opts.bridgeToken ?? process.env.AITM_BRIDGE_TOKEN ?? "").trim() || crypto2.randomBytes(32).toString("base64url");
  const allowNonLoopbackHost = Boolean(opts.host && !isLoopbackHostname(opts.host));
  const clients = /* @__PURE__ */ new Set();
  const unsubscribe = app.store.bus.subscribe((ev) => {
    opts.onEvent?.(ev);
    const data = `data: ${JSON.stringify(ev)}

`;
    for (const res of clients) {
      res.write(data);
    }
  });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname === "/api/bridge" || url.pathname.startsWith("/api/bridge/") || url.pathname === "/bridge" || url.pathname.startsWith("/bridge/")) {
      await handleBridgeRequest(req, res, url, app.bridge, bridgeToken, allowNonLoopbackHost);
      return;
    }
    const send = (code, body, headers = {}) => {
      res.writeHead(code, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", ...headers });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type"
      });
      res.end();
      return;
    }
    if (url.pathname === "/api/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "access-control-allow-origin": "*"
      });
      res.write("retry: 1500\n\n");
      clients.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 2e4);
      ping.unref?.();
      req.on("close", () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }
    const m = /^\/api\/([a-zA-Z.]+)$/.exec(url.pathname);
    if (m && req.method === "POST") {
      const action = m[1];
      if (!ACTIONS.has(action)) return send(404, { ok: false, error: `\u672A\u77E5\u63A5\u53E3\uFF1A${action}` });
      const raw = await readBody(req);
      let payload = void 0;
      if (raw) {
        try {
          payload = JSON.parse(raw);
        } catch {
          return send(400, { ok: false, error: "\u8BF7\u6C42\u4F53\u4E0D\u662F\u5408\u6CD5 JSON" });
        }
      }
      const result = await app.invoke(action, payload);
      return send(result.ok ? 200 : 400, result);
    }
    if (url.pathname === "/api/attachment" && req.method === "GET") {
      const ideaId = url.searchParams.get("ideaId") ?? "";
      const id = url.searchParams.get("id") ?? "";
      try {
        const got = await app["attachment.get"]({ ideaId, id });
        const buf = Buffer4.from(got.dataBase64, "base64");
        res.writeHead(200, {
          "content-type": got.mime || "application/octet-stream",
          "cache-control": "public, max-age=86400",
          "access-control-allow-origin": "*"
        });
        res.end(buf);
      } catch (err) {
        send(404, { ok: false, error: err.message });
      }
      return;
    }
    if (url.pathname === "/api/health") {
      let info = {};
      try {
        info = await app["app.info"]();
      } catch {
      }
      return send(200, {
        ok: true,
        mode: "web",
        actions: ACTIONS.size,
        apiRev: API_REV,
        version: info.version,
        dataDir: info.dataDir,
        buildAt: info.buildAt ?? null
      });
    }
    if (url.pathname.startsWith("/api/")) {
      return send(404, { ok: false, error: `\u672A\u6CE8\u518C\u7684\u63A5\u53E3\uFF1A${url.pathname.slice(5)}` });
    }
    if (opts.staticDir && fs13.existsSync(opts.staticDir)) {
      const rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
      const abs = path17.resolve(opts.staticDir, rel);
      if (abs.startsWith(path17.resolve(opts.staticDir)) && fs13.existsSync(abs) && fs13.statSync(abs).isFile()) {
        const ext = path17.extname(abs).toLowerCase();
        const type = ext === ".html" ? "text/html; charset=utf-8" : ext === ".js" || ext === ".mjs" ? "text/javascript; charset=utf-8" : ext === ".css" ? "text/css; charset=utf-8" : ext === ".json" ? "application/json; charset=utf-8" : ext === ".svg" ? "image/svg+xml" : "application/octet-stream";
        res.writeHead(200, { "content-type": type });
        return res.end(fs13.readFileSync(abs));
      }
      const index = path17.join(opts.staticDir, "index.html");
      if (fs13.existsSync(index)) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(fs13.readFileSync(index));
      }
    }
    const sd = opts.staticDir ? `${opts.staticDir}${fs13.existsSync(opts.staticDir) ? "" : "\uFF08\u76EE\u5F55\u4E0D\u5B58\u5728\uFF01\uFF09"}` : "\u672A\u914D\u7F6E\u9759\u6001\u76EE\u5F55";
    send(404, { ok: false, error: `not found: ${url.pathname}\uFF08\u9759\u6001\u76EE\u5F55: ${sd}\uFF09` });
  });
  server.on("close", () => unsubscribe());
  await new Promise((resolve) => server.listen(opts.port, opts.host ?? "127.0.0.1", resolve));
  const withBridge = server;
  withBridge.bridgeToken = bridgeToken;
  return withBridge;
}
function readBody(req, maxBytes = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error("\u8BF7\u6C42\u4F53\u8FC7\u5927"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer4.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// src/web/l3.ts
function createRestrictedBridgeFacade(bridge) {
  const caps = Object.freeze([...BRIDGE_CAPABILITIES]);
  return Object.freeze({
    protocol: BRIDGE_PROTOCOL_VERSION,
    service: BRIDGE_SERVICE_ID,
    capabilities: caps,
    async discovery(extra) {
      return bridge.discovery(extra);
    },
    async createIdea(input, opts) {
      return bridge.createIdea(input, opts);
    },
    async previewStart(ideaId, input) {
      return bridge.previewStart(ideaId, input);
    },
    async startWork(ideaId, input, opts) {
      return bridge.startWork(ideaId, input, opts);
    }
  });
}
async function createL3(opts = {}) {
  const home = path18.resolve(opts.home ?? process.env.AI_TASKS_HOME ?? path18.resolve(process.cwd(), ".aitasks"));
  const host = opts.host ?? "127.0.0.1";
  setDataRoot(home);
  process.env.AI_TASKS_HOME = home;
  const app = await AppApi.create(
    {
      mode: "web",
      version: opts.version ?? process.env.npm_package_version ?? APP_VERSION,
      reloadL3: opts.reloadL3
    },
    { spawn: opts.spawn ?? null, hostSession: opts.hostSession ?? null }
  );
  const server = await startHttpApi(app, {
    port: opts.port ?? 0,
    host,
    staticDir: opts.staticDir ?? null,
    bridgeToken: opts.bridgeToken ?? null
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const restrictedBridge = createRestrictedBridgeFacade(app.bridge);
  const health = async () => {
    let info = {};
    try {
      info = await app["app.info"]();
    } catch {
    }
    return {
      ok: true,
      mode: "web",
      actions: AppApi.actions.length,
      apiRev: API_REV,
      version: info.version,
      dataDir: info.dataDir,
      buildAt: info.buildAt ?? null
    };
  };
  let stopped = false;
  return {
    app,
    server,
    base: `http://${host}:${port}`,
    port,
    home,
    bridgeToken: server.bridgeToken,
    bridge: restrictedBridge,
    async invoke(action, payload) {
      const result = await app.invoke(action, payload ?? {});
      if (!result?.ok) throw new Error(result?.error ?? `action ${action} \u5931\u8D25`);
      return result.data;
    },
    health,
    async stop() {
      if (stopped) return;
      stopped = true;
      await new Promise((resolve) => server.close(() => resolve()));
      await app.shutdown();
    }
  };
}
export {
  BridgeApiError,
  createL3,
  createRestrictedBridgeFacade
};
//# sourceMappingURL=l3.mjs.map
