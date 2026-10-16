// One session = one workspace + one agent + one UI, plus the input loop and
// slash commands that drive it. Extracted from the CLI entry point so the
// terminal TUI and the web hub (many sessions side by side, one per browser
// sidebar entry) run exactly the same loop.

import { randomBytes } from "crypto";
import * as os from "os";
import { Agent } from "./agent";
import { Config, loadConfig, updateConfig } from "./config";
import { ContextManager } from "./context";
import { detectAll, DetectedModel, resolveContextWindow } from "./detect";
import { EventBus } from "./events";
import { findModelsOnNetwork, FlowUI, manageHosts } from "./network";
import { Plan, PlanStep } from "./plan";
import { buildSystemPrompt, loadAgentsMd } from "./prompt";
import { LmStudioProvider } from "./providers/lmstudio";
import { OllamaProvider } from "./providers/ollama";
import { Effort, Msg, Provider } from "./providers/types";
import { ProjectTokens, SessionBody, SessionMeta, SessionStore, workspaceKey } from "./store";
import { Mode, MODE_LABELS, MODE_ORDER, normalizeMode, ToolContext } from "./tools/index";
import { pickShell } from "./tools/shell";
import { TaskManager } from "./tools/tasks";
import { renderPlan, SelectOption, SessionUI, SlashCommand, summarizeArgs } from "./ui";
import { c, truncateEnd } from "./util";

/** Per-session preferences from the command line. `effort: null` means an
 * explicit "default"; undefined means "whatever the config remembers". */
export interface SessionPrefs {
  mode?: Mode;
  model?: string;
  backend?: string;
  /** Server the wanted model lives on, when the same id exists on several machines. */
  baseUrl?: string;
  ctx?: number;
  effort?: Effort | null;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "models", desc: "Switch model · add models from other machines" },
  { name: "mode", desc: "Set mode (plan / build / auto)" },
  { name: "effort", desc: "Set reasoning effort" },
  { name: "plan", desc: "Show the agent's plan" },
  { name: "details", desc: "Expand or collapse tool output" },
  { name: "thinking", desc: "Show or hide the model's reasoning" },
  { name: "context", desc: "Show context usage" },
  { name: "compact", desc: "Compact the conversation now" },
  { name: "tasks", desc: "List background tasks" },
  { name: "logs", desc: "Show task output — /logs t1" },
  { name: "stop", desc: "Stop a background task — /stop t1" },
  { name: "sessions", desc: "Switch or manage saved sessions" },
  { name: "statistic", desc: "Total tokens spent on this project" },
  { name: "clear", desc: "Start a fresh session" },
  { name: "help", desc: "Show help" },
  { name: "exit", desc: "Quit smolcoder (web: close this session)" },
];

export { MODE_ORDER };

// ---- model selection helpers (shared with the headless path) --------------

/** Output budget scales with the window: big windows can afford whole-file
 * writes (a single write_file's JSON must fit in the output), tiny windows
 * must stay conservative. */
export function outputBudget(window: number): number {
  return Math.max(128, Math.min(8192, Math.floor(window / 4)));
}

export function makeProvider(m: DetectedModel): Provider {
  const maxOut = outputBudget(m.contextWindow);
  return m.backend === "ollama"
    ? new OllamaProvider(m.baseUrl, m.id, m.contextWindow, m.numCtx, maxOut, m.vision)
    : new LmStudioProvider(m.baseUrl, m.id, m.contextWindow, maxOut, m.reasoning, m.vision);
}

/** One-line advice when the effective reasoning setting will be slow: LM
 * Studio applies the model's own default level when none is chosen, and for
 * current qwen builds that default is the maximum. */
export function effortAdvice(m: DetectedModel, effort: Effort | null): string | null {
  if (m.backend !== "lmstudio" || !m.reasoning?.default) return null;
  const d = m.reasoning.default;
  if (effort === null && /^(high|xhigh)$/.test(d)) {
    return `this model thinks at "${d}" by default on LM Studio — expect long pauses before each tool call. /effort off (or --effort off) is many times faster; /effort low or medium keeps some reasoning.`;
  }
  return null;
}

/** Tell the user what context management just did (both UIs; headless logs
 * it to stderr so a long run's log shows when and how hard compaction hit). */
export function reportCompactions(bus: EventBus, ui: { status: (s: string) => void; warn: (s: string) => void }): void {
  bus.on("post_compact", (report: any) => {
    const delta = `${report?.before} → ${report?.after} tokens est.`;
    if (report?.action === "evicted") ui.status(`· pruned context (${delta})`);
    else if (report?.action === "compacted") ui.status(`· compacted the conversation into hand-over notes (${delta})`);
    else if (report?.action === "floor")
      ui.warn(`· context is at its floor: system prompt + tools + the working tail no longer fit comfortably (${delta}). Consider a bigger context window.`);
  });
}

/** `url` says which server the wanted (or else the remembered) model was on;
 * it only breaks ties between machines that serve the same model id. */
export function autoPickModel(
  models: DetectedModel[],
  wanted: string | undefined,
  remembered: string | undefined,
  url?: string
): DetectedModel {
  if (wanted) {
    const hit =
      models.find((m) => m.id === wanted && m.baseUrl === url) ??
      models.find((m) => m.id === wanted) ??
      models.find((m) => m.id.toLowerCase().includes(wanted.toLowerCase()));
    if (hit) return hit;
    throw new Error(`Model "${wanted}" was not found on the selected backend. Use /models to choose an available model.`);
  }
  // With nothing remembered, a model on this computer beats one across the network.
  const local = models.filter((m) => !m.host);
  const pool = local.length ? local : models;
  return (
    models.find((m) => m.id === remembered && m.baseUrl === url) ??
    models.find((m) => m.id === remembered) ??
    pool.find((m) => m.backend === "ollama") ??
    pool.find((m) => m.loaded) ??
    pool[0]
  );
}

export function noBackendsMessage(): string {
  return (
    c.red("No usable model found.") +
    `\n\nsmolcoder connects to a running model server; it does not scan installed apps or drives.\n` +
    `  · ${c.bold("Ollama")}: start the app (or run: ollama serve), then check: ollama list\n` +
    `    Found on this computer, at ${c.dim("$OLLAMA_HOST")}, and in Docker containers that publish its port.\n` +
    `    If the list is empty, run: ollama pull qwen3\n` +
    `  · ${c.bold("LM Studio")}: load a model and start Local Server in the Developer tab (any port).\n` +
    `  · ${c.bold("Another machine")}: start smol in a terminal or with --web and choose "Find models on another machine".\n\n` +
    `Then run smol again.`
  );
}

/** "ollama" on this computer, "ollama @ gpu-box" across the network. */
export function backendLabel(m: DetectedModel): string {
  return m.host ? `${m.backend} @ ${m.host}` : m.backend;
}

export function sessionLine(m: DetectedModel, mode: Mode): string {
  return `${c.green("●")} ${backendLabel(m)} · ${c.bold(m.id)} · ctx ${m.contextWindow.toLocaleString()} · ${MODE_LABELS[mode]} mode`;
}

export function fmtTokens(n: number): string {
  return n < 1000 ? String(n) : (n / 1000).toFixed(1) + "k";
}

/** Mode names and their aliases, as accepted by `/mode <name>`. Returns null
 * for an unknown name so the caller can fall back to the picker or a hint. */
export function resolveModeName(arg: string): Mode | null {
  const aliases: Record<string, Mode> = {
    plan: "plan", ro: "plan", "read-only": "plan", readonly: "plan",
    build: "build", edit: "build", write: "build", e: "build", w: "build",
    auto: "auto", bypass: "auto", "bypass-permissions": "auto", yolo: "auto", b: "auto", y: "auto",
  };
  return aliases[arg.trim().toLowerCase()] ?? null;
}

function modeColored(mode: Mode): string {
  const label = MODE_LABELS[mode];
  if (mode === "auto") return c.red(c.bold(label));
  if (mode === "plan") return c.magenta(c.bold(label));
  return c.cyan(c.bold(label));
}

/** Detect backends, pick a model and resolve its context window. Returns null
 * when no backend answers. `progress` gets a short label for each slow step. */
export async function prepareModel(
  prefs: SessionPrefs,
  cfg: Config,
  progress?: (label: string) => void
): Promise<DetectedModel | null> {
  progress?.("looking for Ollama and LM Studio");
  const url = prefs.model ? prefs.baseUrl : cfg.lastModelUrl;
  // Without --model the remembered one wins anyway, so stop looking the moment
  // it shows up instead of waiting out a network host that is switched off.
  const until =
    !prefs.model && cfg.lastModel
      ? (m: DetectedModel) => m.id === cfg.lastModel && (!url || m.baseUrl === url) && (!prefs.backend || m.backend === prefs.backend)
      : undefined;
  const models = (await detectAll({ hosts: cfg.hosts, until })).filter((m) => !prefs.backend || m.backend === prefs.backend);
  if (models.length === 0) return null;
  const chosen = autoPickModel(models, prefs.model, cfg.lastModel, url);
  progress?.(`loading ${chosen.id}`);
  return resolveContextWindow(chosen, prefs.ctx);
}

/** Picker rows for a model list: this computer first, then each network host. */
export function modelOptions(models: DetectedModel[], current?: DetectedModel): SelectOption[] {
  return models.map((m) => ({
    label: m.id,
    hint:
      (m.backend === "ollama" ? "ollama" : `lm studio${m.loaded ? ` · ctx ${m.contextWindow.toLocaleString()}` : " · not loaded"}`) +
      (m.host ? ` · ${m.host}` : ""),
    current: !!current && m.id === current.id && m.backend === current.backend && m.baseUrl === current.baseUrl,
  }));
}

export const FIND_ROW: SelectOption = { label: "+ Find models on another machine…", hint: "search my network or enter an address" };
export const HOSTS_ROW: SelectOption = { label: "Network hosts…", hint: "rename, remove or re-find added machines" };

/** Nothing answered on this computer. Rather than giving up, offer to look on
 * the network — with both UIs' own pickers, before a session exists. Returns
 * a ready model, or null when the user backs out. */
export async function setupWithoutLocalModels(ui: FlowUI, prefs: SessionPrefs): Promise<DetectedModel | null> {
  for (;;) {
    const pick = await ui.select("No model server found on this computer", [
      { label: "Find models on another machine", hint: "search my network or enter an address" },
      { label: "Look again", hint: "after starting Ollama or LM Studio here" },
    ]);
    if (pick === null) return null;
    if (pick === 0 && !(await findModelsOnNetwork(ui))) continue;
    ui.startSpinner("looking for Ollama and LM Studio");
    const cfg = loadConfig();
    const models = (await detectAll({ hosts: cfg.hosts })).filter((m) => !prefs.backend || m.backend === prefs.backend);
    ui.stopSpinner();
    if (!models.length) {
      ui.warn("Still no model server answering.");
      continue;
    }
    // A machine was just added by hand: let the user say which of its models
    // to load instead of pulling the first one into its memory.
    const idx = models.length === 1 ? 0 : await ui.select("Select model", modelOptions(models));
    if (idx === null) continue;
    ui.startSpinner(`loading ${models[idx].id}`);
    try {
      return await resolveContextWindow(models[idx], prefs.ctx);
    } finally {
      ui.stopSpinner();
    }
  }
}

// ---- session titles ---------------------------------------------------------

/** Ask the model for a short session name from the first exchange. One cheap
 * call with thinking off and a tiny output cap; null when the reply is not
 * usable, in which case the caller keeps its fallback (the first message). */
export async function suggestTitle(messages: Msg[], provider: Provider): Promise<string | null> {
  const first = messages.find((m) => m.role === "user" && !m.compactNote);
  if (!first) return null;
  const reply = [...messages].reverse().find((m) => m.role === "assistant" && m.content.trim());
  try {
    const res = await provider.chat(
      [
        {
          role: "system",
          content:
            "You name coding sessions. Reply with only the title: three to six words, plain text, no quotes, no trailing period.",
        },
        {
          role: "user",
          content:
            `First request:\n${truncateEnd(first.content, 600)}\n\n` +
            (reply ? `Reply excerpt:\n${truncateEnd(reply.content, 400)}\n\n` : "") +
            "Title:",
        },
      ],
      [],
      { effortOverride: "off", maxTokens: 30, timeoutMs: 15_000, background: true }
    );
    return cleanTitle(res.content);
  } catch {
    return null;
  }
}

/** Exported for tests: normalize a model-written title. */
export function cleanTitle(raw: string): string | null {
  let t = String(raw ?? "").replace(/<think>[\s\S]*?(<\/think>|$)/gi, "");
  t = t.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  t = t
    .replace(/^(title|session( name)?)\s*:\s*/i, "")
    .replace(/^["'`“”*#\s]+|["'`“”*.\s]+$/g, "")
    .replace(/\s+/g, " ");
  if (t.length < 3 || /[<>{}]/.test(t)) return null;
  if (t.length > 60) {
    t = t.slice(0, 60);
    const cut = t.lastIndexOf(" ");
    if (cut > 20) t = t.slice(0, cut);
    t = t.replace(/[\s,;:.-]+$/, "");
  }
  return t || null;
}

// ---- session ids and transcript replay -------------------------------------

/** A short hex id, the same shape the web hub mints for its sessions. */
export function newSessionId(): string {
  return randomBytes(4).toString("hex");
}

/** Convert agent messages into the web page's replay events, so a session
 * written from the terminal TUI renders its transcript if opened in --web.
 * Exported for tests. */
export function eventsFromMessages(messages: Msg[]): Record<string, any>[] {
  const out: Record<string, any>[] = [];
  for (const m of messages) {
    if (m.compactNote || m.historyNote) continue;
    if (m.role === "user") {
      out.push({ t: "user", s: m.content });
    } else if (m.role === "assistant") {
      if (m.thinking) out.push({ t: "thinking", s: m.thinking });
      if (m.content && m.content.trim()) out.push({ t: "token", s: m.content });
      for (const tc of m.toolCalls ?? []) out.push({ t: "tool", name: tc.name, summary: summarizeArgs(tc.name, tc.args ?? {}) });
    } else if (m.role === "tool") {
      const lines = String(m.content ?? "").split("\n");
      const first = lines[0] ?? "";
      out.push({ t: "result", line: first.slice(0, 160), err: first.startsWith("Error"), extra: lines.length > 1 ? lines.length - 1 : 0, body: m.content });
    }
  }
  return out;
}

/** A compact "2h ago" / "yesterday" style age for the session picker. */
export function relativeTime(ts: number): string {
  const d = Date.now() - ts;
  if (!ts || d < 30_000) return "just now";
  const m = Math.floor(d / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

// ---- the session -----------------------------------------------------------

/** Everything needed to bring a session back after a restart. */
export interface SessionSnapshot {
  messages: Msg[]; // without the system message — rebuilt on restore
  plan: PlanStep[];
  filesTouched: string[];
  commandsRun: string[];
  originalRequest: string;
  currentRequest: string;
  mode: Mode;
  effort: Effort | null;
  model: string;
  backend: string;
  /** Server the model ran on (absent in sessions saved before network hosts). */
  baseUrl?: string;
}

export interface SessionOptions {
  workspace: string;
  chosen: DetectedModel;
  prefs: SessionPrefs;
  cfg: Config;
  /** Text printed by /help. */
  help: string;
  /** When set, the session saves itself to this store and gains /sessions.
   * The web hub leaves it undefined and owns persistence itself. */
  store?: SessionStore;
}

export class Session {
  readonly workspace: string;
  chosen: DetectedModel;
  effort: Effort | null;
  readonly agent: Agent;
  readonly toolCtx: ToolContext;
  readonly taskManager: TaskManager;
  readonly ctxMgr: ContextManager;
  readonly bus = new EventBus();
  readonly shell = pickShell();
  /** Host hook: fired once when the session has shut down (/exit, ctrl+c). */
  onExit: (() => void) | null = null;
  /** Host hook: fired after each completed user turn (the web hub names the
   * session after the first one). */
  onTurnDone: (() => void) | null = null;
  /** Host hook for /statistic: token usage of this workspace's other sessions.
   * The web hub owns the store, so it provides the numbers; the terminal reads
   * the store directly. `excludeId` is this session, counted live instead. */
  usageForWorkspace: ((excludeId: string) => ProjectTokens) | null = null;

  private readonly agentsMd: string | null;
  private readonly prefs: SessionPrefs;
  private readonly help: string;
  private readonly store?: SessionStore;
  /** On-disk identity of this session, minted on the first save. */
  private id = "";
  private title = "";
  private createdAt = 0;
  /** The user renamed it by hand: the model's title must never replace it. */
  private titleByUser = false;
  private titleTries = 0;
  private ended = false;
  private toolDetails = false;
  private showThinking = true;

  constructor(
    readonly ui: SessionUI,
    opts: SessionOptions
  ) {
    const { workspace, chosen, prefs, cfg } = opts;
    this.workspace = workspace;
    this.chosen = chosen;
    this.prefs = prefs;
    this.help = opts.help;
    this.store = opts.store;
    const mode0 = prefs.mode ?? cfg.lastMode ?? "build";
    this.effort = prefs.effort !== undefined ? prefs.effort : (cfg.effort ?? null);

    const provider = makeProvider(chosen);
    provider.setEffort(this.effort);
    this.taskManager = new TaskManager(workspace);
    this.toolCtx = {
      workspace,
      taskManager: this.taskManager,
      plan: new Plan(),
      filesTouched: new Set(),
      commandsRun: [],
    };
    this.ctxMgr = new ContextManager(chosen.contextWindow, provider.maxOutputTokens);
    this.agentsMd = loadAgentsMd(workspace);
    // The step cap is a runaway-loop backstop, not a work limit — esc/ctrl+c
    // is the user's real kill switch, so set it far above any legitimate task.
    this.agent = new Agent(provider, mode0, this.sysPrompt(mode0), this.toolCtx, this.ctxMgr, this.bus, ui, true, 1000);

    ui.slashCommands = SLASH_COMMANDS;
    ui.hintLeft = workspace.replace(os.homedir(), "~");
    ui.getStatus = () => this.statusLine();
    ui.onModeCycle = () => this.applyModeNow();
    ui.onModeSet = (arg) => this.applyModeNow(arg);
    ui.onCancel = () => this.agent.cancel();
    ui.onExit = () => void this.shutdown();
    reportCompactions(this.bus, ui);
    this.bus.on("context_update", () => ui.refresh());
    this.persist();
  }

  private sysPrompt(mode: Mode): string {
    return buildSystemPrompt({ workspace: this.workspace, mode, shellLabel: this.shell.label, agentsMd: this.agentsMd });
  }

  private persist(): void {
    updateConfig({ lastModel: this.chosen.id, lastModelUrl: this.chosen.baseUrl, lastMode: this.agent.mode, effort: this.effort });
  }

  // ---- session persistence (terminal TUI; the web hub saves its own way) ----

  /** True once the user has actually said something worth keeping. */
  private hasContent(): boolean {
    return this.agent.messages.some((m) => m.role === "user" && !m.compactNote && !m.historyNote);
  }

  private fallbackTitle(): string {
    const first = this.agent.messages.find((m) => m.role === "user" && !m.compactNote && !m.historyNote);
    return (first?.content ?? "").replace(/\s+/g, " ").trim().slice(0, 60) || "untitled session";
  }

  /** Write the current transcript to the shared store. A no-op in the web hub
   * (which owns persistence) and for a session with nothing said yet. Written
   * synchronously: the terminal has one session, so a stale async write racing
   * a switch is not worth the risk. */
  private saveSession(): void {
    if (!this.store || !this.hasContent()) return;
    if (!this.id) this.id = newSessionId();
    if (!this.title) this.title = this.fallbackTitle();
    if (!this.createdAt) this.createdAt = Date.now();
    const meta: SessionMeta = {
      id: this.id,
      workspace: this.workspace,
      title: this.title,
      createdAt: this.createdAt,
      updatedAt: Date.now(),
      model: this.chosen.id,
      backend: this.chosen.backend,
      promptTokens: this.agent.lifetimePromptTokens,
      completionTokens: this.agent.lifetimeCompletionTokens,
    };
    const body: SessionBody = { snapshot: this.snapshot(), events: eventsFromMessages(this.agent.messages) };
    try {
      this.store.saveMeta(meta);
      this.store.saveBodySync(this.id, body);
    } catch {
      /* best effort */
    }
  }

  /** After a completed turn: save, then let the model name the session once. */
  private afterTurn(): void {
    if (!this.store) return;
    if (!this.title) this.title = this.fallbackTitle();
    this.saveSession();
    void this.maybeAutoTitle();
  }

  private async maybeAutoTitle(): Promise<void> {
    if (!this.store || this.titleByUser || this.titleTries >= 2) return;
    this.titleTries++;
    let title: string | null = null;
    try {
      title = await this.suggestTitle();
    } catch {
      title = null;
    }
    if (!title || this.titleByUser) return;
    this.title = title;
    this.saveSession();
  }

  /** Reset everything for a brand-new session (a fresh id, no transcript). */
  private newConversation(): void {
    this.agent.resetTranscript();
    this.agent.resetLifetimeTokens();
    this.toolCtx.plan.reset();
    this.toolCtx.filesTouched.clear();
    this.toolCtx.commandsRun.length = 0;
    this.id = newSessionId();
    this.createdAt = Date.now();
    this.title = "";
    this.titleByUser = false;
    this.titleTries = 0;
  }

  /** The TUI's status row: mode · model · effort · context · plan · tasks. */
  statusLine(): string {
    const agent = this.agent;
    const tasks = this.taskManager.runningSummary().length;
    const plan = this.toolCtx.plan;
    return (
      `${modeColored(agent.mode)} ${c.dim("·")} ${this.chosen.id} ${c.dim(backendLabel(this.chosen))}` +
      (this.effort || agent.provider.effortLabel()
        ? ` ${c.dim("·")} ${c.yellow(agent.provider.effortLabel() ?? this.effort ?? "")}`
        : "") +
      ` ${c.dim("·")} ${c.dim(`${fmtTokens(agent.contextTokens())} (${agent.contextPercent()}%)`)}` +
      ` ${c.dim("·")} ${c.dim(`tok ↓${fmtTokens(agent.totalPromptTokens)} ↑${fmtTokens(agent.totalCompletionTokens)}`)}` +
      (plan.exists
        ? ` ${c.dim("·")} ${
            plan.currentIndex < 0
              ? c.green(`plan ${plan.doneCount}/${plan.steps.length}`)
              : c.cyan(`plan ${plan.doneCount}/${plan.steps.length}`)
          }`
        : "") +
      (tasks ? ` ${c.dim("·")} ${c.green(`${tasks} task${tasks > 1 ? "s" : ""}`)}` : "")
    );
  }

  /** Structured status for the web page's status bar. */
  state(): Record<string, any> {
    const plan = this.toolCtx.plan;
    return {
      mode: this.agent.mode,
      model: this.chosen.id,
      backend: this.chosen.backend,
      host: this.chosen.host,
      vision: this.chosen.vision,
      effort: this.agent.provider.effortLabel() ?? this.effort,
      ctxTokens: this.agent.contextTokens(),
      ctxPct: this.agent.contextPercent(),
      context: this.agent.contextBudget(),
      tokensIn: this.agent.totalPromptTokens,
      tokensOut: this.agent.totalCompletionTokens,
      outcome: this.agent.outcome,
      lastError: this.agent.lastError,
      plan: plan.exists ? { steps: plan.steps, current: plan.currentIndex } : null,
      tasks: this.taskManager.runningSummary().length,
      workspace: this.workspace,
      commands: SLASH_COMMANDS,
      urls: this.taskManager.recentUrls(),
    };
  }

  /** The opening lines: backend · model · mode, workspace, AGENTS.md, advice. */
  announce(): void {
    const ui = this.ui;
    if (this.chosen.note) ui.warn(`  ${this.chosen.note}`);
    const advice = effortAdvice(this.chosen, this.effort);
    if (advice) ui.warn(`  ${advice}`);
  }

  snapshot(): SessionSnapshot {
    return {
      messages: this.agent.messages.slice(1),
      plan: this.toolCtx.plan.steps.map((s) => ({ ...s })),
      filesTouched: [...this.toolCtx.filesTouched],
      commandsRun: [...this.toolCtx.commandsRun],
      originalRequest: this.agent.originalRequest,
      currentRequest: this.agent.currentRequest,
      mode: this.agent.mode,
      effort: this.effort,
      model: this.chosen.id,
      backend: this.chosen.backend,
      baseUrl: this.chosen.baseUrl,
    };
  }

  /** A model-written name for this session, or null to keep the fallback. */
  suggestTitle(): Promise<string | null> {
    return suggestTitle(this.agent.messages, this.agent.provider);
  }

  /** Bring a saved transcript back (the system message is rebuilt for the
   * current mode/workspace; approvals are deliberately not restored). */
  restore(s: SessionSnapshot): void {
    // Clear leftover outcome/error/plan from whatever ran before this session
    // was loaded into the same agent.
    this.agent.resetTranscript();
    this.toolCtx.plan.reset();
    this.agent.restoreTranscript(s.messages ?? [], s.originalRequest ?? "", s.currentRequest ?? "");
    this.toolCtx.plan.steps = (s.plan ?? []).map((p) => ({ text: String(p.text), done: !!p.done,
      ...(typeof p.note === "string" ? { note: p.note.slice(0, 1000) } : {}) }));
    for (const f of s.filesTouched ?? []) this.toolCtx.filesTouched.add(f);
    this.toolCtx.commandsRun.push(...(s.commandsRun ?? []));
  }

  /** The input loop. Returns after /exit (or after the host asked the UI to
   * hand back "/exit"). */
  async run(): Promise<void> {
    const { ui, agent, toolCtx, taskManager } = this;
    await this.bus.emit("session_start");
    for (;;) {
      const raw = await ui.readInput();
      const input = typeof raw === "string" ? raw : raw.text;
      const attachments = typeof raw === "string" ? [] : raw.attachments;

      if (!attachments.length && input.startsWith("/")) {
        const [cmd, ...rest] = input.slice(1).split(/\s+/);
        const arg = rest[0];
        switch (cmd) {
          case "exit":
          case "quit":
          case "q":
            await this.shutdown();
            return;
          case "help":
            ui.println(this.help);
            break;
          case "models":
          case "model":
            await this.switchModel();
            break;
          case "mode":
            await this.setMode(arg);
            break;
          case "effort":
            await this.setEffort(arg);
            break;
          case "plan":
            if (toolCtx.plan.exists) ui.println(renderPlan(toolCtx.plan));
            else ui.status("· no plan yet — the agent creates one when it starts a multi-step task");
            break;
          case "details":
            this.toolDetails = !this.toolDetails;
            ui.setToolDetails?.(this.toolDetails);
            ui.status(`· tool details ${this.toolDetails ? "expanded" : "collapsed"}`);
            break;
          case "thinking":
            this.showThinking = !this.showThinking;
            ui.setThinking?.(this.showThinking);
            ui.status(`· reasoning ${this.showThinking ? "shown" : "hidden"}`);
            break;
          case "tasks":
            ui.println(taskManager.list());
            break;
          case "logs":
            ui.println(taskManager.logs(arg ?? "", Number(rest[1]) || 50));
            break;
          case "stop":
            ui.println(taskManager.stop(arg ?? ""));
            break;
          case "compact":
            ui.startSpinner("compacting");
            try { await agent.compactNow(); }
            catch (err: any) { ui.error(String(err?.message ?? err)); }
            finally { ui.stopSpinner(); }
            break;
          case "context":
            const budget = agent.contextBudget();
            ui.status(
              `Context ${budget.prompt.toLocaleString()} / ${budget.window.toLocaleString()} tokens (${budget.source})\nReply reserve ${budget.reserve.toLocaleString()} · available ${budget.available.toLocaleString()} · ${agent.messages.length} messages · ${agent.tools.length} tools\nSession tokens: ↓${agent.totalPromptTokens.toLocaleString()} in · ↑${agent.totalCompletionTokens.toLocaleString()} out`
            );
            break;
          case "clear":
            if (this.store) {
              this.saveSession();
              this.newConversation();
              ui.replayConversation?.([], "");
              ui.status("· started a fresh session");
            } else {
              agent.resetTranscript();
              toolCtx.plan.reset();
              ui.status("· conversation cleared");
            }
            break;
          case "sessions":
            if (this.store) await this.manageSessions();
            else ui.warn("· use the session list in the sidebar to switch sessions");
            break;
          case "statistic": {
            const u = this.projectUsage();
            const total = u.promptTokens + u.completionTokens;
            ui.status(
              `Token usage for ${this.workspace.replace(os.homedir(), "~")}\n` +
                `${u.sessions} session${u.sessions === 1 ? "" : "s"} · ` +
                `↓${u.promptTokens.toLocaleString()} sent · ↑${u.completionTokens.toLocaleString()} generated · ` +
                `${total.toLocaleString()} total`
            );
            break;
          }
          default:
            ui.warn(`Unknown command /${cmd} — try /help`);
        }
        ui.refresh();
        continue;
      }

      try {
        await agent.runTurn(input, attachments);
        this.afterTurn();
        this.onTurnDone?.();
      } catch (err: any) {
        ui.error(`\n${err?.message ?? err}`);
        if (String(err?.message ?? "").toLowerCase().includes("does not support tools")) {
          ui.warn(
            "This model does not support tool calling. Pick a tool-capable model with /models (e.g. qwen3, llama3.1, mistral-nemo)."
          );
        }
      }
    }
  }

  /** Idempotent: end-of-session hook, kill background tasks, close the UI,
   * then tell the host. */
  async shutdown(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.agent.cancel();
    this.saveSession();
    try {
      await this.bus.emit("session_end");
    } catch {
      /* best effort */
    }
    this.taskManager.killAll();
    this.ui.close();
    this.onExit?.();
  }

  private async switchModel(): Promise<void> {
    const { ui, agent } = this;
    let fresh: DetectedModel[];
    let idx: number | null;
    // The picker is also where other machines are added and managed; after
    // either, look again and reopen it so their models are right there.
    for (;;) {
      const hosts = loadConfig().hosts ?? [];
      ui.startSpinner("looking for models");
      fresh = await detectAll({ hosts });
      ui.stopSpinner();
      if (!fresh.length) ui.warn("No model server is answering right now.");
      const rows = [...modelOptions(fresh, this.chosen), FIND_ROW, ...(hosts.length ? [HOSTS_ROW] : [])];
      idx = await ui.select("Select model", rows);
      if (idx === null) return;
      if (idx < fresh.length) break;
      if (rows[idx] === FIND_ROW) await findModelsOnNetwork(ui);
      else await manageHosts(ui);
    }
    let next: DetectedModel;
    ui.startSpinner(`loading ${fresh[idx].id}`);
    try {
      next = await resolveContextWindow(fresh[idx], this.prefs.ctx);
    } catch (err: any) {
      ui.error(String(err?.message ?? err));
      return;
    } finally {
      ui.stopSpinner();
    }
    this.applyModel(next);
    this.persist();
    this.saveSession();
    ui.println(sessionLine(next, agent.mode));
    if (next.note) ui.warn(`  ${next.note}`);
    const advice = effortAdvice(next, this.effort);
    if (advice) ui.warn(`  ${advice}`);
  }

  /** Swap in a detected model: a fresh provider plus the matching context
   * window. Shared by /models and by resuming a session on another model. */
  private applyModel(next: DetectedModel): void {
    this.chosen = next;
    const p = makeProvider(next);
    p.setEffort(this.effort);
    this.agent.setProvider(p);
    this.ctxMgr.setWindow(next.contextWindow, p.maxOutputTokens);
  }

  /** Immediate mode switch, safe while a turn is running: the agent rechecks
   * the mode before every tool call, so `/mode <name>` typed mid-run or the Tab
   * cycle takes effect from the next action without stopping the run. No
   * argument means "cycle" (used by Tab) rather than opening the picker. */
  applyModeNow(arg?: string): void {
    const next = arg ? resolveModeName(arg) : this.nextMode();
    if (!next) {
      this.ui.status(`· unknown mode '${arg}' — use plan, build or auto`);
      return;
    }
    this.applyMode(next);
  }

  private nextMode(): Mode {
    return MODE_ORDER[(MODE_ORDER.indexOf(this.agent.mode) + 1) % MODE_ORDER.length];
  }

  private applyMode(next: Mode): void {
    const changed = next !== this.agent.mode;
    this.agent.setMode(next, this.sysPrompt(next));
    this.ui.status(changed ? `· mode → ${MODE_LABELS[next]}` : `· already in ${MODE_LABELS[next]} mode`);
    this.persist();
    this.saveSession();
  }

  private async setMode(arg?: string): Promise<void> {
    // Unknown or missing name falls through to the picker (idle-only path).
    const next = arg ? resolveModeName(arg) : await this.pickMode();
    if (!next) return;
    this.applyMode(next);
  }

  private async pickMode(): Promise<Mode | null> {
    const agent = this.agent;
    const idx = await this.ui.select("Select mode", [
      {
        label: "plan",
        hint: "research and design only; read and search files, change nothing",
        current: agent.mode === "plan",
      },
      {
        label: "build",
        hint: "edit files; run commands inside the workspace, ask y/n for anything outside it",
        current: agent.mode === "build",
      },
      {
        label: "auto",
        hint: "full access, never asks for approval",
        current: agent.mode === "auto",
      },
    ]);
    return idx === null ? null : MODE_ORDER[idx];
  }

  private async setEffort(arg?: string): Promise<void> {
    const { ui, agent } = this;
    const levels: (Effort | "default")[] = ["default", "off", "low", "medium", "high"];
    let next: Effort | null | undefined;
    if (arg && (levels as string[]).includes(arg)) {
      next = arg === "default" ? null : (arg as Effort);
    } else {
      const idx = await ui.select("Reasoning effort", [
        {
          label: "default",
          hint: this.chosen.reasoning?.default
            ? `the model's own default (${this.chosen.reasoning.default})`
            : "leave it to the model",
          current: this.effort === null,
        },
        { label: "off", hint: "no thinking — fastest, best for long tool loops", current: this.effort === "off" },
        { label: "low", hint: "brief reasoning", current: this.effort === "low" },
        { label: "medium", hint: "", current: this.effort === "medium" },
        { label: "high", hint: "most thorough — slow on local models", current: this.effort === "high" },
      ]);
      if (idx === null) return;
      next = idx === 0 ? null : (levels[idx] as Effort);
    }
    this.effort = next;
    agent.provider.setEffort(this.effort);
    this.persist();
    this.saveSession();
    const label = agent.provider.effortLabel();
    ui.status(`· effort ${label ?? this.effort ?? "default"}`);
    const advice = effortAdvice(this.chosen, this.effort);
    if (advice) ui.warn(`  ${advice}`);
  }

  // ---- saved sessions (/sessions) -------------------------------------------

  /** Lifetime token spend for this whole project: every saved session for the
   * workspace plus this one's live (not-yet-saved) totals. */
  private projectUsage(): ProjectTokens {
    const live = {
      sessions: this.hasContent() || this.agent.lifetimePromptTokens || this.agent.lifetimeCompletionTokens ? 1 : 0,
      promptTokens: this.agent.lifetimePromptTokens,
      completionTokens: this.agent.lifetimeCompletionTokens,
    };
    let stored: ProjectTokens;
    if (this.store) {
      const key = workspaceKey(this.workspace);
      let promptTokens = 0;
      let completionTokens = 0;
      let sessions = 0;
      for (const m of this.store.listMetas()) {
        if (workspaceKey(m.workspace) !== key || m.id === this.id) continue;
        promptTokens += m.promptTokens ?? 0;
        completionTokens += m.completionTokens ?? 0;
        sessions++;
      }
      stored = { sessions, promptTokens, completionTokens };
    } else if (this.usageForWorkspace) {
      stored = this.usageForWorkspace(this.id);
    } else {
      stored = { sessions: 0, promptTokens: 0, completionTokens: 0 };
    }
    return {
      sessions: live.sessions + stored.sessions,
      promptTokens: live.promptTokens + stored.promptTokens,
      completionTokens: live.completionTokens + stored.completionTokens,
    };
  }

  /** The saved sessions for this workspace, newest first. */
  private workspaceMetas(): SessionMeta[] {
    if (!this.store) return [];
    const key = workspaceKey(this.workspace);
    return this.store
      .listMetas()
      .filter((m) => workspaceKey(m.workspace) === key)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private async manageSessions(): Promise<void> {
    const { ui } = this;
    if (!this.store) {
      ui.warn("Sessions are saved in the web UI only. Run smol --web for switchable, resumable sessions.");
      return;
    }
    const metas = this.workspaceMetas();
    const rows: SelectOption[] = metas.map((m) => ({
      label: m.title || "untitled session",
      hint: `${m.model ?? "?"} · ${relativeTime(m.updatedAt)}${m.id === this.id ? " · current" : ""}`,
      current: m.id === this.id,
    }));
    const NEW = rows.length;
    const RENAME = NEW + 1;
    const DEL = NEW + 2;
    rows.push({ label: "+ New session", hint: "start a fresh conversation" });
    rows.push({ label: "Rename a session…", hint: "" });
    rows.push({ label: "Delete a session…", hint: "permanently removes it from disk" });
    const idx = await ui.select("Sessions", rows);
    if (idx === null) return;
    if (idx === NEW) return void (await this.switchToSession(null));
    if (idx === RENAME) return await this.renameSession(metas);
    if (idx === DEL) return await this.deleteSession(metas);
    if (metas[idx].id === this.id) {
      ui.status("· already in this session");
      return;
    }
    await this.switchToSession(metas[idx].id);
  }

  private async renameSession(metas: SessionMeta[]): Promise<void> {
    const { ui } = this;
    if (!metas.length) {
      ui.warn("No saved sessions to rename yet.");
      return;
    }
    const idx = await ui.select(
      "Rename which session?",
      metas.map((m) => ({ label: m.title || "untitled session", current: m.id === this.id }))
    );
    if (idx === null) return;
    const target = metas[idx];
    const raw = await ui.prompt("New name", target.title || "session name");
    if (raw === null) return;
    const title = raw.replace(/\s+/g, " ").trim().slice(0, 80);
    if (!title) return;
    target.title = title;
    try {
      this.store!.saveMeta(target);
    } catch {
      /* non-fatal */
    }
    if (target.id === this.id) {
      this.title = title;
      this.titleByUser = true;
    }
    ui.status(`· renamed to "${title}"`);
  }

  private async deleteSession(metas: SessionMeta[]): Promise<void> {
    const { ui } = this;
    if (!metas.length) {
      ui.warn("No saved sessions to delete yet.");
      return;
    }
    const idx = await ui.select(
      "Delete which session?",
      metas.map((m) => ({ label: m.title || "untitled session", hint: relativeTime(m.updatedAt), current: m.id === this.id }))
    );
    if (idx === null) return;
    const target = metas[idx];
    const confirm = await ui.select(`Delete "${target.title || "untitled session"}"?`, [
      { label: "Cancel" },
      { label: "Delete permanently", hint: "the transcript cannot be recovered" },
    ]);
    if (confirm !== 1) return;
    try {
      this.store!.delete(target.id);
    } catch (err: any) {
      ui.error(`Could not delete the session: ${err?.message ?? err}`);
      return;
    }
    if (target.id === this.id) {
      this.newConversation();
      ui.replayConversation?.([], "");
    }
    ui.status(`· deleted "${target.title || "untitled session"}"`);
  }

  /** Load another saved session, or a fresh one when `id` is null, into this
   * same agent and rebuild the visible transcript. */
  private async switchToSession(id: string | null): Promise<void> {
    const { ui, agent, toolCtx } = this;
    if (!this.store) return;
    if (this.hasContent()) this.saveSession();

    if (id === null) {
      this.newConversation();
      ui.replayConversation?.([], "");
      ui.status("· started a fresh session");
      return;
    }
    const meta = this.store.loadMeta(id);
    const body = this.store.loadBody(id);
    if (!meta || !body) {
      ui.warn("That session could not be loaded (its file is missing or unreadable).");
      return;
    }
    const s = body.snapshot;
    // The saved model may live on another machine, or not be running at all;
    // re-detect before swapping the provider.
    if (s.model && (s.model !== this.chosen.id || (s.baseUrl && s.baseUrl !== this.chosen.baseUrl) || (s.backend && s.backend !== this.chosen.backend))) {
      ui.startSpinner(`loading ${s.model}`);
      let next: DetectedModel | null = null;
      try {
        next = await prepareModel({ model: s.model, backend: s.backend, baseUrl: s.baseUrl, ctx: this.prefs.ctx }, loadConfig());
      } catch {
        next = null;
      } finally {
        ui.stopSpinner();
      }
      if (!next) {
        ui.warn(`The model this session used ("${s.model}") is not available right now — staying in the current session.`);
        return;
      }
      this.applyModel(next);
    }
    // A saved auto (bypass) mode is never inherited silently (matches the config).
    const savedMode = normalizeMode(s.mode, agent.mode);
    const mode: Mode = savedMode === "auto" ? "build" : savedMode;
    this.effort = s.effort !== undefined ? s.effort : this.effort;
    agent.setMode(mode, this.sysPrompt(mode));
    agent.provider.setEffort(this.effort);
    this.restore(s);
    this.id = id;
    this.title = meta.title || this.fallbackTitle();
    this.createdAt = meta.createdAt || Date.now();
    this.titleByUser = !!meta.title;
    this.titleTries = meta.title ? 99 : 0;
    // Continue the saved session's token accounting where it left off.
    this.agent.lifetimePromptTokens = meta.promptTokens ?? 0;
    this.agent.lifetimeCompletionTokens = meta.completionTokens ?? 0;
    ui.replayConversation?.(agent.messages, this.title);
    if (toolCtx.plan.exists) ui.planUpdated(toolCtx.plan);
    this.persist();
    if (normalizeMode(s.mode, "build") === "auto") {
      ui.warn("· resumed in build mode — auto is never restored; earlier command approvals are not remembered either");
    }
    ui.status(`· resumed "${this.title}"`);
  }
}
