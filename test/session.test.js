// Session persistence helpers: the id shape, the transcript-to-web-events
// converter the terminal TUI uses when it saves, and the picker's age labels.
const test = require("node:test");
const assert = require("node:assert/strict");
const { eventsFromMessages, newSessionId, relativeTime } = require("../dist/session");

test("newSessionId: short hex, path-safe", () => {
  const id = newSessionId();
  assert.match(id, /^[a-f0-9]{8}$/);
  assert.notEqual(newSessionId(), newSessionId());
});

test("eventsFromMessages: maps user, assistant (thinking + text + tool) and tool results", () => {
  const events = eventsFromMessages([
    { role: "system", content: "sys" },
    { role: "user", content: "fix the bug" },
    { role: "assistant", thinking: "let me look", content: "Reading the file.", toolCalls: [{ id: "c1", name: "read_file", args: { path: "a.ts" } }] },
    { role: "tool", content: "line one\nline two", toolCallId: "c1", toolName: "read_file" },
    { role: "assistant", content: "Done." },
  ]);
  assert.deepEqual(
    events.map((e) => e.t),
    ["user", "thinking", "token", "tool", "result", "token"]
  );
  assert.equal(events[0].s, "fix the bug");
  assert.equal(events[3].name, "read_file");
  assert.match(events[3].summary, /a\.ts/);
  assert.equal(events[4].extra, 1);
  assert.equal(events[4].err, false);
  assert.equal(events[5].s, "Done.");
});

test("eventsFromMessages: harness-only messages are not replayed; errors are flagged", () => {
  const events = eventsFromMessages([
    { role: "user", content: "start" },
    { role: "user", content: "note", compactNote: true },
    { role: "assistant", content: "ok", historyNote: true },
    { role: "tool", content: "Error: boom", toolCallId: "x" },
  ]);
  assert.deepEqual(events.map((e) => e.t), ["user", "result"]);
  assert.equal(events[1].err, true);
});

test("relativeTime: reads as an age", () => {
  const now = Date.now();
  assert.equal(relativeTime(now), "just now");
  assert.equal(relativeTime(now - 5 * 60_000), "5m ago");
  assert.equal(relativeTime(now - 3 * 3_600_000), "3h ago");
  assert.equal(relativeTime(now - 26 * 3_600_000), "yesterday");
});
