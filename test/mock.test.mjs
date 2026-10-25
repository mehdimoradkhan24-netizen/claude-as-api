// Offline test: fake Agent SDK `query` that calls the real in-process MCP server like Claude Code would.
import assert from 'node:assert';
import { createApp } from '../server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const ev = (e) => ({ type: 'stream_event', event: e, parent_tool_use_id: null, session_id: 'sid-1' });
function fakeQuery({ prompt, options }) {
  const mcp = options.mcpServers.client.instance;
  return (async function* () {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await mcp.connect(st); const c = new Client({ name: 't', version: '1' }); await c.connect(ct);
    assert.equal((await c.listTools()).tools[0].name, 'read_file');
    for await (const m of prompt) {                           // each user message = one turn
      yield ev({ type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model: 'x', content: [], usage: {} } });
      yield ev({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'mcp__client__read_file', input: {} } });
      yield ev({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"a.txt"}' } });
      yield ev({ type: 'content_block_stop', index: 0 });
      yield ev({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } });
      yield ev({ type: 'message_stop' });
      const r = await c.callTool({ name: 'read_file', arguments: { path: 'a.txt' } });   // blocks until client replies
      yield ev({ type: 'message_start', message: { id: 'm2', type: 'message', role: 'assistant', model: 'x', content: [], usage: {} } });
      yield ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      yield ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'got: ' + r.content[0].text } });
      yield ev({ type: 'content_block_stop', index: 0 });
      yield ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } });
      yield ev({ type: 'message_stop' });
      yield { type: 'result', subtype: 'success', is_error: false, session_id: 'sid-1' };
    }
  })();
}

const server = createApp({ queryFn: fakeQuery });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/v1/messages`;
const tools = [{ name: 'read_file', description: 'read', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }];
const post = (body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 100, tools, ...body }) });

const q = { role: 'user', content: 'read a.txt' };
// 1) streaming request ends with tool_use
let res = await post({ stream: true, messages: [q] });
let txt = await res.text();
assert.match(txt, /event: message_start/); assert.match(txt, /"name":"read_file"/); assert.match(txt, /"stop_reason":"tool_use"/);
// 2) client sends tool_result, non-streaming
const asst = { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: 'a.txt' } }] };
res = await post({ messages: [q, asst, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'HELLO' }] }] });
const msg = await res.json();
assert.equal(msg.stop_reason, 'end_turn'); assert.equal(msg.content[0].text, 'got: HELLO');
console.log('OK', JSON.stringify(msg.content));
server.close(); process.exit(0);
