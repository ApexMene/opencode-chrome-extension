#!/usr/bin/env node
// opencode-browser MCP server — the REAL bridge.
//
// stdio MCP (opencode <-> this process) + WebSocket sidecar (this process <-> extension).
// No npm deps: net + crypto + readline only.
//
// Every tools/call wraps: broadcast {event:"working"} -> forward cmd to extension,
// await ack (20s timeout) -> broadcast {event:"done"} -> return result to opencode.
// The extension holds no state: on WS hello it receives current state (sync).
//
// Events (server -> extension):
//   {event:"working", tool} {event:"done", tool, result?, error?} {event:"sync", state, tool}
// Commands (server -> extension, acked):
//   {id, cmd:"click", x, y} {id, cmd:"type_text", text, submit} {id, cmd:"navigate", url}
//   {id, cmd:"top_video"} {id, cmd:"glow", on} {id, cmd:"cursor", x, y}
// Ack (extension -> server): {id, ok, result?}

const net = require("net");
const crypto = require("crypto");
const readline = require("readline");

const WS_PORT = 7421;
const CMD_TIMEOUT_MS = 120000;
const VERSION = "0.5.0";

const log = (...a) => console.error("[opencode-browser]", ...a);

// ---- bridge state ----
let state = "idle"; // idle | working
let currentTool = null;
let lastResult = null;
let cmdSeq = 0;
const pending = new Map(); // id -> {resolve, timer}
const clients = new Set(); // ws sockets

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const s of clients) {
    try { wsSend(s, msg); } catch {}
  }
}

// ---- minimal WS server (RFC 6455, text frames) ----
function wsAccept(key) {
  return crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
}
function wsSend(sock, str) {
  const data = Buffer.from(str, "utf8");
  let header;
  if (data.length < 126) header = Buffer.from([0x81, data.length]);
  else if (data.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(data.length, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(data.length), 2); }
  sock.write(Buffer.concat([header, data]));
}
function wsHandleFrame(sock, buf) {
  // parse one or more frames; returns leftover
  let off = 0;
  while (buf.length - off >= 2) {
    const b1 = buf[off], b2 = buf[off + 1];
    const opcode = b1 & 0x0f;
    const masked = (b2 & 0x80) !== 0;
    let len = b2 & 0x7f, hlen = 2;
    if (len === 126) { if (buf.length - off < 4) break; len = buf.readUInt16BE(off + 2); hlen = 4; }
    else if (len === 127) { if (buf.length - off < 10) break; len = Number(buf.readBigUInt64BE(off + 2)); hlen = 10; }
    const mlen = masked ? 4 : 0;
    if (buf.length - off < hlen + mlen + len) break;
    let payload = buf.subarray(off + hlen + mlen, off + hlen + mlen + len);
    if (masked) {
      const mask = buf.subarray(off + hlen, off + hlen + 4);
      const out = Buffer.alloc(len);
      for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i % 4];
      payload = out;
    }
    off += hlen + mlen + len;
    if (opcode === 0x8) { sock.end(); return Buffer.alloc(0); } // close
    if (opcode === 0x9) { sock.write(Buffer.from([0x8a, 0x00])); continue; } // ping -> pong
    if (opcode === 0x1) onClientMessage(sock, payload.toString("utf8"));
  }
  return buf.subarray(off);
}
function onClientMessage(sock, text) {
  let m;
  try { m = JSON.parse(text); } catch { return; }
  if (m.role === "extension" && m.type === "hello") {
    sock.isExtension = true;
    log(`ext hello (total ext clients: ${[...clients].filter((c) => c.isExtension).length})`);
    wsSend(sock, JSON.stringify({ event: "sync", state, tool: currentTool, result: lastResult }));
    return;
  }
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    clearTimeout(p.timer);
    p.resolve(m);
    return;
  }
  if (m.id) log(`late/unknown ack id=${m.id} ok=${m.ok} result=${String(m.result || "").slice(0, 120)}`);
}
const wsServer = net.createServer((sock) => {
  let hs = Buffer.alloc(0), upgraded = false, rest = Buffer.alloc(0);
  sock.on("data", (chunk) => {
    if (!upgraded) {
      hs = Buffer.concat([hs, chunk]);
      const s = hs.toString("latin1");
      if (!s.includes("\r\n\r\n")) return;
      const key = (s.match(/Sec-WebSocket-Key:\s*(.+)\r/i) || [])[1]?.trim();
      if (!key) { sock.end(); return; }
      sock.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`
      );
      upgraded = true;
      clients.add(sock);
      const idx = s.indexOf("\r\n\r\n");
      rest = wsHandleFrame(sock, hs.subarray(idx + 4));
      return;
    }
    rest = wsHandleFrame(sock, Buffer.concat([rest, chunk]));
  });
  const drop = () => {
    if (sock.isExtension) log(`ext disconnect (remaining ext: ${[...clients].filter((c) => c.isExtension && c !== sock).length})`);
    clients.delete(sock);
    try { sock.destroy(); } catch {}
  };
  sock.on("close", drop);
  sock.on("error", drop);
});
wsServer.listen(WS_PORT, "127.0.0.1", () => log(`ws sidecar on 127.0.0.1:${WS_PORT}`));

function extCount() { return [...clients].filter((c) => c.isExtension).length; }
function sendCmd(cmd) {
  return new Promise((resolve) => {
    const id = `cmd-${++cmdSeq}-${Date.now()}`;
    if (extCount() === 0) { resolve({ id, ok: false, result: "no extension connected" }); return; }
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ id, ok: false, result: "ack timeout" });
    }, CMD_TIMEOUT_MS);
    // resolve only on ok=true; ok=false acks (e.g. a SW with no groupable tab)
    // are ignored while we keep waiting for a real success until timeout
    pending.set(id, { resolve: (ack) => {
      if (ack && ack.ok) { clearTimeout(timer); pending.delete(id); resolve(ack); }
      else log(`ignoring ok=false ack id=${id} result=${String((ack && ack.result) || "").slice(0, 80)} error=${String((ack && ack.error) || "").slice(0, 160)} — still waiting`);
    }, timer });
    broadcast({ ...cmd, id });
  });
}

// ---- MCP tools ----
const TOOLS = [
  { name: "browser_navigate", description: "Navigate the active browser tab to a URL (via Opencode in Chrome extension).", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "browser_click", description: "Move the phantom cursor to x,y and click (page coordinates).", inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] } },
  { name: "browser_type", description: "Type text into the page search box (YouTube-aware) and optionally submit.", inputSchema: { type: "object", properties: { text: { type: "string" }, submit: { type: "boolean" } }, required: ["text"] } },
  { name: "browser_glow", description: "Turn the agent glow + phantom cursor overlay on or off.", inputSchema: { type: "object", properties: { on: { type: "boolean" } }, required: ["on"] } },
  { name: "browser_top_video", description: "On YouTube home: click the most-viewed video.", inputSchema: { type: "object", properties: {} } },
  { name: "browser_snapshot", description: "Bridge status: extension connected, current state, last tool result.", inputSchema: { type: "object", properties: {} } },
  { name: "browser_debug_tabs", description: "List tabs as seen by the extension service worker.", inputSchema: { type: "object", properties: {} } },
  { name: "browser_debug_ping", description: "Ping the extension service worker through the sidecar (proves SW alive + WS path).", inputSchema: { type: "object", properties: {} } },
  { name: "browser_cdp_click", description: "REAL CDP mouse click at x,y (chrome.debugger, like Claude computer tool). Phantom cursor moves first.", inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] } },
  { name: "browser_cdp_type", description: "REAL CDP keyboard typing into the focused element (click it first with browser_cdp_click).", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "browser_cdp_shot", description: "REAL CDP screenshot (jpeg base64) of the active tab, like Claude computer captureScreenshot.", inputSchema: { type: "object", properties: {} } },
  { name: "browser_approve_site", description: "Approve a site hostname for agent control (ask mode). Pass host or omit for current tab.", inputSchema: { type: "object", properties: { host: { type: "string" } } } },
  { name: "browser_quick", description: "Quick mode: run a compact op sequence in one call, e.g. 'N https://x.com; C 640,360; T hello; S'. Ops: G on/off, N url, C x,y, T text, V top_video, S shot.", inputSchema: { type: "object", properties: { ops: { type: "string" } }, required: ["ops"] } },
];

async function runTool(name, args) {
  if (name === "browser_snapshot") {
    return { connected: extCount() > 0, clients: extCount(), state, tool: currentTool, lastResult };
  }
  if (name === "browser_debug_tabs") {
    if (extCount() === 0) return { connected: false };
    state = "working"; currentTool = name;
    try { const ack = await sendCmd({ cmd: "debug_tabs" }); return { ack: ack.ok, tabs: ack.ok ? JSON.parse(ack.result || "[]") : null, error: ack.error }; }
    finally { state = "idle"; currentTool = null; }
  }
  if (name === "browser_debug_ping") {
    if (extCount() === 0) return { connected: false };
    const ack = await sendCmd({ cmd: "debug_ping" });
    return { ack: ack.ok, result: ack.ok ? ack.result : null, error: ack.error, late: !ack.ok ? "check sidecar log for late/unknown ack" : undefined };
  }
  if (name === "browser_quick") {
    if (extCount() === 0) return { connected: false };
    const steps = String(args.ops || "").split(";").map((s) => s.trim()).filter(Boolean);
    state = "working"; currentTool = name;
    broadcast({ event: "working", tool: name });
    const out = [];
    try {
      for (const st of steps) {
        const op = st[0]?.toUpperCase(), rest = st.slice(1).trim();
        let cmd = null;
        if (op === "G") cmd = { cmd: "glow", on: /on|1|true/i.test(rest) };
        else if (op === "N") cmd = { cmd: "navigate", url: rest };
        else if (op === "C") { const [x, y] = rest.split(",").map(Number); cmd = { cmd: "cdp_click", x, y }; }
        else if (op === "T") cmd = { cmd: "cdp_type", text: rest };
        else if (op === "V") cmd = { cmd: "top_video" };
        else if (op === "S") cmd = { cmd: "cdp_shot" };
        if (!cmd) { out.push({ step: st, ok: false, error: "unknown op" }); continue; }
        const ack = await sendCmd(cmd);
        out.push({ step: st, ok: !!ack?.ok, result: ack?.ok ? String(ack.result || "").slice(0, 300) : ack?.result });
      }
    } finally {
      state = "idle"; currentTool = null;
      broadcast({ event: "done", tool: name, result: `${out.filter((o) => o.ok).length}/${out.length} ok` });
    }
    return { ack: out.every((o) => o.ok), steps: out, extensionConnected: extCount() > 0 };
  }
  const cmd = { cmd: name.replace("browser_", ""), ...args };
  if (name === "browser_navigate") { cmd.cmd = "navigate"; cmd.url = args.url; }
  if (name === "browser_type") { cmd.cmd = "type_text"; cmd.text = args.text; cmd.submit = args.submit !== false; }
  if (name === "browser_glow") { cmd.cmd = "glow"; cmd.on = !!args.on; }
  state = "working"; currentTool = name;
  broadcast({ event: "working", tool: name });
  let ack;
  try { ack = await sendCmd(cmd); }
  catch (e) { ack = { ok: false, result: String(e) }; }
  state = "idle"; lastResult = ack?.result ?? null;
  broadcast({ event: "done", tool: name, result: lastResult, error: ack?.ok ? undefined : (ack?.result || "failed") });
  currentTool = null;
  return { ack: !!ack?.ok, result: ack?.result ?? null, extensionConnected: extCount() > 0 };
}

// ---- MCP stdio transport (NDJSON) ----
const rl = readline.createInterface({ input: process.stdin, terminal: false });
function reply(id, result) {
  if (id === undefined || id === null) return;
  console.log(JSON.stringify({ jsonrpc: "2.0", id, result }));
}
function replyError(id, code, message) {
  if (id === undefined || id === null) return;
  console.log(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
}
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  try {
    if (method === "initialize") {
      reply(id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "opencode-browser", version: VERSION } });
    } else if (method === "ping") {
      reply(id, {});
    } else if (method === "tools/list") {
      reply(id, { tools: TOOLS });
    } else if (method === "tools/call") {
      const tname = params?.name;
      const tool = TOOLS.find((t) => t.name === tname);
      if (!tool) { replyError(id, -32602, `unknown tool ${tname}`); return; }
      const out = await runTool(tname, params?.arguments || {});
      reply(id, { content: [{ type: "text", text: JSON.stringify(out) }] });
    } else if (id !== undefined && id !== null) {
      replyError(id, -32601, `method not found: ${method}`);
    }
    // notifications (no id): ignore
  } catch (e) {
    replyError(id, -32603, String(e?.message || e));
  }
});
log(`mcp stdio ready (v${VERSION})`);
