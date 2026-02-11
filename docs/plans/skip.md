# Skip: Parked Ideas from Entire.io Learnings

Ideas from `entire-learnings.md` that we're not building now, and why.

---

## Intent capture (attach "why" to each deploy)

**What it is:** Install Claude Code hooks that parse the agent's session transcript, extract the prompt that triggered the deploy, and store it as metadata alongside the deploy record.

**Why skip:**
- The "why" already exists in the conversation — the user is reading it in their terminal
- Requires parsing JSONL transcripts that change format across Claude Code versions
- Must handle different transcript formats for Gemini, Cursor, Codex
- High maintenance surface for a string that the user already sees
- Entire needs this because sessions close and context is lost. Jack's sessions don't close mid-deploy.

**Revisit when:** Users ask "what triggered this deploy?" across sessions, or we build a dashboard where deploy history is browsable without conversation context.

---

## Team deploys / conflict detection

**What it is:** Track multiple agents deploying to the same project. Detect conflicts: "Claude Code deployed 30s ago, Cursor is trying to deploy now — merge or override?"

**Why skip:**
- Jack's user is a solo dev (SPIRIT: "Vibecoders. Solo devs with too many ideas and not enough weekends.")
- No signal from actual users that multi-agent conflicts are a problem
- Building team coordination before having teams is speculative
- The deploy tracking in Ship 2 gives us the foundation if we need this later

**Revisit when:** We have team/org features and users report deploy conflicts.

---

## Deploy policies (governance layer)

**What it is:** Rules like auto-rollback on high error rate, require approval before production deploy, rate limit agent deploys per hour.

**Why skip:**
- SPIRIT explicitly calls out: "You don't want migrations, enterprise approval flows, or 23-step deployment pipelines"
- Governance is for organizations with compliance requirements, not vibecoders
- Auto-rollback sounds good but requires reliable error rate detection, which requires reliable log aggregation, which is a large scope creep
- Rate limiting agents is solving a problem nobody reported

**Revisit when:** Enterprise users appear, or agents start deploying in runaway loops (then rate limiting becomes a safety feature, not governance).

---

## `jack enable` as a separate command

**What it is:** A new command distinct from `jack init` that does one-command project setup: create/connect project, install hooks, configure MCP, set up metadata storage.

**Why skip:**
- `jack init` already exists and does most of this
- Two setup commands ("init or enable?") violates Convention Over Configuration
- The right move is enhancing `jack init`, not adding a second entry point
- Every new command is a concept the user has to learn

**What we're doing instead:** Enhancing `jack init` (Ship 4) to also install Claude Code hooks when it detects Claude Code.

---

## Naming the deploy context concept ("snapshots", "deploy snapshots")

**What it is:** Come up with a branded name for deployment state tracking, like Entire uses "checkpoints."

**Why skip:**
- Naming before building is marketing, not product
- Ship the feature first, see how users describe it naturally, then formalize the name
- "Deployments" and "deploys" are already clear, jargon-free terms that match SPIRIT's output guidelines
- Premature naming creates premature abstraction

**Revisit when:** The feature exists and we need a shorthand for docs/marketing.

---

## All of these share a pattern

Each skipped item is either:
1. **Solving a team problem for solo users** (team deploys, policies)
2. **High maintenance for marginal benefit** (intent capture)
3. **Premature abstraction** (naming, new commands)

The test from SPIRIT: *"Would we use jack or reach for wrangler directly?"* None of these skipped items affect that answer. The things we ARE building (health checks, real deploy data, rollback, fork) directly make jack more useful than wrangler.
