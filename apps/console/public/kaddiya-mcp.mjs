#!/usr/bin/env node
// Kaddiya MCP stdio shim (ADR 0014 D4).
//
// Claude Desktop and Claude.ai custom connectors authenticate remote MCP
// servers with OAuth only — there is no field for a bearer — but Claude
// Desktop does run local stdio servers. This bridges the two: it reads
// newline-delimited JSON-RPC on stdin, POSTs each message to the Kaddiya /mcp
// endpoint with the Authorization header the desktop client cannot send, and
// writes each response back to stdout as one line.
//
// It is a client adapter, not a second server. It never parses a tool result
// and has no opinion about the protocol beyond the three headers the
// 2026-07-28 revision asks a client to mirror (MCP-Protocol-Version,
// Mcp-Method, Mcp-Name) and the two response framings a server may answer
// with (a JSON body, or one SSE stream carrying the same messages).
//
// Zero dependencies, `node:` imports only. Run it from claude_desktop_config.json:
//
//   { "mcpServers": { "kaddiya": {
//       "command": "node",
//       "args": ["/path/to/kaddiya-mcp.mjs"],
//       "env": { "KADDIYA_MCP_URL": "https://kaddiya.example.com/mcp",
//                "KADDIYA_MCP_TOKEN": "kmcp_…" } } } }
//
// `npx -y mcp-remote` does the same job if your team accepts that; this file
// exists so you do not have to.

import process from 'node:process';

const URL_ = process.env.KADDIYA_MCP_URL || '';
const TOKEN = process.env.KADDIYA_MCP_TOKEN || '';
const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';

if (!URL_ || !TOKEN) {
  process.stderr.write('kaddiya-mcp: set KADDIYA_MCP_URL and KADDIYA_MCP_TOKEN in the client config.\n');
  process.exit(2);
}

/** Requests still in flight, by JSON-RPC id, so notifications/cancelled can abort one. */
const inFlight = new Map();

const write = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const log = (text) => process.stderr.write(`kaddiya-mcp: ${text}\n`);

/** The version an `initialize` handshake settled on, for later legacy requests. */
let negotiated = '';

/**
 * The headers the modern revision asks a client to mirror from the body, so a
 * proxy can route and a server can refuse a mismatch without parsing JSON.
 */
function mirrored(message) {
  const headers = {};
  const version = message?.params?._meta?.[PROTOCOL_VERSION_META_KEY] || negotiated;
  if (version) headers['MCP-Protocol-Version'] = version;
  if (typeof message?.method === 'string') headers['Mcp-Method'] = message.method;
  const name = message?.params?.name || message?.params?.uri;
  if (typeof name === 'string') headers['Mcp-Name'] = name;
  return headers;
}

/** One SSE stream carries the same JSON-RPC messages, one per `data:` line. */
async function pumpEventStream(response) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let cut;
    while ((cut = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('');
      if (!data) continue;           // a comment frame: the keepalive
      try { write(JSON.parse(data)); } catch { log('dropped an unparseable event'); }
    }
  }
}

async function forward(message) {
  const id = message?.id;
  const controller = new AbortController();
  if (id !== undefined && id !== null) inFlight.set(id, controller);
  try {
    const response = await fetch(URL_, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${TOKEN}`,
        ...mirrored(message),
      },
      body: JSON.stringify(message),
    });

    // 202 is the acknowledgement of a notification: there is no body to relay.
    if (response.status === 202) return;

    const type = String(response.headers.get('content-type') || '');
    if (type.includes('text/event-stream') && response.body) {
      await pumpEventStream(response);
      return;
    }

    const text = await response.text();
    if (!text) {
      if (!response.ok) log(`HTTP ${response.status} with no body`);
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      log(`HTTP ${response.status}: ${text.slice(0, 200)}`);
      return;
    }
    // A transport-level refusal (401, 403) arrives as Kaddiya's own JSON, not
    // JSON-RPC. Relay it as an error on this id so the client shows the reason
    // instead of a silent hang.
    if (parsed.jsonrpc !== '2.0' && id !== undefined && id !== null) {
      return write({ jsonrpc: '2.0', id, error: { code: -32000, message: `Kaddiya ${response.status}: ${parsed.error || text.slice(0, 200)}` } });
    }
    if (parsed.jsonrpc !== '2.0') return log(`HTTP ${response.status}: ${text.slice(0, 200)}`);

    if (message?.method === 'initialize' && parsed.result?.protocolVersion) negotiated = parsed.result.protocolVersion;
    write(parsed);
  } catch (err) {
    if (err?.name === 'AbortError') return;
    log(String(err?.message || err));
    if (id !== undefined && id !== null) {
      write({ jsonrpc: '2.0', id, error: { code: -32000, message: `Could not reach Kaddiya: ${err?.message || err}` } });
    }
  } finally {
    if (id !== undefined && id !== null) inFlight.delete(id);
  }
}

function handle(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return log('dropped an unparseable line from stdin');
  }
  if (message?.method === 'notifications/cancelled') {
    const target = message?.params?.requestId;
    inFlight.get(target)?.abort();
    inFlight.delete(target);
    // The server holds nothing between POSTs, so there is nothing to tell it.
    return;
  }
  forward(message);
}

let pending = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  pending += chunk;
  let cut;
  while ((cut = pending.indexOf('\n')) !== -1) {
    const line = pending.slice(0, cut).trim();
    pending = pending.slice(cut + 1);
    if (line) handle(line);
  }
});
process.stdin.on('end', () => {
  for (const controller of inFlight.values()) controller.abort();
  process.exit(0);
});
