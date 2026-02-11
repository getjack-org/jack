import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Template } from "../templates/types.ts";
import type { AgentConfig, AgentDefinition } from "./agents.ts";

/**
 * Template for AGENTS.md
 */
function generateAgentsMd(projectName: string, template: Template): string {
	const summary = template.agentContext?.summary || "A jack project";
	const fullText = template.agentContext?.full_text || "";

	return `# ${projectName}

> ${summary}

## Deployment

This project is deployed and managed via jack:

\`\`\`bash
jack ship    # Deploy to production
jack logs    # Stream production logs
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

- **Deploy**: \`jack ship\` - Deploy to production
- **Logs**: \`jack logs\` - Stream production logs

## Important

Never run \`wrangler\` commands directly. All deployment is handled by jack.
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

/**
 * Regenerate agent context files, overwriting existing files
 * Used by `jack agents refresh` to update files from template
 */
export async function regenerateAgentFiles(
	projectDir: string,
	projectName: string,
	template: Template,
	agents: Array<{ id: string; config: AgentConfig; definition: AgentDefinition }>,
): Promise<string[]> {
	const writtenSharedFiles = new Set<string>();
	const updatedFiles: string[] = [];

	for (const { definition } of agents) {
		for (const file of definition.projectFiles) {
			// Skip shared files if already written
			if (file.shared && writtenSharedFiles.has(file.path)) {
				continue;
			}

			const filePath = join(projectDir, file.path);
			const content = generateFileContent(file.template, projectName, template);
			await Bun.write(filePath, content);
			updatedFiles.push(file.path);

			if (file.shared) {
				writtenSharedFiles.add(file.path);
			}
		}
	}

	return updatedFiles;
}
