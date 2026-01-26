import type { TemplateIntent } from "./types";

/**
 * Generate the prompt for the spec drafting phase
 * This prompt guides Claude to interview the user and produce a complete spec
 */
export function generateSpecPrompt(intent: TemplateIntent): string {
	return `
You are helping create a new Jack template. Your job is to gather requirements
and produce a detailed specification document.

## User's Initial Request

"${intent.description}"

${intent.preferences ? `Preferences: ${JSON.stringify(intent.preferences, null, 2)}` : ""}

## Your Task

1. First, ask clarifying questions to understand the requirements fully:
   - What is the primary use case?
   - Who is the target audience (indie hackers, enterprise, hobbyists)?
   - What features are essential vs nice-to-have?
   - Any specific integrations needed (Stripe, auth providers, etc.)?
   - What should the default UI look like?

2. Based on the answers, draft a complete specification in this format:

---

# Template Spec: {name}

## Description

{One paragraph describing what this template is for and who should use it}

## Target Audience

{Who is this template for? What's their skill level?}

## Technical Decisions

### {Area 1, e.g., Authentication}
**Choice**: {What we're using}
**Reasoning**: {Why this choice makes sense}
**Tradeoffs**: {What we're giving up}
**Alternatives considered**: {What else was evaluated}

### {Area 2, e.g., Database}
...

## Features

- {Feature 1}
- {Feature 2}
- ...

## Capabilities Required

- db: {Yes/No - why}
- kv: {Yes/No - why}
- ai: {Yes/No - why}

## Secrets

| Secret | Required | Description | Setup URL |
|--------|----------|-------------|-----------|
| {KEY} | Yes/No | {What it's for} | {URL} |

## Validation Criteria

### Endpoints to Test
- \`GET /api/health\` → 200 OK
- \`GET /api/...\` → ...

### Browser Tests
- {What should work in the browser}

---

\`\`\`json
{
  "name": "{lowercase-with-hyphens}",
  "description": "{short description}",
  "framework": "hono|nextjs|vite-react|api-only",
  "frontend": "vite-react|nextjs|none",
  "capabilities": ["db", "kv", ...],
  "requires": ["DB", "KV", ...],
  "secrets": [
    {"name": "SECRET_KEY", "required": true, "description": "...", "setupUrl": "..."}
  ],
  "intent": {
    "keywords": ["keyword1", "keyword2"],
    "examples": ["example use case"]
  },
  "validation": {
    "endpoints": [
      {"path": "/api/health", "method": "GET", "expectedStatus": 200}
    ],
    "browserTests": [
      {"name": "Landing page loads", "steps": ["navigate to /", "verify heading exists"]}
    ]
  }
}
\`\`\`

## Important Guidelines

- Use jack-template as the project name placeholder (it gets replaced during \`jack new\`)
- Don't include wrangler in dependencies (jack handles this globally)
- Keep dependencies minimal - only what's actually needed
- Follow Jack conventions from the templates/CLAUDE.md guide
- The JSON block at the end is required - it's parsed by the factory

## Interview Style

Be conversational. Ask one or two questions at a time. Don't overwhelm the user.
Suggest reasonable defaults when the user is unsure.
Once you have enough information, produce the spec document.
  `.trim();
}

/**
 * Generate the prompt for the implementation phase
 * This prompt guides Claude to generate all template files
 */
export function generateImplementationPrompt(
	specDraft: string,
	templatesDir: string,
	specName: string,
): string {
	return `
You are implementing a new Jack template based on the approved specification.

## Specification

${specDraft}

## Output Location

Create all files in: ${templatesDir}/${specName}/

## Implementation Guide

### 1. Create .jack.json

This is the template metadata file. Include:
- name, description (from spec)
- secrets array (required secrets)
- optionalSecrets array (with setupUrl for each)
- capabilities array
- requires array
- agentContext with summary and full_text (documentation for AI agents)
- hooks (preDeploy for secret validation, postDeploy for URL handling)
- intent with keywords

Example structure:
\`\`\`json
{
  "name": "${specName}",
  "description": "...",
  "secrets": ["REQUIRED_KEY"],
  "optionalSecrets": [
    {"name": "OPTIONAL_KEY", "description": "...", "setupUrl": "..."}
  ],
  "capabilities": ["db"],
  "requires": ["DB"],
  "agentContext": {
    "summary": "One-line summary",
    "full_text": "## Project Structure\\n\\n- src/worker.ts - API routes\\n..."
  },
  "hooks": {
    "preDeploy": [
      {"action": "require", "source": "secret", "key": "REQUIRED_KEY", "setupUrl": "..."}
    ],
    "postDeploy": [
      {"action": "clipboard", "text": "{{url}}", "message": "URL copied"},
      {"action": "box", "title": "{{name}}", "lines": ["{{url}}"]}
    ]
  },
  "intent": {
    "keywords": ["keyword1", "keyword2"]
  }
}
\`\`\`

### 2. Create wrangler.jsonc

Use jack-template as the worker name (gets replaced during \`jack new\`):

\`\`\`jsonc
{
  "name": "jack-template",
  "main": "src/worker.ts",
  "compatibility_date": "2024-12-01",
  "compatibility_flags": ["nodejs_compat"],
  // Add D1 binding if db capability
  "d1_databases": [
    {"binding": "DB", "database_name": "jack-template-db", "database_id": "local"}
  ],
  // Add KV binding if kv capability
  "kv_namespaces": [
    {"binding": "KV", "id": "local"}
  ],
  // Add assets if frontend
  "assets": {
    "directory": "dist/client",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": true
  }
}
\`\`\`

### 3. Create package.json

\`\`\`json
{
  "name": "jack-template",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build && vite build --ssr",
    "preview": "wrangler dev"
  },
  "dependencies": {
    // Only runtime deps the user code needs
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.x",
    "typescript": "^5.x"
    // Build tools if needed (vite, tailwind, etc.)
    // NO wrangler - jack handles this globally
  }
}
\`\`\`

### 4. Create Source Files

Based on the framework choice:

**For Hono API:**
- src/worker.ts - Main Hono app with routes
- src/types.ts - TypeScript types for Env bindings

**For Vite + React:**
- src/worker.ts - Hono API routes
- src/App.tsx - React app entry
- src/main.tsx - React DOM render
- src/components/ - React components
- index.html - HTML entry point
- vite.config.ts - Vite configuration

**For all templates:**
- tsconfig.json - TypeScript config
- schema.sql - D1 schema if using database

### 5. Create schema.sql (if using database)

\`\`\`sql
-- Schema for ${specName}
-- Applied automatically by jack during deploy

CREATE TABLE IF NOT EXISTS ... ;
\`\`\`

### 6. Generate bun.lock

After creating package.json, run:
\`\`\`bash
cd ${templatesDir}/${specName}
bun install
\`\`\`

This creates bun.lock for faster installs.

## Code Quality Requirements

1. **Type Safety**: Full TypeScript with strict mode
2. **Error Handling**: Proper error responses, no unhandled promises
3. **Security**: No hardcoded secrets, validate input, sanitize output
4. **Conventions**: Follow patterns from existing Jack templates
5. **Comments**: Minimal - code should be self-documenting

## File Creation Order

1. .jack.json (metadata)
2. wrangler.jsonc (config)
3. package.json (deps)
4. tsconfig.json (typescript)
5. src/worker.ts (API)
6. schema.sql (if db)
7. Frontend files (if applicable)
8. bun install (generates lock)

Start implementing now. Create each file using the appropriate tool.
  `.trim();
}

/**
 * Generate prompt for fixing type errors
 */
export function generateTypeFixPrompt(templatePath: string, errors: string): string {
	return `
Fix the following TypeScript errors in the template at ${templatePath}:

\`\`\`
${errors}
\`\`\`

Rules:
1. Only fix the type errors - don't change functionality
2. Prefer adding proper types over using \`any\`
3. If a type import is missing, add it
4. If a type definition is wrong, fix the definition

Read the relevant files, make the fixes, and run tsc again to verify.
  `.trim();
}

/**
 * Generate prompt for smoke testing
 */
export function generateSmokeTestPrompt(
	deployUrl: string,
	endpoints: Array<{ path: string; method: string; expectedStatus: number }>,
): string {
	return `
Run smoke tests against the deployed template.

Base URL: ${deployUrl}

Tests:
${endpoints
	.map(
		(e, i) => `
${i + 1}. ${e.method} ${e.path}
   Expected: ${e.expectedStatus}
   Command: curl -s -o /dev/null -w "%{http_code}" -X ${e.method} ${deployUrl}${e.path}
`,
	)
	.join("\n")}

For each test:
1. Run the curl command
2. Compare status code to expected
3. Report PASS or FAIL

If any test fails, investigate the cause by checking:
- curl -s ${deployUrl}{path} for response body
- Any error messages in the response

Report results in this format:
- [PASS] GET /api/health → 200
- [FAIL] GET /api/users → 500 (expected 200)
  `.trim();
}
