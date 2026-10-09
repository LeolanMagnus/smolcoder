// Streaming markdown highlighter for the model's reply. Text arrives in
// arbitrary chunks (split mid-line, mid-token), so this keeps a tiny per-line
// state machine: the leading characters of a line are buffered just long
// enough to tell a heading / list / quote / code fence from plain text, then
// the rest of the line is coloured as it streams.
//
// Inline markers (**bold**, *italic*, ~~strike~~, [links](url) and `code`) are
// held only while they are still open, so ordinary prose keeps streaming
// character by character. Code-fence bodies are tokenised per language
// (comment / string / number / keyword / type / function / operator), mirroring
// opencode's syntax vocabulary.
//
// The output is 24-bit ANSI built from the active theme (dark or light); with
// `color` off it is the plain text, so headless consumers still get a clean
// stream.

import { ANSI_RESET, MarkdownRole, Palette, markdownOf, paletteOf, ansi } from "../theme";

/** Decide a line's role from its leading characters. `done` is false while the
 * prefix could still grow into a marker (e.g. "##" before the space, "12"
 * before the dot). */
function resolve(prefix: string, codeBlock: boolean): { role?: MarkdownRole; done: boolean } {
  const lead = prefix.match(/^\s*/)?.[0] ?? "";
  const body = prefix.slice(lead.length);

  if (codeBlock) {
    if (/^`{3}/.test(body)) return { role: "hr", done: true };
    if (/^`{0,2}$/.test(body)) return { done: false };
    return { role: "codeBlock", done: true };
  }

  if (body === "") return { done: false };
  const ch = body[0];

  if (ch === "`") {
    if (/^`{3}/.test(body)) return { role: "hr", done: true };
    if (/^`{1,2}$/.test(body)) return { done: false };
    return { role: "text", done: true };
  }
  if (ch === "#") {
    const run = /^#{1,6}/.exec(body)?.[0] ?? "";
    const rest = body.slice(run.length);
    if (rest === "") return { done: false };
    if (/^\s/.test(rest)) return { role: "heading", done: true };
    return { role: "text", done: true };
  }
  if (ch === ">") return { role: "quote", done: true };
  if (ch === "-" || ch === "*" || ch === "+") {
    const rest = body.slice(1);
    if (rest === "") return { done: false };
    if (/^\s/.test(rest)) return { role: "listItem", done: true };
    return { role: "text", done: true };
  }
  if (/[0-9]/.test(ch)) {
    const rest = body.replace(/^\d+/, "");
    if (rest === "") return { done: false };
    if (rest[0] !== "." && rest[0] !== ")") return { role: "text", done: true };
    const after = rest.slice(1);
    if (after === "") return { done: false };
    if (/^\s/.test(after)) return { role: "listEnum", done: true };
    return { role: "text", done: true };
  }
  return { role: "text", done: true };
}

/** Last-resort role for a line that ends while still undecided. */
function finalize(prefix: string, codeBlock: boolean): MarkdownRole {
  if (codeBlock) return /^\s*`{3}/.test(prefix) ? "hr" : "codeBlock";
  if (/^\s*#{1,6}\s*$/.test(prefix)) return "heading";
  if (/^\s*>/.test(prefix)) return "quote";
  if (/^\s*[-*+]\s*$/.test(prefix)) return "listItem";
  if (/^\s*\d+[.)]\s*$/.test(prefix)) return "listEnum";
  return "text";
}

const MAX_PREFIX = 64;

// ---- inline markdown ------------------------------------------------------

interface Attr {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  underline?: boolean;
}

interface Span {
  text: string;
  role: MarkdownRole;
  attr: Attr;
  /** False when the span ends the line while a marker could still be closed. */
  stable: boolean;
}

/** Index of a lone "*" (not part of "**") at or after `from`, or -1. */
function indexLoneStar(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === "*" && s[i - 1] !== "*" && s[i + 1] !== "*") return i;
  }
  return -1;
}

/** Split one line of raw text into contiguous styled spans. */
function tokenizeInline(raw: string, baseRole: MarkdownRole): Span[] {
  const spans: Span[] = [];
  let plain = "";
  const flush = () => {
    if (plain) {
      spans.push({ text: plain, role: baseRole, attr: {}, stable: true });
      plain = "";
    }
  };

  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];

    if (ch === "`") {
      const end = raw.indexOf("`", i + 1);
      if (end < 0) {
        flush();
        spans.push({ text: raw.slice(i), role: "code", attr: {}, stable: false });
        i = raw.length;
        break;
      }
      flush();
      spans.push({ text: raw.slice(i, end + 1), role: "code", attr: {}, stable: true });
      i = end + 1;
      continue;
    }

    if (ch === "*") {
      const run = /^\*+/.exec(raw.slice(i))![0];
      const marker = run.length >= 3 ? "***" : run.length === 2 ? "**" : "*";
      const from = i + marker.length;
      const end = marker === "*" ? indexLoneStar(raw, from) : raw.indexOf(marker, from);
      const attr: Attr = marker === "***" ? { bold: true, italic: true } : marker === "**" ? { bold: true } : { italic: true };
      const role: MarkdownRole = marker === "*" ? "emph" : "strong";
      if (end < 0) {
        flush();
        spans.push({ text: raw.slice(i), role, attr, stable: false });
        i = raw.length;
        break;
      }
      flush();
      spans.push({ text: raw.slice(i, end + marker.length), role, attr, stable: true });
      i = end + marker.length;
      continue;
    }

    if (ch === "~" && raw[i + 1] === "~") {
      const end = raw.indexOf("~~", i + 2);
      if (end < 0) {
        flush();
        spans.push({ text: raw.slice(i), role: "strike", attr: { strike: true }, stable: false });
        i = raw.length;
        break;
      }
      flush();
      spans.push({ text: raw.slice(i, end + 2), role: "strike", attr: { strike: true }, stable: true });
      i = end + 2;
      continue;
    }

    if (ch === "[") {
      const m = /^\[([^\]]*)\]\(([^)\s]*)\)/.exec(raw.slice(i));
      if (m) {
        flush();
        spans.push({ text: m[0], role: "link", attr: { underline: true }, stable: true });
        i += m[0].length;
        continue;
      }
      if (/^\[[^\]]*(\][^)]*)?$/.test(raw.slice(i)) && /[\[(]/.test(raw.slice(i))) {
        // A link that is still open at the end of the buffered text.
        flush();
        spans.push({ text: raw.slice(i), role: "link", attr: { underline: true }, stable: false });
        i = raw.length;
        break;
      }
      plain += ch;
      i++;
      continue;
    }

    plain += ch;
    i++;
  }
  flush();
  return spans;
}

// ---- code-fence syntax ----------------------------------------------------

interface LangCfg {
  line?: string;
  block?: [string, string];
  strings: string[];
  keywords: Set<string>;
  types: Set<string>;
}

const JS_KEYWORDS = new Set("const let var function return if else for while do switch case break continue new typeof instanceof class extends import export from default try catch finally throw async await yield delete in of void this super static get set enum interface type implements public private protected readonly as satisfies".split(" "));
const JS_TYPES = new Set("string number boolean any unknown never object symbol bigint void Array Promise Record Map Set Date Error Object Function".split(" "));
const PY_KEYWORDS = new Set("def return if elif else for while import from as class try except finally raise with lambda yield global nonlocal pass break continue and or not in is None True False async await assert del".split(" "));
const SH_KEYWORDS = new Set("if then else elif fi for while do done case esac function in return exit local export source echo cd set unset".split(" "));
const JSON_KEYWORDS = new Set("true false null".split(" "));

const LANGS: Record<string, LangCfg> = {
  js: { line: "//", block: ["/*", "*/"], strings: ['"', "'", "`"], keywords: JS_KEYWORDS, types: JS_TYPES },
  json: { strings: ['"'], keywords: JSON_KEYWORDS, types: new Set() },
  python: { line: "#", strings: ['"', "'"], keywords: PY_KEYWORDS, types: new Set() },
  shell: { line: "#", strings: ['"', "'"], keywords: SH_KEYWORDS, types: new Set() },
  html: { block: ["<!--", "-->"], strings: ['"', "'"], keywords: new Set(), types: new Set() },
  css: { block: ["/*", "*/"], strings: ['"', "'"], keywords: new Set(), types: new Set() },
};

const LANG_ALIASES: Record<string, string> = {
  javascript: "js", jsx: "js", ts: "js", typescript: "js", tsx: "js", node: "js", mjs: "js", cjs: "js",
  py: "python", python3: "python",
  sh: "shell", bash: "shell", zsh: "shell", console: "shell", ksh: "shell",
  jsonc: "json", json5: "json",
  xml: "html", svg: "html", vue: "html",
  scss: "css", less: "css",
};

type CodeRole = "plain" | "comment" | "string" | "number" | "keyword" | "type" | "function" | "operator";

interface CodeTok {
  text: string;
  role: CodeRole;
}

function scanString(line: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < line.length) {
    if (line[i] === "\\") {
      i += 2;
      continue;
    }
    if (line[i] === quote) return i + 1;
    i++;
  }
  return line.length;
}

function tokenizeCode(line: string, lang: string): CodeTok[] | null {
  const cfg = LANGS[LANG_ALIASES[lang] ?? lang];
  if (!cfg) return null;

  const out: CodeTok[] = [];
  let plain = "";
  let i = 0;
  const flush = () => {
    if (plain) {
      out.push({ text: plain, role: "plain" });
      plain = "";
    }
  };

  while (i < line.length) {
    if (cfg.block && line.startsWith(cfg.block[0], i)) {
      flush();
      const end = line.indexOf(cfg.block[1], i + cfg.block[0].length);
      const stop = end < 0 ? line.length : end + cfg.block[1].length;
      out.push({ text: line.slice(i, stop), role: "comment" });
      i = stop;
      continue;
    }
    if (cfg.line && line.startsWith(cfg.line, i)) {
      flush();
      out.push({ text: line.slice(i), role: "comment" });
      i = line.length;
      continue;
    }
    const ch = line[i];
    if (cfg.strings.includes(ch)) {
      flush();
      const stop = scanString(line, i, ch);
      out.push({ text: line.slice(i, stop), role: "string" });
      i = stop;
      continue;
    }
    if (/[0-9]/.test(ch) && !/[A-Za-z_$]/.test(line[i - 1] ?? "")) {
      const m = /^[0-9][0-9a-zA-Z_]*(?:\.[0-9]+)?/.exec(line.slice(i))!;
      flush();
      out.push({ text: m[0], role: "number" });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(line.slice(i))!;
      const word = m[0];
      const after = line.slice(i + word.length);
      let role: CodeRole = "plain";
      if (cfg.keywords.has(word)) role = "keyword";
      else if (cfg.types.has(word)) role = "type";
      else if (/^\s*\(/.test(after)) role = "function";
      flush();
      if (role === "plain") plain += word;
      else out.push({ text: word, role });
      i += word.length;
      continue;
    }
    if (/[+\-*/%=<>!&|^~?:.,;()[\]{}]/.test(ch)) {
      flush();
      out.push({ text: ch, role: "operator" });
      i++;
      continue;
    }
    plain += ch;
    i++;
  }
  flush();
  return out;
}

const LANG_RE = /^\s*`{3,}\s*([A-Za-z0-9_+#.-]*)/;

export class StreamHighlighter {
  private codeBlock = false;
  private lineStart = true;
  private prefix = "";
  private lineRole: MarkdownRole = "text";
  private fenceLine = false;
  private pendingLang = "";
  private codeLang = "";
  private codeLine = "";
  private inlineRaw = "";
  private inlineEmitted = 0;
  private curColor: string | null = null;
  private roles: ReturnType<typeof markdownOf>;
  private palette: Palette;

  constructor(private color = true, mode: "dark" | "light" = "dark") {
    this.roles = markdownOf(mode);
    this.palette = paletteOf(mode);
  }

  setMode(mode: "dark" | "light"): void {
    this.roles = markdownOf(mode);
    this.palette = paletteOf(mode);
  }

  /** Feed a chunk of streamed text; returns the ANSI-decorated text to print. */
  push(text: string): string {
    let out = "";
    for (const ch of text) out += this.feed(ch);
    return out;
  }

  /** Emit any partial line and clear the active colour (call before a newline
   * that the caller writes itself, or when the response is cut short). */
  flush(): string {
    let out = "";
    if (this.lineStart && this.prefix) {
      const role = finalize(this.prefix, this.codeBlock);
      out += this.paint(this.prefix, role);
      this.lineRole = role;
      this.fenceLine = role === "hr";
      this.prefix = "";
      this.lineStart = false;
    }
    if (this.codeBlock && this.codeLine) {
      out += this.paintCodeLine(this.codeLine);
      this.codeLine = "";
    }
    if (!this.lineStart) out += this.flushInline();
    if (this.color && this.curColor !== null) {
      out += ANSI_RESET;
      this.curColor = null;
    }
    return out;
  }

  reset(): void {
    this.codeBlock = false;
    this.lineStart = true;
    this.prefix = "";
    this.lineRole = "text";
    this.fenceLine = false;
    this.pendingLang = "";
    this.codeLang = "";
    this.codeLine = "";
    this.inlineRaw = "";
    this.inlineEmitted = 0;
    this.curColor = null;
  }

  private feed(ch: string): string {
    if (ch === "\n") return this.newline();
    if (this.lineStart) {
      this.prefix += ch;
      const r = resolve(this.prefix, this.codeBlock);
      if (!r.done && this.prefix.length <= MAX_PREFIX) return "";
      return this.commit(r.role ?? "text");
    }
    if (this.codeBlock) {
      this.codeLine += ch;
      return "";
    }
    this.inlineRaw += ch;
    return this.renderInline();
  }

  private commit(role: MarkdownRole): string {
    this.lineRole = role;
    this.fenceLine = role === "hr";
    this.lineStart = false;
    const text = this.prefix;
    this.prefix = "";
    if (role === "codeBlock") {
      this.codeLine += text;
      return "";
    }
    if (role === "hr" && !this.codeBlock) this.pendingLang = LANG_RE.exec(text)?.[1] ?? "";
    this.inlineRaw = "";
    this.inlineEmitted = 0;
    return this.paint(text, role);
  }

  /** Emit the stable spans of the current inline line, holding back only an
   * unresolved trailing marker so prose keeps streaming character by character. */
  private renderInline(): string {
    if (!this.color) {
      const out = this.inlineRaw.slice(this.inlineEmitted);
      this.inlineEmitted = this.inlineRaw.length;
      return out;
    }
    const spans = tokenizeInline(this.inlineRaw, this.lineRole);
    let out = "";
    let pos = 0;
    for (const span of spans) {
      const end = pos + span.text.length;
      if (span.stable && end > this.inlineEmitted) {
        // A span completed past the emission frontier: paint it (or just the
        // tail, when an earlier chunk stopped mid-span) and advance.
        const start = Math.max(pos, this.inlineEmitted);
        const tail = span.text.slice(start - pos);
        if (tail) {
          out += this.paintSpan(tail, span.role, span.attr);
          this.inlineEmitted = end;
        }
      }
      pos = end;
      if (!span.stable) break;
    }
    return out;
  }

  /** Emit whatever inline text is still buffered, undecorated, at line end. */
  private flushInline(): string {
    let out = "";
    const rest = this.inlineRaw.slice(this.inlineEmitted);
    if (rest) out = this.color ? this.paint(rest, this.lineRole) : rest;
    this.inlineRaw = "";
    this.inlineEmitted = 0;
    return out;
  }

  private newline(): string {
    let out = "";
    if (this.lineStart) {
      out += this.commit(finalize(this.prefix, this.codeBlock));
    } else if (this.codeBlock) {
      out += this.paintCodeLine(this.codeLine);
      this.codeLine = "";
    } else {
      out += this.flushInline();
    }
    if (this.color && this.curColor !== null) {
      out += ANSI_RESET;
      this.curColor = null;
    }
    if (this.fenceLine) {
      if (!this.codeBlock) this.codeLang = this.pendingLang;
      else this.codeLang = "";
      this.codeBlock = !this.codeBlock;
      this.fenceLine = false;
    }
    this.lineStart = true;
    this.prefix = "";
    this.lineRole = "text";
    this.inlineRaw = "";
    this.inlineEmitted = 0;
    return out + "\n";
  }

  private paintCodeLine(line: string): string {
    if (!this.color) return line;
    const toks = tokenizeCode(line, this.codeLang);
    if (!toks) return this.paint(line, "codeBlock");
    let out = "";
    for (const t of toks) out += this.paintHex(t.text, this.codeColor(t.role));
    return out;
  }

  private codeColor(role: CodeRole): string {
    const p = this.palette;
    switch (role) {
      case "comment":
        return p.synComment;
      case "string":
        return p.synString;
      case "number":
        return p.synNumber;
      case "keyword":
        return p.synKeyword;
      case "type":
        return p.synType;
      case "function":
        return p.synFunction;
      case "operator":
        return p.synOperator;
      default:
        return this.roles.codeBlock;
    }
  }

  private paint(s: string, role: MarkdownRole): string {
    return this.paintHex(s, this.roles[role]);
  }

  private paintSpan(s: string, role: MarkdownRole, attr: Attr): string {
    if (!this.color) return s;
    let out = "";
    if (attr.bold) out += "\x1b[1m";
    if (attr.italic) out += "\x1b[3m";
    if (attr.strike) out += "\x1b[9m";
    if (attr.underline) out += "\x1b[4m";
    out += this.paintHex(s, this.roles[role]);
    if (attr.bold || attr.italic || attr.strike || attr.underline) {
      out += ANSI_RESET;
      this.curColor = null;
    }
    return out;
  }

  private paintHex(s: string, hex: string): string {
    if (!this.color) return s;
    let out = "";
    if (this.curColor !== hex) {
      out += ansi(hex);
      this.curColor = hex;
    }
    return out + s;
  }
}
