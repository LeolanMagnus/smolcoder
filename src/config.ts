// User config (~/.smolcoder.json) and the data directory (~/.smolcoder/) that
// holds saved web sessions and the workspace list. Shared by the CLI entry
// point, the session loop and the web hub.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Effort } from "./providers/types";
import { Mode, normalizeMode } from "./tools/index";

// SMOLCODER_CONFIG points tests at a scratch file so they never touch the
// real one.
export const CONFIG_PATH = process.env.SMOLCODER_CONFIG || path.join(os.homedir(), ".smolcoder.json");
export const DATA_DIR = path.join(os.homedir(), ".smolcoder");

/** Another machine that serves models, added from the model picker. */
export interface SavedHost {
  /** What to connect to: a bare host ("192.168.1.50", "gpu-box.local") means
   * "look for Ollama and LM Studio on their usual ports"; a full URL or
   * host:port names one server exactly. */
  address: string;
  /** Display name; defaults to the host part of the address. */
  name?: string;
}

/** An optional stdio MCP (Model Context Protocol) server whose tools join the
 * agent's toolset. Adding an entry is the trust decision: everything the
 * server exposes becomes callable without further prompts — only run servers
 * you would run their commands from. */
export interface McpServerConfig {
  /** Executable to spawn, e.g. "uvx", "npx" or "node". */
  command: string;
  args?: string[];
  /** Extra environment variables for the server process (merged over the
   * CLI's own environment). */
  env?: Record<string, string>;
  /** Set false to keep the entry but skip starting the server. */
  enabled?: boolean;
  /** Per-call timeout in milliseconds (default 120000). Long renders may
   * need more. */
  timeoutMs?: number;
  /** Also expose this server's tools in plan mode. Default false: MCP tools
   * cannot be inspected for safety the way built-ins can, so plan mode hides
   * them unless you explicitly opt in. */
  allowInPlan?: boolean;
}

export interface Config {
  lastModel?: string;
  /** Server the last model ran on — the same model id can exist on several machines. */
  lastModelUrl?: string;
  lastMode?: Mode;
  effort?: Effort | null;
  hosts?: SavedHost[];
  /** Reply theme: "auto" detects the terminal (default), or force dark/light. */
  theme?: "auto" | "dark" | "light";
  /** MCP servers, keyed by a short name that becomes part of every tool name:
   * "blender" turns a tool "get_scene_info" into mcp_blender_get_scene_info. */
  mcpServers?: Record<string, McpServerConfig>;
  /** Hard cap on MCP tools injected across all servers (default 12). Every
   * schema is billed against the model's context window on every request. */
  maxMcpTools?: number;
}

export function loadConfig(): Config {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    // Never let the auto (bypass) mode be inherited implicitly from a past
    // session — a single shift+tab into it would otherwise silently persist
    // unattended, unchecked command execution into every later run, including
    // headless -p in CI. It requires an explicit flag (-m auto / --bypass /
    // --yolo) each time. Old configs saved "write"/"yolo"/"bypass"/"ro" under
    // the previous mode names.
    if (typeof cfg.lastMode === "string") {
      const m = normalizeMode(cfg.lastMode, "build");
      cfg.lastMode = m === "auto" ? "build" : m;
    }
    cfg.hosts = Array.isArray(cfg.hosts)
      ? cfg.hosts
          .filter((h: any) => h && typeof h.address === "string" && h.address.trim())
          .map((h: any) => ({ address: h.address.trim(), ...(typeof h.name === "string" && h.name.trim() ? { name: h.name.trim() } : {}) }))
      : [];
    cfg.mcpServers = sanitizeMcpServers(cfg.mcpServers);
    return cfg;
  } catch {
    return {};
  }
}

/** Keep only well-formed MCP entries: a typo in one server must never take
 * down the others or the run. Fields that fail validation are dropped, not
 * the whole entry. */
export function sanitizeMcpServers(raw: unknown): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const v = value as any;
    if (!name.trim() || !v || typeof v !== "object" || typeof v.command !== "string" || !v.command.trim()) continue;
    const entry: McpServerConfig = { command: v.command.trim() };
    if (Array.isArray(v.args) && v.args.every((a: any) => typeof a === "string")) entry.args = v.args;
    if (v.env && typeof v.env === "object" && !Array.isArray(v.env)) {
      const env: Record<string, string> = {};
      for (const [key, val] of Object.entries(v.env as Record<string, unknown>)) {
        if (typeof val === "string") env[key] = val;
      }
      if (Object.keys(env).length) entry.env = env;
    }
    if (v.enabled === false) entry.enabled = false;
    if (Number.isSafeInteger(v.timeoutMs) && v.timeoutMs > 0) entry.timeoutMs = v.timeoutMs;
    if (v.allowInPlan === true) entry.allowInPlan = true;
    out[name.trim()] = entry;
  }
  return out;
}

export function saveConfig(cfg: Config): void {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch {
    /* non-fatal */
  }
}

/** Change some settings and keep the rest. Re-reads the file first: several
 * web sessions share it, and each one only knows about its own fields. */
export function updateConfig(patch: Partial<Config>): Config {
  const next = { ...loadConfig(), ...patch };
  saveConfig(next);
  return next;
}
