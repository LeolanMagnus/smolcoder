// MCP integration: config → stdio server → namespaced tools → results,
// including images for vision models, timeouts, the tool cap and the
// process-wide manager lifecycle.
const test = require("node:test");
const { after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "smol-mcp-"));
const CONFIG = path.join(tmp, "config.json");
process.env.SMOLCODER_CONFIG = CONFIG;
const FIXTURE = path.join(__dirname, "fixtures", "mcp-server.cjs");

const mcp = require("../dist/mcp");
const { executeTool } = require("../dist/tools/index");
const { Agent } = require("../dist/agent");
const { ContextManager } = require("../dist/context");
const { EventBus } = require("../dist/events");
const { Plan } = require("../dist/plan");
const { TaskManager } = require("../dist/tools/tasks");

function baseServer(extra = {}) {
  return { command: process.execPath, args: [FIXTURE], timeoutMs: 8000, ...extra };
}
function writeConfig(server, extra = {}) {
  fs.writeFileSync(CONFIG, JSON.stringify({ ...extra, mcpServers: { fixture: server } }));
}
function freshCtx(workspace) {
  return { workspace, filesTouched: new Set(), commandsRun: [], skillsLoaded: new Set() };
}

writeConfig(baseServer());
after(() => mcp.shutdownMcp());

test("discovers tools, namespaces their names and hides them from plan mode", async () => {
  assert.equal(await mcp.ensureMcpStarted(), true);
  const names = mcp.mcpSpecsFor("build").map((s) => s.name);
  assert.ok(names.includes("mcp_fixture_echo"));
  assert.ok(names.includes("mcp_fixture_weird_name_tool"));
  assert.equal(mcp.mcpSpecsFor("plan").length, 0);
  assert.equal(mcp.isMcpTool("mcp_fixture_echo"), true);
  assert.equal(await mcp.ensureMcpStarted(), false); // started once, never twice
});

test("runs MCP tools through executeTool", async () => {
  const ctx = freshCtx(tmp);
  assert.match(await executeTool("mcp_fixture_echo", { text: "hi" }, ctx), /echo: hi/);
  assert.match(await executeTool("mcp_fixture_fail", {}, ctx), /^Error: boom/);
  assert.match(await executeTool("mcp_fixture_missing", {}, ctx), /unknown tool/i);
});

test("saves image results into the workspace and hands refs to the agent", async () => {
  const ctx = freshCtx(tmp);
  const out = await executeTool("mcp_fixture_draw", {}, ctx);
  assert.match(out, /\.smolcoder\/mcp\/fixture\//);
  assert.match(out, /drew one pixel/);
  assert.equal(ctx.mcpImages.length, 1);
  assert.equal(ctx.mcpImages[0].mime, "image/png");
  assert.ok(fs.existsSync(ctx.mcpImages[0].path));
  assert.equal(fs.readFileSync(ctx.mcpImages[0].path).subarray(1, 4).toString(), "PNG");
});

test("a hanging tool times out with a clear error", async () => {
  writeConfig(baseServer({ timeoutMs: 1500 }));
  mcp.shutdownMcp();
  await mcp.ensureMcpStarted();
  const started = Date.now();
  const out = await executeTool("mcp_fixture_hang", {}, freshCtx(tmp));
  assert.match(out, /did not answer "tools\/call" within 2s/);
  assert.ok(Date.now() - started < 10_000);
});

test("caps injected MCP tools at 12 and reports the rest", async () => {
  writeConfig(baseServer({ env: { MCP_FIXTURE_MANY: "1" } }));
  mcp.shutdownMcp();
  await mcp.ensureMcpStarted();
  assert.equal(mcp.mcpSpecsFor("build").length, 12);
  const notes = mcp.takeMcpNotes().map((n) => n.text).join("\n");
  assert.match(notes, /cap of 12/);
});

test("maxMcpTools raises the cap", async () => {
  writeConfig(baseServer({ env: { MCP_FIXTURE_MANY: "1" } }), { maxMcpTools: 28 });
  mcp.shutdownMcp();
  await mcp.ensureMcpStarted();
  assert.equal(mcp.mcpSpecsFor("build").length, 25);
  assert.doesNotMatch(mcp.takeMcpNotes().map((n) => n.text).join("\n"), /cap of/);
});

test("allowInPlan exposes a server's tools in plan mode", async () => {
  writeConfig(baseServer({ allowInPlan: true }));
  mcp.shutdownMcp();
  await mcp.ensureMcpStarted();
  assert.ok(mcp.mcpSpecsFor("plan").length > 0);
  assert.equal(mcp.mcpSpecsFor("plan")[0].name.startsWith("mcp_fixture_"), true);
});

test("the agent attaches MCP images to the conversation", async () => {
  writeConfig(baseServer());
  mcp.shutdownMcp();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "smol-mcp-ws-"));
  const toolCtx = { workspace: ws, taskManager: new TaskManager(ws), plan: new Plan(), filesTouched: new Set(), commandsRun: [], skillsLoaded: new Set() };
  let reply = 0;
  const provider = {
    label: "fake", modelId: "fake", contextWindow: 8000, maxOutputTokens: 2000,
    setEffort() {}, effortLabel() { return null; },
    async chat() {
      const r = reply++ === 0
        ? { content: "", toolCalls: [{ id: "d1", name: "mcp_fixture_draw", args: {} }] }
        : { content: "looked at it", toolCalls: [] };
      return { content: "", toolCalls: [], generatedTokens: 100, genTokPerSec: 50, promptTokens: 500, completionTokens: 20, ...r };
    },
  };
  const ui = {
    token() {}, thinking() {}, toolCall() {}, toolResult() {}, println() {},
    status() {}, warn() {}, error() {}, startSpinner() {}, stopSpinner() {},
    async confirmCommand() { return "yes"; }, turnEnd() {}, planUpdated() {},
  };
  const agent = new Agent(provider, "build", "sys", toolCtx, new ContextManager(8000, 2000), new EventBus(), ui, false, 20);
  await agent.runTurn("draw a render and look at it");
  assert.equal(agent.outcome, "completed");
  const withImages = agent.messages.filter((m) => m.role === "user" && m.images?.length);
  assert.equal(withImages.length, 1);
  assert.match(withImages[0].content, /attached/);
  assert.ok(fs.existsSync(withImages[0].images[0].path));
});

test("shutdownMcp clears the registry", () => {
  mcp.shutdownMcp();
  assert.equal(mcp.isMcpTool("mcp_fixture_echo"), false);
});
