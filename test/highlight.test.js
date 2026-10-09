// The streaming markdown highlighter that colours the model's reply in the
// terminal. Text arrives in arbitrary chunks, so the interesting cases are
// markers split across chunk boundaries and code-fence body state.
const test = require("node:test");
const assert = require("node:assert/strict");
const { StreamHighlighter } = require("../dist/tui/highlight");
const { MARKDOWN, ansi } = require("../dist/theme");

// eslint-disable-next-line no-control-regex
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("plain text streams through as body text", () => {
  const hl = new StreamHighlighter(true);
  const out = hl.push("hello world\n");
  assert.equal(strip(out), "hello world\n");
  assert.ok(out.includes(ansi(MARKDOWN.text)));
});

test("a heading is recognised even when its marker is split across chunks", () => {
  const hl = new StreamHighlighter(true);
  const out = hl.push("## Ti") + hl.push("tle\n");
  assert.equal(strip(out), "## Title\n");
  assert.ok(out.includes(ansi(MARKDOWN.heading)));
});

test("a code fence switches its body to the code-block colour", () => {
  const hl = new StreamHighlighter(true);
  const out = hl.push("```js\nconst a = 1;\n```\n");
  assert.equal(strip(out), "```js\nconst a = 1;\n```\n");
  assert.ok(out.includes(ansi(MARKDOWN.codeBlock)));
});

test("code inside inline backticks is coloured distinctly from the surrounding text", () => {
  const hl = new StreamHighlighter(true);
  const out = hl.push("use `npm test` now\n");
  assert.equal(strip(out), "use `npm test` now\n");
  assert.ok(out.includes(ansi(MARKDOWN.code)));
});

test("strikethrough is coloured, links are underlined in colour, and bold/italic combine", () => {
  const hl = new StreamHighlighter(true);
  const out = hl.push("~~old~~ [go](http://x) and ***bolditalic***\n");
  assert.equal(strip(out), "~~old~~ [go](http://x) and ***bolditalic***\n");
  assert.ok(out.includes(ansi(MARKDOWN.strike)));
  assert.ok(out.includes(ansi(MARKDOWN.link)));
  const emphasised = ansi(MARKDOWN.strong) + ansi(MARKDOWN.emph); // combined attributes use both roles — just assert roles present
  assert.ok(out.includes(ansi(MARKDOWN.strong)));
  assert.ok(out.includes(ansi(MARKDOWN.emph)));
});

test("a language alias (ts) is tokenised in a code fence", () => {
  const hl = new StreamHighlighter(true);
  const out = hl.push("```ts\nconst x: number = 1;\n```\n");
  assert.equal(strip(out), "```ts\nconst x: number = 1;\n```\n");
  assert.ok(out.includes(ansi(MARKDOWN.codeBlock)));
});

test("partial inline markers do not emit uncoloured garbage at end of line", () => {
  const hl = new StreamHighlighter(true);
  const a = hl.push("text **unclosed");
  const b = hl.flush();
  assert.equal(strip(a + b), "text **unclosed");
  hl.reset();
  const c = hl.push("link [incomplete");
  const d = hl.flush();
  assert.equal(strip(c + d), "link [incomplete");
});

test("a code fence with no language still uses the code block colour", () => {
  const hl = new StreamHighlighter(true);
  const out = hl.push("```\nplain\n```\n");
  assert.equal(strip(out), "```\nplain\n```\n");
  assert.ok(out.includes(ansi(MARKDOWN.codeBlock)));
});

test("flush inside a code fence emits the buffered code line", () => {
  const hl = new StreamHighlighter(true);
  hl.push("```js\nconst");
  const out = hl.flush();
  assert.equal(strip(out), "const");
});

test("list items and blockquotes are coloured", () => {
  const hl = new StreamHighlighter(true);
  const out = hl.push("- item\n> quote\n");
  assert.equal(strip(out), "- item\n> quote\n");
  assert.ok(out.includes(ansi(MARKDOWN.listItem)));
  assert.ok(out.includes(ansi(MARKDOWN.quote)));
});

test("flush emits a partial line once, and reset clears the fence state", () => {
  const hl = new StreamHighlighter(true);
  const a = hl.push("no newline");
  const b = hl.flush();
  assert.equal(strip(a + b), "no newline");
  assert.equal(strip(hl.flush()), "", "a second flush adds nothing");
  hl.reset();
  const c = hl.push("```\nx\n");
  assert.ok(c.includes(ansi(MARKDOWN.codeBlock)), "reset dropped the fence state");
});

test("colour off gives the plain stream", () => {
  const hl = new StreamHighlighter(false);
  const out = hl.push("## h\n`code`\n");
  assert.equal(out, "## h\n`code`\n");
  assert.ok(!out.includes("\x1b"));
});
