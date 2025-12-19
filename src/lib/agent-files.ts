import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Template } from "../templates/types.ts";
import type { AgentConfig, AgentDefinition } from "./agents.ts";

/**
 * Template for AGENTS.md
 */
function generateAgentsMd(projectName: string, template: Template): string {
	const summary = template.agentContext?.summary || "A Cloudflare Workers project";
	const fullText = template.agentContext?.full_text || "";

	return `# ${projectName}

> ${summary}

## Deployment

This project is deployed to Cloudflare Workers using jack:

\`\`\`bash
jack ship    # Deploy to Cloudflare Workers
jack logs    # Stream production logs
jack dev     # Start local development server
\`\`\`

All deployment is handled by jack. Never run \`wrangler\` commands directly.

${fullText}
`;
}

/**
 * Template for CLAUDE.md
 */
function generateClaudeMd(): string {
	return `# Claude Code Instructions

See [AGENTS.md](./AGENTS.md) for complete project context and deployment instructions.

## Quick Commands

- **Deploy**: \`jack ship\` - Deploy to Cloudflare Workers
- **Logs**: \`jack logs\` - Stream production logs
- **Dev**: \`jack dev\` - Start local development server

## Important

Never run \`wrangler\` commands directly. All deployment is handled by jack.
`;
}

/**
 * Template for .cursorrules
 */
function generateCursorrules(): string {
	return `# Cursor Rules

See AGENTS.md for project context and deployment instructions.

## Deployment Commands

- Deploy: \`jack ship\`
- Logs: \`jack logs\`
- Dev server: \`jack dev\`

Do not suggest \`wrangler\` commands - all deployment is handled by jack.
`;
}

/**
 * Template for .windsurfrules
 */
function generateWindsurfrules(): string {
	return `# Windsurf Rules

See AGENTS.md for project context and deployment instructions.

## Deployment

This project uses jack for deployment:
- \`jack ship\` - Deploy to production
- \`jack logs\` - View logs
- \`jack dev\` - Local development

Never suggest wrangler commands directly.
`;
}

/**
 * Generate content for a specific template type
 */
function generateFileContent(
	templateType: string,
	projectName: string,
	template: Template,
): string {
	switch (templateType) {
		case "agents-md":
			return generateAgentsMd(projectName, template);
		case "claude-md":
			return generateClaudeMd();
		case "cursorrules":
			return generateCursorrules();
		case "windsurfrules":
			return generateWindsurfrules();
		default:
			throw new Error(`Unknown template type: ${templateType}`);
	}
}

/**
 * Generate agent context files for active agents
 */
export async function generateAgentFiles(
	projectDir: string,
	projectName: string,
	template: Template,
	agents: Array<{ id: string; config: AgentConfig; definition: AgentDefinition }>,
): Promise<void> {
	const writtenSharedFiles = new Set<string>();

	for (const { definition } of agents) {
		for (const file of definition.projectFiles) {
			// Skip shared files if already written
			if (file.shared && writtenSharedFiles.has(file.path)) {
				continue;
			}

			const filePath = join(projectDir, file.path);

			// Skip if file already exists (don't overwrite user modifications)
			if (existsSync(filePath)) {
				continue;
			}

			const content = generateFileContent(file.template, projectName, template);
			await Bun.write(filePath, content);

			if (file.shared) {
				writtenSharedFiles.add(file.path);
			}
		}
	}
}
