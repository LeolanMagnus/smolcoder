// Agent-loop behaviour with a scripted fake provider: what the model is told
// when its output overflows the cap (the classic local-model "write the whole
// file in one call" failure), and the per-turn stats.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
// Keep the real ~/.smolcoder.json (and any configured MCP servers) out of tests.
process.env.SMOLCODER_CONFIG = path.join(os.tmpdir(), `smolcoder-test-config-${process.pid}.json`);
const { Agent } = require("../dist/agent");
const { ContextManager } = require("../dist/context");
const { EventBus } = require("../dist/events");
const { Plan } = require("../dist/plan");
const { TaskManager } = require("../dist/tools/tasks");

function fakeUi() {
  const lines = [];
  return {
    lines,
    token() {}, thinking() {}, toolCall() {}, toolResult() {}, println() {},
    status(s) { lines.push(s); }, warn(s) { lines.push(s); }, error(s) { lines.push(s); },
    startSpinner() {}, stopSpinner() {}, async confirmCommand() { return "yes"; },
    turnEnd(label) { lines.push("END " + label); }, planUpdated() {},
  };
}

function scriptedProvider(replies) {
  const seen = [];
  let i = 0;
  return {
    seen,
    label: "fake", modelId: "fake", contextWindow: 8000, maxOutputTokens: 2000,
    setEffort() {}, effortLabel() { return null; },
    async chat(messages) {
      seen.push(messages.map((m) => ({ role: m.role, content: m.content })));
      const r = replies[Math.min(i++, replies.length - 1)];
      return { content: "", toolCalls: [], generatedTokens: 100, genTokPerSec: 50, promptTokens: 500, completionTokens: 20, ...r };
    },
  };
}

function makeAgent(provider, ui, mode = "auto", interactive = false) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tc-agent-"));
  const toolCtx = { workspace: ws, taskManager: new TaskManager(ws), plan: new Plan(), filesTouched: new Set(), commandsRun: [] };
  return new Agent(provider, mode, "sys", toolCtx, new ContextManager(8000, 2000), new EventBus(), ui, interactive, 20);
}

test("alternating unchanged reads stop with a recoverable error before the model-step limit", async () => {
  const replies = Array.from({length:12}, (_, i) => ({ content:'', toolCalls:[{id:`r${i}`, name:'read_file', args:{path:i%2?'b.txt':'a.txt'}}] }));
  const agent = makeAgent(scriptedProvider(replies), fakeUi());
  fs.writeFileSync(path.join(agent.toolCtx.workspace,'a.txt'),'first module');
  fs.writeFileSync(path.join(agent.toolCtx.workspace,'b.txt'),'second module');
  await assert.rejects(agent.runTurn('implement the next module'), /same unchanged data/);
  assert.equal(agent.outcome, 'error');
  assert.equal(agent.lastTurnStats.toolCalls, 9);
  assert.match(agent.messages.at(-1).content, /Do not restart the same reads/);
});

test("implicit plan creation renders once; showing it does not re-arm its completion nudge", async () => {
  const provider = scriptedProvider([
    {toolCalls:[{id:'p1',name:'plan',args:{steps:'Implement; Test'}}]},
    {content:'paused'},
    {toolCalls:[{id:'p2',name:'plan',args:{action:'show'}}]},
    {content:'blocked and needs clarification'},
  ]);
  let updates=0;const ui=fakeUi();ui.planUpdated=()=>updates++;
  const agent = makeAgent(provider, ui);
  await agent.runTurn('build');
  assert.equal(provider.seen.length, 4);
  assert.equal(updates,1);
});

test("a cut-off tool call (empty, truncated, no thinking) is coached to split the file", async () => {
  const provider = scriptedProvider([
    { content: "", toolCalls: [], truncated: true },
    { content: "ok, splitting", toolCalls: [] },
  ]);
  const agent = makeAgent(provider, fakeUi());
  await agent.runTurn("build it");
  const nudge = provider.seen[1].at(-1);
  assert.equal(nudge.role, "user");
  assert.match(nudge.content, /cut off by the output limit of 2000 tokens/);
  assert.match(nudge.content, /NOT executed and nothing was saved/);
  assert.match(nudge.content, /write_file with the first part/);
  assert.doesNotMatch(nudge.content, /reasoning used/);
});

test("an empty truncated reply WITH thinking is blamed on reasoning", async () => {
  const provider = scriptedProvider([
    { content: "", thinking: "hmm hmm hmm", toolCalls: [], truncated: true },
    { content: "answer", toolCalls: [] },
  ]);
  const agent = makeAgent(provider, fakeUi());
  await agent.runTurn("think");
  assert.match(provider.seen[1].at(-1).content, /reasoning used the entire output limit \(2000 tokens\)/);
});

test('reasoning exhaustion uses one action-only retry without changing session effort',async()=>{
  const options=[];
  const provider=scriptedProvider([
    {thinking:'long reasoning',truncated:true},
    {toolCalls:[{id:'read',name:'list_files',args:{}}]},
    {content:'done'}
  ]);
  const chat=provider.chat.bind(provider);
  provider.chat=(messages,tools,opts)=>{options.push(opts);return chat(messages);};
  provider.setEffort=()=>{throw Error('must not mutate preference');};
  const ui=fakeUi();const agent=makeAgent(provider,ui);
  await agent.runTurn('make progress');
  assert.equal(agent.outcome,'completed');
  assert.equal(options[0].effortOverride,undefined);
  assert.equal(options[1].effortOverride,'off');
  assert.equal(options[2].effortOverride,undefined);
  assert.ok(ui.lines.some(s=>s.includes('thinking off')));
});

test("a truncated call that arrives as unparseable JSON (LM Studio) gets the same coaching", async () => {
  const provider = scriptedProvider([
    { content: "", toolCalls: [{ id: "c1", name: "write_file", args: {}, rawArgs: '{"path": "a.js", "content": "....', parseError: "invalid JSON" }], truncated: true },
    { content: "ok", toolCalls: [] },
  ]);
  const agent = makeAgent(provider, fakeUi());
  await agent.runTurn("build it");
  const toolMsg = provider.seen[1].find((m) => m.role === "tool");
  assert.ok(toolMsg);
  assert.match(toolMsg.content, /^Error: Your tool call was cut off by the output limit of 2000 tokens/);
});

test('repeated reasoning exhaustion extends a bounded recovery interval then restores effort',async()=>{
  const options=[];
  const read=i=>({toolCalls:[{id:'read'+i,name:'list_files',args:{path:'.',limit:10+i}}]});
  const provider=scriptedProvider([
    {thinking:'exhausted',truncated:true},read(0),
    {thinking:'exhausted again',truncated:true},...Array.from({length:4},(_,i)=>read(i+1)),
    {content:'done'}
  ]);
  const chat=provider.chat.bind(provider);
  provider.chat=(messages,tools,opts)=>{options.push(opts.effortOverride);return chat(messages);};
  provider.setEffort=()=>{throw Error('must not mutate preference');};
  const agent=makeAgent(provider,fakeUi());await agent.runTurn('make progress');
  assert.equal(agent.outcome,'completed');
  assert.deepEqual(options,[undefined,'off',undefined,'off','off','off','off',undefined]);
});

test("turn stats accumulate tokens, speed and tool calls", async () => {
  const provider = scriptedProvider([
    // list_files (not plan: an unfinished plan would trigger the quit-halfway nudge and a third call)
    { content: "", toolCalls: [{ id: "c1", name: "list_files", args: {} }], generatedTokens: 200, genTokPerSec: 100 },
    { content: "done", toolCalls: [], generatedTokens: 50, genTokPerSec: 50 },
  ]);
  const ui = fakeUi();
  const agent = makeAgent(provider, ui);
  await agent.runTurn("go");
  const st = agent.lastTurnStats;
  assert.equal(st.modelCalls, 2);
  assert.equal(st.toolCalls, 1);
  assert.equal(st.generatedTokens, 250);
  // 200 tok @ 100/s = 2 s, 50 tok @ 50/s = 1 s → 250 tok over 3 s ≈ 83 tok/s
  assert.equal(Math.round(st.generatedTokens / st.genSeconds), 83);
  assert.match(ui.lines.find((l) => l.startsWith("END ")), /1 tool · 250 tok @ 83 tok\/s/);
});

test("lifetime token counters survive a transcript reset but reset with the session", async () => {
  const provider = scriptedProvider([{ content: "done", toolCalls: [], promptTokens: 300, completionTokens: 40 }]);
  const agent = makeAgent(provider, fakeUi());
  await agent.runTurn("go");
  assert.equal(agent.totalPromptTokens, 300);
  assert.equal(agent.lifetimePromptTokens, 300);
  assert.equal(agent.lifetimeCompletionTokens, 40);
  agent.resetTranscript();
  assert.equal(agent.totalPromptTokens, 0, "per-transcript counters clear");
  assert.equal(agent.lifetimePromptTokens, 300, "lifetime counters survive /clear");
  assert.equal(agent.lifetimeCompletionTokens, 40);
  agent.resetLifetimeTokens();
  assert.equal(agent.lifetimePromptTokens, 0);
  assert.equal(agent.lifetimeCompletionTokens, 0);
});

test("a multi-step run with no plan gets one reminder to create one", async () => {
  const reads = Array.from({ length: 6 }, (_, i) => ({
    content: "", toolCalls: [{ id: `r${i}`, name: "read_file", args: { path: `mod${i}.txt` } }],
  }));
  const provider = scriptedProvider([...reads, { content: "done", toolCalls: [] }]);
  const agent = makeAgent(provider, fakeUi());
  for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(agent.toolCtx.workspace, `mod${i}.txt`), `module ${i}`);
  await agent.runTurn("wire up a multi-step feature");
  // The reminder rides on the 6th tool result, so the request after it carries it.
  const afterSixth = provider.seen[6];
  assert.ok(afterSixth, "the model asked again after the sixth tool call");
  const reminders = afterSixth.filter((m) => m.role === "tool" && /no plan is set/.test(m.content));
  assert.equal(reminders.length, 1);
  assert.match(reminders[0].content, /plan \{"action": "set"/);
});

test("the create-plan reminder is not repeated across the turn", async () => {
  const calls = Array.from({ length: 8 }, (_, i) => ({
    content: "", toolCalls: [{ id: `r${i}`, name: "read_file", args: { path: `mod${i}.txt` } }],
  }));
  const provider = scriptedProvider([...calls, { content: "done", toolCalls: [] }]);
  const agent = makeAgent(provider, fakeUi());
  for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(agent.toolCtx.workspace, `mod${i}.txt`), `module ${i}`);
  await agent.runTurn("wire up a multi-step feature");
  const last = provider.seen.at(-1);
  const total = last.filter((m) => m.role === "tool" && /no plan is set/.test(m.content)).length;
  assert.equal(total, 1, "exactly one reminder in the transcript");
});

test("interactive: an unplanned file edit is refused until a plan exists", async () => {
  const provider = scriptedProvider([
    { toolCalls: [{ id: "r1", name: "read_file", args: { path: "a.txt" } }] },
    { toolCalls: [{ id: "r2", name: "read_file", args: { path: "a.txt" } }] },
    { toolCalls: [{ id: "r3", name: "read_file", args: { path: "a.txt" } }] },
    { toolCalls: [{ id: "w1", name: "write_file", args: { path: "out.txt", content: "hi" } }] },
    { toolCalls: [{ id: "p1", name: "plan", args: { steps: "write out.txt" } }] },
    { toolCalls: [{ id: "w2", name: "write_file", args: { path: "out.txt", content: "hi" } }] },
    { content: "done" },
  ]);
  const agent = makeAgent(provider, fakeUi(), "build", true);
  fs.writeFileSync(path.join(agent.toolCtx.workspace, "a.txt"), "module a");
  await agent.runTurn("write out.txt in several steps");
  const gated = provider.seen.some((msgs) =>
    msgs.some((m) => m.role === "tool" && /set a short plan before changing files/.test(m.content)));
  assert.ok(gated, "the unplanned edit was refused with plan coaching");
  assert.equal(fs.readFileSync(path.join(agent.toolCtx.workspace, "out.txt"), "utf8"), "hi", "the edit lands once a plan is set");
  assert.ok(agent.toolCtx.plan.exists, "a plan now exists");
});

test("headless: the decomposition gate never blocks edits (acceptance is the contract)", async () => {
  const provider = scriptedProvider([
    { toolCalls: [{ id: "r1", name: "read_file", args: { path: "a.txt" } }] },
    { toolCalls: [{ id: "r2", name: "read_file", args: { path: "a.txt" } }] },
    { toolCalls: [{ id: "r3", name: "read_file", args: { path: "a.txt" } }] },
    { toolCalls: [{ id: "w1", name: "write_file", args: { path: "out.txt", content: "hi" } }] },
    { content: "done" },
  ]);
  const agent = makeAgent(provider, fakeUi(), "build", false);
  fs.writeFileSync(path.join(agent.toolCtx.workspace, "a.txt"), "module a");
  await agent.runTurn("write out.txt");
  assert.equal(fs.readFileSync(path.join(agent.toolCtx.workspace, "out.txt"), "utf8"), "hi");
});

test("the plan gate never deadlocks a model that refuses to plan", async () => {
  const writes = Array.from({ length: 5 }, (_, i) => ({
    toolCalls: [{ id: `w${i}`, name: "write_file", args: { path: "out.txt", content: `v${i}` } }],
  }));
  const provider = scriptedProvider([
    { toolCalls: [{ id: "r1", name: "read_file", args: { path: "a.txt" } }] },
    { toolCalls: [{ id: "r2", name: "read_file", args: { path: "a.txt" } }] },
    { toolCalls: [{ id: "r3", name: "read_file", args: { path: "a.txt" } }] },
    ...writes,
    { content: "done" },
  ]);
  const agent = makeAgent(provider, fakeUi(), "build", true);
  fs.writeFileSync(path.join(agent.toolCtx.workspace, "a.txt"), "module a");
  await agent.runTurn("keep writing");
  assert.equal(fs.readFileSync(path.join(agent.toolCtx.workspace, "out.txt"), "utf8"), "v4", "after a few refusals the edit is allowed through");
});

test("build mode: an in-workspace command runs without asking", async () => {
  const provider = scriptedProvider([
    { content: "", toolCalls: [{ id: "c1", name: "run_command", args: { command: "echo hello-from-tree" } }] },
    { content: "done", toolCalls: [] },
  ]);
  const ui = fakeUi();
  let asked = 0;
  ui.confirmCommand = async () => { asked++; return "no"; };
  const agent = makeAgent(provider, ui, "build", true);
  await agent.runTurn("go");
  assert.equal(asked, 0);
  const toolMsg = provider.seen[1].find((m) => m.role === "tool");
  assert.match(toolMsg.content, /hello-from-tree/);
});

test("build mode: a command reaching outside the workspace asks, with the reason", async () => {
  const provider = scriptedProvider([
    { content: "", toolCalls: [{ id: "c1", name: "run_command", args: { command: "node /tmp/probe.mjs && node /tmp/other.mjs" } }] },
    { content: "done", toolCalls: [] },
  ]);
  const ui = fakeUi();
  const asks = [];
  ui.confirmCommand = async (command, reason) => { asks.push({ command, reason }); return "no"; };
  const agent = makeAgent(provider, ui, "build", true);
  await agent.runTurn("go");
  assert.equal(asks.length, 1);
  assert.match(asks[0].reason, /outside the workspace \(\/tmp\/probe\.mjs\)/);
  const toolMsg = provider.seen[1].find((m) => m.role === "tool");
  assert.match(toolMsg.content, /declined/);
});

test("build mode, headless: an outside command is refused with coaching instead of hanging", async () => {
  const provider = scriptedProvider([
    { content: "", toolCalls: [{ id: "c1", name: "run_command", args: { command: "cat ~/.npmrc" } }] },
    { content: "done", toolCalls: [] },
  ]);
  const ui = fakeUi();
  ui.confirmCommand = async () => { throw new Error("must not prompt when non-interactive"); };
  const agent = makeAgent(provider, ui, "build", false);
  await agent.runTurn("go");
  const toolMsg = provider.seen[1].find((m) => m.role === "tool");
  assert.match(toolMsg.content, /^Error: this command uses the home directory/);
  assert.match(toolMsg.content, /--mode auto/);
});

test("auto mode never asks", async () => {
  const provider = scriptedProvider([
    { content: "", toolCalls: [{ id: "c1", name: "run_command", args: { command: "echo ~/nothing-is-read" } }] },
    { content: "done", toolCalls: [] },
  ]);
  const ui = fakeUi();
  ui.confirmCommand = async () => { throw new Error("auto must not prompt"); };
  const agent = makeAgent(provider, ui, "auto", true);
  await agent.runTurn("go");
  const toolMsg = provider.seen[1].find((m) => m.role === "tool");
  assert.match(toolMsg.content, /nothing-is-read/);
});

test("a mid-turn switch to auto drops the approval gate and is announced to the model", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tc-agent-"));
  const toolCtx = { workspace: ws, taskManager: new TaskManager(ws), plan: new Plan(), filesTouched: new Set(), commandsRun: [] };
  const ui = fakeUi();
  let asked = 0;
  ui.confirmCommand = async () => { asked++; return "no"; };
  const seen = [];
  let agent;
  const provider = {
    label: "fake", modelId: "fake", contextWindow: 8000, maxOutputTokens: 2000,
    setEffort() {}, effortLabel() { return null; },
    async chat(messages) {
      seen.push(messages.map((m) => m.content).join("\n"));
      if (seen.length === 1) {
        agent.setMode("auto", "auto sys"); // the user switches on the fly
        return { content: "", toolCalls: [{ id: "c1", name: "run_command", args: { command: "echo ~/mode-probe" } }], generatedTokens: 1, promptTokens: 1, completionTokens: 1 };
      }
      return { content: "done", toolCalls: [], generatedTokens: 1, promptTokens: 1, completionTokens: 1 };
    },
  };
  agent = new Agent(provider, "build", "sys", toolCtx, new ContextManager(8000, 2000), new EventBus(), ui, true, 20);
  await agent.runTurn("go");
  assert.equal(asked, 0, "auto mode runs the outside command without asking");
  assert.match(seen[1], /Mode changed to auto/, "the model is told about the switch");
});

test("a mid-turn switch to plan skips acceptance instead of failing the turn", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tc-agent-"));
  const toolCtx = { workspace: ws, taskManager: new TaskManager(ws), plan: new Plan(), filesTouched: new Set(), commandsRun: [] };
  fs.writeFileSync(path.join(ws, "a.txt"), "hello");
  let agent;
  let calls = 0;
  const provider = {
    label: "fake", modelId: "fake", contextWindow: 8000, maxOutputTokens: 2000,
    setEffort() {}, effortLabel() { return null; },
    async chat() {
      if (++calls === 1) {
        agent.setMode("plan", "plan sys"); // the user downgrades mid-run
        return { content: "", toolCalls: [{ id: "c1", name: "read_file", args: { path: "a.txt" } }], generatedTokens: 1, promptTokens: 1, completionTokens: 1 };
      }
      return { content: "here is the plan; no changes were made", toolCalls: [], generatedTokens: 1, promptTokens: 1, completionTokens: 1 };
    },
  };
  agent = new Agent(provider, "build", "sys", toolCtx, new ContextManager(8000, 2000), new EventBus(), fakeUi(), true, 20, { command: 'node -e "process.exit(1)"' });
  await agent.runTurn("go");
  assert.equal(agent.outcome, "completed", "the plan-mode turn finishes instead of throwing");
  assert.equal(agent.lastError, null);
});
