/**
 * jack skills - Manage agent skills for project-specific knowledge
 *
 * Skills are capability chips that teach AI agents Jack Cloud-specific patterns.
 * Uses skills.sh (npx skills add) for installation.
 */

import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type AgentLaunchConfig,
  getPreferredLaunchAgent,
  launchAgent,
} from "../lib/agents.ts";
import { error, info, success, item } from "../lib/output.ts";

const SKILLS_REPO = "getjack-org/skills";
const SUPPORTED_AGENTS = ["claude-code", "codex"];

// Hardcoded catalog - could fetch from repo index.json later
const AVAILABLE_SKILLS = [
  { name: "add-payments", description: "Add Stripe subscription payments" },
  { name: "add-auth", description: "Add Better Auth authentication" },
  { name: "add-ai", description: "Add Workers AI integration" },
];

export default async function skills(
  subcommand?: string,
  args: string[] = [],
): Promise<void> {
  if (!subcommand) {
    return showHelp();
  }

  switch (subcommand) {
    case "run":
      return await runSkill(args[0]);
    case "list":
    case "ls":
      return await listSkills();
    case "remove":
    case "rm":
      return await removeSkill(args[0]);
    default:
      error(`Unknown subcommand: ${subcommand}`);
      info("Available: run, list, remove");
      process.exit(1);
  }
}

function showHelp(): void {
  console.log("");
  info("jack skills - Manage agent skills");
  console.log("");
  console.log("Commands:");
  console.log("  run <name>          Install (if needed) and launch agent with skill");
  console.log("  list                List installed skills in current project");
  console.log("  remove <name>       Remove a skill from project");
  console.log("");
  console.log("Available skills:");
  for (const skill of AVAILABLE_SKILLS) {
    console.log(`  ${skill.name.padEnd(16)} ${skill.description}`);
  }
  console.log("");
}

async function runSkill(skillName?: string): Promise<void> {
  if (!skillName) {
    error("Missing skill name");
    info("Usage: jack skills run <name>");
    console.log("");
    console.log("Available skills:");
    for (const skill of AVAILABLE_SKILLS) {
      console.log(`  ${skill.name.padEnd(16)} ${skill.description}`);
    }
    process.exit(1);
  }

  const projectDir = process.cwd();

  // 1. Validate skill exists in catalog
  const skill = AVAILABLE_SKILLS.find((s) => s.name === skillName);
  if (!skill) {
    error(`Skill not found: ${skillName}`);
    console.log("");
    console.log("Available skills:");
    for (const s of AVAILABLE_SKILLS) {
      console.log(`  ${s.name.padEnd(16)} ${s.description}`);
    }
    process.exit(1);
  }

  // 2. Check if already installed
  const skillPath = join(projectDir, ".claude/skills", skillName);
  if (!existsSync(skillPath)) {
    info(`Installing ${skillName}...`);

    const agentFlags = SUPPORTED_AGENTS.flatMap((a) => ["--agent", a]);
    const proc = Bun.spawn(
      [
        "npx",
        "skills",
        "add",
        SKILLS_REPO,
        "--skill",
        skillName,
        ...agentFlags,
        "--yes",
      ],
      {
        cwd: projectDir,
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    // Collect output for error reporting
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    await proc.exited;

    if (proc.exitCode !== 0) {
      error(`Failed to install skill: ${skillName}`);
      // Show stderr on failure for debugging
      if (stderr.trim()) {
        console.error(stderr);
      }
      process.exit(1);
    }

    success(`Installed ${skillName}`);
  } else {
    info(`Skill ${skillName} already installed`);
  }

  // 3. Get preferred agent
  const preferred = await getPreferredLaunchAgent();
  if (!preferred) {
    error("No agent configured");
    info("Run: jack init");
    process.exit(1);
  }

  // 4. Launch agent with skill command
  const agentName = preferred.definition.name;
  console.log("");
  info(`Launching ${agentName} with /${skillName}...`);

  const launchWithSkill: AgentLaunchConfig = {
    ...preferred.launch,
    args: [...(preferred.launch.args || []), `/${skillName}`],
  };

  const result = await launchAgent(launchWithSkill, projectDir);

  if (!result.success) {
    error(`Failed to launch ${agentName}`);
    if (result.error) {
      info(result.error);
    }
    process.exit(1);
  }
}

async function listSkills(): Promise<void> {
  const projectDir = process.cwd();
  const skillsDir = join(projectDir, ".claude/skills");

  if (!existsSync(skillsDir)) {
    info("No skills installed in this project.");
    console.log("");
    info("Run 'jack skills run <name>' to install and use a skill.");
    console.log("");
    console.log("Available skills:");
    for (const skill of AVAILABLE_SKILLS) {
      console.log(`  ${skill.name.padEnd(16)} ${skill.description}`);
    }
    return;
  }

  // List directories in .claude/skills/
  const entries = await readdir(skillsDir, { withFileTypes: true });
  const skills = entries.filter((e) => e.isSymbolicLink() || e.isDirectory());

  if (skills.length === 0) {
    info("No skills installed in this project.");
    console.log("");
    info("Run 'jack skills run <name>' to install and use a skill.");
    return;
  }

  console.log("");
  info("Installed skills (project):");
  for (const skill of skills) {
    const desc =
      AVAILABLE_SKILLS.find((s) => s.name === skill.name)?.description ?? "";
    item(`${skill.name.padEnd(16)} ${desc}`);
  }
  console.log("");
  info("Run 'jack skills run <name>' to use a skill.");
}

async function removeSkill(skillName?: string): Promise<void> {
  if (!skillName) {
    error("Missing skill name");
    info("Usage: jack skills remove <name>");
    process.exit(1);
  }

  const projectDir = process.cwd();

  // Remove from all agent directories
  const dirs = [".agents/skills", ".claude/skills", ".codex/skills", ".cursor/skills"];
  let removed = false;

  for (const dir of dirs) {
    const path = join(projectDir, dir, skillName);
    if (existsSync(path)) {
      await rm(path, { recursive: true, force: true });
      removed = true;
    }
  }

  if (removed) {
    success(`Removed ${skillName}`);
  } else {
    info(`Skill ${skillName} not found in project`);
  }
}
