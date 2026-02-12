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

## Quick Commands

| Command | What it does |
|---------|--------------|
| \`jack ship\` | Deploy to production |
| \`jack logs\` | Stream live logs |
| \`jack services\` | Manage databases, KV, and other bindings |
| \`jack secrets\` | Manage environment secrets |

## Services & Bindings

Jack manages your project's services. To add a database:

\`\`\`bash
jack services db create
\`\`\`

To query it:

\`\`\`bash
jack services db query "SELECT * FROM users"
\`\`\`

${fullText}

## For AI Agents

### MCP Tools

If jack MCP is connected, **always prefer these tools over CLI commands or wrangler**:

| Tool | Use for |
|------|---------|
| \`mcp__jack__create_project\` | Create a new project (supports forking via \`template: "username/slug"\`) |
| \`mcp__jack__deploy_project\` | Deploy changes |
| \`mcp__jack__get_project_status\` | Check deployment status and URL |
| \`mcp__jack__list_projects\` | List all projects |
| \`mcp__jack__create_database\` | Create a database |
| \`mcp__jack__execute_sql\` | Query the database (read-only by default) |
| \`mcp__jack__list_databases\` | List project databases |
| \`mcp__jack__create_storage_bucket\` | Create object storage |
| \`mcp__jack__create_vectorize_index\` | Create vector search index |
| \`mcp__jack__tail_logs\` | Debug with live log samples |
| \`mcp__jack__start_log_session\` | Start real-time log stream |
| \`mcp__jack__create_cron\` | Create scheduled tasks |
| \`mcp__jack__list_domains\` | List custom domains |
| \`mcp__jack__connect_domain\` | Add a custom domain |

### Documentation

Full jack documentation: https://docs.getjack.org/llms-full.txt
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
