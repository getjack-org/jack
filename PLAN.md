# Plan: Ask Feature 10x

## Overview

Four improvements to the post-deployment `ask` feature:

1. **LLM Synthesis** — replace deterministic `pickAnswer()` with Claude on the server side
2. **Session Transcript at Deploy** — automatically capture and upload the Claude Code session context when deploying
3. **Git/JJ Diff at Deploy** — capture actual VCS diff in the CLI and store it with the deployment
4. **Real AST Parsing** — replace regex symbol extraction with `acorn` + `acorn-typescript`

---

## Feature 1: LLM Synthesis

Replace the heuristic `pickAnswer()` in `ask-project.ts` with a real Claude API call.

### What changes

**`apps/control-plane/src/types.ts`**
- Add `ANTHROPIC_API_KEY?: string` to `Bindings`

**`apps/control-plane/wrangler.toml`**
- Add comment: `# - ANTHROPIC_API_KEY  # Anthropic API key for ask_project synthesis`

**`apps/control-plane/package.json`**
- Add `@anthropic-ai/sdk` dependency

**`apps/control-plane/src/ask-project.ts`**
- Add `synthesizeWithLLM(evidence, question, opts?)` function:
  - Formats evidence as a structured markdown block for Claude
  - Includes session transcript excerpt (if available) and VCS diff stat (if available)
  - Calls `claude-haiku-4-5-20251001` via Anthropic SDK
  - Returns `{ answer: string, root_cause?: string, suggested_fix?: string, confidence: "high" | "medium" | "low" }`
  - Falls back to `pickAnswer()` if `ANTHROPIC_API_KEY` is not set or the call fails
- Update `answerProjectQuestion()` to call `synthesizeWithLLM()` instead of `pickAnswer()`
- Keep `pickAnswer()` as the fallback
- Extend API response shape to include `root_cause?`, `suggested_fix?`, `confidence`

### Prompt structure for Claude

```
You are a debugging assistant for deployed Cloudflare Workers projects.
Given evidence collected about a project, answer the user's question concisely.

Question: <question>

Evidence:
<formatted evidence list — type, source, summary, relation>

[If session transcript available]:
Context from deploy session (last 30 messages):
<transcript excerpt>

[If VCS diff available]:
Code changed in this deployment:
<diff_stat>

Respond with JSON:
{
  "answer": "...",
  "root_cause": "..." | null,
  "suggested_fix": "..." | null,
  "confidence": "high" | "medium" | "low"
}
```

---

## Feature 2: Session Transcript at Deploy

Automatically capture the Claude Code session transcript at deploy time and store it as a deployment artifact. The `ask` feature then uses it as context.

### Mechanism

Two paths, both automatic (no agent opt-in):

**Path A — CLI deploy** (`jack deploy` run as a Bash tool by Claude Code):
- Extend the existing `SessionStart` hook in `installClaudeCodeHooks()` to also export `CLAUDE_TRANSCRIPT_PATH` via `CLAUDE_ENV_FILE`
- After a successful deploy, `jack deploy` checks for `CLAUDE_TRANSCRIPT_PATH` env var and uploads the transcript

**Path B — MCP deploy** (`deploy_project` MCP tool called by Claude Code):
- Add a `PostToolUse` hook in `installClaudeCodeHooks()` that fires when `tool_name === "deploy_project"`
- Hook reads `transcript_path` and `tool_response` from stdin
- Extracts `deploymentId` and `projectId` from tool response JSON
- Calls `jack _internal upload-session-transcript --project <id> --deployment <id> --transcript-path <path>`

### What changes

**`apps/cli/src/lib/claude-hooks-installer.ts`**
- Extend `installClaudeCodeHooks()` to also install:
  - Updated `SessionStart` hook command that exports `CLAUDE_TRANSCRIPT_PATH` and `CLAUDE_SESSION_ID` via `CLAUDE_ENV_FILE`
  - New `PostToolUse` hook entry with `matcher: "deploy_project"` that runs `jack _internal upload-session-transcript ...`
- Keep existing hook deduplication logic

**`apps/cli/src/lib/session-transcript.ts`** (new file)
- `readAndTruncateTranscript(path: string): Promise<string | null>`:
  - Reads JSONL file from `transcript_path`
  - Keeps only `type: "user" | "assistant"` lines
  - Truncates to last 200 messages or 100KB, whichever is smaller
  - Returns truncated JSONL string
- `uploadSessionTranscript(opts: { projectId, deploymentId, transcriptPath, authToken, baseUrl })`:
  - Calls `readAndTruncateTranscript()`
  - PUTs to `/v1/projects/:projectId/deployments/:deploymentId/session-transcript`

**`apps/cli/src/commands/internal.ts`** (new command or extend existing)
- Add `jack _internal upload-session-transcript` subcommand
- Reads `--project-id`, `--deployment-id`, `--transcript-path` args
- Calls `uploadSessionTranscript()` using saved auth token
- Silent: exits 0 even on failure (hook errors must not block the user)

**`apps/cli/src/lib/managed-deploy.ts`** (or wherever deploy completes)
- After successful deploy: check `process.env.CLAUDE_TRANSCRIPT_PATH`
- If set, call `uploadSessionTranscript()` asynchronously (fire-and-forget, silent)

**`apps/control-plane/src/index.ts`**
- New endpoint: `PUT /v1/projects/:projectId/deployments/:deploymentId/session-transcript`
  - Auth: same JWT org membership check
  - Body: raw text (JSONL)
  - Stores to R2: `projects/{projectId}/deployments/{deploymentId}/session-transcript.jsonl`
  - Updates `deployments SET has_session_transcript = 1 WHERE id = ?`

**`apps/control-plane/migrations/0031_add_deployment_context.sql`** (new)
```sql
ALTER TABLE deployments ADD COLUMN has_session_transcript INTEGER DEFAULT 0;
ALTER TABLE deployments ADD COLUMN vcs_type TEXT;
ALTER TABLE deployments ADD COLUMN vcs_sha TEXT;
ALTER TABLE deployments ADD COLUMN vcs_message TEXT;
ALTER TABLE deployments ADD COLUMN vcs_diff_stat TEXT;
ALTER TABLE deployments ADD COLUMN vcs_diff TEXT;
```

**`apps/control-plane/src/ask-project.ts`**
- Before calling `synthesizeWithLLM()`: if `deployment.has_session_transcript`, fetch from R2 and pass last 30 messages as context
- Add `"session_transcript"` evidence type — summary says e.g. "Deploy session had 47 turns. Agent was working on: ..."

---

## Feature 3: Git/JJ Diff at Deploy

Capture the actual VCS diff in the CLI at deploy time and store it with the deployment.

### What changes

**`apps/cli/src/lib/vcs.ts`** (new file)
```typescript
interface VcsDiff {
  vcs: "git" | "jj";
  sha: string;
  message: string;      // commit/change description
  diff_stat: string;    // max 2KB
  diff: string;         // max 15KB, truncated with notice if over
}

async function captureVcsDiff(projectDir: string): Promise<VcsDiff | null>
```

- Detects VCS by checking for `.git/` (git) or `.jj/` (jj) in `projectDir` and parents
- Git commands:
  - `git -C <dir> rev-parse HEAD` → sha
  - `git -C <dir> log -1 --pretty=%s` → message
  - `git -C <dir> diff HEAD~1 --stat` → diff_stat (if no parent commit, diff against empty tree)
  - `git -C <dir> diff HEAD~1 --unified=3` → diff (truncated to 15KB)
- JJ commands:
  - `jj --no-pager log -r @ --no-graph --template 'commit_id.short()'` → sha
  - `jj --no-pager log -r @ --no-graph --template 'description.first_line()'` → message
  - `jj --no-pager diff --stat` → diff_stat
  - `jj --no-pager diff` → diff (truncated to 15KB)
- Silent fallback: catches all errors, returns `null` if anything fails or VCS not found

**`apps/cli/src/lib/managed-deploy.ts`** (or deploy request builder)
- Call `captureVcsDiff(projectDir)` before deploy request
- Include `vcs` field in request body if non-null

**`apps/control-plane/src/index.ts`** (deploy endpoint)
- Accept optional `vcs?: VcsDiff` in deploy request body
- Pass through to `createCodeDeployment()`

**`apps/control-plane/src/deployment-service.ts`**
- `createCodeDeployment()` accepts optional `vcs` field
- Stores `vcs_type`, `vcs_sha`, `vcs_message`, `vcs_diff_stat`, `vcs_diff` on deployment record

**`apps/control-plane/src/ask-project.ts`**
- For "what changed" questions: pull `vcs_diff_stat` + `vcs_sha` + `vcs_message` from deployment
- Add `"vcs_diff"` evidence type with summary like "Deployed from commit abc1234: 'fix auth middleware'. Changed 3 files, +47 -12 lines."
- Pass `vcs_diff` to `synthesizeWithLLM()` for full diff context

---

## Feature 4: Real AST Parsing

Replace regex-based symbol extraction with a proper parser to get accurate symbols, imports, and a lightweight call graph.

### Parser choice: `acorn` + `acorn-walk` + `acorn-typescript`

- Pure JS, ~300KB total — no Wasm, works in Cloudflare Workers
- Handles JS, JSX, TS, TSX (TypeScript stripped before parse via lightweight type stripping)
- Acorn is battle-tested and used by many JS tools

Alternative considered: `tree-sitter` Wasm (more accurate but 2-5MB Wasm bundle per language, cold start cost). Skip for now.

### What changes

**`apps/control-plane/package.json`**
- Add `acorn`, `acorn-walk`, `acorn-typescript`

**`apps/control-plane/src/ask-code-index.ts`**
- Replace `jsTsAdapter` regex implementation with AST-based extraction
- New/improved symbol extraction:

| Kind | Before (regex) | After (AST) |
|------|---------------|-------------|
| `route` | basic `app.get("/x")` pattern | + object router `{ GET: handler }`, `pathname === "/x"` chained routes |
| `function` | name only | name + param count + async/generator in signature |
| `class` | name only | name + method names listed in signature |
| `export` | any `export` keyword | distinguishes named/default/re-export |
| `env_binding` | `env.UPPER_SNAKE` | same, but accurate (no false positives in strings/comments) |
| `sql_ref` | SQL keyword match | same, more accurate (avoids matches in comments) |
| `import` | not extracted | **new**: `from` module path + imported names |
| `interface` | not extracted | **new**: TypeScript interface names |
| `type_alias` | not extracted | **new**: TypeScript `type X = ...` |

- New `meta` column on symbol rows (stored as JSON string) holds:
  - For `function`: `{ params: string[], async: bool, callees: string[] }` — lightweight call graph
  - For `import`: `{ from: string, names: string[] }`
  - For `class`: `{ methods: string[] }`

**`apps/control-plane/migrations/0031_add_deployment_context.sql`** (same migration as above)
```sql
ALTER TABLE ask_code_symbols_latest ADD COLUMN meta TEXT;
ALTER TABLE ask_code_index_runs ADD COLUMN parser_version TEXT;
```

- Bump `PARSER_VERSION` constant in `ask-code-index.ts` to trigger re-index on next deploy

---

## Migration summary

One new migration file: `0031_add_deployment_context.sql`

```sql
-- Deployment context columns
ALTER TABLE deployments ADD COLUMN has_session_transcript INTEGER DEFAULT 0;
ALTER TABLE deployments ADD COLUMN vcs_type TEXT;
ALTER TABLE deployments ADD COLUMN vcs_sha TEXT;
ALTER TABLE deployments ADD COLUMN vcs_message TEXT;
ALTER TABLE deployments ADD COLUMN vcs_diff_stat TEXT;
ALTER TABLE deployments ADD COLUMN vcs_diff TEXT;

-- AST parser meta column
ALTER TABLE ask_code_symbols_latest ADD COLUMN meta TEXT;
```

---

## New files

| File | Purpose |
|------|---------|
| `apps/cli/src/lib/vcs.ts` | Git/JJ diff capture |
| `apps/cli/src/lib/session-transcript.ts` | Transcript read, truncate, upload |
| `apps/control-plane/migrations/0031_add_deployment_context.sql` | Schema additions |

---

## Modified files

| File | Change |
|------|--------|
| `apps/control-plane/src/types.ts` | Add `ANTHROPIC_API_KEY?` to Bindings |
| `apps/control-plane/wrangler.toml` | Add secret comment |
| `apps/control-plane/package.json` | Add `@anthropic-ai/sdk`, `acorn`, `acorn-walk`, `acorn-typescript` |
| `apps/control-plane/src/ask-project.ts` | Add `synthesizeWithLLM()`, load transcript + VCS diff context |
| `apps/control-plane/src/ask-code-index.ts` | Replace regex with AST parser |
| `apps/control-plane/src/index.ts` | New `PUT .../session-transcript` endpoint; accept `vcs` in deploy |
| `apps/control-plane/src/deployment-service.ts` | Store VCS fields on deployment |
| `apps/cli/src/lib/claude-hooks-installer.ts` | Add SessionStart env export + PostToolUse hook |
| `apps/cli/src/lib/managed-deploy.ts` | Capture VCS diff + upload transcript after deploy |
| `apps/cli/src/commands/` | Add `jack _internal upload-session-transcript` |

---

## Open questions (no blockers)

1. **Codex CLI**: no hooks API exists yet (open issue #2765). Transcript capture for Codex is deferred — the `vcs` diff path will still work for Codex users since it's CLI-side.

2. **Model for LLM synthesis**: plan uses `claude-haiku-4-5-20251001`. If response quality is insufficient, swap to `claude-sonnet-4-5-20250929` — just a one-line constant change.

3. **PostToolUse hook `tool_response` parsing**: the `deploy_project` MCP tool returns `{ deploymentId, projectId, ... }` wrapped in `formatSuccessResponse`. The hook script will parse the text content JSON. If the shape changes, the hook silently fails (no user impact — transcript upload is always best-effort).
