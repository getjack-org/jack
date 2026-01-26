/**
 * Agent integration module
 *
 * Ensures AI agents have proper context for jack projects.
 * Called during both project creation and first BYO deploy.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Template } from "../templates/types.ts";
import { installMcpConfigsToAllApps, isAppInstalled } from "./mcp-config.ts";

export interface EnsureAgentResult {
	mcpInstalled: string[];
	jackMdCreated: boolean;
	referencesAdded: string[];
}

export interface EnsureAgentOptions {
	template?: Template;
	silent?: boolean;
	projectName?: string;
}

/**
 * Generate JACK.md content
 * Uses template agentContext if available, otherwise generic jack instructions
 */
export function generateJackMd(projectName?: string, template?: Template): string {
	const header = projectName ? `# ${projectName}\n\n` : "# Jack\n\n";

	const templateSummary = template?.agentContext?.summary;
	const templateFullText = template?.agentContext?.full_text;

	const summarySection = templateSummary ? `> ${templateSummary}\n\n` : "";

	const templateSection = templateFullText ? `${templateFullText}\n\n` : "";

	return `${header}${summarySection}This project is deployed and managed via jack.

## Quick Commands

| Command | What it does |
|---------|--------------|
| \`jack ship\` | Deploy to production |
| \`jack logs\` | Stream live logs |
| \`jack services\` | Manage databases, KV, and other bindings |
| \`jack secrets\` | Manage environment secrets |

## Important

- **Never run \`wrangler\` commands directly** - jack handles all infrastructure
- Use \`jack services db\` to create and query databases
- Secrets sync automatically across deploys

## Services & Bindings

Jack manages your project's services. To add a database:

\`\`\`bash
jack services db create
\`\`\`

To query it:

\`\`\`bash
jack services db query "SELECT * FROM users"
\`\`\`

More bindings (KV, R2, queues) coming soon.

${templateSection}## For AI Agents

### MCP Tools

If jack MCP is connected, prefer these tools over CLI commands:

| Tool | Use for |
|------|---------|
| \`mcp__jack__deploy_project\` | Deploy changes |
| \`mcp__jack__create_database\` | Create a new database |
| \`mcp__jack__execute_sql\` | Query the database |
| \`mcp__jack__list_projects\` | List all projects |
| \`mcp__jack__get_project_status\` | Check deployment status |

### Documentation

Full jack documentation: https://docs.getjack.org/llms-full.txt
`;
}

/**
 * Create JACK.md if it doesn't exist
 */
async function ensureJackMd(
	projectPath: string,
	projectName?: string,
	template?: Template,
): Promise<boolean> {
	const jackMdPath = join(projectPath, "JACK.md");

	if (existsSync(jackMdPath)) {
		return false;
	}

	const content = generateJackMd(projectName, template);
	await Bun.write(jackMdPath, content);
	return true;
}

/**
 * Append JACK.md reference to existing agent files (CLAUDE.md, AGENTS.md)
 */
async function appendJackMdReferences(projectPath: string): Promise<string[]> {
	const filesToCheck = ["CLAUDE.md", "AGENTS.md"];
	const referencesAdded: string[] = [];
	const jackMdPath = join(projectPath, "JACK.md");

	// Only add references if JACK.md exists
	if (!existsSync(jackMdPath)) {
		return referencesAdded;
	}

	const referenceBlock = `<!-- Added by jack -->
> **Jack project** - See [JACK.md](./JACK.md) for deployment, services, and bindings.

`;

	for (const filename of filesToCheck) {
		const filePath = join(projectPath, filename);

		if (!existsSync(filePath)) {
			continue;
		}

		try {
			const content = await Bun.file(filePath).text();

			// Skip if reference already exists
			if (content.includes("JACK.md") || content.includes("<!-- Added by jack -->")) {
				continue;
			}

			// Find position after first heading, or prepend if no heading
			const headingMatch = content.match(/^#[^\n]*\n/m);
			let newContent: string;

			if (headingMatch && headingMatch.index !== undefined) {
				const insertPos = headingMatch.index + headingMatch[0].length;
				newContent = content.slice(0, insertPos) + "\n" + referenceBlock + content.slice(insertPos);
			} else {
				newContent = referenceBlock + content;
			}

			await Bun.write(filePath, newContent);
			referencesAdded.push(filename);
		} catch {
			// Ignore errors reading/writing individual files
		}
	}

	return referencesAdded;
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
 * This function:
 * 1. Creates JACK.md if not exists (with template context if available)
 * 2. Appends JACK.md reference to existing CLAUDE.md/AGENTS.md
 * 3. Installs MCP config to detected AI apps
 *
 * Safe to call multiple times - all operations are idempotent.
 */
export async function ensureAgentIntegration(
	projectPath: string,
	options: EnsureAgentOptions = {},
): Promise<EnsureAgentResult> {
	const { template, projectName } = options;

	// 1. Create JACK.md if not exists
	const jackMdCreated = await ensureJackMd(projectPath, projectName, template);

	// 2. Append references to existing agent files
	const referencesAdded = await appendJackMdReferences(projectPath);

	// 3. Ensure MCP is configured
	const mcpInstalled = await ensureMcpConfigured();

	return {
		mcpInstalled,
		jackMdCreated,
		referencesAdded,
	};
}
