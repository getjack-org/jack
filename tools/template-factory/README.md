# Jack Template Factory

A Smithers-powered workflow for creating new built-in Jack templates.

## Overview

The Template Factory uses [Smithers](https://github.com/evmts/smithers) to orchestrate
a multi-phase workflow that:

1. **Spec Phase**: Interviews you about requirements and drafts a specification
2. **Implementation Phase**: Generates template files in a git worktree
3. **Validation Phase**: Creates a test project, deploys it, runs smoke tests
4. **Review Phase**: Human review of the implementation
5. **Finalize Phase**: Cleanup, register template, commit to main

## Installation

```bash
cd tools/template-factory
bun install
```

## Usage

### Create a New Template

```bash
# Start the factory with your template idea
bun run factory "SaaS starter with Stripe payments"

# Or more specific
bun run factory "API template with rate limiting, JWT auth, and OpenAPI docs"
```

### Resume a Previous Run

```bash
# Resume the most recent execution
bun run factory --resume

# Resume a specific execution
bun run factory --execution abc123
```

## Workflow Phases

### Phase 1: Spec

The factory will interview you to understand your requirements:

```
? What is the primary use case for this template?
? Who is the target audience?
? What features are essential?
? Any specific integrations needed?
```

Based on your answers, it drafts a specification document (`spec.md`) with:
- Description and target audience
- Technical decisions with tradeoffs
- Required capabilities (db, kv, ai, etc.)
- Secrets configuration
- Validation criteria

**Human Review**: You review the spec and can request changes before proceeding.

### Phase 2: Implementation

The factory generates template files in a git worktree (`template/{name}`):

- `.jack.json` - Template metadata
- `wrangler.jsonc` - Cloudflare Workers config
- `package.json` - Dependencies
- `src/` - Source files
- `schema.sql` - Database schema (if using D1)

It then runs iterative loops to fix any type or lint errors.

### Phase 3: Validation

The factory validates the template works correctly:

1. Creates a test project: `jack new test-{name} -t ./templates/{name}`
2. Deploys it: `jack ship`
3. Runs smoke tests on API endpoints
4. Runs browser tests using Playwright MCP

### Phase 4: Review (Autonomous)

Claude automatically validates the deployment:

- Checks the homepage loads correctly
- Tests API endpoints mentioned in the spec
- Verifies Jack conventions are followed

This phase runs automatically after successful validation.

### Phase 5: Finalize

If approved:

1. Tears down the test project
2. Adds template to `BUILTIN_TEMPLATES` array
3. Commits changes with a descriptive message

## Resumability

All workflow state is persisted in SQLite (`.smithers/template-factory/`).
If the process is interrupted, you can resume exactly where you left off.

## Architecture

```
tools/template-factory/
├── src/
│   ├── index.tsx           # Entry point and CLI
│   ├── TemplateFactory.tsx # Main Smithers workflow
│   ├── prompts.ts          # Prompt templates
│   └── types.ts            # TypeScript types and Zod schemas
├── package.json
├── tsconfig.json
└── README.md
```

## Key Components

### TemplateFactory.tsx

The main workflow component using Smithers primitives:

- `<Phase>` - Sequential workflow phases
- `<Step>` - Individual steps within phases
- `<While>` - Iterative loops (for fixing errors)
- `<Parallel>` - Concurrent execution (for smoke tests)
- `<Worktree>` - Git worktree isolation
- `<Human>` - Human review checkpoints
- `<Claude>` - AI agent execution

### State Management

State is stored in Smithers' SQLite database with keys like:
- `factory:phase` - Current phase
- `factory:spec:draft` - Spec markdown
- `factory:spec:approved` - Human approval status
- `factory:validate:url` - Deployed URL

### Human Interaction (Hybrid Approach)

The workflow uses a **hybrid** human-in-the-loop model:

1. **Spec Phase**: Pauses for human approval after drafting the specification
2. **Implementation onward**: Runs autonomously (Claude handles implementation, validation, and finalization)

To approve the spec draft, use the approve script in a separate terminal:

```bash
# List pending interactions
bun run pending

# Approve the spec to continue
bun run approve

# Reject to stop the workflow
bun run reject
```

This matches Smithers' design philosophy ("Let your agent write agents") while maintaining
human oversight at the critical spec definition stage.

## Customization

### Adding New Phases

Add a new `<Phase>` component in `TemplateFactory.tsx`:

```tsx
<Phase name="my-phase" skipIf={() => !previousPhaseComplete}>
  <Step name="my-step">
    <Claude>Your prompt here</Claude>
  </Step>
</Phase>
```

### Modifying Prompts

Edit `prompts.ts` to change how the AI generates specs or implementations.

### Adding Validation Tests

Modify `extractEndpointsFromSpec()` or `extractBrowserTestsFromSpec()` to
parse additional test criteria from the spec document.

## Troubleshooting

### Workflow Stuck

Check the Smithers database for state:

```bash
sqlite3 .smithers/template-factory/smithers.db "SELECT * FROM state"
```

If state from a previous run is interfering, start a fresh execution (without `--resume`)
to automatically reset the workflow state.

### Human Interaction Not Progressing

If the workflow is waiting for human input:

1. Check for pending interactions: `bun run pending`
2. Approve to continue: `bun run approve`
3. Or reject to stop: `bun run reject`

### Type Errors Not Fixing

The `While` loop has a max iterations limit. If it's not converging:

1. Check the generated code manually
2. Fix issues in the template
3. Resume with `--resume`

### Browser Tests Failing

Ensure Playwright MCP is configured and the deployment URL is accessible.

## Future Enhancements

- [ ] `useHumanInteractive` for conversational spec refinement
- [ ] Multiple validation environments (staging, preview)
- [ ] Automatic PR creation instead of direct commit
- [ ] Template versioning and upgrade paths
