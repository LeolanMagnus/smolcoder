// Human-facing diff for file edits, derived from tool arguments alone. No
// filesystem access, so every UI surface (TUI, headless, web) renders the same
// thing from the same call. Line-prefixed like a unified diff: added, removed,
// context. Bounded so a whole-file write cannot flood a small terminal.

export interface DiffLine {
  kind: "add" | "del" | "ctx";
  text: string;
}

const MAX_DIFF_LINES = 400;
const CONTEXT = 3;
// Guard the O(n*m) LCS table: above this, fall back to a coarse whole-block
// diff rather than allocating a huge matrix.
const LCS_CELL_LIMIT = 2_000_000;

function split(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n");
}

function lcsDiff(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  if (n * m > LCS_CELL_LIMIT) return coarse(a, b);
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "ctx", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: "del", text: a[i++] });
    } else {
      out.push({ kind: "add", text: b[j++] });
    }
  }
  while (i < n) out.push({ kind: "del", text: a[i++] });
  while (j < m) out.push({ kind: "add", text: b[j++] });
  return out;
}

function coarse(a: string[], b: string[]): DiffLine[] {
  const out: DiffLine[] = [];
  for (const line of a) out.push({ kind: "del", text: line });
  for (const line of b) out.push({ kind: "add", text: line });
  return out;
}

/** Keep only hunks: unchanged runs longer than 2*CONTEXT collapse to a "…". */
function hunks(lines: DiffLine[]): DiffLine[] {
  const changed: number[] = [];
  lines.forEach((l, i) => {
    if (l.kind !== "ctx") changed.push(i);
  });
  if (!changed.length) return [];
  const keep = new Set<number>();
  for (const idx of changed) {
    for (let k = Math.max(0, idx - CONTEXT); k <= Math.min(lines.length - 1, idx + CONTEXT); k++) keep.add(k);
  }
  const out: DiffLine[] = [];
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!keep.has(i)) continue;
    if (last >= 0 && i > last + 1) out.push({ kind: "ctx", text: "…" });
    out.push(lines[i]);
    last = i;
  }
  return out;
}

/** Added/removed line counts for a collapsed header badge. */
export function diffCounts(lines: DiffLine[]): { adds: number; dels: number } {
  let adds = 0;
  let dels = 0;
  for (const l of lines) {
    if (l.kind === "add") adds++;
    else if (l.kind === "del") dels++;
  }
  return { adds, dels };
}

/** Diff for a write/edit tool call, or null for anything else. */
export function editDiff(name: string, args: Record<string, any>): DiffLine[] | null {
  let lines: DiffLine[];
  if (name === "edit_file") {
    if (typeof args?.old_text !== "string" || typeof args?.new_text !== "string") return null;
    lines = hunks(lcsDiff(split(args.old_text), split(args.new_text)));
  } else if (name === "write_file") {
    if (typeof args?.content !== "string") return null;
    lines = split(args.content).map((text) => ({ kind: "add" as const, text }));
  } else {
    return null;
  }
  if (lines.length > MAX_DIFF_LINES) {
    const omitted = lines.length - MAX_DIFF_LINES;
    lines = lines.slice(0, MAX_DIFF_LINES);
    lines.push({ kind: "ctx", text: `… ${omitted} more diff lines` });
  }
  return lines.length ? lines : null;
}
