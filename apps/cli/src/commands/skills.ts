/**
 * jack skills - Manage agent skills for project-specific knowledge
 *
 * Skills are capability chips that teach AI agents Jack Cloud-specific patterns.
 * Uses skills.sh (npx skills add) for installation.
 */

import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { type AgentLaunchConfig, getPreferredLaunchAgent, launchAgent } from "../lib/agents.ts";
import { error, info, item, success } from "../lib/output.ts";

const SKILLS_REPO = "getjack-org/skills";
const SKILLS_API_URL = `https://api.github.com/repos/${SKILLS_REPO}/contents/skills`;
const SUPPORTED_AGENTS = ["claude-code", "codex"];

// Cache for fetched skills (per process)
let cachedSkills: { name: string; description: string }[] | null = null;
let fetchError: string | null = null;

const FETCH_TIMEOUT_MS = 5000;

interface GitHubContent {
	name: string;
	type: string;
	download_url: string | null;
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, {
			headers: { "User-Agent": "jack-cli" },
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timeout);
	}
}

async function fetchAvailableSkills(): Promise<{ name: string; description: string }[]> {
	if (cachedSkills) return cachedSkills;
	if (fetchError) return []; // Don't retry on same process

	try {
		const res = await fetchWithTimeout(SKILLS_API_URL, FETCH_TIMEOUT_MS);

		if (res.status === 403) {
			fetchError = "GitHub API rate limit exceeded. Try again later.";
			return [];
		}

		if (!res.ok) {
			fetchError = `GitHub API error: ${res.status}`;
			return [];
		}

		const contents: GitHubContent[] = await res.json();
		const skillDirs = contents.filter((c) => c.type === "dir");

		// Fetch descriptions from SKILL.md in parallel (with timeout each)
		const skills = await Promise.all(
			skillDirs.map(async (dir) => {
				const description = await fetchSkillDescription(dir.name);
				return { name: dir.name, description };
			}),
		);

		cachedSkills = skills;
		return skills;
	} catch (err) {
		if (err instanceof Error && err.name === "AbortError") {
			fetchError = "Request timed out. Check your internet connection.";
		} else {
			fetchError = "Could not fetch skills catalog.";
		}
		return [];
	}
}

function getFetchError(): string | null {
	return fetchError;
}

async function fetchSkillDescription(skillName: string): Promise<string> {
	try {
		const url = `https://raw.githubusercontent.com/${SKILLS_REPO}/main/skills/${skillName}/SKILL.md`;
		const res = await fetch(url, {
			headers: { "User-Agent": "jack-cli" },
		});

		if (!res.ok) return "";

		const content = await res.text();
		// Parse YAML frontmatter for description
		const match = content.match(/^---\n([\s\S]*?)\n---/);
		if (match) {
			const frontmatter = match[1];
			const descMatch = frontmatter.match(/description:\s*>?\s*\n?\s*(.+?)(?:\n\s{2,}|$)/s);
			if (descMatch) {
				// Get first line of description
				return descMatch[1].split("\n")[0].trim();
			}
		}
		return "";
	} catch {
		return "";
	}
}

export default async function skills(subcommand?: string, args: string[] = []): Promise<void> {
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
		case "upgrade":
		case "update":
			return await upgradeSkill(args[0]);
		default:
			error(`Unknown subcommand: ${subcommand}`);
			info("Available: run, list, remove, upgrade");
			process.exit(1);
	}
}

async function showHelp(): Promise<void> {
	console.log("");
	info("jack skills - Manage agent skills");
	console.log("");
	console.log("Commands:");
	console.log("  run <name>          Install (if needed) and launch agent with skill");
	console.log("  list                List installed skills in current project");
	console.log("  remove <name>       Remove a skill from project");
	console.log("  upgrade <name>      Re-install skill to get latest version");
	console.log("");
	const skills = await fetchAvailableSkills();
	if (skills.length > 0) {
		console.log("Available skills:");
		for (const skill of skills) {
			console.log(`  ${skill.name.padEnd(16)} ${skill.description}`);
		}
		console.log("");
	} else {
		const err = getFetchError();
		if (err) {
			info(`Could not load skills catalog: ${err}`);
			info("You can still run: jack skills run <skill-name>");
			console.log("");
		}
	}
}

async function runSkill(skillName?: string): Promise<void> {
	const availableSkills = await fetchAvailableSkills();

	if (!skillName) {
		error("Missing skill name");
		info("Usage: jack skills run <name>");
		if (availableSkills.length > 0) {
			console.log("");
			console.log("Available skills:");
			for (const skill of availableSkills) {
				console.log(`  ${skill.name.padEnd(16)} ${skill.description}`);
			}
		} else {
			const err = getFetchError();
			if (err) {
				console.log("");
				info(`Could not load skills catalog: ${err}`);
			}
		}
		process.exit(1);
	}

	const projectDir = process.cwd();

	// 1. Validate skill exists in catalog (if we could fetch it)
	if (availableSkills.length > 0) {
		const skill = availableSkills.find((s) => s.name === skillName);
		if (!skill) {
			error(`Skill not found: ${skillName}`);
			console.log("");
			console.log("Available skills:");
			for (const s of availableSkills) {
				console.log(`  ${s.name.padEnd(16)} ${s.description}`);
			}
			process.exit(1);
		}
	}
	// If fetch failed, let skills.sh handle validation

	// 2. Check if already installed
	const skillPath = join(projectDir, ".claude/skills", skillName);
	if (!existsSync(skillPath)) {
		info(`Installing ${skillName}...`);

		const agentFlags = SUPPORTED_AGENTS.flatMap((a) => ["--agent", a]);
		const proc = Bun.spawn(
			["npx", "skills", "add", SKILLS_REPO, "--skill", skillName, ...agentFlags, "--yes"],
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
	const availableSkills = await fetchAvailableSkills();

	if (!existsSync(skillsDir)) {
		info("No skills installed in this project.");
		console.log("");
		info("Run 'jack skills run <name>' to install and use a skill.");
		if (availableSkills.length > 0) {
			console.log("");
			console.log("Available skills:");
			for (const skill of availableSkills) {
				console.log(`  ${skill.name.padEnd(16)} ${skill.description}`);
			}
		} else {
			const err = getFetchError();
			if (err) {
				console.log("");
				info(`Could not load skills catalog: ${err}`);
			}
		}
		return;
	}

	// List directories in .claude/skills/
	const entries = await readdir(skillsDir, { withFileTypes: true });
	const installedSkills = entries.filter((e) => e.isSymbolicLink() || e.isDirectory());

	if (installedSkills.length === 0) {
		info("No skills installed in this project.");
		console.log("");
		info("Run 'jack skills run <name>' to install and use a skill.");
		return;
	}

	console.log("");
	info("Installed skills (project):");
	for (const skill of installedSkills) {
		const desc = availableSkills.find((s) => s.name === skill.name)?.description ?? "";
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

async function upgradeSkill(skillName?: string): Promise<void> {
	if (!skillName) {
		error("Missing skill name");
		info("Usage: jack skills upgrade <name>");
		process.exit(1);
	}

	const projectDir = process.cwd();
	const skillPath = join(projectDir, ".claude/skills", skillName);

	// Check if installed
	if (!existsSync(skillPath)) {
		error(`Skill ${skillName} not installed`);
		info(`Install it first: jack skills run ${skillName}`);
		process.exit(1);
	}

	// Remove existing installation
	info(`Removing old version of ${skillName}...`);
	const dirs = [".agents/skills", ".claude/skills", ".codex/skills", ".cursor/skills"];
	for (const dir of dirs) {
		const path = join(projectDir, dir, skillName);
		if (existsSync(path)) {
			await rm(path, { recursive: true, force: true });
		}
	}

	// Re-install from GitHub
	info(`Installing latest ${skillName}...`);
	const agentFlags = SUPPORTED_AGENTS.flatMap((a) => ["--agent", a]);
	const proc = Bun.spawn(
		["npx", "skills", "add", SKILLS_REPO, "--skill", skillName, ...agentFlags, "--yes"],
		{
			cwd: projectDir,
			stdout: "pipe",
			stderr: "pipe",
		},
	);

	const stderr = await new Response(proc.stderr).text();
	await proc.exited;

	if (proc.exitCode !== 0) {
		error(`Failed to upgrade skill: ${skillName}`);
		if (stderr.trim()) {
			console.error(stderr);
		}
		process.exit(1);
	}

	success(`Upgraded ${skillName} to latest version`);
}
