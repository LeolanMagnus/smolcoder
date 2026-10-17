// Skills: discovery across the four roots, frontmatter parsing, the compact
// system-prompt section, on-demand loading and the skill tool.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { discoverSkills, loadSkill, renderSkillsPrompt } = require("../dist/skills");
const { buildToolSpecs, executeTool } = require("../dist/tools/index");
const { buildSystemPrompt } = require("../dist/prompt");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "smol-skills-"));

function fixture() {
  const base = fs.mkdtempSync(path.join(tmp, "case-"));
  const ws = path.join(base, "ws");
  const home = path.join(base, "home");
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  return { ws, home };
}

function writeSkill(root, folder, content) {
  const dir = path.join(root, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), content);
  return dir;
}

test("discovers skills from all four roots; project shadows global", () => {
  const { ws, home } = fixture();
  writeSkill(path.join(ws, ".smolcoder", "skills"), "retro", "---\nname: retro\ndescription: Project retopology workflow.\n---\n\nBody.");
  writeSkill(path.join(ws, ".claude", "skills"), "uv", "# UV unwrap\n\nHow to unwrap a mesh.");
  writeSkill(path.join(home, ".smolcoder", "skills"), "retro", "---\nname: retro\ndescription: Global retopology (shadowed).\n---\n");
  writeSkill(path.join(home, ".claude", "skills"), "paint", '---\nname: paint\ndescription: "Texture painting pass."\n---\n');

  const skills = discoverSkills(ws, home);
  const byName = new Map(skills.map((s) => [s.name, s]));
  assert.deepEqual([...byName.keys()].sort(), ["paint", "retro", "uv"]);
  assert.equal(byName.get("retro").source, "project");
  assert.match(byName.get("retro").description, /Project retopology/);
  assert.equal(byName.get("uv").source, "project-claude");
  assert.equal(byName.get("uv").description, "UV unwrap");
  assert.equal(byName.get("paint").source, "global-claude");
  assert.equal(byName.get("paint").description, "Texture painting pass.");
});

test("frontmatter: folded descriptions, fallback names, invalid folders skipped", () => {
  const { ws, home } = fixture();
  const root = path.join(ws, ".smolcoder", "skills");
  writeSkill(root, "folded", "---\ndescription: >\n  A long description\n  split across lines.\n---\n\nBody");
  writeSkill(root, "Mixed-Case", "---\nname: Bad_Name\n---\n\nfallback body text");
  writeSkill(root, "not a name!", "no frontmatter here");

  const skills = discoverSkills(ws, home);
  const byName = new Map(skills.map((s) => [s.name, s]));
  assert.equal(byName.get("folded").description, "A long description split across lines.");
  assert.ok(byName.has("mixed-case")); // invalid frontmatter name falls back to the folder
  assert.equal(byName.get("mixed-case").description, "fallback body text");
  assert.equal(skills.length, 2); // "not a name!" cannot yield a valid name -> skipped
});

test("renderSkillsPrompt: null when empty, caps description and section size", () => {
  assert.equal(renderSkillsPrompt([]), null);
  const many = Array.from({ length: 30 }, (_, i) => ({
    name: `skill-${i}`,
    description: "x".repeat(300),
    dir: "d",
    source: "project",
  }));
  const section = renderSkillsPrompt(many);
  const firstEntry = section.split("\n")[1];
  const shown = firstEntry.slice(firstEntry.indexOf(" — ") + 3);
  assert.ok(shown.length <= 160); // description elided, not dumped wholesale
  assert.match(shown, /…/);
  assert.ok(section.length <= 3200); // header/footer overhead over the section cap
  assert.match(section, /and \d+ more/);
});

test("loadSkill: case-insensitive, size-capped, coaches unknown names", () => {
  const { ws, home } = fixture();
  writeSkill(path.join(ws, ".smolcoder", "skills"), "big", "---\nname: big\ndescription: Big.\n---\n" + "y".repeat(20000));
  const skills = discoverSkills(ws, home);
  const text = loadSkill(skills, "BIG");
  assert.match(text, /^Skill "big" \(project\):/);
  assert.match(text, /truncated/);
  assert.ok(text.length < 12500);
  assert.match(loadSkill(skills, "nope"), /no skill named "nope".*big/s);
  assert.match(loadSkill([], "nope"), /no skills are installed/);
  assert.match(loadSkill(skills, ""), /name is required/);
});

test("the skill tool is available in every mode and lists/loads skills", async () => {
  const { ws } = fixture();
  writeSkill(path.join(ws, ".smolcoder", "skills"), "retro", "---\nname: retro\ndescription: Retopo pass.\n---\nSTEP-ONE marker");
  for (const mode of ["plan", "build", "auto"]) {
    assert.ok(buildToolSpecs(mode).some((t) => t.name === "skill"), mode);
  }
  const ctx = { workspace: ws, filesTouched: new Set(), commandsRun: [] };
  assert.match(await executeTool("skill", { action: "list" }, ctx), /retro \(project\) — Retopo pass\./);
  assert.match(await executeTool("skill", { action: "load", name: "retro" }, ctx), /STEP-ONE marker/);
  assert.match(await executeTool("skill", {}, ctx), /action must be/);
});

test("buildSystemPrompt appends the skills section", () => {
  const base = buildSystemPrompt({ workspace: "ws", mode: "build", shellLabel: "bash" });
  assert.ok(!base.includes("Available skills"));
  const section = renderSkillsPrompt([{ name: "retro", description: "Retopo.", dir: "d", source: "project" }]);
  const withSkills = buildSystemPrompt({ workspace: "ws", mode: "build", shellLabel: "bash", skills: section });
  assert.match(withSkills, /Available skills/);
  assert.match(withSkills, /- retro — Retopo\./);
});
