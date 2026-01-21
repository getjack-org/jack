# Template Factory - Agent Context

## What This Is

A Smithers-powered workflow for creating new Jack built-in templates. Uses JSX components
to define an execution plan that Claude agents follow.

## Key Files

```
src/
├── index.tsx           # CLI entry point, parses args, sets up Smithers DB
├── TemplateFactory.tsx # Main workflow with 5 phases
├── prompts.ts          # Prompt templates for spec and implementation
└── types.ts            # Zod schemas for template spec validation
```

## Smithers Concepts

**Phase**: Sequential workflow stage. Phases run one at a time, in order.
**Step**: Individual task within a phase. Steps also run sequentially by default.
**While**: Iterative loop that continues until condition is false.
**Parallel**: Run multiple agents concurrently.
**Worktree**: Git branch isolation for implementation.
**Human**: Pause for human approval (binary approve/reject).
**Claude**: Execute a Claude agent with the given prompt.

## State Management

State persists in SQLite at `.smithers/template-factory/`. Key patterns:

```tsx
// Write state
db.state.set("factory:spec:approved", true);

// Read state reactively (triggers re-render when changed)
const approved = useQueryValue<boolean>("factory:spec:approved");
```

## Workflow Overview

```
1. Spec Phase
   └── draft-spec (Claude interviews user)
   └── review-spec (Human approves spec)

2. Implement Phase (in Worktree)
   └── scaffold (Claude generates files)
   └── typecheck (While loop until no errors)
   └── lint (While loop until clean)

3. Validate Phase
   └── create-test-project (jack new)
   └── deploy (jack ship)
   └── smoke-tests (Parallel curl tests)
   └── browser-tests (Playwright MCP)

4. Review Phase
   └── human-review (Human approves implementation)

5. Finalize Phase
   └── cleanup-test (jack down)
   └── register-template (add to BUILTIN_TEMPLATES)
   └── commit (git commit)
```

## Adding Features

### New Validation Test

1. Add test type to `types.ts`
2. Add extraction function in `TemplateFactory.tsx`
3. Add test component/step in validation phase

### New Phase

```tsx
<Phase name="my-phase" skipIf={() => !prerequisiteComplete}>
  <Step name="step-1">
    <Claude model="sonnet" maxTurns={20}>
      Prompt text here
    </Claude>
  </Step>
</Phase>
```

### Richer Human Feedback

The `Human` component only supports approve/reject. For conversational feedback,
use `useHumanInteractive` hook (see Smithers docs). Example:

```tsx
function InteractiveReview({ spec }: { spec: string }) {
  const { requestAsync } = useHumanInteractive();

  useEffect(() => {
    requestAsync(
      "Review and provide feedback on the spec",
      { context: { spec }, systemPrompt: "Help refine the spec" }
    ).then(result => {
      // result.transcript contains the conversation
      // result.outcome is the final status
    });
  }, []);
}
```

## Testing Changes

```bash
# Run the factory
bun run factory "Test template description"

# Check Smithers DB
sqlite3 .smithers/template-factory/smithers.db "SELECT key, value FROM state"

# Resume after changes
bun run factory --resume
```

## Common Issues

1. **Prompt too long**: Split into multiple steps or summarize context
2. **While loop not terminating**: Check the condition logic, add max iterations
3. **State not updating**: Ensure you're using `useQueryValue` for reactive reads
4. **Human step blocking**: The workflow pauses until approve/reject via TUI
