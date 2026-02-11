import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const HOOK_COMMAND = "jack mcp context 2>/dev/null || true";

/**
 * Install a Claude Code SessionStart hook to the project's .claude/settings.json.
 * Only fires when Claude Code is opened in this project directory.
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
		const sessionStart = (hooks.SessionStart as Array<Record<string, unknown>>) ?? [];

		// Check if jack hook is already installed
		for (const entry of sessionStart) {
			const entryHooks = entry.hooks as Array<Record<string, string>> | undefined;
			if (entryHooks?.some((h) => h.command?.includes("jack mcp context"))) {
				return true;
			}
		}

		sessionStart.push({
			matcher: "",
			hooks: [{ type: "command", command: HOOK_COMMAND }],
		});

		hooks.SessionStart = sessionStart;
		settings.hooks = hooks;

		await Bun.write(settingsPath, JSON.stringify(settings, null, 2));
		return true;
	} catch {
		return false;
	}
}
