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

// A left-button press at 1-based cell (x, y), as an SGR mouse report.
const click = (y, x = 3) => keys(`\x1b[<0;${x};${y}M`);

test("tui: the plan shows collapsed and expands on a mouse click", () => {
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

  const expanded = capture(() => click(1));
  assert.match(expanded, /add movement/, "clicking the header reveals the full checklist");
  assert.match(expanded, /run build/);

  const recollapsed = capture(() => click(1));
  assert.doesNotMatch(recollapsed, /add movement/, "clicking again collapses it");
  capture(() => tui.close());
});

test("tui: a tool call expands on a click to its result summary", () => {
  const tui = new Tui();
  tui.start();
  tui.toolCall("read_file", { path: "src/app.ts" });
  tui.toolResult("export const x = 1;\nline2\nline3", 12);
  const collapsed = capture(() => tui.readInput());
  assert.match(collapsed, /read_file/, "the tool name is shown");
  assert.match(collapsed, /src\/app\.ts/, "the argument summary is shown");
  assert.doesNotMatch(collapsed, /\(\+2 lines\)/, "the result summary is hidden while collapsed");

  const expanded = capture(() => click(1));
  assert.match(expanded, /\(\+2 lines\)/, "the result summary appears when expanded");
  assert.match(expanded, /12ms/, "the duration appears with the summary");
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

test("tui: replayConversation clears the screen and rebuilds a resumed transcript", () => {
  const tui = new Tui();
  tui.start();
  capture(() => tui.println("old stuff"));

  const frame = capture(() => {
    tui.replayConversation(
      [
        { role: "system", content: "sys" },
        { role: "user", content: "add a score counter" },
        { role: "assistant", content: "Done — added it.", toolCalls: [{ id: "c1", name: "edit_file", args: { path: "game.js" } }] },
        { role: "tool", content: "Wrote 3 lines", toolCallId: "c1" },
      ],
      "score counter"
    );
  });
  assert.match(frame, /resumed session/);
  assert.match(frame, /score counter/, "the session title is shown");
  assert.match(frame, /add a score counter/, "the user turn is replayed");
  assert.match(frame, /Done — added it\./, "the assistant reply is replayed");
  assert.match(frame, /edit_file/);
  assert.match(frame, /game\.js/, "the tool call and its arguments are replayed");
  assert.doesNotMatch(frame, /old stuff/, "the previous transcript is cleared");

  const fresh = capture(() => tui.replayConversation([], ""));
  assert.match(fresh, /new session/);
  assert.doesNotMatch(fresh, /add a score counter/, "a new session starts empty");
  capture(() => tui.close());
});

test("tui: shift+Tab and a /mode line switch mode mid-run instead of queueing", () => {
  const tui = new Tui();
  let cycles = 0;
  let setArg = "unset";
  tui.onModeCycle = () => cycles++;
  tui.onModeSet = (arg) => { setArg = arg; };
  tui.start();
  capture(() => tui.readInput());
  capture(() => keys("hello\r")); // submit a turn: the agent is now running

  const tabbed = capture(() => keys("\x1b[Z")); // shift+Tab
  assert.equal(cycles, 1, "shift+Tab cycles the mode while the agent runs");
  assert.match(tabbed, /hello/, "the running transcript is still on screen");

  const typed = capture(() => keys("/mode auto\r"));
  assert.equal(setArg, "auto", "a /mode line is applied at once, not after the turn");
  const bare = capture(() => keys("/mode\r"));
  assert.equal(setArg, "", "a bare /mode cycles (the callback receives an empty name)");

  // An ordinary message typed mid-run is still queued for after the turn.
  capture(() => keys("later\r"));
  assert.deepEqual(tui.inputQueue, ["later"]);
  capture(() => tui.close());
});

test("tui: the approval prompt is a menu — arrows move, enter confirms, esc denies", async () => {
  const tui = new Tui();
  let p;
  const frame = capture(() => {
    tui.start();
    p = tui.confirmCommand("rm -rf /tmp/x", "reaches outside the workspace");
  });
  assert.match(frame, /run\? rm -rf \/tmp\/x/, "the command is shown");
  assert.match(frame, /reaches outside the workspace/, "so is the reason");
  assert.match(frame, /Yes\s+run this command once/, "first option");
  assert.match(frame, /Always allow 'rm'\s+for this session/, "second option names the program");
  assert.match(frame, /No\s+refuse and tell the model/, "third option");
  assert.match(frame, /↑↓ choose · enter confirm · esc deny/, "the keys are advertised");

  // Down moves the highlight; enter picks whatever is highlighted.
  capture(() => keys(DOWN));
  capture(() => keys("\r"));
  assert.equal(await p, "always", "the second row resolves to always");

  // The highlight starts on "yes": enter alone runs the command once.
  capture(() => {
    p = tui.confirmCommand("ls /root");
    keys("\r");
  });
  assert.equal(await p, "yes");

  capture(() => {
    p = tui.confirmCommand("ls /root");
    keys("\x1b");
  });
  assert.equal(await p, "no", "esc denies");
  capture(() => {
    p = tui.confirmCommand("ls /root");
    keys("\x03");
  });
  assert.equal(await p, "no", "ctrl+c denies");

  // Direct letter and number shortcuts still work.
  capture(() => {
    p = tui.confirmCommand("ls");
    keys("y");
  });
  assert.equal(await p, "yes");
  capture(() => {
    p = tui.confirmCommand("ls");
    keys("2");
    keys("\r");
  });
  assert.equal(await p, "always", "number keys jump to a row, enter confirms it");
  capture(() => tui.close());
});
