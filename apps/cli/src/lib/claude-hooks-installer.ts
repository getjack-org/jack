import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const MCP_CONTEXT_COMMAND = "jack mcp context 2>/dev/null || true";
const POST_DEPLOY_COMMAND = "jack _internal post-deploy 2>/dev/null || true";

/**
 * Install Claude Code hooks to the project's .claude/settings.json:
 *
 * - SessionStart: runs `jack mcp context` (project context for Claude Code)
 * - PostToolUse(deploy_project): runs `jack _internal post-deploy` to upload the session
 *   transcript to the control plane after an MCP-triggered deploy
 *
 * Non-destructive: preserves existing hooks and deduplicates.
 */
export async function installClaudeCodeHooks(projectPath: string): Promise<boolean> {
	try {
		const claudeDir = join(projectPath, ".claude");
		const settingsPath = join(claudeDir, "settings.json");

		// Ensure .claude directory exists
		if (!existsSync(claudeDir)) {
			await mkdir(claudeDir, { recursive: true });
		}

		let settings: Record<string, unknown> = {};
		if (existsSync(settingsPath)) {
			try {
				settings = await Bun.file(settingsPath).json();
			} catch {
				settings = {};
			}
		}

		const hooks = (settings.hooks as Record<string, unknown[]>) ?? {};

		// --- SessionStart hooks ---
		const sessionStart = (hooks.SessionStart as Array<Record<string, unknown>>) ?? [];

		const hasMcpContext = sessionStart.some((entry) => {
			const entryHooks = entry.hooks as Array<Record<string, string>> | undefined;
			return entryHooks?.some((h) => h.command?.includes("jack mcp context"));
		});
		if (!hasMcpContext) {
			sessionStart.push({
				matcher: "",
				hooks: [{ type: "command", command: MCP_CONTEXT_COMMAND }],
			});
		}

		hooks.SessionStart = sessionStart;

		// --- PostToolUse hooks ---
		const postToolUse = (hooks.PostToolUse as Array<Record<string, unknown>>) ?? [];

		const hasPostDeploy = postToolUse.some((entry) => {
			const entryHooks = entry.hooks as Array<Record<string, string>> | undefined;
			return entryHooks?.some((h) => h.command?.includes("jack _internal post-deploy"));
		});
		if (!hasPostDeploy) {
			postToolUse.push({
				matcher: "deploy_project",
				hooks: [{ type: "command", command: POST_DEPLOY_COMMAND }],
			});
		}

		hooks.PostToolUse = postToolUse;
		settings.hooks = hooks;

		await Bun.write(settingsPath, JSON.stringify(settings, null, 2));
		return true;
	} catch {
		return false;
	}
}
