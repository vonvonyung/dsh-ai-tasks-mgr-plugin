/**
 * 期望的 action 数 —— **从内核源码推导**，不再硬编码。
 *
 * 为什么：`/api/health` 报的 action 数是「契约里有多少个接口」的硬事实，
 * 内核加一个 action（例如 2026-10-06 合进来的 `calendar.export`），
 * 所有写死 `63` 的断言就集体变红 —— 而它们红得没有信息量（不是回归，是数字过期）。
 * 所以这里按 `src/core/api.ts` 里 `AppApi` 的方法名数一遍：规则与
 * `src/core/http.ts` 的白名单同源（`AppApi.actions` 取 prototype 上形如 `idea.list` 的名字）。
 *
 * 推导不到（分发安装里没有仓库、或源码改版到认不出来）就退回 `fallback`，
 * 宁可退化成「老式硬编码」，也不要因为读不到源码就把断言全放过去。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 与 `src/core/api.ts` 的 `AppApi.actions` 同一个形状：小写段 + 点 + 驼峰/点段 */
const ACTION_NAME = /^\s{2}(?:async\s+)?'([a-z]+\.[a-zA-Z][a-zA-Z.]*)'\(/gm;

/**
 * @param {string} repo 仓库根（没有就传一个不存在的路径）
 * @param {number} fallback 读不到源码时用的老数字
 */
export function expectedActions(repo, fallback) {
  try {
    const src = fs.readFileSync(path.join(repo, 'src', 'core', 'api.ts'), 'utf8');
    const body = src.slice(src.indexOf('export class AppApi'));
    if (!body) return fallback;
    const names = new Set([...body.matchAll(ACTION_NAME)].map((m) => m[1]));
    // 合理下限：真读到源码了就不可能只有几个（防止切片失败后数出一两个名字）
    return names.size > 25 ? names.size : fallback;
  } catch {
    return fallback;
  }
}
