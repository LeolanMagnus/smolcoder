// A minimal MCP (Model Context Protocol) client: spawn one server over stdio
// and speak line-delimited JSON-RPC 2.0 to it. Dependency-free on purpose —
// smolcoder has zero runtime dependencies, and the protocol is small.

import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import { killTree } from "../tools/shell";

/** One tool as advertised by the server ("tools/list" entry). */
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, any>;
}

/** One content part of a "tools/call" result. */
export interface McpContentPart {
  type: string;
  text?: string;
  /** Base64 payload for image/audio/blob parts. */
  data?: string;
  mimeType?: string;
}

export interface McpCallResult {
  content?: McpContentPart[];
  /** True when the tool ran and failed; `content` then carries the message. */
  isError?: boolean;
}

interface Pending {
  method: string;
  cleanup: () => void;
  resolve: (value: any) => void;
  reject: (err: Error) => void;
}

const STDERR_TAIL = 4000;
const PROTOCOL_VERSION = "2025-06-18";
const VERSION = require("../../package.json").version as string;

export class McpClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private stderrTail = "";
  private dead = false;

  constructor(
    readonly name: string,
    private readonly command: string,
    private readonly args: string[],
    private readonly env: Record<string, string> | undefined,
    private readonly callTimeoutMs: number
  ) {}

  get alive(): boolean {
    return this.proc !== null && !this.dead;
  }

  /** Spawn the server, complete the MCP handshake and list its tools. Safe to
   * call again after a crash: the old process is always cleaned up first. */
  async start(startupTimeoutMs = 30000): Promise<McpToolInfo[]> {
    this.kill();
    this.dead = false;
    this.buffer = "";
    this.stderrTail = "";
    const proc = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // Own process group on POSIX so killTree can take the whole tree down.
      detached: process.platform !== "win32",
      env: this.env ? { ...process.env, ...this.env } : process.env,
    });
    this.proc = proc;
    proc.on("error", (err) => this.fail(`could not start: ${err.message}`));
    proc.on("exit", (code, signal) => this.fail(`the server exited (${signal ?? `code ${code}`})`));
    proc.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    proc.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL);
    });

    // Lenient version handling: real servers answer older protocol versions
    // with their own choice in the result; we never gate on it.
    await this.request(
      "initialize",
      { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "smolcoder", version: VERSION } },
      startupTimeoutMs
    );
    this.notify("notifications/initialized", {});
    return this.listTools(startupTimeoutMs);
  }

  private async listTools(timeoutMs: number): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.request("tools/list", cursor ? { cursor } : {}, timeoutMs);
      if (Array.isArray(page?.tools)) tools.push(...page.tools);
      cursor = typeof page?.nextCursor === "string" && page.nextCursor ? page.nextCursor : undefined;
    } while (cursor);
    return tools;
  }

  /** Run a tool. Transport errors throw; tool failures come back as a result
   * with isError — the caller decides how to phrase both. */
  async callTool(name: string, args: Record<string, any>, signal?: AbortSignal): Promise<McpCallResult> {
    const result = await this.request("tools/call", { name, arguments: args ?? {} }, this.callTimeoutMs, signal);
    return (result ?? {}) as McpCallResult;
  }

  /** Kill the server process tree. Synchronous; safe in a process-exit hook. */
  kill(): void {
    const proc = this.proc;
    if (!proc) return;
    this.dead = true;
    this.proc = null;
    for (const p of this.pending.values()) {
      p.cleanup();
      p.reject(new Error("MCP client shut down."));
    }
    this.pending.clear();
    try {
      proc.stdin.end();
    } catch {
      /* already closed */
    }
    try {
      proc.stdout.destroy();
      proc.stderr.destroy();
    } catch {
      /* already closed */
    }
    if (proc.pid && !proc.killed) killTree(proc.pid);
  }

  private notify(method: string, params: any): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private request(method: string, params: any, timeoutMs: number, signal?: AbortSignal): Promise<any> {
    if (!this.alive) {
      return Promise.reject(new Error(`MCP server "${this.name}" is not running.${this.stderrHint()}`));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        p.cleanup();
        // Tell the server the answer is no longer wanted (best effort).
        this.notify("notifications/cancelled", { requestId: id, reason: "cancelled by the user" });
        p.reject(new Error("cancelled"));
      };
      const timer = setTimeout(() => {
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        p.cleanup();
        p.reject(
          new Error(`MCP server "${this.name}" did not answer "${method}" within ${Math.round(timeoutMs / 1000)}s.`)
        );
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, { method, cleanup, resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private write(message: any): void {
    try {
      this.proc?.stdin.write(JSON.stringify(message) + "\n");
    } catch {
      /* the exit handler reports the real failure */
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.onLine(line);
    }
  }

  private onLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      // Some servers print banners on stdout; keep them for error messages.
      this.stderrTail = (this.stderrTail + `\n[non-JSON on stdout] ${line.slice(0, 300)}`).slice(-STDERR_TAIL);
      return;
    }
    if (!msg || typeof msg !== "object") return;
    if (msg.id !== undefined && typeof msg.method === "string") {
      // A server-to-client request (sampling, roots, elicitation). None are
      // implemented; refuse so the server is not left waiting for a reply.
      this.write({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: "smolcoder does not implement server-initiated requests" },
      });
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      p.cleanup();
      if (msg.error) {
        p.reject(new Error(`MCP server "${this.name}" error ${msg.error.code ?? "?"}: ${msg.error.message ?? "unknown error"}`));
      } else {
        p.resolve(msg.result);
      }
    }
    // Notifications (no id) are ignored.
  }

  private fail(reason: string): void {
    if (this.dead && this.pending.size === 0) return;
    this.dead = true;
    const error = new Error(`MCP server "${this.name}" ${reason}.${this.stderrHint()}`);
    for (const p of this.pending.values()) {
      p.cleanup();
      p.reject(error);
    }
    this.pending.clear();
  }

  private stderrHint(): string {
    const tail = this.stderrTail.replace(/\s+/g, " ").trim();
    return tail ? ` Server output: ${tail.slice(-600)}` : "";
  }
}
