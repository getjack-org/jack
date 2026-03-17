import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installClaudeCodeHooks } from "../src/lib/claude-hooks-installer.ts";

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "claude-hooks-installer-test-"));
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

describe("installClaudeCodeHooks", () => {
	test("installs session start + both deploy matcher hooks", async () => {
		const ok = await installClaudeCodeHooks(tempDir);
		expect(ok).toBe(true);

		const settingsPath = join(tempDir, ".claude", "settings.json");
		const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
		const hooks = (settings.hooks as Record<string, unknown>) ?? {};
		const sessionStart = (hooks.SessionStart as Array<Record<string, unknown>>) ?? [];
		const postToolUse = (hooks.PostToolUse as Array<Record<string, unknown>>) ?? [];

		const sessionCommands = sessionStart.flatMap((entry) => {
			const entryHooks = (entry.hooks as Array<Record<string, unknown>>) ?? [];
			return entryHooks
				.map((hook) => (typeof hook.command === "string" ? hook.command : ""))
				.filter(Boolean);
		});
		expect(sessionCommands.some((cmd) => cmd.includes("jack mcp context"))).toBe(true);

		const postDeployEntries = postToolUse.filter((entry) => {
			const entryHooks = (entry.hooks as Array<Record<string, unknown>>) ?? [];
			return entryHooks.some((hook) =>
				typeof hook.command === "string" && hook.command.includes("jack _internal post-deploy"),
			);
		});
		const matchers = postDeployEntries.map((entry) => String(entry.matcher ?? ""));
		expect(matchers).toContain("deploy_project");
		expect(matchers).toContain("mcp__jack__deploy_project");
	});

	test("does not duplicate existing post-deploy matchers", async () => {
		await installClaudeCodeHooks(tempDir);
		await installClaudeCodeHooks(tempDir);

		const settingsPath = join(tempDir, ".claude", "settings.json");
		const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
		const hooks = (settings.hooks as Record<string, unknown>) ?? {};
		const postToolUse = (hooks.PostToolUse as Array<Record<string, unknown>>) ?? [];

		const deployMatcherCount = postToolUse.filter(
			(entry) => entry.matcher === "deploy_project",
		).length;
		const mcpMatcherCount = postToolUse.filter(
			(entry) => entry.matcher === "mcp__jack__deploy_project",
		).length;

		expect(deployMatcherCount).toBe(1);
		expect(mcpMatcherCount).toBe(1);
	});
});
