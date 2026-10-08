// web_fetch: download an http/https page and return it as readable text. Zero
// dependencies — the global fetch on Node 18+ is enough. HTML is reduced to a
// light markdown shape (headings, links, lists, code); scripts, styles and
// binary payloads are never handed to the model. The result is capped so one
// page cannot flood a small context window.
//
// Read-only and available in every mode: reaching outside the workspace is the
// whole point, so it is not gated like commands. Fetched pages are untrusted
// input — the model is told elsewhere to treat text as data, not instructions.

import { truncateEnd } from "../util";

const FETCH_TIMEOUT_MS = 15000;
const MAX_BYTES = 2 * 1024 * 1024; // stop downloading past this
const OUTPUT_CHARS = 9000; // under TOOL_RESULT_CAP (10000) and read_file's cap

const TEXTUAL = /^(text\/|application\/(json|xml|javascript|ecmascript|xhtml\+xml|ld\+json|rss\+xml|atom\+xml)|[\w.+-]+\+xml)/i;
const BINARY_HINT = /^(image|audio|video|font)\//i;

export async function webFetch(args: Record<string, any>, signal?: AbortSignal): Promise<string> {
  const raw = args?.url;
  if (typeof raw !== "string" || !raw.trim()) {
    return 'Error: url is required. Example: {"url": "https://example.com/docs"}';
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return `Error: "${raw}" is not a valid URL. Include the scheme, e.g. https://example.com/page.`;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `Error: only http and https URLs can be fetched (got "${url.protocol}").`;
  }
  if (signal?.aborted) return "Error: fetch cancelled";

  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetch(url.href, {
        redirect: "follow",
        signal: ctrl.signal,
        headers: {
          "user-agent": "smolcoder",
          accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.5",
        },
      });
    } catch (err: any) {
      if (signal?.aborted) return "Error: fetch cancelled";
      const why = ctrl.signal.aborted
        ? `timed out after ${FETCH_TIMEOUT_MS / 1000}s`
        : String(err?.message ?? err);
      return `Error: could not fetch ${url.href} (${why}). Check the address and that this computer can reach it.`;
    }

    if (!res.ok) {
      return `Error: ${url.href} returned ${res.status} ${res.statusText}. The page may be missing, protected, or require a login.`;
    }

    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    const type = contentType.split(";")[0].trim();
    if (type && !TEXTUAL.test(type) && BINARY_HINT.test(type)) {
      return `Error: ${url.href} is ${type} data, not readable text. web_fetch returns text pages only.`;
    }

    const body = await readCapped(res, MAX_BYTES, contentType);
    if (signal?.aborted) return "Error: fetch cancelled";
    if (!body.trim()) return `Error: ${url.href} returned an empty body.`;

    const isHtml = /html/i.test(contentType) || (!type && /^\s*</.test(body));
    let text = (isHtml ? htmlToText(body) : body.trim()).trim();
    if (!text) text = "(the page contained no readable text)";

    let out = text;
    if (res.url && res.url !== url.href) out += `\n\n[followed a redirect; final URL: ${res.url}]`;
    if (out.length > OUTPUT_CHARS) {
      out = truncateEnd(out, OUTPUT_CHARS, "page truncated; fetch a more specific URL if needed");
    }
    return out;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Read at most `maxBytes` and decode using the charset the server declared. */
async function readCapped(res: Response, maxBytes: number, contentType: string): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return await res.text();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.byteLength) {
      chunks.push(value);
      total += value.byteLength;
      if (total >= maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* best effort */
        }
        break;
      }
    }
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  const m = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType);
  const charset = m ? m[1] : "utf-8";
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return buf.toString("utf8");
  }
}

// ---------------------------------------------------------------------------
// A small HTML-to-text reducer. It is not a parser; it removes the parts a
// model must never see (scripts, styles, embedded markup) and gives the rest a
// readable shape. Code blocks are protected from whitespace collapsing.
// ---------------------------------------------------------------------------

const SENT = String.fromCharCode(1); // never appears in page text

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try {
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      } catch {
        return m;
      }
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export function htmlToText(html: string): string {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? decodeEntities(stripTags(titleMatch[1])) : "";

  let s = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|template|iframe|head)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");

  // Inline shapes before the remaining tags are stripped.
  s = s.replace(/<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi,
    (_m, dq: string, sq: string, bare: string, inner: string) => {
      const href = dq ?? sq ?? bare ?? "";
      const label = stripTags(inner);
      if (!href || /^javascript:/i.test(href)) return label || href;
      if (!label || href === label) return href;
      return `[${label}](${href})`;
    });
  s = s.replace(/<img\b[^>]*?alt\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*\/?>/gi,
    (_m, dq: string, sq: string) => {
      const alt = dq ?? sq ?? "";
      return alt ? `[image: ${alt}]` : "";
    });

  // Protect code/pre so whitespace collapsing cannot destroy indentation.
  const blocks: string[] = [];
  s = s.replace(/<(pre|code)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, tag: string, inner: string) => {
    const raw = decodeEntities(inner.replace(/<[^>]+>/g, ""));
    const isPre = tag.toLowerCase() === "pre";
    blocks.push(isPre ? raw.replace(/^\n+|\n+$/g, "") : "`" + raw.replace(/\s+/g, " ").trim() + "`");
    return `${SENT}${blocks.length - 1}${SENT}`;
  });

  s = s
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n: string, t: string) =>
      `\n\n${"#".repeat(Number(n))} ${stripTags(t)}\n\n`)
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, t: string) => `\n- ${stripTags(t)}`)
    .replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, t: string) => `\n> ${stripTags(t)}\n`)
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|header|footer|nav|tr|table|ul|ol|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  s = decodeEntities(s)
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  s = s.replace(new RegExp(SENT + "(\\d+)" + SENT, "g"), (_m, i: string) => blocks[Number(i)] ?? "");
  return title ? `# ${title}\n\n${s}`.trim() : s;
}
