// Full-screen transcript model for the interactive TUI: the conversation is a
// retained list of blocks (user text, streamed reply, tool calls, the plan,
// status lines). Each block renders itself to width-bounded rows, cached until
// its content or the terminal width changes. The screen is composed from the
// visible slice of those rows plus the bottom input frame, and painted with a
// line diff so a repaint on every streamed token never flickers.

import { ThemeMode } from "../theme";
import { c, fmtDuration, useColor } from "../util";
import { StreamHighlighter } from "./highlight";

const ACCENT = "\x1b[36m";
const RESET = "\x1b[0m";

export type Tone = "status" | "warn" | "error";

export interface ToolInfo {
  /** One-line result summary: the first line plus a "(+N lines)" tail. */
  summary: string;
  took: string;
  err: boolean;
  warn?: boolean;
}

export type Block =
  | { kind: "line"; text: string; tone: Tone }
  | { kind: "user"; text: string }
  | { kind: "content"; raw: string }
  | { kind: "tool"; name: string; argsSummary: string; result?: ToolInfo; expanded: boolean }
  | {
      kind: "plan";
      steps: { text: string; done: boolean; durationMs?: number }[];
      current: number;
      done: number;
      total: number;
      expanded: boolean;
    }
  | { kind: "turnend"; label: string };

/** Visible width of a string, ignoring ANSI SGR sequences. */
export function visLen(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** Cut a colored string to a visible length without splitting escape codes. */
export function truncateVisible(s: string, max: number): string {
  let out = "";
  let seen = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\x1b") {
      const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
      if (m) {
        out += m[0];
        i += m[0].length - 1;
        continue;
      }
    }
    if (seen >= max) continue;
    out += s[i];
    seen++;
  }
  return out;
}

/** Wrap text to `width` visible cells, honouring explicit newlines and never
 * splitting an ANSI escape. `width` is clamped to at least 1. */
export function wrapAnsi(s: string, width: number): string[] {
  const w = Math.max(1, width);
  const rows: string[] = [];
  let row = "";
  let len = 0;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\x1b") {
      const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
      if (m) {
        row += m[0];
        i += m[0].length;
        continue;
      }
    }
    if (ch === "\n") {
      rows.push(row);
      row = "";
      len = 0;
      i++;
      continue;
    }
    row += ch;
    len++;
    i++;
    if (len >= w) {
      rows.push(row);
      row = "";
      len = 0;
    }
  }
  rows.push(row);
  return rows;
}

/** Run the streamed reply's raw text through the highlighter in one pass. */
export function highlightRaw(raw: string, mode: ThemeMode): string {
  const h = new StreamHighlighter(useColor, mode);
  return h.push(raw) + h.flush();
}

function tone(text: string, t: Tone): string {
  // Text that already carries ANSI (a rendered plan, the banner) is left alone.
  if (/\x1b\[[0-9;]*m/.test(text)) return text;
  if (t === "warn") return c.yellow(text);
  if (t === "error") return c.red(text);
  return c.gray(text);
}

/** Render one block to width-bounded rows (each row fits `width` cells). */
export function renderBlock(b: Block, width: number, mode: ThemeMode): string[] {
  switch (b.kind) {
    case "user": {
      const rows: string[] = [];
      for (const line of b.text.split("\n")) {
        const parts = wrapAnsi(line, Math.max(1, width - 2));
        for (const p of parts) rows.push(`${ACCENT}▌${RESET} ${c.bold(p)}`);
      }
      return rows.length ? rows : [`${ACCENT}▌${RESET} `];
    }
    case "content":
      return wrapAnsi(highlightRaw(b.raw, mode), width);
    case "tool": {
      const marker = c.dim(b.expanded ? "⌄" : "›");
      const head = `${marker} ${c.cyan("→")} ${c.bold(b.name)} ${c.dim(b.argsSummary)}`;
      const rows = wrapAnsi(head, width);
      if (b.expanded && b.result) {
        const glyph = b.result.err ? c.red("✗") : b.result.warn ? c.yellow("!") : c.green("✓");
        const body = b.result.err ? c.red(b.result.summary) : b.result.warn ? c.yellow(b.result.summary) : c.dim(b.result.summary);
        const line = `  ${glyph} ${body}${b.result.took ? c.dim(" · " + b.result.took) : ""}`;
        for (const r of wrapAnsi(line, width)) rows.push(r);
      }
      return rows;
    }
    case "plan": {
      const marker = c.dim(b.expanded ? "⌄" : "›");
      const cur = b.current >= 0 ? b.steps[b.current]?.text ?? "" : "complete";
      const head = b.expanded
        ? `${marker} ${c.bold(`Plan ${b.done}/${b.total}`)}`
        : `${marker} ${c.bold(`Plan ${b.done}/${b.total}`)} ${c.dim("· " + cur)}`;
      const rows = [truncateVisible(head, width)];
      if (b.expanded) {
        b.steps.forEach((s, i) => {
          let row: string;
          if (s.done) {
            const took = s.durationMs !== undefined ? ` ${c.dim("· " + fmtDuration(s.durationMs))}` : "";
            row = `  ${c.dim("✔ " + s.text)}${took}`;
          } else if (i === b.current) {
            row = `  ${c.cyan("▶ " + s.text)}`;
          } else {
            row = `  ${c.gray("○ " + s.text)}`;
          }
          for (const r of wrapAnsi(row, width)) rows.push(r);
        });
      }
      return rows;
    }
    case "turnend":
      return [c.dim("■ " + b.label)];
    case "line":
      if (b.text === "") return [""];
      return wrapAnsi(tone(b.text, b.tone), width);
  }
}

interface Entry {
  block: Block;
  rows: string[];
  width: number;
  rev: number;
}

/** Retained conversation: append, update-in-place, and a cached flat view for
 * hit-testing (each screen line knows which block it belongs to). */
export class Transcript {
  private entries: Entry[] = [];
  private nextRev = 0;

  get length(): number {
    return this.entries.length;
  }

  /** Append a block; returns its index. */
  add(block: Block): number {
    this.entries.push({ block, rows: [], width: -1, rev: this.nextRev++ });
    return this.entries.length - 1;
  }

  /** Replace a block's content and invalidate its cached rows. */
  update(index: number, block: Block): void {
    const e = this.entries[index];
    if (!e) return;
    e.block = block;
    e.rev = this.nextRev++;
    e.width = -1; // force a re-render even if the width is unchanged
  }

  blockAt(index: number): Block | undefined {
    return this.entries[index]?.block;
  }

  get lastIndex(): number {
    return this.entries.length - 1;
  }

  /** Drop the last block (used to discard an interrupted streamed reply). */
  pop(): Block | undefined {
    return this.entries.pop()?.block;
  }

  /** Flatten to display lines plus, per line, the owning block index. */
  flatten(width: number, mode: ThemeMode): { lines: string[]; owner: number[] } {
    const lines: string[] = [];
    const owner: number[] = [];
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      if (e.width !== width) {
        e.rows = renderBlock(e.block, width, mode);
        e.width = width;
      }
      for (const r of e.rows) {
        lines.push(r);
        owner.push(i);
      }
    }
    return { lines, owner };
  }
}

/** Push only the screen rows that changed, using absolute cursor addressing.
 * Returns nothing; `prev` is updated in place. */
export function paintDiff(prev: string[], next: string[], cols: number): string {
  let out = "";
  for (let r = 0; r < next.length; r++) {
    const line = truncateVisible(next[r] ?? "", cols);
    if (prev[r] === line) continue;
    out += `\x1b[${r + 1};1H\x1b[2K` + line;
    prev[r] = line;
  }
  for (let r = next.length; r < prev.length; r++) {
    out += `\x1b[${r + 1};1H\x1b[2K`;
    prev[r] = "";
  }
  prev.length = next.length;
  return out;
}
