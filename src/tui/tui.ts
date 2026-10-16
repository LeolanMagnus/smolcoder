// The interactive TUI. A full-screen (alternate buffer) view: a retained
// transcript on top and the input frame docked at the bottom. Tool calls and
// the plan are collapsible — click a block's header with the mouse to expand
// it — mirroring how tool responses behave in opencode. Hand-rolled ANSI,
// zero deps.

import { Plan } from "../plan";
import { Msg } from "../providers/types";
import { ThemeMode } from "../theme";
import { diffCounts, editDiff } from "../tools/diff";
import { SelectOption, SessionUI, SlashCommand, summarizeArgs } from "../ui";
import { c, fmtDuration } from "../util";
import { LineEditor, layoutBuffer } from "./editor";
import { Key, KeyDecoder, Mouse } from "./keys";
import { Block, paintDiff, Transcript, ToolInfo, truncateVisible, visLen } from "./render";

type State = "hidden" | "idle" | "select" | "confirm" | "prompt";

const SELECT_ROWS = 10;

const ACCENT = "\x1b[36m"; // cyan accent bar
const RESET = "\x1b[0m";
const BAR = `${ACCENT}▌${RESET} `;
// Selection bar for menu/picker rows, per theme (no dark shading elsewhere).
const SEL_DARK = "\x1b[48;5;31m\x1b[38;5;231m";
const SEL_LIGHT = "\x1b[48;5;117m\x1b[38;5;232m";

/** One row of the input block: accent bar + content padded to width. No
 * background shading — the block blends with the terminal (dark or light). */
function boxRow(content: string, w: number): string {
  const inner = Math.max(1, w - 2);
  if (visLen(content) > inner) content = truncateVisible(content, inner);
  const pad = Math.max(0, inner - visLen(content));
  return `${ACCENT}▌${RESET} ${content}${" ".repeat(pad)}`;
}

interface Frame {
  lines: string[];
  curRow: number;
  curCol: number;
}

export class Tui implements SessionUI {
  slashCommands: SlashCommand[] = [];
  getStatus: () => string = () => "";
  onModeCycle: (() => void) | null = null;
  onCancel: (() => void) | null = null;
  onExit: (() => void) | null = null;
  placeholder = "Describe a change…   / commands";
  /** Shown dim on the left of the hint row (the workspace path). */
  hintLeft = "";
  /** Opening banner lines, seeded into the transcript on start(). */
  banner: string[] = [];

  private ed = new LineEditor();
  private decoder = new KeyDecoder();
  private onDataFn: ((d: string) => void) | null = null;
  private onResizeFn: (() => void) | null = null;
  private state: State = "hidden";
  private history: string[] = [];
  private histIdx = -1;
  private histStash = "";
  private menuIndex = 0;
  private lastMenuFilter: string | null = null;
  private notice: string | null = null;
  private lastCtrlC = 0;
  private submitResolve: ((s: string) => void) | null = null;

  private transcript = new Transcript();
  private currentContent: number | null = null;
  private currentPlan: number | null = null;
  private pendingTool: number | null = null;
  private pendingDiff: import("../tools/diff").DiffLine[] | null = null;
  private currentThought: number | null = null;
  private thoughtStart = 0;
  private thoughtRaw = "";
  private showThinking = true;
  private toolDetails = false;
  /** Messages typed while the agent is working, run after the current turn. */
  private inputQueue: string[] = [];
  private queueEd = new LineEditor();
  private scrollOffset = 0;
  /** A transient status row (spinner / reasoning ticker / argument progress)
   * pinned above the input frame, and what currently owns it. */
  private transient: string | null = null;
  private transientKind: "spinner" | "ticker" | "progress" | null = null;
  private ownerRow: number[] = [];
  private prevScreen: string[] = [];

  private sel: {
    title: string;
    options: SelectOption[];
    filter: string;
    index: number;
    /** First visible row: the list scrolls so the selection never leaves the window. */
    top: number;
    resolve: (i: number | null) => void;
  } | null = null;
  private promptState: {
    title: string;
    placeholder: string;
    ed: LineEditor;
    resolve: (s: string | null) => void;
  } | null = null;
  private started = false;
  private confirmState: {
    command: string;
    reason?: string;
    /** Selected menu row: 0 yes · 1 always · 2 no. */
    index: number;
    resolve: (r: "yes" | "no" | "always") => void;
  } | null = null;
  private spinnerTimer: NodeJS.Timeout | null = null;
  private spinnerActive = false;
  private progressTimer: NodeJS.Timeout | null = null;
  private progressActive = false;
  private progressName = "";
  private progressChars = 0;
  private progressStart = 0;
  private progressFrame = 0;
  private mode: ThemeMode;

  constructor(mode: ThemeMode = "dark") {
    this.mode = mode;
  }

  setTheme(mode: ThemeMode): void {
    this.mode = mode;
    if (this.started) this.render();
  }

  private selBar(): string {
    return this.mode === "light" ? SEL_LIGHT : SEL_DARK;
  }

  /** Safe to call twice: startup opens the TUI early when it has to ask where
   * the models are, and the session starts it again later. */
  start(): void {
    if (this.started) return;
    this.started = true;
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    this.onDataFn = (d: string) => this.onData(d);
    this.onResizeFn = () => this.render();
    process.stdin.on("data", this.onDataFn);
    process.stdout.on("resize", this.onResizeFn);
    if (this.banner.length) {
      this.transcript.add({ kind: "line", text: this.banner.join("\n"), tone: "status" });
    }
    // Alternate screen + SGR mouse + bracketed paste.
    process.stdout.write("\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[?2004h\x1b[2J\x1b[H\x1b[?25l");
    this.prevScreen = [];
    this.render();
  }

  close(): void {
    this.stopSpinner();
    this.finishThought();
    this.stopProgress();
    process.stdout.write("\x1b[?1006l\x1b[?1000l\x1b[?2004l\x1b[?1049l\x1b[?25h");
    if (this.onDataFn) process.stdin.off("data", this.onDataFn);
    if (this.onResizeFn) process.stdout.off("resize", this.onResizeFn);
    process.stdin.setRawMode?.(false);
    process.stdin.pause();
  }

  // ---- input ---------------------------------------------------------------

  readInput(): Promise<string> {
    this.ed.clear();
    this.histIdx = -1;
    this.menuIndex = 0;
    this.transient = null;
    this.scrollOffset = 0;
    this.state = "idle";
    // A message typed while the previous turn ran is taken first. It was
    // already echoed when queued, so only the input state is reset here.
    if (this.inputQueue.length) {
      const next = this.inputQueue.shift()!;
      this.render();
      return Promise.resolve(next);
    }
    this.render();
    return new Promise((res) => (this.submitResolve = res));
  }

  select(title: string, options: SelectOption[]): Promise<number | null> {
    this.stopSpinner();
    this.finishThought();
    this.stopProgress();
    this.state = "select";
    return new Promise((resolve) => {
      this.sel = { title, options, filter: "", index: 0, top: 0, resolve };
      this.render();
    });
  }

  prompt(title: string, placeholder = ""): Promise<string | null> {
    this.stopSpinner();
    this.finishThought();
    this.stopProgress();
    this.state = "prompt";
    return new Promise((resolve) => {
      this.promptState = { title, placeholder, ed: new LineEditor(), resolve };
      this.render();
    });
  }

  confirmCommand(command: string, reason?: string): Promise<"yes" | "no" | "always"> {
    this.stopSpinner();
    this.finishThought();
    this.stopProgress();
    this.state = "confirm";
    return new Promise((resolve) => {
      this.confirmState = { command, reason, index: 0, resolve };
      this.render();
    });
  }

  // ---- key routing ---------------------------------------------------------

  private onData(data: string): void {
    for (const key of this.decoder.decode(data)) {
      if (key.type === "mouse") {
        this.onMouse(key.mouse!);
        continue;
      }
      if (key.type === "pgup") {
        this.scroll(this.pageStep());
        this.render();
        continue;
      }
      if (key.type === "pgdn") {
        this.scroll(-this.pageStep());
        this.render();
        continue;
      }
      switch (this.state) {
        case "idle":
          this.keyIdle(key);
          break;
        case "select":
          this.keySelect(key);
          break;
        case "confirm":
          this.keyConfirm(key);
          break;
        case "prompt":
          this.keyPrompt(key);
          break;
        case "hidden": // agent running — type to queue a follow-up message
          this.keyHidden(key);
          break;
      }
    }
  }

  /** Mouse: wheel scrolls, a left click toggles the block under the cursor. */
  private onMouse(m: Mouse): void {
    if (m.code === 64 || m.code === 65) {
      this.scroll(m.code === 64 ? 3 : -3);
      this.render();
      return;
    }
    if (m.release || (m.code & 3) !== 0) return; // left button press only
    const idx = this.ownerRow[m.y - 1];
    if (idx === undefined || idx < 0) return;
    const b = this.transcript.blockAt(idx);
    if (b && (b.kind === "tool" || b.kind === "plan" || b.kind === "thought")) {
      this.transcript.update(idx, { ...b, expanded: !b.expanded });
      this.render();
    }
  }

  private pageStep(): number {
    return Math.max(1, this.rows() - 3);
  }

  /** Positive delta scrolls toward older content. */
  private scroll(delta: number): void {
    this.scrollOffset = Math.max(0, this.scrollOffset + delta);
  }

  private keyIdle(key: Key): void {
    this.notice = null;
    const menu = this.menuEntries();
    switch (key.type) {
      case "char":
      case "text":
        this.ed.insert(key.text!);
        break;
      case "enter":
        this.submit(menu);
        return;
      case "tab":
        if (menu.length > 0) {
          this.ed.set("/" + menu[Math.min(this.menuIndex, menu.length - 1)].name + " ");
        }
        break;
      case "shifttab":
        this.onModeCycle?.();
        break;
      case "backspace":
        this.ed.backspace();
        break;
      case "delete":
        this.ed.del();
        break;
      case "left":
        this.ed.left();
        break;
      case "right":
        this.ed.right();
        break;
      case "home":
      case "ctrla":
        this.ed.home();
        break;
      case "end":
      case "ctrle":
        this.ed.end();
        break;
      case "ctrlu":
        this.ed.killToLineStart();
        break;
      case "ctrlw":
        this.ed.deleteWordBack();
        break;
      case "up":
        if (menu.length > 0) {
          this.menuIndex = (this.menuIndex - 1 + menu.length) % menu.length;
        } else if (!this.ed.upLine()) {
          this.historyPrev();
        }
        break;
      case "down":
        if (menu.length > 0) {
          this.menuIndex = (this.menuIndex + 1) % menu.length;
        } else if (!this.ed.downLine()) {
          this.historyNext();
        }
        break;
      case "esc":
        this.ed.clear();
        break;
      case "ctrlc": {
        if (this.ed.buffer.length > 0) {
          this.ed.clear();
        } else if (Date.now() - this.lastCtrlC < 1500) {
          this.onExit?.();
          return;
        } else {
          this.lastCtrlC = Date.now();
          this.notice = "press ctrl+c again to exit";
        }
        break;
      }
      case "ctrld":
        if (this.ed.buffer.length === 0) {
          this.onExit?.();
          return;
        }
        break;
    }
    this.render();
  }

  private submit(menu: SlashCommand[]): void {
    let text = this.ed.buffer;
    if (menu.length > 0) {
      text = "/" + menu[Math.min(this.menuIndex, menu.length - 1)].name;
    }
    text = text.trim();
    if (!text) return;
    if (this.history[this.history.length - 1] !== text) this.history.push(text);
    this.state = "hidden";
    this.currentContent = null;
    this.currentPlan = null;
    this.pendingTool = null;
    this.scrollOffset = 0;
    this.transient = null;
    this.transcript.add({ kind: "line", text: "", tone: "status" });
    this.transcript.add({ kind: "user", text });
    this.render();
    const resolve = this.submitResolve;
    this.submitResolve = null;
    resolve?.(text);
  }

  /** While the agent runs: edit the follow-up queue buffer. Enter queues the
   * message to run after the current turn; esc clears it, then cancels. */
  private keyHidden(key: Key): void {
    const ed = this.queueEd;
    switch (key.type) {
      case "char":
      case "text":
        ed.insert(key.text!);
        break;
      case "backspace":
        ed.backspace();
        break;
      case "delete":
        ed.del();
        break;
      case "left":
        ed.left();
        break;
      case "right":
        ed.right();
        break;
      case "home":
      case "ctrla":
        ed.home();
        break;
      case "end":
      case "ctrle":
        ed.end();
        break;
      case "ctrlu":
        ed.killToLineStart();
        break;
      case "ctrlw":
        ed.deleteWordBack();
        break;
      case "enter": {
        const text = ed.buffer.trim();
        if (text) {
          ed.clear();
          this.inputQueue.push(text);
          this.transcript.add({ kind: "line", text: "", tone: "status" });
          this.transcript.add({ kind: "user", text });
          this.notice = null;
        }
        break;
      }
      case "esc":
        if (ed.buffer.length > 0) ed.clear();
        else this.onCancel?.();
        break;
      case "ctrlc":
        this.onCancel?.();
        break;
      default:
        break;
    }
    this.render();
  }

  private historyPrev(): void {
    if (this.history.length === 0) return;
    if (this.histIdx === -1) {
      this.histStash = this.ed.buffer;
      this.histIdx = this.history.length - 1;
    } else if (this.histIdx > 0) {
      this.histIdx--;
    } else return;
    this.ed.set(this.history[this.histIdx]);
  }

  private historyNext(): void {
    if (this.histIdx === -1) return;
    if (this.histIdx < this.history.length - 1) {
      this.histIdx++;
      this.ed.set(this.history[this.histIdx]);
    } else {
      this.histIdx = -1;
      this.ed.set(this.histStash);
    }
  }

  private keySelect(key: Key): void {
    const s = this.sel!;
    const filtered = this.filteredOptions();
    switch (key.type) {
      case "up":
        s.index = filtered.length ? (s.index - 1 + filtered.length) % filtered.length : 0;
        break;
      case "down":
      case "tab":
        s.index = filtered.length ? (s.index + 1) % filtered.length : 0;
        break;
      case "char":
      case "text":
        s.filter += key.text!;
        s.index = 0;
        break;
      case "backspace":
        s.filter = s.filter.slice(0, -1);
        s.index = 0;
        break;
      case "enter": {
        if (!filtered.length) break;
        const original = s.options.indexOf(filtered[Math.min(s.index, filtered.length - 1)]);
        this.endSelect(original);
        return;
      }
      case "esc":
      case "ctrlc":
        this.endSelect(null);
        return;
      default:
        break;
    }
    this.render();
  }

  private endSelect(result: number | null): void {
    const s = this.sel!;
    this.sel = null;
    this.state = "hidden";
    this.render();
    s.resolve(result);
  }

  private keyPrompt(key: Key): void {
    const p = this.promptState!;
    const finish = (value: string | null) => {
      this.promptState = null;
      this.state = "hidden";
      this.transcript.add({ kind: "line", text: `  ${p.title}: ${value ?? "cancelled"}`, tone: "status" });
      this.render();
      p.resolve(value);
    };
    switch (key.type) {
      case "char":
      case "text":
        p.ed.insert(key.text!.replace(/[\r\n]+/g, " "));
        break;
      case "backspace":
        p.ed.backspace();
        break;
      case "delete":
        p.ed.del();
        break;
      case "left":
        p.ed.left();
        break;
      case "right":
        p.ed.right();
        break;
      case "home":
      case "ctrla":
        p.ed.home();
        break;
      case "end":
      case "ctrle":
        p.ed.end();
        break;
      case "ctrlu":
        p.ed.killToLineStart();
        break;
      case "ctrlw":
        p.ed.deleteWordBack();
        break;
      case "enter":
        finish(p.ed.buffer.trim() || null);
        return;
      case "esc":
      case "ctrlc":
        finish(null);
        return;
      default:
        break;
    }
    this.render();
  }

  private filteredOptions(): SelectOption[] {
    const s = this.sel!;
    if (!s.filter) return s.options;
    const f = s.filter.toLowerCase();
    return s.options.filter((o) => o.label.toLowerCase().includes(f));
  }

  private keyConfirm(key: Key): void {
    const cs = this.confirmState!;
    const results: ("yes" | "always" | "no")[] = ["yes", "always", "no"];
    let result: "yes" | "no" | "always" | null = null;
    switch (key.type) {
      case "up":
        cs.index = (cs.index + results.length - 1) % results.length;
        break;
      case "down":
      case "tab":
        cs.index = (cs.index + 1) % results.length;
        break;
      case "enter":
        result = results[cs.index];
        break;
      case "esc":
      case "ctrlc":
        result = "no";
        break;
      case "char": {
        const ch = key.text!.toLowerCase();
        if (ch === "y") result = "yes";
        else if (ch === "n") result = "no";
        else if (ch === "a") result = "always";
        else if (ch >= "1" && ch <= "3") cs.index = Number(ch) - 1;
        break;
      }
      default:
        break;
    }
    if (result === null) {
      this.render();
      return;
    }
    this.confirmState = null;
    this.state = "hidden";
    this.transcript.add({
      kind: "line",
      text: `  ${result === "always" ? "always allowed" : result} — ${cs.command}`,
      tone: "status",
    });
    this.render();
    cs.resolve(result);
  }

  // ---- rendering -----------------------------------------------------------

  private menuEntries(): SlashCommand[] {
    const b = this.ed.buffer;
    if (!b.startsWith("/") || b.includes(" ") || b.includes("\n")) return [];
    const filter = b.slice(1).toLowerCase();
    const list = this.slashCommands.filter((cmd) => cmd.name.startsWith(filter)).slice(0, 8);
    if (filter !== this.lastMenuFilter) {
      this.menuIndex = 0;
      this.lastMenuFilter = filter;
    }
    if (this.menuIndex >= list.length) this.menuIndex = 0;
    return list;
  }

  private width(): number {
    return Math.max(30, (process.stdout.columns || 80) - 1);
  }

  private rows(): number {
    return Math.max(3, process.stdout.rows || 24);
  }

  /** The bottom frame (input block, slash menu, pickers) for the current state. */
  private frameLines(w: number): Frame {
    const lines: string[] = [];
    let curRow = -1;
    let curCol = 0;

    if (this.state === "idle") {
      const menu = this.menuEntries();
      const menuW = Math.min(w, 64);
      for (let i = 0; i < menu.length; i++) {
        const row = ` /${menu[i].name.padEnd(12)} ${menu[i].desc}`.slice(0, menuW).padEnd(menuW);
        lines.push(
          i === this.menuIndex
            ? `${this.selBar()}${row}${RESET}`
            : ` ${c.bold("/" + menu[i].name.padEnd(12))} ${c.dim(menu[i].desc)}`
        );
      }
      const inputW = w - 2;
      if (this.ed.buffer.length === 0) {
        curRow = lines.length;
        curCol = 2;
        lines.push(boxRow(c.dim(this.placeholder.slice(0, inputW)), w));
      } else {
        const lay = layoutBuffer(this.ed.buffer, this.ed.cursor, inputW);
        curRow = lines.length + lay.curRow;
        curCol = 2 + lay.curCol;
        for (const row of lay.rows) lines.push(boxRow(row, w));
      }
      lines.push(boxRow(this.getStatus(), w));
      if (this.notice) lines.push(" " + c.yellow(this.notice));
    } else if (this.state === "hidden") {
      // The agent is working: keep the input visible so the user can queue the
      // next message, with the context/status line under it.
      const inputW = w - 2;
      const hint = this.inputQueue.length ? ` · ${this.inputQueue.length} queued` : "";
      if (this.queueEd.buffer.length === 0) {
        curRow = lines.length;
        curCol = 2;
        lines.push(boxRow(c.dim(("type to queue a message…" + hint).slice(0, inputW)), w));
      } else {
        const lay = layoutBuffer(this.queueEd.buffer, this.queueEd.cursor, inputW);
        curRow = lines.length + lay.curRow;
        curCol = 2 + lay.curCol;
        for (const row of lay.rows) lines.push(boxRow(row, w));
      }
      lines.push(boxRow(this.getStatus(), w));
    } else if (this.state === "select" && this.sel) {
      const s = this.sel;
      const sw = Math.min(w, 64);
      lines.push(BAR + c.bold(s.title) + "   " + c.dim("esc cancel"));
      lines.push(BAR + (s.filter ? s.filter : c.dim("type to filter")));
      const filtered = this.filteredOptions();
      if (!filtered.length) lines.push(c.dim("   no matches"));
      if (s.index < s.top) s.top = s.index;
      if (s.index >= s.top + SELECT_ROWS) s.top = s.index - SELECT_ROWS + 1;
      s.top = Math.max(0, Math.min(s.top, filtered.length - SELECT_ROWS));
      if (s.top > 0) lines.push(c.dim(`   ↑ ${s.top} more`));
      for (let i = s.top; i < Math.min(filtered.length, s.top + SELECT_ROWS); i++) {
        const o = filtered[i];
        const marker = o.current ? "● " : "  ";
        const plain = ` ${marker}${o.label}${o.hint ? "  " + o.hint : ""}`.slice(0, sw).padEnd(sw);
        lines.push(
          i === s.index
            ? `${this.selBar()}${plain}${RESET}`
            : ` ${o.current ? c.green(marker) : marker}${o.label}${o.hint ? "  " + c.dim(o.hint) : ""}`
        );
      }
      const below = filtered.length - s.top - SELECT_ROWS;
      if (below > 0) lines.push(c.dim(`   ↓ ${below} more (type to filter)`));
    } else if (this.state === "prompt" && this.promptState) {
      const p = this.promptState;
      const pw = Math.min(w, 64);
      lines.push(BAR + c.bold(p.title) + "   " + c.dim("enter confirm · esc cancel"));
      curRow = lines.length;
      if (p.ed.buffer.length === 0) {
        curCol = 2;
        lines.push(boxRow(c.dim(p.placeholder.slice(0, pw - 2)), pw));
      } else {
        const from = Math.max(0, p.ed.cursor - (pw - 3));
        curCol = 2 + p.ed.cursor - from;
        lines.push(boxRow(p.ed.buffer.slice(from, from + pw - 2), pw));
      }
    } else if (this.state === "confirm" && this.confirmState) {
      const cs = this.confirmState;
      const program = cs.command.trim().split(/\s+/)[0];
      lines.push(BAR + c.yellow("run? ") + c.bold(cs.command.slice(0, w - 8)));
      if (cs.reason) lines.push("  " + c.dim(cs.reason));
      const options: { label: string; hint: string }[] = [
        { label: "Yes", hint: "run this command once" },
        { label: `Always allow '${program}'`, hint: "for this session" },
        { label: "No", hint: "refuse and tell the model" },
      ];
      const plainWidth = Math.min(w, 64);
      for (let i = 0; i < options.length; i++) {
        const o = options[i];
        const plain = ` ${o.label}  ${o.hint}`.slice(0, plainWidth).padEnd(plainWidth);
        lines.push(
          i === cs.index
            ? `${this.selBar()}${plain}${RESET}`
            : ` ${c.bold(o.label)}  ${c.dim(o.hint)}`
        );
      }
      lines.push("  " + c.dim("↑↓ choose · enter confirm · esc deny"));
    }
    return { lines, curRow, curCol };
  }

  /** Compose and paint one full screen: transcript viewport + transient row +
   * the bottom frame. */
  private render(): void {
    if (!this.started) return;
    const w = this.width();
    const total = this.rows();
    const { lines, owner } = this.transcript.flatten(w, this.mode);
    const frame = this.frameLines(w);
    const transientRows = this.transient ? 1 : 0;
    const bottom = frame.lines.length + transientRows;
    const viewH = Math.max(0, total - bottom);

    const maxStart = Math.max(0, lines.length - viewH);
    this.scrollOffset = Math.min(this.scrollOffset, maxStart);
    const start = maxStart - this.scrollOffset;

    const screen: string[] = [];
    this.ownerRow = [];
    for (let i = 0; i < viewH; i++) {
      const idx = start + i;
      screen.push(idx < lines.length ? truncateVisible(lines[idx], w) : "");
      this.ownerRow.push(idx < owner.length ? owner[idx] : -1);
    }
    if (transientRows) {
      screen.push(truncateVisible(this.transient!, w));
      this.ownerRow.push(-1);
    }
    for (const l of frame.lines) {
      screen.push(truncateVisible(l, w));
      this.ownerRow.push(-1);
    }
    while (screen.length < total) {
      screen.push("");
      this.ownerRow.push(-1);
    }

    let cursorRow = -1;
    let cursorCol = 0;
    if (frame.curRow >= 0) {
      cursorRow = viewH + transientRows + frame.curRow;
      cursorCol = frame.curCol;
    }
    this.paint(screen, cursorRow, cursorCol);
  }

  private paint(screen: string[], cursorRow: number, cursorCol: number): void {
    const w = this.width();
    if (process.stdout.isTTY) {
      let out = paintDiff(this.prevScreen, screen, w);
      out += cursorRow >= 0 ? `\x1b[${cursorRow + 1};${cursorCol + 1}H\x1b[?25h` : "\x1b[?25l";
      process.stdout.write(out);
    } else {
      // No cursor addressing off a real terminal (tests, pipes): full frame.
      process.stdout.write(screen.join("\n") + "\n");
      if (cursorRow >= 0) process.stdout.write(`\x1b[${cursorRow + 1};${cursorCol + 1}H`);
    }
  }

  /** Redraw the frame if one is on screen (status bar refresh, etc.). */
  refresh(): void {
    this.render();
  }

  // ---- AgentUI (output while the agent runs) -------------------------------

  token(text: string): void {
    this.stopSpinner();
    this.finishThought();
    this.stopProgress();
    if (this.currentContent === null) {
      this.currentContent = this.transcript.add({ kind: "content", raw: "" });
    }
    const b = this.transcript.blockAt(this.currentContent) as { kind: "content"; raw: string };
    this.transcript.update(this.currentContent, { kind: "content", raw: b.raw + text });
    this.render();
  }

  /** Reasoning streams into a collapsible block (like opencode), kept after the
   * turn so it can be reviewed; hidden by default when /thinking is off. */
  thinking(text: string): void {
    this.stopSpinner();
    if (this.state !== "hidden") return;
    if (!this.showThinking) return;
    if (this.currentThought === null) {
      this.thoughtStart = Date.now();
      this.thoughtRaw = "";
      this.currentThought = this.transcript.add({ kind: "thought", raw: "", expanded: false, seconds: 0 });
    }
    this.thoughtRaw += text;
    this.transcript.update(this.currentThought, {
      kind: "thought",
      raw: this.thoughtRaw,
      expanded: false,
      seconds: Math.floor((Date.now() - this.thoughtStart) / 1000),
    });
    this.render();
  }

  /** Freeze the current reasoning block's elapsed time. */
  private finishThought(): void {
    if (this.currentThought === null) return;
    const block = this.transcript.blockAt(this.currentThought);
    if (block?.kind === "thought") {
      this.transcript.update(this.currentThought, { ...block, seconds: Math.floor((Date.now() - this.thoughtStart) / 1000) });
    }
    this.currentThought = null;
    this.thoughtRaw = "";
  }

  /** Called as a tool call's arguments stream in: a live "writing X · Nk · Ns"
   * transient row until the call completes. */
  toolCallProgress(name: string, chars: number): void {
    this.stopSpinner();
    if (this.state !== "hidden") return;
    this.finishThought();
    this.progressName = name;
    this.progressChars = chars;
    if (!this.progressActive) {
      this.progressActive = true;
      this.transientKind = "progress";
      this.progressStart = Date.now();
      this.progressTimer = setInterval(() => this.renderProgress(), 100);
    }
    this.renderProgress();
  }

  private renderProgress(): void {
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    const secs = Math.floor((Date.now() - this.progressStart) / 1000);
    const size = this.progressChars >= 1000 ? `${(this.progressChars / 1000).toFixed(1)}k` : String(this.progressChars);
    const label = `${this.progressName} · ${size} chars · ${secs}s · esc to cancel`;
    this.transient = c.cyan(frames[this.progressFrame++ % frames.length]) + " " + c.dim(label);
    this.render();
  }

  private stopProgress(): void {
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
    if (this.progressActive) {
      this.progressActive = false;
      if (this.transientKind === "progress") {
        this.transient = null;
        this.transientKind = null;
      }
    }
  }

  toolCall(name: string, args: Record<string, any>): void {
    this.stopSpinner();
    this.finishThought();
    this.stopProgress();
    this.currentContent = null;
    this.pendingDiff = editDiff(name, args);
    this.pendingTool = this.transcript.add({
      kind: "tool",
      name,
      argsSummary: summarizeArgs(name, args),
      expanded: this.toolDetails,
    });
    this.render();
  }

  toolResult(result: string, durationMs?: number): void {
    this.stopSpinner();
    this.finishThought();
    this.stopProgress();
    const lines = result.split("\n");
    const first = lines[0] ?? "";
    const err = first.startsWith("Error");
    const warn = !err && result.includes("Warning:");
    let summary: string;
    if (err) summary = first.slice(0, 120);
    else if (warn) summary = result.slice(result.indexOf("Warning:")).split("\n")[0];
    else summary = first.slice(0, 100) + (lines.length > 1 ? ` (+${lines.length - 1} lines)` : "");
    const took = durationMs !== undefined ? fmtDuration(durationMs) : "";
    // A failed edit must not advertise changes that were never written.
    const diff = err ? undefined : this.pendingDiff ?? undefined;
    const counts = diff ? diffCounts(diff) : { adds: 0, dels: 0 };
    this.pendingDiff = null;

    if (this.pendingTool !== null) {
      const b = this.transcript.blockAt(this.pendingTool);
      if (b && b.kind === "tool") {
        this.transcript.update(this.pendingTool, {
          ...b,
          result: { summary, took, err, warn, body: err ? undefined : result, diff, adds: counts.adds, dels: counts.dels },
        });
      }
      this.pendingTool = null;
    } else {
      this.transcript.add({ kind: "line", text: summary, tone: err ? "error" : "status" });
    }
    this.render();
  }

  resetResponse(): void {
    this.stopSpinner();
    this.finishThought();
    this.stopProgress();
    while (this.transcript.lastIndex >= 0) {
      const kind = this.transcript.blockAt(this.transcript.lastIndex)?.kind;
      if (kind !== "content" && kind !== "thought") break;
      this.transcript.pop();
    }
    this.currentContent = null;
    this.currentThought = null;
    this.thoughtRaw = "";
    this.transcript.add({ kind: "line", text: "[Interrupted response discarded]", tone: "status" });
    this.render();
  }

  /** Replace the whole transcript with a resumed conversation (or an empty one
   * for a fresh session). Agent messages are replayed as blocks; tool results
   * are matched to their call by id. */
  replayConversation(messages: Msg[], title = ""): void {
    this.stopSpinner();
    this.finishThought();
    this.stopProgress();
    this.transcript.clear();
    this.currentContent = null;
    this.currentPlan = null;
    this.pendingTool = null;
    this.pendingDiff = null;
    this.currentThought = null;
    this.thoughtRaw = "";
    this.scrollOffset = 0;
    this.inputQueue = [];
    this.queueEd.clear();

    if (this.banner.length) this.transcript.add({ kind: "line", text: this.banner.join("\n"), tone: "status" });
    this.transcript.add({
      kind: "line",
      text: title ? `${c.dim("· resumed session")} ${c.bold(title)}` : c.dim("· new session"),
      tone: "status",
    });

    const toolBlocks = new Map<string, number>();
    for (const m of messages) {
      if (m.role === "system" || m.compactNote || m.historyNote) continue;
      if (m.role === "user") {
        this.transcript.add({ kind: "user", text: m.content });
      } else if (m.role === "assistant") {
        if (m.thinking) this.transcript.add({ kind: "thought", raw: m.thinking, expanded: false, seconds: 0 });
        if (m.content && m.content.trim()) this.transcript.add({ kind: "content", raw: m.content });
        for (const tc of m.toolCalls ?? []) {
          const idx = this.transcript.add({
            kind: "tool",
            name: tc.name,
            argsSummary: summarizeArgs(tc.name, tc.args ?? {}),
            expanded: this.toolDetails,
          });
          if (tc.id) toolBlocks.set(tc.id, idx);
        }
      } else if (m.role === "tool") {
        const lines = String(m.content ?? "").split("\n");
        const first = lines[0] ?? "";
        const err = first.startsWith("Error");
        const info: ToolInfo = { summary: first.slice(0, 120), took: "", err };
        const idx = m.toolCallId !== undefined ? toolBlocks.get(m.toolCallId) : undefined;
        const b = idx !== undefined ? this.transcript.blockAt(idx) : undefined;
        if (b && b.kind === "tool") {
          this.transcript.update(idx!, { ...b, result: info });
        } else {
          this.transcript.add({ kind: "line", text: first, tone: err ? "error" : "status" });
        }
      }
    }
    this.render();
  }

  println(s = ""): void {
    this.stopSpinner();
    this.finishThought();
    this.stopProgress();
    this.transcript.add({ kind: "line", text: s, tone: "status" });
    this.render();
  }

  status(s: string): void {
    this.println(s);
  }

  turnEnd(label: string): void {
    this.stopSpinner();
    this.finishThought();
    this.stopProgress();
    this.currentContent = null;
    this.pendingTool = null;
    this.transcript.add({ kind: "line", text: "", tone: "status" });
    this.transcript.add({ kind: "turnend", label });
    this.render();
  }

  planUpdated(plan: Plan): void {
    this.stopSpinner();
    this.finishThought();
    this.stopProgress();
    this.currentContent = null;
    const block: Block = {
      kind: "plan",
      steps: plan.steps.map((s) => ({ text: s.text, done: s.done, durationMs: s.durationMs })),
      current: plan.currentIndex,
      done: plan.doneCount,
      total: plan.steps.length,
      expanded: false,
    };
    if (this.currentPlan !== null && this.transcript.blockAt(this.currentPlan)?.kind === "plan") {
      const prev = this.transcript.blockAt(this.currentPlan) as { kind: "plan"; expanded: boolean };
      this.transcript.update(this.currentPlan, { ...block, expanded: prev.expanded });
    } else {
      this.currentPlan = this.transcript.add(block);
    }
    this.render();
  }

  /** `/details`: expand or collapse every tool block (like opencode). */
  setToolDetails(expanded: boolean): void {
    this.toolDetails = expanded;
    this.transcript.updateAll(
      (b) => b.kind === "tool",
      (b) => ({ ...(b as Extract<Block, { kind: "tool" }>), expanded })
    );
    this.render();
  }

  /** `/thinking`: show or hide reasoning blocks. Hiding removes the ones already
   * in the transcript; showing applies to reasoning from here on. */
  setThinking(visible: boolean): void {
    this.showThinking = visible;
    if (!visible) {
      this.transcript.removeAll((b) => b.kind === "thought");
      this.currentThought = null;
      this.thoughtRaw = "";
    }
    this.render();
  }

  warn(s: string): void {
    this.stopSpinner();
    this.finishThought();
    this.stopProgress();
    this.transcript.add({ kind: "line", text: s, tone: "warn" });
    this.render();
  }

  error(s: string): void {
    this.stopSpinner();
    this.finishThought();
    this.stopProgress();
    this.transcript.add({ kind: "line", text: s, tone: "error" });
    this.render();
  }

  startSpinner(label: string): void {
    if (this.state !== "hidden") return;
    this.stopSpinner();
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let i = 0;
    const started = Date.now();
    this.spinnerActive = true;
    this.transientKind = "spinner";
    this.spinnerTimer = setInterval(() => {
      const secs = Math.floor((Date.now() - started) / 1000);
      this.transient = c.cyan(frames[i++ % frames.length]) + " " + c.dim(label + (secs > 2 ? ` ${secs}s` : "") + " · esc to cancel");
      this.render();
    }, 100);
    this.transient = c.cyan(frames[0]) + " " + c.dim(label + " · esc to cancel");
    this.render();
  }

  stopSpinner(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
    this.spinnerActive = false;
    if (this.transientKind === "spinner") {
      this.transient = null;
      this.transientKind = null;
    }
  }
}
