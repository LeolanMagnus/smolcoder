// MCP servers from ~/.smolcoder.json, started lazily on the first agent turn.
// Deliberately a process-wide singleton: several sessions (web hub) share one
// set of server processes, which also matches servers like the Blender addon
// that accept exactly one tool connection.

import * as fs from "fs";
import * as path from "path";
import { loadConfig, McpServerConfig } from "../config";
import { ImageRef, ToolSpec } from "../providers/types";
import { Mode } from "../tools/index";
import { McpCallResult, McpClient, McpContentPart, McpToolInfo } from "./client";

/** Default hard cap on injected MCP tools: every schema is billed against the
 * local model's context window on every request. Servers are connected in
 * config order; tools beyond the cap are reported and skipped. */
const DEFAULT_MAX_MCP_TOOLS = 12;
const MAX_DESCRIPTION_CHARS = 600;

interface RegisteredTool {
  /** Name the model sees: mcp_<server>_<tool>, sanitized to the OpenAI-safe
   * alphabet and at most 64 characters. */
  wire: string;
  server: string;
  tool: string;
  description: string;
  parameters: ToolSpec["parameters"];
  allowInPlan: boolean;
  client: McpClient;
}

export interface McpNote {
  level: "info" | "warn";
  text: string;
}

export interface McpToolOutput {
  text: string;
  /** Images the tool returned, saved under <workspace>/.smolcoder/mcp/. */
  images: ImageRef[];
}

let tools = new Map<string, RegisteredTool>();
let clients: McpClient[] = [];
let started = false;
let starting: Promise<boolean> | null = null;
let notes: McpNote[] = [];
let imageSeq = 0;

/** True when servers are configured but the next turn will pay the startup
 * cost — lets the agent show a "starting MCP servers…" line in time. */
export function mcpNeedsStart(): boolean {
  if (started || starting) return false;
  return enabledServers().length > 0;
}

/** Connect every configured server once. Returns true when this call did the
 * startup work, so the caller can show the notes exactly once. Never rejects:
 * a broken server becomes a warning, not a failed turn. */
export function ensureMcpStarted(): Promise<boolean> {
  if (starting) return starting;
  if (started) return Promise.resolve(false);
  starting = startAll().finally(() => {
    starting = null;
  });
  return starting;
}

function enabledServers(): [string, McpServerConfig][] {
  const servers = loadConfig().mcpServers ?? {};
  return Object.entries(servers).filter(([, cfg]) => cfg.enabled !== false);
}

function mcpToolCap(): number {
  const configured = loadConfig().maxMcpTools;
  return Number.isSafeInteger(configured) && configured! > 0 ? configured! : DEFAULT_MAX_MCP_TOOLS;
}

async function startAll(): Promise<boolean> {
  started = true;
  const servers = enabledServers();
  if (servers.length === 0) return false;
  const maxTools = mcpToolCap();
  let count = 0;
  for (const [name, cfg] of servers) {
    const client = new McpClient(name, cfg.command, cfg.args ?? [], cfg.env, cfg.timeoutMs ?? 120_000);
    try {
      const advertised = await client.start();
      clients.push(client);
      let added = 0;
      for (const info of advertised) {
        if (!info?.name) continue;
        if (count >= maxTools) {
          notes.push({ level: "info", text: `mcp "${name}": tool cap of ${maxTools} reached — "${info.name}" is not exposed` });
          continue;
        }
        const wire = uniqueWireName(name, info.name);
        tools.set(wire, {
          wire,
          server: name,
          tool: info.name,
          description: describe(name, info),
          parameters: coerceSchema(info.inputSchema),
          allowInPlan: cfg.allowInPlan === true,
          client,
        });
        count++;
        added++;
      }
      notes.push({ level: "info", text: `mcp "${name}": ${added} tool${added === 1 ? "" : "s"} available` });
    } catch (err: any) {
      client.kill();
      notes.push({ level: "warn", text: `mcp "${name}" unavailable: ${err?.message ?? err}` });
    }
  }
  if (clients.length) process.once("exit", shutdownMcp);
  return true;
}

export function isMcpTool(name: string): boolean {
  return tools.has(name);
}

/** Tool schemas for a mode. Plan mode hides MCP tools unless their server
 * opted in: unlike built-ins, nothing about them was reviewed. */
export function mcpSpecsFor(mode: Mode): ToolSpec[] {
  const specs: ToolSpec[] = [];
  for (const t of tools.values()) {
    if (mode === "plan" && !t.allowInPlan) continue;
    specs.push({ name: t.wire, description: t.description, parameters: t.parameters });
  }
  return specs;
}

/** Run one MCP tool and turn its result into a tool-result string. Images are
 * saved into the workspace and returned for the agent to attach. */
export async function callMcpTool(
  wire: string,
  args: Record<string, any>,
  workspace: string,
  signal?: AbortSignal
): Promise<McpToolOutput> {
  const t = tools.get(wire);
  if (!t) return { text: `Error: unknown MCP tool "${wire}".`, images: [] };
  const label = `${t.server}.${t.tool}`;
  try {
    if (!t.client.alive) {
      // The server died (crash, Blender restarted): one transparent retry.
      await t.client.start();
    }
    const result = await t.client.callTool(t.tool, args ?? {}, signal);
    return renderResult(t, result, workspace);
  } catch (err: any) {
    const message = signal?.aborted ? "cancelled by the user" : err?.message ?? String(err);
    return { text: `Error: the MCP tool "${label}" failed: ${message}`, images: [] };
  }
}

/** Startup notes from the first connection attempt, drained so the UI shows
 * them once. */
export function takeMcpNotes(): McpNote[] {
  const out = notes;
  notes = [];
  return out;
}

/** Kill every server and forget everything. Wired to process exit; also used
 * by tests and a restart path in the future. Safe to call repeatedly. */
export function shutdownMcp(): void {
  for (const client of clients) {
    try {
      client.kill();
    } catch {
      /* already gone */
    }
  }
  clients = [];
  tools = new Map();
  notes = [];
  started = false;
}

// ---- helpers ---------------------------------------------------------------

function renderResult(t: RegisteredTool, result: McpCallResult, workspace: string): McpToolOutput {
  const text: string[] = [];
  const images: ImageRef[] = [];
  for (const part of result.content ?? []) {
    if (part?.type === "text" && typeof part.text === "string") {
      text.push(part.text);
      continue;
    }
    if (part?.type === "image" && typeof part.data === "string") {
      const saved = saveImage(t, part, workspace);
      if (saved) {
        images.push(saved.ref);
        text.push(saved.note);
      } else {
        text.push("[An image result arrived but could not be saved.]");
      }
      continue;
    }
    if (part?.type === "resource" || part?.type === "resource_link" || part?.type === "audio") {
      text.push(`[${part.type} result] ${JSON.stringify(part).slice(0, 1500)}`);
      continue;
    }
    text.push(`[unsupported result part: ${part?.type ?? "unknown"}]`);
  }
  let out = text.join("\n").trim() || "(the tool returned no output)";
  if (result.isError) out = `Error: ${out}`;
  return { text: out, images };
}

const EXT_BY_MIME: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

function saveImage(t: RegisteredTool, part: McpContentPart, workspace: string): { ref: ImageRef; note: string } | null {
  try {
    const mime = typeof part.mimeType === "string" && part.mimeType.startsWith("image/") ? part.mimeType : "image/png";
    const ext = EXT_BY_MIME[mime] ?? "png";
    const dir = path.join(workspace, ".smolcoder", "mcp", sanitize(t.server));
    fs.mkdirSync(dir, { recursive: true });
    const file = `${sanitize(t.tool)}-${Date.now()}-${++imageSeq}.${ext}`;
    const abs = path.join(dir, file);
    fs.writeFileSync(abs, Buffer.from(part.data!, "base64"));
    const rel = path.relative(workspace, abs).split(path.sep).join("/");
    return {
      ref: { path: abs, mime: ext === "jpg" ? "image/jpeg" : mime, name: file.slice(0, file.lastIndexOf(".")) },
      note: `[The tool produced an image, saved to ${rel} and attached to this conversation so you can look at it.]`,
    };
  } catch {
    return null;
  }
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_") || "_";
}

function uniqueWireName(server: string, tool: string): string {
  const base = sanitize(`mcp_${server}_${tool}`).slice(0, 64);
  let wire = base;
  for (let i = 2; tools.has(wire); i++) {
    const suffix = `_${i}`;
    wire = base.slice(0, 64 - suffix.length) + suffix;
  }
  return wire;
}

/** MCP servers advertise full JSON Schema. Only the envelope is normalized
 * here: nested structures are passed through, because dropping them would
 * make a tool look argument-less. */
function coerceSchema(input: unknown): ToolSpec["parameters"] {
  const schema = input && typeof input === "object" ? (input as any) : {};
  const properties =
    schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties) ? schema.properties : {};
  const parameters: ToolSpec["parameters"] = { type: "object", properties };
  if (Array.isArray(schema.required)) parameters.required = schema.required.filter((r: any) => typeof r === "string");
  return parameters;
}

function describe(server: string, info: McpToolInfo): string {
  const text = (info.description ?? "").replace(/\s+/g, " ").trim();
  const head = text ? text.slice(0, MAX_DESCRIPTION_CHARS) : `MCP tool ${info.name}.`;
  return `${head} (MCP server "${server}")`;
}
