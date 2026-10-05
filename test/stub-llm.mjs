/**
 * 假模型（OpenAI 兼容 SSE）：不花真 token 就能让 DSH 走完「模型 → 工具 → 结果 → 回答」。
 * 第一轮按 STUB_TOOL/STUB_ARGS 发起工具调用；第二轮回最终文本。
 */
import http from 'node:http';
import fs from 'node:fs';

const PORT = Number(process.env.STUB_PORT ?? 8899);
const LOG = process.env.STUB_LOG ?? '';
const TOOL = process.env.STUB_TOOL ?? 'aitm_health';
const ARGS = process.env.STUB_ARGS ?? '{}';

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') return void res.writeHead(404).end('not found');
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw); } catch { /* 保底 */ }
    if (LOG) { try { fs.appendFileSync(LOG, JSON.stringify({ url: req.url, body }) + '\n'); } catch { /* 忽略 */ } }

    const msgs = body.messages ?? [];
    const toolResult = [...msgs].reverse().find((m) => m.role === 'tool');
    const id = `chatcmpl-stub-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    const model = body.model ?? 'stub-model';
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    const chunk = (delta, finish = null) => ({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] });

    send(chunk({ role: 'assistant', content: '' }));
    if (!toolResult) {
      send(chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: TOOL, arguments: ARGS } }] }));
      send(chunk({}, 'tool_calls'));
    } else {
      send(chunk({ content: `STUB_DONE ${String(toolResult.content ?? '').slice(0, 1500)}` }));
      send(chunk({}, 'stop'));
    }
    send({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`[stub-llm] http://127.0.0.1:${PORT}/v1 tool=${TOOL}`));
