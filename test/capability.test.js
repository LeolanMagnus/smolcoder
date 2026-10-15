// Capability-negotiation tests: /api/show capabilities drive toolsSupported
// (detect layer), so non-tool models never receive tool schemas.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { resolveContextWindow } = require("../dist/detect");

function stubOllama(capabilities) {
  return http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url === "/api/show") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ capabilities, model_info: { "qwen3.ctx.context_length": 32768 } }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "unexpected " + req.url }));
      }
    });
  });
}

async function withServer(server, fn) {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test("toolsSupported: capabilities including 'tools' set it true", async () => {
  const s = stubOllama(["completion", "tools", "vision"]);
  await withServer(s, async (base) => {
    const m = await resolveContextWindow({ id: "qwen3:8b", backend: "ollama", baseUrl: base, contextWindow: 0 });
    assert.equal(m.toolsSupported, true);
  });
});

test("toolsSupported: capabilities without 'tools' set it false (gemma-class models)", async () => {
  const s = stubOllama(["completion", "vision"]);
  await withServer(s, async (base) => {
    const m = await resolveContextWindow({ id: "gemma3:4b", backend: "ollama", baseUrl: base, contextWindow: 0 });
    assert.equal(m.toolsSupported, false);
  });
});

test("toolsSupported: vision stays independent of tools", async () => {
  const s = stubOllama(["completion"]);
  await withServer(s, async (base) => {
    const m = await resolveContextWindow({ id: "plain", backend: "ollama", baseUrl: base, contextWindow: 0 });
    assert.equal(m.toolsSupported, false);
    assert.equal(m.vision, false);
  });
});