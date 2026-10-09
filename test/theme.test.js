// The reply theme: one palette, opencode's default shifted toward blue, that
// feeds both the terminal's ANSI and the web stylesheet's CSS variables.
const test = require("node:test");
const assert = require("node:assert/strict");
const { LIGHT_PALETTE, MARKDOWN, PALETTE, ansi, detectMode, hexToRgb, markdownOf } = require("../dist/theme");
const { STYLES } = require("../dist/web/styles");

test("every palette role is a valid hex colour", () => {
  for (const [name, hex] of Object.entries(PALETTE)) {
    assert.match(hex, /^#[0-9a-f]{6}$/, name);
  }
});

test("ansi builds a 24-bit foreground escape", () => {
  assert.equal(ansi("#8ab4f8"), "\x1b[38;2;138;180;248m");
  assert.deepEqual(hexToRgb("#000000"), [0, 0, 0]);
});

test("the web stylesheet carries the reply theme", () => {
  for (const role of ["text", "heading", "link", "code", "strong", "emph", "quote", "hr"]) {
    assert.ok(STYLES.includes(MARKDOWN[role]), "missing markdown colour for " + role);
  }
  assert.match(STYLES, /--md-heading:/);
  assert.match(STYLES, /\.md li::marker/);
});

test("the light palette mirrors every dark role and stays a valid hex", () => {
  assert.deepEqual(Object.keys(LIGHT_PALETTE).sort(), Object.keys(PALETTE).sort());
  for (const [name, hex] of Object.entries(LIGHT_PALETTE)) assert.match(hex, /^#[0-9a-f]{6}$/, name);
});

test("markdownOf('light') is legible ink, not pale-on-white", () => {
  const light = markdownOf("light");
  assert.equal(light.codeBlock, LIGHT_PALETTE.ink);
  assert.match(light.heading, /^#[0-9a-f]{6}$/);
});

test("detectMode uses an explicit override, then the env, then dark", () => {
  assert.equal(detectMode("light"), "light");
  assert.equal(detectMode(undefined, { SMOLCODER_THEME: "light" }), "light");
  assert.equal(detectMode(undefined, { COLORFGBG: "0;15" }), "light", "COLORFGBG is fg;bg, the background decides");
  assert.equal(detectMode(undefined, { COLORFGBG: "15;0" }), "dark");
  assert.equal(detectMode(undefined, {}), "dark");
  assert.equal(detectMode("dark", { SMOLCODER_THEME: "light" }), "dark", "explicit override wins");
});

test("the web stylesheet flips its variables for a light system", () => {
  assert.match(STYLES, /@media \(prefers-color-scheme: light\)/);
  const light = markdownOf("light");
  for (const [role, hex] of Object.entries(light)) {
    assert.ok(STYLES.includes(hex), "light stylesheet misses " + role);
  }
});
