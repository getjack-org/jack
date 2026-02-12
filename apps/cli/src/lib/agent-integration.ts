/**
 * Agent integration module
 *
 * Ensures AI agents have MCP configured for jack projects.
 * Called during both project creation and first BYO deploy.
 */

import { installMcpConfigsToAllApps, isAppInstalled } from "./mcp-config.ts";

export interface EnsureAgentResult {
	mcpInstalled: string[];
}

export interface EnsureAgentOptions {
	silent?: boolean;
}

/**
 * Ensure MCP is configured for detected AI apps
 * Returns list of apps that were configured
 */
async function ensureMcpConfigured(): Promise<string[]> {
	// Only attempt if at least one supported app is installed
	const hasClaudeCode = isAppInstalled("claude-code");
	const hasClaudeDesktop = isAppInstalled("claude-desktop");

	if (!hasClaudeCode && !hasClaudeDesktop) {
		return [];
	}

	try {
		return await installMcpConfigsToAllApps();
	} catch {
		// Don't fail if MCP install fails
		return [];
	}
}

/**
 * Ensure agent integration is set up for a project
 *
 * Installs MCP config to detected AI apps.
 * Safe to call multiple times - all operations are idempotent.
 */
export async function ensureAgentIntegration(
	_projectPath: string,
	_options: EnsureAgentOptions = {},
): Promise<EnsureAgentResult> {
	const mcpInstalled = await ensureMcpConfigured();

	return {
		mcpInstalled,
	};
}
