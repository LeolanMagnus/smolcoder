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

export interface Config {
  lastModel?: string;
  /** Server the last model ran on — the same model id can exist on several machines. */
  lastModelUrl?: string;
  lastMode?: Mode;
  effort?: Effort | null;
  hosts?: SavedHost[];
  /** Reply theme: "auto" detects the terminal (default), or force dark/light. */
  theme?: "auto" | "dark" | "light";
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
    return cfg;
  } catch {
    return {};
  }
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
