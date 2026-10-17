// Minimal stdio MCP server for tests: line-delimited JSON-RPC 2.0 on stdin,
// same back on stdout. Advertises tools that exercise every client path:
// success, tool error, image result, timeout, and name sanitization.
const readline = require("node:readline");

const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const tools = [
  { name: "echo", description: "Echo the given text back.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "fail", description: "Always reports a tool error.", inputSchema: { type: "object", properties: {} } },
  { name: "draw", description: "Returns a one-pixel PNG.", inputSchema: { type: "object", properties: {} } },
  { name: "hang", description: "Never answers.", inputSchema: { type: "object", properties: {} } },
  { name: "weird.name/tool", description: "Name with characters that need sanitizing.", inputSchema: { type: "object", properties: {} } },
];

// MCP_FIXTURE_MANY pads the list past the manager's tool cap.
if (process.env.MCP_FIXTURE_MANY === "1") {
  for (let i = 1; i <= 20; i++) {
    tools.push({ name: `pad${i}`, description: `Padding tool ${i}.`, inputSchema: { type: "object", properties: {} } });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === "initialize" && msg.id !== undefined) {
    return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1.0.0" } } });
  }
  if (msg.method === "tools/list" && msg.id !== undefined) {
    return send({ jsonrpc: "2.0", id: msg.id, result: { tools } });
  }
  if (msg.method === "tools/call" && msg.id !== undefined) {
    const name = msg.params && msg.params.name;
    const args = (msg.params && msg.params.arguments) || {};
    if (name === "hang") return; // never answers: exercises the call timeout
    if (name === "fail") {
      return send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "boom" }], isError: true } });
    }
    if (name === "draw") {
      return send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "image", data: PNG_1PX, mimeType: "image/png" }, { type: "text", text: "drew one pixel" }] } });
    }
    if (name === "weird.name/tool") {
      return send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "weird ok" }] } });
    }
    return send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `echo: ${args.text ?? ""}` }] } });
  }
  if (msg.id !== undefined) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  }
  // Notifications (e.g. notifications/initialized) need no reply.
});

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}
