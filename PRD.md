# Agent Context Setup PRD

## Overview

### Problem Statement
AI coding agents (Claude Code, Cursor, Windsurf, etc.) are becoming essential developer tools, but they need project-specific context to be effective. Currently, when a developer creates a new project with `jack new`, the AI agent doesn't know:
- How to deploy the project (jack-specific commands)
- What the template does and how it's structured
- Project-specific conventions and patterns

This forces developers to manually explain jack's deployment workflow every time they start working with an agent on a new project.

### Objective
Automatically configure AI coding agent context during project creation, enabling agents to understand and deploy jack projects without manual explanation. This feature should:
- **Be invisible**: Happen automatically during `jack init` and `jack new`
- **Be universal**: Work with any AI coding agent that supports context files
- **Be template-aware**: Include template-specific context from `.jack.json`
- **Be maintainable**: Use a shared AGENTS.md file to avoid duplication
- **Be respectful**: Only generate files for agents the user has installed

### Success Metrics
- 100% of new projects include AGENTS.md with deployment instructions
- Agent-specific files (CLAUDE.md, etc.) generated only for detected/enabled agents
- Zero manual configuration required by users
- Agents can successfully run `jack ship` without being prompted for deployment instructions

## Scope

### In Scope
1. Agent detection during `jack init`
2. Config storage in `~/.config/jack/config.json`
3. Generation of AGENTS.md during `jack new`
4. Generation of agent-specific files (e.g., CLAUDE.md) during `jack new`
5. Template-specific context via `.jack.json` `agentContext` field
6. CLI commands: `jack agents` (list), `jack agents scan`, `jack agents add/remove/enable/disable`
7. Path validation before generating files
8. Cross-platform path detection (macOS, Linux, Windows)

### Out of Scope
1. Editing existing agent context files (user responsibility)
2. Syncing changes to AGENTS.md across existing projects
3. Agent-specific context beyond deployment/structure (e.g., API docs, dependencies)
4. Custom agent registry beyond the built-in list
5. Cloud-based agent detection or registration
6. Agent version management
7. Automatic updates when jack commands change
8. Integration with agent-specific features (e.g., Cursor's tab completion)

### Dependencies
- Existing `jack init` command for config setup
- Existing `jack new` command for project creation
- Template system with `.jack.json` support
- Config directory at `~/.config/jack/config.json`

## User Stories

### Story 1: First-Time User with Claude Code
**As a** developer using Claude Code for the first time with jack
**I want** jack to automatically configure Claude Code with project context
**So that** Claude can deploy my projects without me explaining how jack works

**Acceptance Criteria:**
- Running `jack init` detects Claude Code installation at `~/.claude`
- Running `jack new my-app` generates both AGENTS.md and CLAUDE.md
- Claude Code can read CLAUDE.md and understand `jack ship` deploys the project
- No manual configuration steps required

### Story 2: Multi-Agent User
**As a** developer who uses both Cursor and Claude Code
**I want** jack to configure both agents automatically
**So that** I can switch between agents without reconfiguring

**Acceptance Criteria:**
- `jack init` detects both Cursor and Claude Code
- `jack new my-app` generates AGENTS.md, CLAUDE.md, and cursor-specific files
- Both agents can independently understand the project structure
- Disabling one agent via `jack agents disable cursor` stops generating its files

### Story 3: Manual Agent Addition
**As a** developer using a custom Windsurf installation
**I want** to manually add Windsurf with a custom path
**So that** jack generates Windsurf context files even though auto-detection failed

**Acceptance Criteria:**
- Running `jack agents add windsurf --path /custom/path/Windsurf.app` adds Windsurf
- Future `jack new` commands generate Windsurf-specific files
- `jack agents` shows Windsurf in the list with the custom path

### Story 4: Template-Specific Context
**As a** template author
**I want** to include agent context in my template's `.jack.json`
**So that** projects using my template automatically include template-specific guidance

**Acceptance Criteria:**
- Template's `.jack.json` includes `agentContext.summary` and `agentContext.full_text`
- Generated AGENTS.md includes the template's context
- Context describes project structure, conventions, and resources
- Multiple templates can have different agent contexts

### Story 5: Agent Rescanning
**As a** developer who just installed Cursor
**I want** to rescan for agents without re-running `jack init`
**So that** future projects include Cursor context

**Acceptance Criteria:**
- Running `jack agents scan` detects the new Cursor installation
- User is prompted to enable newly detected agents
- Next `jack new` command generates Cursor context files
- Already-enabled agents remain unchanged

## Technical Requirements

### Data Models

#### Config Structure (`~/.config/jack/config.json`)
```json
{
  "version": 1,
  "initialized": true,
  "initializedAt": "2025-01-15T10:30:00Z",
  "agents": {
    "claude-code": {
      "active": true,
      "path": "~/.claude",
      "detectedAt": "2025-01-15T10:30:00Z"
    },
    "cursor": {
      "active": true,
      "path": "/Applications/Cursor.app",
      "detectedAt": "2025-01-15T10:30:00Z"
    },
    "windsurf": {
      "active": false,
      "path": "/Applications/Windsurf.app",
      "detectedAt": "2025-01-15T10:30:00Z"
    }
  }
}
```

**Field Definitions:**
- `agents`: Object mapping agent IDs to their configuration
- `agents[id].active`: Boolean indicating if files should be generated for this agent
- `agents[id].path`: String path where the agent was found/specified
- `agents[id].detectedAt`: ISO 8601 timestamp of when agent was first detected
- Agent not in object → never detected/added

#### Agent Registry (in code at `src/lib/agents.ts`)
```typescript
interface AgentDefinition {
  id: string;                    // "claude-code", "cursor", "windsurf"
  name: string;                  // "Claude Code", "Cursor", "Windsurf"
  searchPaths: string[];         // Possible installation locations
  projectFiles: ProjectFile[];   // Files to generate in projects
}

interface ProjectFile {
  path: string;           // Relative path in project (e.g., "CLAUDE.md")
  template: string;       // Template ID to use
  shared?: boolean;       // If true, file is shared across agents (e.g., AGENTS.md)
}
```

**Built-in Agent Definitions:**
```typescript
const AGENT_REGISTRY: AgentDefinition[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    searchPaths: [
      "~/.claude",
      "~/.config/claude",
      "%APPDATA%/Claude",  // Windows
    ],
    projectFiles: [
      { path: "CLAUDE.md", template: "claude-md" },
      { path: "AGENTS.md", template: "agents-md", shared: true },
    ],
  },
  {
    id: "cursor",
    name: "Cursor",
    searchPaths: [
      "/Applications/Cursor.app",
      "~/.cursor",
      "%PROGRAMFILES%/Cursor",  // Windows
      "/usr/share/cursor",      // Linux
    ],
    projectFiles: [
      { path: ".cursorrules", template: "cursorrules" },
      { path: "AGENTS.md", template: "agents-md", shared: true },
    ],
  },
  {
    id: "windsurf",
    name: "Windsurf",
    searchPaths: [
      "/Applications/Windsurf.app",
      "~/.windsurf",
      "%PROGRAMFILES%/Windsurf",  // Windows
    ],
    projectFiles: [
      { path: ".windsurfrules", template: "windsurfrules" },
      { path: "AGENTS.md", template: "agents-md", shared: true },
    ],
  },
];
```

#### Template agentContext (in `.jack.json`)
```json
{
  "name": "miniapp",
  "description": "Farcaster Miniapp (React + Vite)",
  "agentContext": {
    "summary": "A Farcaster miniapp using React + Vite frontend, Hono API on Cloudflare Workers, with D1 SQLite database.",
    "full_text": "## Project Structure\n\n- `src/App.tsx` - React application entry point\n- `src/worker.ts` - Hono API routes for backend\n- `src/components/` - React components\n- `schema.sql` - D1 database schema\n\n## Conventions\n\n- API routes are defined with Hono in `src/worker.ts`\n- Frontend uses Vite for bundling\n- Database migrations are applied automatically during deployment\n- Secrets are managed via `jack secrets add KEY`\n\n## Resources\n\n- [Farcaster Miniapp Docs](https://docs.farcaster.xyz/miniapps)\n- [Hono Documentation](https://hono.dev)"
  }
}
```

### Generated File Templates

#### AGENTS.md Template
```markdown
# {{projectName}}

> {{agentContext.summary}}

## Deployment

This project is deployed to Cloudflare Workers using jack:

```bash
jack ship    # Deploy to Cloudflare Workers
jack logs    # Stream production logs
jack dev     # Start local development server
```

All deployment is handled by jack. Never run `wrangler` commands directly.

{{agentContext.full_text}}
```

**Template Variables:**
- `{{projectName}}`: The project directory name
- `{{agentContext.summary}}`: One-line description from `.jack.json`
- `{{agentContext.full_text}}`: Full markdown context from `.jack.json`

#### CLAUDE.md Template
```markdown
# Claude Code Instructions

See [AGENTS.md](./AGENTS.md) for complete project context and deployment instructions.

## Quick Commands

- **Deploy**: `jack ship` - Deploy to Cloudflare Workers
- **Logs**: `jack logs` - Stream production logs
- **Dev**: `jack dev` - Start local development server

## Important

Never run `wrangler` commands directly. All deployment is handled by jack.
```

#### .cursorrules Template
```
# Cursor Rules

See AGENTS.md for project context and deployment instructions.

## Deployment Commands

- Deploy: `jack ship`
- Logs: `jack logs`
- Dev server: `jack dev`

Do not suggest `wrangler` commands - all deployment is handled by jack.
```

#### .windsurfrules Template
```
# Windsurf Rules

See AGENTS.md for project context and deployment instructions.

## Deployment

This project uses jack for deployment:
- `jack ship` - Deploy to production
- `jack logs` - View logs
- `jack dev` - Local development

Never suggest wrangler commands directly.
```

### Architecture

#### New Module: `src/lib/agents.ts`
```typescript
// Core agent detection and management
export function scanAgents(): Promise<DetectionResult>
export function getActiveAgents(): Promise<AgentConfig[]>
export function addAgent(id: string, path?: string): Promise<void>
export function removeAgent(id: string): Promise<void>
export function enableAgent(id: string): Promise<void>
export function disableAgent(id: string): Promise<void>
export function validateAgentPaths(): Promise<ValidationResult>
```

#### New Module: `src/lib/agent-files.ts`
```typescript
// Template rendering for agent context files
export function generateAgentFiles(
  projectDir: string,
  projectName: string,
  template: Template,
  agents: AgentConfig[]
): Promise<void>
```

#### Modified Module: `src/commands/init.ts`
Add agent detection step after Cloudflare authentication:
```typescript
// After authentication succeeds
output.start("Detecting AI coding agents...");
const detectionResult = await scanAgents();
// Save detected agents to config
// Display what was found
```

#### Modified Module: `src/commands/new.ts`
Add agent file generation after template rendering:
```typescript
// After writing template files
const activeAgents = await getActiveAgents();
if (activeAgents.length > 0) {
  await generateAgentFiles(targetDir, projectName, template, activeAgents);
}
```

#### New Command: `src/commands/agents.ts`
```typescript
export default async function agents(
  subcommand?: string,
  args?: string[]
): Promise<void>
```

Subcommands:
- (none): List all agents with status
- `scan`: Re-detect agents, prompt to enable new ones
- `add <id> [--path <path>]`: Manually add agent
- `remove <id>`: Remove agent from config
- `enable <id>`: Set agent active
- `disable <id>`: Set agent inactive

### Security Considerations
1. **Path traversal**: Validate all paths before writing files
2. **Config injection**: Sanitize agent IDs (alphanumeric + hyphen only)
3. **File overwrite**: Never overwrite existing AGENTS.md/CLAUDE.md without confirmation
4. **Path disclosure**: Don't expose sensitive paths in error messages

### Performance Targets
- Agent detection during `jack init`: < 500ms
- Agent file generation during `jack new`: < 100ms (already writing files)
- `jack agents scan`: < 500ms
- Total impact on `jack new`: < 200ms additional time

### Error Handling

#### Scenario: Agent path no longer exists
```
! Claude Code was configured at ~/.claude but the path no longer exists
→ Run: jack agents scan
```

#### Scenario: Invalid agent ID
```
✗ Unknown agent: invalid-agent
→ Available agents: claude-code, cursor, windsurf
→ Run: jack agents
```

#### Scenario: Template missing agentContext
```
(No error - fall back to generic deployment instructions)
```

#### Scenario: Unable to write agent files
```
! Failed to write AGENTS.md: Permission denied
→ Check directory permissions: /path/to/project
```

## Implementation Approach

This section provides step-by-step guidance for implementing the feature. Each step is designed to be independently testable.

### Phase 1: Core Agent Infrastructure (Foundation)

**Estimated time:** 4-6 hours

#### Step 1.1: Create Agent Registry
**File:** `src/lib/agents.ts`

Create the agent registry and core types:

```typescript
import { existsSync } from "node:fs";
import { homedir } from "node:os";

export interface AgentDefinition {
  id: string;
  name: string;
  searchPaths: string[];
  projectFiles: ProjectFile[];
}

export interface ProjectFile {
  path: string;
  template: string;
  shared?: boolean;
}

export interface AgentConfig {
  active: boolean;
  path: string;
  detectedAt: string;
}

export const AGENT_REGISTRY: AgentDefinition[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    searchPaths: ["~/.claude", "~/.config/claude"],
    projectFiles: [
      { path: "CLAUDE.md", template: "claude-md" },
      { path: "AGENTS.md", template: "agents-md", shared: true },
    ],
  },
  {
    id: "cursor",
    name: "Cursor",
    searchPaths: ["/Applications/Cursor.app", "~/.cursor"],
    projectFiles: [
      { path: ".cursorrules", template: "cursorrules" },
      { path: "AGENTS.md", template: "agents-md", shared: true },
    ],
  },
  {
    id: "windsurf",
    name: "Windsurf",
    searchPaths: ["/Applications/Windsurf.app", "~/.windsurf"],
    projectFiles: [
      { path: ".windsurfrules", template: "windsurfrules" },
      { path: "AGENTS.md", template: "agents-md", shared: true },
    ],
  },
];

/**
 * Expand ~ to home directory and handle Windows paths
 */
function expandPath(path: string): string {
  if (path.startsWith("~")) {
    return path.replace("~", homedir());
  }
  // Handle Windows environment variables like %APPDATA%
  if (process.platform === "win32" && path.includes("%")) {
    return path.replace(/%([^%]+)%/g, (_, key) => process.env[key] || "");
  }
  return path;
}

/**
 * Check if a path exists (used for agent detection)
 */
export function pathExists(path: string): boolean {
  try {
    return existsSync(expandPath(path));
  } catch {
    return false;
  }
}

/**
 * Get agent definition by ID
 */
export function getAgentDefinition(id: string): AgentDefinition | undefined {
  return AGENT_REGISTRY.find(agent => agent.id === id);
}
```

**Testing:**
```bash
# Test expandPath
bun test src/lib/agents.test.ts
```

#### Step 1.2: Add Agent Config to Config Module
**File:** `src/commands/init.ts`

Update the JackConfig interface to include agents:

```typescript
interface JackConfig {
  version: number;
  initialized: boolean;
  initializedAt: string;
  agents?: Record<string, AgentConfig>;  // Add this line
}
```

**Testing:**
- Config should load/save without errors
- Backward compatibility: old configs without `agents` should still work

#### Step 1.3: Implement Agent Detection
**File:** `src/lib/agents.ts`

Add agent scanning functionality:

```typescript
import { readConfig, writeConfig } from "../commands/init.ts";

export interface DetectionResult {
  detected: Array<{ id: string; path: string }>;
  total: number;
}

/**
 * Scan for installed agents by checking known paths
 */
export async function scanAgents(): Promise<DetectionResult> {
  const detected: Array<{ id: string; path: string }> = [];

  for (const agent of AGENT_REGISTRY) {
    for (const searchPath of agent.searchPaths) {
      if (pathExists(searchPath)) {
        detected.push({ id: agent.id, path: expandPath(searchPath) });
        break; // Use first found path
      }
    }
  }

  return { detected, total: AGENT_REGISTRY.length };
}

/**
 * Get active agents from config
 */
export async function getActiveAgents(): Promise<
  Array<{ id: string; config: AgentConfig; definition: AgentDefinition }>
> {
  const config = await readConfig();
  if (!config?.agents) return [];

  const active = [];
  for (const [id, agentConfig] of Object.entries(config.agents)) {
    if (agentConfig.active) {
      const definition = getAgentDefinition(id);
      if (definition) {
        active.push({ id, config: agentConfig, definition });
      }
    }
  }

  return active;
}

/**
 * Update agent in config
 */
export async function updateAgent(
  id: string,
  config: AgentConfig
): Promise<void> {
  const jackConfig = await readConfig();
  if (!jackConfig) {
    throw new Error("jack not initialized - run: jack init");
  }

  if (!jackConfig.agents) {
    jackConfig.agents = {};
  }

  jackConfig.agents[id] = config;
  await writeConfig(jackConfig);
}
```

**Note:** You'll need to export `readConfig` and `writeConfig` from `init.ts`.

**Testing:**
```bash
# Manual test
bun run src/index.ts -- test-scan
# Should detect installed agents
```

### Phase 2: Agent Detection During Init

**Estimated time:** 2-3 hours

#### Step 2.1: Integrate Detection into `jack init`
**File:** `src/commands/init.ts`

Add agent detection after Cloudflare authentication:

```typescript
import { scanAgents, updateAgent, getAgentDefinition } from "../lib/agents.ts";

export default async function init(): Promise<void> {
  // ... existing code through authentication ...

  // Step 3: Detect agents
  const agentSpin = spinner("Detecting AI coding agents...");
  const detectionResult = await scanAgents();
  agentSpin.stop();

  if (detectionResult.detected.length > 0) {
    success(`Found ${detectionResult.detected.length} agent(s)`);
    for (const { id, path } of detectionResult.detected) {
      const definition = getAgentDefinition(id);
      item(`${definition?.name}: ${path}`);

      // Auto-enable detected agents
      await updateAgent(id, {
        active: true,
        path: path,
        detectedAt: new Date().toISOString(),
      });
    }
  } else {
    info("No agents detected (you can add them later with: jack agents add)");
  }

  // Step 4: Save config (already exists, just ensure agents are saved)
  await writeConfig({
    version: 1,
    initialized: true,
    initializedAt: new Date().toISOString(),
  });

  console.error("");
  success("jack is ready!");
  if (!alreadySetUp) {
    info("Create your first project: jack new my-app");
  }
}
```

**Testing:**
1. Run `jack init` with Claude Code installed → should detect and show it
2. Run `jack init` without any agents → should show "No agents detected" message
3. Check `~/.config/jack/config.json` contains agents object

### Phase 3: Agent File Generation

**Estimated time:** 4-5 hours

#### Step 3.1: Add agentContext to Template Type
**File:** `src/templates/types.ts`

```typescript
export interface AgentContext {
  summary: string;
  full_text: string;
}

export interface Template {
  files: Record<string, string>;
  secrets?: string[];
  capabilities?: Capability[];
  description?: string;
  hooks?: TemplateHooks;
  agentContext?: AgentContext;  // Add this line
}
```

#### Step 3.2: Update Miniapp Template
**File:** `templates/miniapp/.jack.json`

```json
{
  "name": "miniapp",
  "description": "Farcaster Miniapp (React + Vite)",
  "secrets": ["NEYNAR_API_KEY"],
  "capabilities": ["db"],
  "agentContext": {
    "summary": "A Farcaster miniapp using React + Vite frontend, Hono API on Cloudflare Workers, with D1 SQLite database.",
    "full_text": "## Project Structure\n\n- `src/App.tsx` - React application entry point\n- `src/worker.ts` - Hono API routes for backend\n- `src/components/` - React components\n- `schema.sql` - D1 database schema\n\n## Conventions\n\n- API routes are defined with Hono in `src/worker.ts`\n- Frontend uses Vite for bundling\n- Database migrations are applied automatically during deployment\n- Secrets are managed via `jack secrets add KEY`\n\n## Resources\n\n- [Farcaster Miniapp Docs](https://docs.farcaster.xyz/miniapps)\n- [Hono Documentation](https://hono.dev)\n- [Cloudflare D1 Docs](https://developers.cloudflare.com/d1)"
  },
  "hooks": {
    // ... existing hooks ...
  }
}
```

#### Step 3.3: Create Agent File Generator
**File:** `src/lib/agent-files.ts`

```typescript
import { join } from "node:path";
import { existsSync } from "node:fs";
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
  template: Template
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
  agents: Array<{ id: string; config: AgentConfig; definition: AgentDefinition }>
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
```

**Testing:**
1. Create a test project directory
2. Call `generateAgentFiles` with mock data
3. Verify AGENTS.md and CLAUDE.md are created with correct content
4. Verify shared files (AGENTS.md) are only written once

#### Step 3.4: Integrate into `jack new`
**File:** `src/commands/new.ts`

Add agent file generation after template rendering:

```typescript
import { getActiveAgents } from "../lib/agents.ts";
import { generateAgentFiles } from "../lib/agent-files.ts";

export default async function newProject(
  name?: string,
  options: { template?: string } = {},
): Promise<void> {
  // ... existing code through template rendering ...

  // After writing all template files, before installing dependencies
  const activeAgents = await getActiveAgents();
  if (activeAgents.length > 0) {
    const agentDuration = await time("Generate agent files", async () => {
      await generateAgentFiles(targetDir, projectName, template!, activeAgents);
    });
    timings.push({ label: "Generate agent files", duration: agentDuration });
  }

  // ... continue with rest of existing code ...
}
```

**Testing:**
1. Run `jack init` (detects Claude Code)
2. Run `jack new test-project`
3. Verify `test-project/AGENTS.md` exists with correct content
4. Verify `test-project/CLAUDE.md` exists and references AGENTS.md
5. Verify both files contain deployment instructions

### Phase 4: Agent Management Commands

**Estimated time:** 4-5 hours

#### Step 4.1: Create Base Agents Command
**File:** `src/commands/agents.ts`

```typescript
import {
  getActiveAgents,
  scanAgents,
  updateAgent,
  getAgentDefinition,
  AGENT_REGISTRY,
  pathExists,
} from "../lib/agents.ts";
import { readConfig } from "./init.ts";
import { output, success, error, info, item } from "../lib/output.ts";

export default async function agents(
  subcommand?: string,
  args: string[] = []
): Promise<void> {
  if (!subcommand) {
    return await listAgents();
  }

  switch (subcommand) {
    case "scan":
      return await scanAndPrompt();
    case "add":
      return await addAgent(args);
    case "remove":
      return await removeAgent(args);
    case "enable":
      return await enableAgent(args);
    case "disable":
      return await disableAgent(args);
    default:
      error(`Unknown subcommand: ${subcommand}`);
      info("Available: scan, add, remove, enable, disable");
      process.exit(1);
  }
}

/**
 * List all agents with their status
 */
async function listAgents(): Promise<void> {
  const config = await readConfig();
  const configuredAgents = config?.agents || {};

  console.error("");
  info("AI Coding Agents");
  console.error("");

  for (const definition of AGENT_REGISTRY) {
    const agentConfig = configuredAgents[definition.id];

    if (agentConfig) {
      const statusMark = agentConfig.active ? "✓" : "○";
      const status = agentConfig.active ? "active" : "inactive";
      success(`${statusMark} ${definition.name} (${status})`);
      item(`Path: ${agentConfig.path}`);

      // Validate path still exists
      if (!pathExists(agentConfig.path)) {
        item("⚠ Path no longer exists - run: jack agents scan");
      }
    } else {
      item(`○ ${definition.name} (not detected)`);
    }
    console.error("");
  }

  info("Commands: jack agents scan | add | remove | enable | disable");
}

/**
 * Scan for agents and prompt to enable new ones
 */
async function scanAndPrompt(): Promise<void> {
  output.start("Scanning for agents...");
  const detectionResult = await scanAgents();
  output.stop();

  if (detectionResult.detected.length === 0) {
    info("No agents detected");
    return;
  }

  const config = await readConfig();
  const existingAgents = config?.agents || {};
  const newAgents = detectionResult.detected.filter(
    ({ id }) => !existingAgents[id]
  );

  if (newAgents.length === 0) {
    success("No new agents found");
    return;
  }

  console.error("");
  success(`Found ${newAgents.length} new agent(s):`);
  for (const { id, path } of newAgents) {
    const definition = getAgentDefinition(id);
    item(`${definition?.name}: ${path}`);

    // Auto-enable (following omakase principle)
    await updateAgent(id, {
      active: true,
      path,
      detectedAt: new Date().toISOString(),
    });
  }

  console.error("");
  success("New agents enabled");
  info("Future projects will include context files for these agents");
}

/**
 * Manually add an agent
 */
async function addAgent(args: string[]): Promise<void> {
  const [agentId, ...rest] = args;

  if (!agentId) {
    error("Agent ID required");
    info("Usage: jack agents add <id> [--path /custom/path]");
    info(`Available IDs: ${AGENT_REGISTRY.map(a => a.id).join(", ")}`);
    process.exit(1);
  }

  const definition = getAgentDefinition(agentId);
  if (!definition) {
    error(`Unknown agent: ${agentId}`);
    info(`Available: ${AGENT_REGISTRY.map(a => a.id).join(", ")}`);
    process.exit(1);
  }

  // Parse --path flag
  const pathIndex = rest.indexOf("--path");
  let customPath: string | undefined;
  if (pathIndex >= 0 && rest[pathIndex + 1]) {
    customPath = rest[pathIndex + 1];
  }

  // If no custom path, try to detect
  let path = customPath;
  if (!path) {
    for (const searchPath of definition.searchPaths) {
      if (pathExists(searchPath)) {
        path = searchPath;
        break;
      }
    }
  }

  if (!path) {
    error(`Could not detect ${definition.name}`);
    info(`Specify path manually: jack agents add ${agentId} --path /path/to/agent`);
    process.exit(1);
  }

  if (!pathExists(path)) {
    error(`Path does not exist: ${path}`);
    process.exit(1);
  }

  await updateAgent(agentId, {
    active: true,
    path,
    detectedAt: new Date().toISOString(),
  });

  success(`Added ${definition.name}`);
  item(`Path: ${path}`);
  info("Future projects will include context files for this agent");
}

/**
 * Remove an agent from config
 */
async function removeAgent(args: string[]): Promise<void> {
  const [agentId] = args;

  if (!agentId) {
    error("Agent ID required");
    info("Usage: jack agents remove <id>");
    process.exit(1);
  }

  const config = await readConfig();
  if (!config?.agents?.[agentId]) {
    error(`Agent not configured: ${agentId}`);
    process.exit(1);
  }

  delete config.agents[agentId];
  await writeConfig(config);

  success(`Removed ${agentId}`);
}

/**
 * Enable an agent
 */
async function enableAgent(args: string[]): Promise<void> {
  const [agentId] = args;

  if (!agentId) {
    error("Agent ID required");
    info("Usage: jack agents enable <id>");
    process.exit(1);
  }

  const config = await readConfig();
  const agentConfig = config?.agents?.[agentId];

  if (!agentConfig) {
    error(`Agent not configured: ${agentId}`);
    info(`Run: jack agents add ${agentId}`);
    process.exit(1);
  }

  agentConfig.active = true;
  await writeConfig(config!);

  success(`Enabled ${agentId}`);
}

/**
 * Disable an agent
 */
async function disableAgent(args: string[]): Promise<void> {
  const [agentId] = args;

  if (!agentId) {
    error("Agent ID required");
    info("Usage: jack agents disable <id>");
    process.exit(1);
  }

  const config = await readConfig();
  const agentConfig = config?.agents?.[agentId];

  if (!agentConfig) {
    error(`Agent not configured: ${agentId}`);
    process.exit(1);
  }

  agentConfig.active = false;
  await writeConfig(config!);

  success(`Disabled ${agentId}`);
  info("Future projects will not include context files for this agent");
}
```

**Note:** You'll need to export `writeConfig` from `init.ts`.

#### Step 4.2: Register Command in CLI
**File:** `src/index.ts`

Add the agents command to the CLI router:

```typescript
import agents from "./commands/agents.ts";

// In the command routing section
if (cli.input[0] === "agents") {
  await agents(cli.input[1], cli.input.slice(2));
  process.exit(0);
}
```

**Testing:**
1. `jack agents` → lists all agents with status
2. `jack agents scan` → detects agents, auto-enables new ones
3. `jack agents add windsurf --path /custom/path` → adds agent with custom path
4. `jack agents disable cursor` → disables cursor
5. `jack agents enable cursor` → re-enables cursor
6. `jack agents remove windsurf` → removes windsurf from config

### Phase 5: Path Validation & Polish

**Estimated time:** 2-3 hours

#### Step 5.1: Add Path Validation Before File Generation
**File:** `src/commands/new.ts`

Before generating agent files, validate that configured paths still exist:

```typescript
import { validateAgentPaths } from "../lib/agents.ts";

// Before generating agent files
if (activeAgents.length > 0) {
  const validation = await validateAgentPaths();

  if (validation.invalid.length > 0) {
    output.warn("Some agent paths no longer exist:");
    for (const { id, path } of validation.invalid) {
      item(`${id}: ${path}`);
    }
    info("Run: jack agents scan");

    // Filter out invalid agents
    activeAgents = activeAgents.filter(({ id }) =>
      !validation.invalid.some(inv => inv.id === id)
    );
  }

  if (activeAgents.length > 0) {
    await generateAgentFiles(targetDir, projectName, template!, activeAgents);
  }
}
```

#### Step 5.2: Implement Validation Function
**File:** `src/lib/agents.ts`

```typescript
export interface ValidationResult {
  valid: Array<{ id: string; path: string }>;
  invalid: Array<{ id: string; path: string }>;
}

/**
 * Validate that all configured agent paths still exist
 */
export async function validateAgentPaths(): Promise<ValidationResult> {
  const config = await readConfig();
  const agents = config?.agents || {};

  const valid: Array<{ id: string; path: string }> = [];
  const invalid: Array<{ id: string; path: string }> = [];

  for (const [id, agentConfig] of Object.entries(agents)) {
    if (agentConfig.active) {
      if (pathExists(agentConfig.path)) {
        valid.push({ id, path: agentConfig.path });
      } else {
        invalid.push({ id, path: agentConfig.path });
      }
    }
  }

  return { valid, invalid };
}
```

**Testing:**
1. Configure an agent with a valid path
2. Delete/move the agent
3. Run `jack new test-project`
4. Verify warning is shown and agent files are not generated for invalid agent
5. Verify suggestion to run `jack agents scan`

#### Step 5.3: Add Success Message for Agent Files
**File:** `src/commands/new.ts`

After generating agent files, show confirmation:

```typescript
if (activeAgents.length > 0) {
  await generateAgentFiles(targetDir, projectName, template!, activeAgents);

  // Show what was generated
  const agentNames = activeAgents
    .map(({ definition }) => definition.name)
    .join(", ");
  success(`Generated context for: ${agentNames}`);
}
```

## Validation Criteria

### Functional Acceptance Criteria
- [ ] `jack init` detects installed agents (Claude Code, Cursor, Windsurf)
- [ ] `jack init` saves detected agents to `~/.config/jack/config.json`
- [ ] `jack new my-app` generates AGENTS.md with deployment instructions
- [ ] `jack new my-app` generates agent-specific files (CLAUDE.md, .cursorrules) for active agents
- [ ] AGENTS.md includes template-specific context from `.jack.json`
- [ ] `jack agents` lists all agents with active/inactive status
- [ ] `jack agents scan` detects newly installed agents
- [ ] `jack agents add <id> --path <path>` manually adds agent
- [ ] `jack agents remove <id>` removes agent from config
- [ ] `jack agents enable/disable <id>` toggles agent activation
- [ ] Invalid agent paths trigger warning during `jack new`
- [ ] Shared files (AGENTS.md) are only written once per project
- [ ] Existing agent files are not overwritten

### Technical Validation Criteria
- [ ] Agent detection completes in < 500ms
- [ ] Agent file generation adds < 200ms to `jack new` total time
- [ ] Config structure is backward compatible (old configs still work)
- [ ] Agent IDs are validated (alphanumeric + hyphen only)
- [ ] Paths are validated before writing files
- [ ] Cross-platform path handling works (macOS, Linux, Windows)
- [ ] No file overwrites without user confirmation
- [ ] Error messages are clear and actionable

### User Experience Validation
- [ ] First-time user runs `jack init` → sees agents detected automatically
- [ ] First-time user runs `jack new` → gets working project with agent context
- [ ] User with Claude Code can immediately ask Claude to "deploy this" and it works
- [ ] User who installs new agent can run `jack agents scan` to enable it
- [ ] User can disable unwanted agents without breaking jack
- [ ] Error messages follow the format: "what happened → why → what to do next"

### Edge Cases
- [ ] No agents installed → jack works normally, no agent files generated
- [ ] All agents disabled → jack works normally, no agent files generated
- [ ] Template without agentContext → AGENTS.md generated with generic content
- [ ] Agent path contains spaces → handled correctly
- [ ] Multiple search paths for same agent → uses first found path
- [ ] User manually edits AGENTS.md → not overwritten on next `jack new`
- [ ] Config directory doesn't exist → created automatically
- [ ] Config file corrupted → shows clear error message

## Risks and Mitigations

### Risk 1: Path Detection Fragility
**Risk:** Agent installation paths vary widely, especially on different OSes and custom installs.

**Mitigation:**
- Provide multiple search paths per agent
- Allow manual path specification via `jack agents add --path`
- Don't fail silently - show what was/wasn't detected
- Let users easily rescan with `jack agents scan`

### Risk 2: Template Context Maintenance
**Risk:** Template authors might not add/update agentContext, leading to poor agent experience.

**Mitigation:**
- Provide good defaults - AGENTS.md works even without template context
- Document agentContext in template development guide
- Include example in miniapp template as reference
- Make agentContext optional, not required

### Risk 3: Agent File Proliferation
**Risk:** Too many agent files clutter projects (CLAUDE.md, .cursorrules, .windsurfrules, etc.).

**Mitigation:**
- Use AGENTS.md as single source of truth
- Agent-specific files are minimal (reference AGENTS.md)
- Only generate files for active agents
- Easy to disable unwanted agents

### Risk 4: AGENTS.md Standard Evolution
**Risk:** AGENTS.md standard might evolve, requiring updates to our implementation.

**Mitigation:**
- Keep AGENTS.md format simple and generic
- Don't over-engineer - basic markdown is enough
- Focus on deployment commands (our core value)
- Template-specific content is separate, easy to update

### Risk 5: Performance Impact
**Risk:** Agent detection/file generation slows down `jack init` and `jack new`.

**Mitigation:**
- Target < 500ms for detection during init (one-time cost)
- Target < 200ms for file generation during new (already writing files)
- Use simple file existence checks (fast)
- Avoid network calls or complex validation

### Risk 6: Cross-Platform Compatibility
**Risk:** Path handling differs between macOS, Linux, Windows.

**Mitigation:**
- Use Node.js path utilities (join, resolve)
- Support tilde expansion (~) for home directory
- Support Windows environment variables (%APPDATA%, etc.)
- Test on multiple platforms before release
- Document platform-specific paths in agent registry

## Timeline Estimate

### Development Phases
1. **Phase 1: Core Infrastructure** (4-6 hours)
   - Agent registry and types
   - Config structure update
   - Path detection logic

2. **Phase 2: Init Integration** (2-3 hours)
   - Agent detection during init
   - Config persistence
   - User feedback

3. **Phase 3: File Generation** (4-5 hours)
   - Template updates
   - File generation logic
   - Integration with `jack new`

4. **Phase 4: Management Commands** (4-5 hours)
   - CLI command implementation
   - Subcommand routing
   - Error handling

5. **Phase 5: Polish** (2-3 hours)
   - Path validation
   - Edge case handling
   - User messaging

**Total Estimated Time:** 16-22 hours for a mid-level developer

### Testing Requirements
- **Unit tests:** 2-3 hours (path utilities, config handling)
- **Integration tests:** 3-4 hours (end-to-end workflows)
- **Manual testing:** 2-3 hours (cross-platform, edge cases)

**Total Testing Time:** 7-10 hours

### Documentation
- Update README with agent features: 1 hour
- Template development guide: 1 hour
- Internal documentation: 1 hour

**Total Documentation Time:** 3 hours

**Grand Total:** 26-35 hours

## Success Criteria

### Launch Criteria (Must Have)
1. Agent detection works on macOS (primary platform)
2. AGENTS.md generated for all new projects
3. Claude Code integration works end-to-end
4. Basic CLI commands functional (list, scan, add, remove)
5. Zero breaking changes to existing jack functionality
6. Performance targets met (< 500ms detection, < 200ms generation)

### Post-Launch Criteria (Nice to Have)
1. Windows path detection working
2. Linux path detection working
3. Additional agents beyond Claude Code, Cursor, Windsurf
4. Community templates with rich agentContext
5. Analytics on agent adoption
6. User feedback on agent experience

### Measurement
- **Adoption:** % of new projects that include agent files
- **Success:** % of users who successfully deploy via agent commands
- **Satisfaction:** User feedback on agent integration
- **Performance:** Actual timing measurements from debug output

---

## Appendix: Example Flows

### Flow 1: First-Time User Setup
```bash
# User installs jack and runs init
$ jack init
✓ Wrangler installed
✓ Authenticated with Cloudflare
✓ Found 1 agent(s)
  Claude Code: ~/.claude

✓ jack is ready!
→ Create your first project: jack new my-app

# User creates a project
$ jack new my-app
✓ Created my-app/
✓ Dependencies installed
✓ Generated context for: Claude Code
✓ Built
✓ Live: https://my-app-abc123.workers.dev

# User opens in Claude Code
$ cd my-app
$ claude

# Claude reads CLAUDE.md → AGENTS.md → knows how to deploy
```

### Flow 2: Manual Agent Addition
```bash
# User installs Windsurf in custom location
$ jack agents add windsurf --path /opt/windsurf

✓ Added Windsurf
  Path: /opt/windsurf
→ Future projects will include context files for this agent

# Next project includes Windsurf context
$ jack new another-app
✓ Generated context for: Claude Code, Windsurf
```

### Flow 3: Agent Management
```bash
# List agents
$ jack agents

→ AI Coding Agents

✓ Claude Code (active)
  Path: ~/.claude

○ Cursor (not detected)

✓ Windsurf (active)
  Path: /opt/windsurf

# Disable Claude Code
$ jack agents disable claude-code
✓ Disabled claude-code
→ Future projects will not include context files for this agent

# Re-enable later
$ jack agents enable claude-code
✓ Enabled claude-code
```

### Flow 4: Path Validation
```bash
# User's Claude installation moved
$ jack new test-app
! Claude Code was configured at ~/.claude but the path no longer exists
→ Run: jack agents scan

✓ Created test-app/
✓ Generated context for: Windsurf
# (Claude context not generated)

# User rescans
$ jack agents scan
✓ Found 1 new agent(s):
  Claude Code: ~/.config/claude

✓ New agents enabled
→ Future projects will include context files for these agents
```

---

## File Reference

Files that will be created or modified:

### New Files
- `/Users/hellno/dev/misc/jack/src/lib/agents.ts` - Agent registry and management
- `/Users/hellno/dev/misc/jack/src/lib/agent-files.ts` - File generation logic
- `/Users/hellno/dev/misc/jack/src/commands/agents.ts` - CLI commands

### Modified Files
- `/Users/hellno/dev/misc/jack/src/commands/init.ts` - Add agent detection
- `/Users/hellno/dev/misc/jack/src/commands/new.ts` - Add file generation
- `/Users/hellno/dev/misc/jack/src/templates/types.ts` - Add AgentContext type
- `/Users/hellno/dev/misc/jack/templates/miniapp/.jack.json` - Add agentContext field
- `/Users/hellno/dev/misc/jack/src/index.ts` - Register agents command

### Generated Files (per project)
- `AGENTS.md` - Universal agent context (shared)
- `CLAUDE.md` - Claude Code specific (references AGENTS.md)
- `.cursorrules` - Cursor specific (references AGENTS.md)
- `.windsurfrules` - Windsurf specific (references AGENTS.md)
