// The TUI's pickers, driven by feeding keys to stdin and reading the frames it
// draws. stdout is only captured inside synchronous sections so the test
// runner's own output is never swallowed.
const test = require("node:test");
const assert = require("node:assert/strict");
const { Tui } = require("../dist/tui/tui");

function capture(fn) {
  const real = process.stdout.write;
  let out = "";
  process.stdout.write = (s) => ((out += s), true);
  try {
    fn();
  } finally {
    process.stdout.write = real;
  }
  // eslint-disable-next-line no-control-regex
  return out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
}
const keys = (s) => process.stdin.emit("data", s);
const DOWN = "\x1b[B";
const UP = "\x1b[A";

test("tui: a text prompt edits one line, submits on enter and cancels on ctrl+c", async () => {
  const tui = new Tui();
  let p;
  const frame = capture(() => {
    tui.start();
    tui.start(); // startup may open it before the session does
    p = tui.prompt("Address of the machine", "192.168.1.50");
  });
  assert.match(frame, /Address of the machine/);
  assert.match(frame, /192\.168\.1\.50/, "the placeholder shows while empty");
  const typed = capture(() => keys("gpu-bx"));
  assert.match(typed, /gpu-bx/);
  const echoed = capture(() => {
    keys("\x7f"); // backspace
    keys("ox.local\r");
  });
  assert.equal(await p, "gpu-box.local", "start() twice did not double the keystrokes");
  assert.match(echoed, /Address of the machine: gpu-box\.local/);

  let cancelled, empty;
  capture(() => {
    cancelled = tui.prompt("Name");
    keys("half\x03");
  });
  assert.equal(await cancelled, null);
  capture(() => {
    empty = tui.prompt("Name");
    keys("  \r");
  });
  assert.equal(await empty, null);
  capture(() => tui.close());
});

test("tui: a long list scrolls with the selection, so rows past the tenth can be reached", async () => {
  const tui = new Tui();
  const options = Array.from({ length: 15 }, (_, i) => ({ label: `model-${String(i + 1).padStart(2, "0")}` }));
  options.push({ label: "+ Find models on another machine…" });
  let p;
  const first = capture(() => {
    tui.start();
    p = tui.select("Select model", options);
  });
  assert.match(first, /model-10/);
  assert.doesNotMatch(first, /model-11/);
  assert.match(first, /↓ 6 more/);

  const scrolled = capture(() => keys(DOWN.repeat(12)));
  const last = scrolled.slice(scrolled.lastIndexOf("Select model"));
  assert.match(last, /model-13/);
  assert.doesNotMatch(last, /model-03/);
  assert.match(last, /↑ 3 more/);
  assert.match(last, /↓ 3 more/);

  // Up from the top wraps to the bottom: the network row is one keypress away.
  const wrapped = capture(() => {
    keys(UP.repeat(13));
  });
  assert.match(wrapped.slice(wrapped.lastIndexOf("Select model")), /Find models on another machine/);
  capture(() => keys("\r"));
  assert.equal(await p, 15);
  capture(() => tui.close());
});

test("tui: a streaming tool call shows a live progress indicator, cleared by output", () => {
  const tui = new Tui();
  const frame = capture(() => {
    tui.start();
    tui.toolCallProgress("write_file", 1200);
  });
  assert.match(frame, /write_file/, "the tool being written is named");
  assert.match(frame, /1\.2k chars/, "the streamed argument size is shown");
  assert.match(frame, /\d+s/, "elapsed seconds are shown");

  const after = capture(() => {
    tui.token("done\n");
    tui.close();
  });
  assert.doesNotMatch(after, /write_file/, "real output replaces the indicator");
});

test("tui: the plan shows collapsed and expands on ctrl+o", () => {
  const tui = new Tui();
  const plan = {
    steps: [{ text: "wire entry" }, { text: "add movement" }, { text: "run build" }],
    currentIndex: 0,
    doneCount: 0,
  };
  tui.start();
  tui.planUpdated(plan);
  const collapsed = capture(() => {
    tui.readInput();
  });
  assert.match(collapsed, /Plan 0\/3/, "the collapsed header shows progress");
  assert.match(collapsed, /wire entry/, "the current step is shown");
  assert.doesNotMatch(collapsed, /add movement/, "the checklist is hidden while collapsed");

  const expanded = capture(() => keys("\x0f")); // ctrl+o
  assert.match(expanded, /add movement/, "ctrl+o reveals the full checklist");
  assert.match(expanded, /run build/);

  const recollapsed = capture(() => keys("\x0f"));
  assert.doesNotMatch(recollapsed, /add movement/, "ctrl+o collapses it again");
  capture(() => tui.close());
});

test("tui: reasoning streams on a live ticker and collapses on content", () => {
  const tui = new Tui();
  const frame = capture(() => {
    tui.start();
    tui.thinking("weighing the options");
  });
  assert.match(frame, /✦/, "reasoning shows the pulse marker");
  assert.match(frame, /weighing the options/);

  const after = capture(() => {
    tui.token("answer\n");
    tui.close();
  });
  assert.doesNotMatch(after, /weighing the options/);
});
