// Anthropic-compatible /v1/messages server on top of the Claude Agent SDK.
//
//  - Wire format is the Anthropic Messages API (no OpenAI translation).
//  - Real streaming: SDK stream_event messages are forwarded as SSE as they arrive.
//  - One persistent Agent SDK session (one `query()` in streaming-input mode) per conversation.
//  - Tools are NOT run here. The client's tools (e.g. VS Code Copilot on system B) are exposed to
//    Claude through an in-process MCP server. When Claude calls one, the HTTP response ends with
//    stop_reason "tool_use" and the MCP handler stays pending until the client sends the
//    matching tool_result in its next request.
import http from 'node:http';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const API_KEY = process.env.PROXY_API_KEY || '';          // empty = no auth
const DEFAULT_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MIN || 60) * 60_000;
const MCP_NAME = 'client';
const PREFIX = `mcp__${MCP_NAME}__`;

// Clients (VS Code) send their own model *id* (e.g. "SystemA_s5.5"); only real Claude names go to the SDK.
const sdkModel = (m) => (/^(claude-|sonnet|opus|haiku|fable|default)/i.test(m || '') ? m : DEFAULT_MODEL);

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const blocksOf = (c) => (typeof c === 'string' ? [{ type: 'text', text: c }] : c || []);
const textOf = (c) => blocksOf(c).filter((b) => b.type === 'text').map((b) => b.text).join('\n');

function pushQueue() {
  const items = []; let wake = null; let closed = false;
  return {
    push(x) { items.push(x); wake?.(); },
    close() { closed = true; wake?.(); },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (items.length) { yield items.shift(); continue; }
        if (closed) return;
        await new Promise((r) => (wake = r)); wake = null;
      }
    },
  };
}

function renderHistory(messages) {
  return messages.map((m) => {
    const parts = blocksOf(m.content).map((b) => {
      if (b.type === 'text') return b.text;
      if (b.type === 'tool_use') return `[tool_use ${b.name} ${JSON.stringify(b.input)}]`;
      if (b.type === 'tool_result') return `[tool_result ${textOf(b.content)}]`;
      return `[${b.type}]`;
    });
    return `${m.role.toUpperCase()}: ${parts.join('\n')}`;
  }).join('\n\n');
}

function toMcpContent(content) {
  const out = blocksOf(content).flatMap((b) => {
    if (b.type === 'text') return [{ type: 'text', text: b.text }];
    if (b.type === 'image' && b.source?.type === 'base64')
      return [{ type: 'image', data: b.source.data, mimeType: b.source.media_type }];
    return [];
  });
  return out.length ? out : [{ type: 'text', text: '' }];
}

export function createApp({ queryFn = sdkQuery } = {}) {
  const sessions = new Map();

  // ---------- session ----------
  function createSession(key, body, resumeId) {
    const s = {
      key, model: body.model, tools: body.tools || [], toolSig: sha(JSON.stringify(body.tools || [])),
      input: pushQueue(), sink: null, pending: new Map(), early: new Map(), current: {}, sdkSessionId: resumeId,
      resultWaiters: [], lastUsed: Date.now(), dead: false,
    };

    const mcp = new McpServer({ name: MCP_NAME, version: '1.0.0' }, { capabilities: { tools: {} } });
    mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: s.tools.map((t) => ({
        name: t.name, description: t.description || '',
        inputSchema: t.input_schema || { type: 'object', properties: {} },
      })),
    }));
    mcp.server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const { name, arguments: args = {} } = req.params;
      const want = JSON.stringify(args);
      const open = Object.values(s.current).filter((c) => !c.claimed && c.name === name);
      const call = open.find((c) => JSON.stringify(c.input) === want) || open[0];
      if (!call) return { isError: true, content: [{ type: 'text', text: 'Unknown tool call' }] };
      call.claimed = true;
      if (s.early.has(call.id)) { const r = s.early.get(call.id); s.early.delete(call.id); return r; }   // client answered before we asked
      return new Promise((resolve) => s.pending.set(call.id, resolve));   // resolved by the next HTTP request
    });

    const systemText = [textOf(body.system), `Tools are provided by the client and are named ${PREFIX}<name>. Use them to act on the user's machine.`]
      .filter(Boolean).join('\n\n');

    s.query = queryFn({
      prompt: s.input,
      options: {
        model: sdkModel(body.model),
        systemPrompt: systemText,
        tools: [],                                   // no built-in tools: everything runs on the client
        mcpServers: { [MCP_NAME]: { type: 'sdk', name: MCP_NAME, instance: mcp } },
        allowedTools: [`${PREFIX}*`],
        canUseTool: async (_n, input) => ({ behavior: 'allow', updatedInput: input }),
        includePartialMessages: true,
        settingSources: [],
        resume: resumeId,
        cwd: process.cwd(),
      },
    });
    s.loop = pump(s);
    return s;
  }

  // Reads SDK messages forever, forwards stream events to whichever HTTP response is attached.
  async function pump(s) {
    try {
      for await (const m of s.query) {
        if (m.session_id) s.sdkSessionId = m.session_id;
        if (m.type === 'stream_event' && !m.parent_tool_use_id) forward(s, m.event);
        else if (m.type === 'result') {
          if (m.is_error && s.sink) s.sink.error(m.errors?.join('; ') || m.subtype || 'agent error');
          s.sink?.finish();
          s.resultWaiters.splice(0).forEach((r) => r());
        }
      }
    } catch (e) {
      s.sink?.error(String(e?.message || e));
    } finally {
      s.dead = true; sessions.delete(s.key);
      s.sink?.finish(); s.resultWaiters.splice(0).forEach((r) => r());
    }
  }

  function forward(s, ev) {
    if (ev.type === 'message_start') { s.current = {}; s.stopReason = null; ev.message.model = s.model || ev.message.model; }
    if (ev.type === 'content_block_start' && ev.content_block.type === 'tool_use') {
      const name = ev.content_block.name.replace(PREFIX, '');
      ev.content_block.name = name;
      s.current[ev.index] = { id: ev.content_block.id, name, input: {}, json: '' };
    }
    if (ev.type === 'content_block_delta' && ev.delta.type === 'input_json_delta' && s.current[ev.index])
      s.current[ev.index].json += ev.delta.partial_json;
    if (ev.type === 'content_block_stop' && s.current[ev.index]?.json !== undefined) {
      try { s.current[ev.index].input = JSON.parse(s.current[ev.index].json || '{}'); } catch { /* keep {} */ }
    }
    if (ev.type === 'message_delta') s.stopReason = ev.delta.stop_reason;
    s.sink?.event(ev);
    // A message that ends in tool_use ends this HTTP response; the tool handler waits for the next one.
    if (ev.type === 'message_stop') s.sink?.finish();
  }

  const settle = (s) => new Promise((r) => s.resultWaiters.push(r));

  // ---------- request handling ----------
  async function handle(body, headers, sink) {
    const msgs = body.messages || [];
    const last = msgs[msgs.length - 1];
    if (!last || last.role !== 'user') throw httpError(400, 'last message must have role "user"');

    const key = headers['x-session-id'] || sha(`${body.model}|${textOf(body.system)}|${textOf(msgs[0]?.content)}`);
    const toolSig = sha(JSON.stringify(body.tools || []));
    let s = sessions.get(key);

    // client tool set changed (e.g. user toggled tools): restart, keeping context via `resume`
    if (s && s.toolSig !== toolSig && s.pending.size === 0) {
      const id = s.sdkSessionId; s.input.close(); s.query.close?.(); sessions.delete(key); s = null;
      s = createSession(key, body, id);
      sessions.set(key, s);
    }
    const fresh = !s;
    if (!s) { s = createSession(key, body); sessions.set(key, s); }
    s.lastUsed = Date.now();

    const results = blocksOf(last.content).filter((b) => b.type === 'tool_result');
    const extra = blocksOf(last.content).filter((b) => b.type === 'text').map((b) => b.text).join('\n');

    if (s.pending.size && !results.length) {                       // user interrupted a pending tool call
      for (const [id, resolve] of s.pending) resolve({ isError: true, content: [{ type: 'text', text: 'Cancelled by user' }] });
      s.pending.clear(); s.early.clear();
      s.sink = null; await settle(s);
    }

    s.sink = sink;
    if (results.length) {
      let first = true;
      for (const r of results) {
        const content = toMcpContent(r.content);
        if (first && extra) content.push({ type: 'text', text: extra });
        first = false;
        const value = { isError: !!r.is_error, content };
        const resolve = s.pending.get(r.tool_use_id);
        if (resolve) { s.pending.delete(r.tool_use_id); resolve(value); } else s.early.set(r.tool_use_id, value);
      }
      for (const [id, resolve] of s.pending) {                       // client never answered these
        resolve({ isError: true, content: [{ type: 'text', text: 'No result returned by client' }] });
        s.pending.delete(id);
      }
    } else {
      let content = blocksOf(last.content).filter((b) => b.type !== 'tool_result');
      if (fresh && msgs.length > 1)
        content = [{ type: 'text', text: `Conversation so far:\n${renderHistory(msgs.slice(0, -1))}\n\nCurrent message:` }, ...content];
      s.input.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null });
    }
    return s;
  }

  const httpError = (status, message) => Object.assign(new Error(message), { status });

  // ---------- HTTP ----------
  const send = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const err = (res, status, message) => send(res, status, { type: 'error', error: { type: status === 401 ? 'authentication_error' : status === 400 ? 'invalid_request_error' : 'api_error', message } });
  const readBody = (req) => new Promise((ok, no) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => { try { ok(JSON.parse(d || '{}')); } catch (e) { no(httpError(400, 'invalid JSON')); } }); });

  const server = http.createServer(async (req, res) => {
    try {
      const token = (req.headers['x-api-key'] || '') || String(req.headers.authorization || '').replace(/^Bearer /, '');
      const loopback = /^(::1|(::ffff:)?127\.0\.0\.1)$/.test(req.socket.remoteAddress || '');
      if (API_KEY && token !== API_KEY && !(loopback && !token)) {   // empty key is accepted from this machine only
        console.warn(`401 ${req.method} ${req.url} from ${req.socket.remoteAddress}: got key ${token ? `"${token.slice(0, 3)}…" (len ${token.length})` : '(none)'}, expected len ${API_KEY.length}; auth headers: ${Object.keys(req.headers).filter((h) => /key|auth/i.test(h)).join(', ') || '(none)'}`);
        return err(res, 401, 'invalid api key');
      }
      const url = req.url.split('?')[0];

      if (req.method === 'GET' && url === '/v1/models')
        return send(res, 200, { data: [{ type: 'model', id: DEFAULT_MODEL, display_name: DEFAULT_MODEL, created_at: '2026-01-01T00:00:00Z' }], has_more: false, first_id: DEFAULT_MODEL, last_id: DEFAULT_MODEL });
      if (req.method === 'POST' && url === '/v1/messages/count_tokens') {
        const b = await readBody(req);
        return send(res, 200, { input_tokens: Math.ceil(JSON.stringify([b.system, b.messages, b.tools]).length / 4) });
      }
      if (req.method !== 'POST' || url !== '/v1/messages') return err(res, 404, 'not found');

      const body = await readBody(req);
      console.log(`${req.method} ${url} model=${JSON.stringify(body.model)} stream=${!!body.stream} msgs=${(body.messages || []).length} tools=${(body.tools || []).length}`);
      const wantStream = !!body.stream;
      let events = [], done, failure;
      const finished = new Promise((r) => (done = r));
      let started = false;
      const start = () => { if (started || !wantStream) return; started = true; res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }); };
      const sink = {
        event(ev) {
          if (wantStream) { start(); res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`); } else events.push(ev);
        },
        error(m) { failure = m; },
        finish() { done(); },
      };
      const s = await handle(body, req.headers, sink);
      req.on('close', () => { if (!res.writableEnded) { s.sink = null; done(); } });
      await finished;
      if (s.sink === sink) s.sink = null;

      if (wantStream) {
        start();
        if (failure) res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: failure } })}\n\n`);
        return res.end();
      }
      if (failure) return err(res, 500, failure);
      send(res, 200, assemble(events));
    } catch (e) {
      if (!res.headersSent) err(res, e.status || 500, e.message); else res.end();
    }
  });

  const gc = setInterval(() => {
    for (const [k, s] of sessions) if (!s.pending.size && Date.now() - s.lastUsed > SESSION_TTL_MS) { s.input.close(); s.query.close?.(); sessions.delete(k); }
  }, 60_000);
  gc.unref();
  server.on('close', () => { clearInterval(gc); for (const s of sessions.values()) { s.input.close(); s.query.close?.(); } });
  return server;
}

// Non-streaming: fold stream events into one Message object.
function assemble(events) {
  let msg = { type: 'message', role: 'assistant', content: [], stop_reason: null, stop_sequence: null };
  for (const ev of events) {
    if (ev.type === 'message_start') msg = { ...msg, ...ev.message, content: [] };
    else if (ev.type === 'content_block_start') msg.content[ev.index] = { ...ev.content_block, ...(ev.content_block.type === 'tool_use' ? { input: '' } : {}) };
    else if (ev.type === 'content_block_delta') {
      const b = msg.content[ev.index], d = ev.delta;
      if (d.type === 'text_delta') b.text += d.text;
      else if (d.type === 'input_json_delta') b.input += d.partial_json;
      else if (d.type === 'thinking_delta') b.thinking = (b.thinking || '') + d.thinking;
      else if (d.type === 'signature_delta') b.signature = d.signature;
    } else if (ev.type === 'content_block_stop') {
      const b = msg.content[ev.index];
      if (b?.type === 'tool_use') { try { b.input = JSON.parse(b.input || '{}'); } catch { b.input = {}; } }
    } else if (ev.type === 'message_delta') {
      msg.stop_reason = ev.delta.stop_reason; msg.stop_sequence = ev.delta.stop_sequence ?? null;
      msg.usage = { ...msg.usage, ...ev.usage };
    }
  }
  return msg;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  createApp().listen(PORT, HOST, () =>
    console.log(`Anthropic-compatible endpoint: http://${HOST}:${PORT}/v1/messages  (model ${DEFAULT_MODEL}${API_KEY ? ', key required' : ', NO auth'})`));
}
