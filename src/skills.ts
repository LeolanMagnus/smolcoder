// Skills: reusable workflows saved as <name>/SKILL.md folders, compatible
// with the Claude Code convention. Only a compact list (name — description)
// rides in the system prompt; the full instructions load on demand through
// the skill tool, so a workspace with many skills still fits a small context
// window. Zero dependencies: frontmatter is parsed line by line.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface SkillInfo {
  /** Lowercase name the model and the skill tool use. */
  name: string;
  description: string;
  /** Folder containing SKILL.md. */
  dir: string;
  source: "project" | "project-claude" | "global" | "global-claude";
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DESCRIPTION_CAP = 160; // chars per entry in the prompt list
const PROMPT_SECTION_CAP = 3000; // chars of the whole skills section (~750 tokens)
const MAX_PROMPT_SKILLS = 24;
const SKILL_TEXT_CAP = 12000; // chars of a loaded SKILL.md

/** The folders searched for skills, most specific first. `home` is a
 * parameter so tests never touch the real home directory. */
export function skillRoots(workspace: string, home: string = os.homedir()): { dir: string; source: SkillInfo["source"] }[] {
  return [
    { dir: path.join(workspace, ".smolcoder", "skills"), source: "project" },
    { dir: path.join(workspace, ".claude", "skills"), source: "project-claude" },
    { dir: path.join(home, ".smolcoder", "skills"), source: "global" },
    { dir: path.join(home, ".claude", "skills"), source: "global-claude" },
  ];
}

/** Scan every root for <folder>/SKILL.md. A broken file is skipped, not an
 * error; a name found in an earlier (more specific) root shadows later ones. */
export function discoverSkills(workspace: string, home: string = os.homedir()): SkillInfo[] {
  const found = new Map<string, SkillInfo>();
  for (const root of skillRoots(workspace, home)) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root.dir, { withFileTypes: true });
    } catch {
      continue; // no such root
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root.dir, entry.name);
      let text: string;
      try {
        text = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8");
      } catch {
        continue; // not a skill folder
      }
      const front = parseFrontmatter(text);
      const name = pickName(front.name, entry.name);
      if (!name || found.has(name)) continue;
      const description = (front.description || firstParagraph(text) || "").replace(/\s+/g, " ").trim();
      found.set(name, { name, description, dir, source: root.source });
    }
  }
  return [...found.values()];
}

/** The compact "Available skills" section for the system prompt, or null
 * when nothing is installed. The list is what makes the model load a skill;
 * the caps keep it from eating a small context window. */
export function renderSkillsPrompt(skills: SkillInfo[]): string | null {
  if (!skills.length) return null;
  const lines: string[] = [];
  let used = 0;
  for (const skill of skills) {
    if (lines.length >= MAX_PROMPT_SKILLS) break;
    const desc =
      skill.description.length > DESCRIPTION_CAP
        ? skill.description.slice(0, DESCRIPTION_CAP - 1).trimEnd() + "…"
        : skill.description;
    const line = `- ${skill.name}${desc ? " — " + desc : ""}`;
    if (used + line.length + 1 > PROMPT_SECTION_CAP) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (!lines.length) return null;
  const rest = skills.length - lines.length;
  return (
    'Available skills — reusable workflows saved as markdown. When a task matches one, load it first with skill {"action":"load","name":"<name>"} and follow its instructions:\n' +
    lines.join("\n") +
    (rest > 0 ? `\n…and ${rest} more — list them with skill {"action":"list"}.` : "")
  );
}

/** The full instructions of one skill, for the skill tool's "load" action.
 * `loaded` receives the canonical name when a read succeeds — the session
 * uses it to show which skills are in play. */
export function loadSkill(skills: SkillInfo[], name: string, loaded?: Set<string>): string {
  const wanted = String(name ?? "").trim().toLowerCase();
  if (!wanted) {
    return `Error: name is required. Example: {"action": "load", "name": "${skills[0]?.name ?? "my-skill"}"}`;
  }
  const skill = skills.find((s) => s.name.toLowerCase() === wanted);
  if (!skill) {
    return skills.length
      ? `Error: no skill named "${name}". Available: ${skills.map((s) => s.name).join(", ")}.`
      : "Error: no skills are installed. A skill is a folder with a SKILL.md, in .smolcoder/skills/ or .claude/skills/ of the workspace, or the same paths under the home directory.";
  }
  let text: string;
  try {
    text = fs.readFileSync(path.join(skill.dir, "SKILL.md"), "utf8").trim();
  } catch (err: any) {
    return `Error: could not read the skill "${skill.name}": ${err?.message ?? err}`;
  }
  if (text.length > SKILL_TEXT_CAP) text = text.slice(0, SKILL_TEXT_CAP) + "\n[SKILL.md was truncated here to save context.]";
  loaded?.add(skill.name);
  return `Skill "${skill.name}" (${skill.source}):\n\n${text}`;
}

/** Human-readable inventory, for the skill tool's "list" action. */
export function listSkillsText(skills: SkillInfo[]): string {
  if (!skills.length) {
    return "No skills found. A skill is a folder with a SKILL.md, in .smolcoder/skills/ or .claude/skills/ of the workspace, or the same paths under the home directory.";
  }
  return skills
    .map((s) => `${s.name} (${s.source}) — ${s.description || "no description"}\n  ${path.join(s.dir, "SKILL.md")}`)
    .join("\n");
}

// ---- helpers ---------------------------------------------------------------

/** frontmatter `name` wins when valid; otherwise the folder name, lowercased.
 * Anything that still fails the name rules makes the folder not a skill. */
function pickName(frontName: string | undefined, folder: string): string | null {
  const fromFront = (frontName ?? "").trim().toLowerCase();
  if (NAME_RE.test(fromFront)) return fromFront;
  const fromFolder = folder.trim().toLowerCase();
  if (NAME_RE.test(fromFolder)) return fromFolder;
  return null;
}

/** Minimal frontmatter parser: a leading --- block with `key: value` lines.
 * Handles quoted strings and `|`/`>` blocks; everything else is ignored. */
function parseFrontmatter(text: string): { name?: string; description?: string } {
  const out: { name?: string; description?: string } = {};
  const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!block) return out;
  const lines = block[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key !== "name" && key !== "description") continue;
    let value = m[2].trim();
    if (value === "|" || value === ">") {
      const parts: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) parts.push(lines[++i].trim());
      value = parts.join(value === ">" ? " " : "\n");
    } else {
      value = value.replace(/^(["'])(.*)\1$/, "$2");
    }
    out[key] = value.trim();
  }
  return out;
}

/** Description fallback when the frontmatter has none: the first non-empty
 * line of the body, with any markdown heading marker removed. */
function firstParagraph(text: string): string {
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
  for (const line of body.split(/\r?\n/)) {
    const clean = line.replace(/^#+\s*/, "").trim();
    if (clean) return clean;
  }
  return "";
}
