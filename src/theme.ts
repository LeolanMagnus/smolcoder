// The colour theme for the model's reply, shared by both surfaces. It starts
// from opencode's default palette and is shifted toward blue while the role
// structure (luminance, contrast, syntax roles) is kept. There is a dark and a
// light variant; the terminal picks one automatically (see detectMode / the
// OSC 11 probe below) and the web picks one with prefers-color-scheme. The
// terminal turns these hex values into 24-bit ANSI; the web UI turns them into
// CSS variables, so the two never drift apart.

export type ThemeMode = "dark" | "light";

export interface Palette {
  neutral: string; // background
  ink: string; // body text
  textWeak: string; // comments, rules, muted
  primary: string; // links, list markers
  accent: string; // headings, keywords
  success: string; // strings, inline code
  warning: string; // strong, constants
  error: string; // variables, errors
  info: string; // properties, operators, enumerations
  type: string; // types, emphasis, quotes
  diffAdd: string;
  diffDelete: string;
  // Code-fence syntax roles (opencode's syntax* vocabulary).
  synComment: string;
  synKeyword: string;
  synString: string;
  synNumber: string;
  synType: string;
  synFunction: string;
  synOperator: string;
  /** Subtle background for inline code. */
  codeBg: string;
}

export const DARK_PALETTE: Palette = {
  neutral: "#0a0c12", // background
  ink: "#e6ebf2", // body text
  textWeak: "#7d8794", // comments, rules, muted
  primary: "#8ab4f8", // links, list markers
  accent: "#b39cf5", // headings, keywords
  success: "#7fd8b8", // strings, inline code
  warning: "#e0b070", // strong, constants
  error: "#e0709a", // variables, errors
  info: "#56b8f2", // properties, operators, enumerations
  type: "#c0caf5", // types, emphasis, quotes
  diffAdd: "#8fd8b8",
  diffDelete: "#e2709a",
  synComment: "#7d8794",
  synKeyword: "#b39cf5",
  synString: "#7fd8b8",
  synNumber: "#e0b070",
  synType: "#c0caf5",
  synFunction: "#8ab4f8",
  synOperator: "#56b8f2",
  codeBg: "#141c26",
};

// The light variant keeps the same role structure but is tuned for a light
// background: dark ink and deeper, saturated accents that stay legible on white.
export const LIGHT_PALETTE: Palette = {
  neutral: "#ffffff",
  ink: "#1f2328",
  textWeak: "#6e7781",
  primary: "#0969da",
  accent: "#8250df",
  success: "#1a7f37",
  warning: "#9a6700",
  error: "#cf222e",
  info: "#0550ae",
  type: "#6639ba",
  diffAdd: "#1a7f37",
  diffDelete: "#cf222e",
  synComment: "#6e7781",
  synKeyword: "#cf222e",
  synString: "#0a3069",
  synNumber: "#0550ae",
  synType: "#953800",
  synFunction: "#8250df",
  synOperator: "#0550ae",
  codeBg: "#f0f1f3",
};

export function paletteOf(mode: ThemeMode): Palette {
  return mode === "light" ? LIGHT_PALETTE : DARK_PALETTE;
}

/** Backwards-compatible default: the dark palette. */
export const PALETTE = DARK_PALETTE;

/** Markdown roles → hex, the vocabulary both the terminal highlighter and the
 * web stylesheet speak. */
export function markdownOf(mode: ThemeMode) {
  const p = paletteOf(mode);
  return {
    text: p.ink,
    heading: p.accent,
    code: p.success,
    codeBlock: p.ink,
    link: p.primary,
    linkText: p.info,
    strong: p.warning,
    emph: p.type,
    quote: p.type,
    hr: p.textWeak,
    listItem: p.primary,
    listEnum: p.info,
    strike: p.textWeak,
  };
}

export const MARKDOWN = markdownOf("dark");

export type MarkdownRole = keyof typeof MARKDOWN;

/** Split "#rrggbb" into 0-255 components. */
export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/** A 24-bit foreground escape for a hex colour. */
export function ansi(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  return `\x1b[38;2;${r};${g};${b}m`;
}

/** A 24-bit background escape for a hex colour. */
export function ansiBg(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  return `\x1b[48;2;${r};${g};${b}m`;
}

export const ANSI_RESET = "\x1b[0m";

function normalizeMode(value: unknown): ThemeMode | null {
  return value === "dark" || value === "light" ? value : null;
}

/** Synchronous mode resolution from an explicit override (config), the
 * SMOLCODER_THEME env var, or COLORFGBG. Falls back to dark. */
export function detectMode(override?: unknown, env: NodeJS.ProcessEnv = process.env): ThemeMode {
  const explicit = normalizeMode(override) ?? normalizeMode(env.SMOLCODER_THEME);
  if (explicit) return explicit;
  const cf = env.COLORFGBG;
  if (cf) {
    const bg = Number(cf.split(";").pop());
    // COLORFGBG is "fg;bg"; background indices 0-6 are dark, 7-15 light.
    if (Number.isFinite(bg)) return bg >= 7 ? "light" : "dark";
  }
  return "dark";
}

/** Best-effort OSC 11 background probe: asks the terminal for its default
 * background and reads the rgb reply, with a hard timeout so a terminal that
 * does not answer never stalls startup. Returns null when unknown. */
export function queryTerminalMode(timeoutMs = 150): Promise<ThemeMode | null> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) return Promise.resolve(null);
  const stdin = process.stdin;
  return new Promise((resolve) => {
    let done = false;
    const finish = (m: ThemeMode | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stdin.off("data", onData);
      try {
        if (!wasRaw) stdin.setRawMode?.(false);
      } catch {
        /* best effort */
      }
      resolve(m);
    };
    const scale = (h: string) => parseInt(h, 16) / (h.length >= 4 ? 0xffff : 0xff);
    const onData = (buf: Buffer | string) => {
      const s = buf.toString();
      const m = /\x1b\]11;rgb:([0-9a-f]{2,4})\/([0-9a-f]{2,4})\/([0-9a-f]{2,4})/i.exec(s);
      if (!m) return;
      const lum = 0.299 * scale(m[1]) + 0.587 * scale(m[2]) + 0.114 * scale(m[3]);
      finish(lum > 0.5 ? "light" : "dark");
    };
    const wasRaw = stdin.isRaw;
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      stdin.setRawMode?.(true);
      stdin.resume();
    } catch {
      finish(null);
      return;
    }
    stdin.on("data", onData);
    process.stdout.write("\x1b]11;?\x07");
  });
}

/** Resolve the terminal theme at startup: explicit config/env wins, then
 * COLORFGBG, then the OSC 11 probe, then dark. */
export async function resolveMode(override?: unknown, env: NodeJS.ProcessEnv = process.env): Promise<ThemeMode> {
  const explicit = normalizeMode(override) ?? normalizeMode(env.SMOLCODER_THEME);
  if (explicit) return explicit;
  const cf = env.COLORFGBG;
  if (cf) {
    const bg = Number(cf.split(";").pop());
    if (Number.isFinite(bg)) return bg >= 7 ? "light" : "dark";
  }
  const probed = await queryTerminalMode();
  return probed ?? "dark";
}
