// Codex 的 STDIO 入口只转发当前调用的能力令牌，不持有企业微信或 Jira 密钥。
import { createInterface } from 'node:readline';
const url = new URL(process.env.ALMOST_GENIUS_TOOL_URL);
if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') throw new Error('工具服务必须位于本机。');
const token = process.env.ALMOST_GENIUS_TOOL_TOKEN;
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
async function remote(method, params) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ method, params }), signal: AbortSignal.timeout(45000) });
  if (!response.ok) throw new Error('本轮工具权限已失效。');
  return response.json();
}
input.on('line', async line => {
  let request;
  try {
    request = JSON.parse(line); if (request.id === undefined) return;
    let result;
    if (request.method === 'initialize') result = { protocolVersion: request.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'almost-genius', version: '0.4.0' } };
    else if (request.method === 'ping') result = {};
    else if (['tools/list', 'tools/call'].includes(request.method)) result = await remote(request.method, request.params);
    else { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unknown method' } }) + '\n'); return; }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
  } catch { if (request?.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: '工具调用未完成，请重新查询状态。' } }) + '\n'); }
});
