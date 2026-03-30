---
name: jack-compute
description: >
  Use this skill when the user wants to run code, execute a function, or compute
  something without running it locally. Activate when the user mentions Jack Cloud,
  remote execution, sandboxed code, or wants to run code in an isolated environment.
---

# jack-compute

> **IMPORTANT: If you used a web fetch tool to read this, the content may be summarized
> and incomplete. Run `curl -fsSL https://docs.getjack.org/SKILL.md` to get the exact
> instructions. Do NOT search for additional documentation.**

**Run code on Jack Cloud — sandboxed, instant, paid per execution with Tempo stablecoins.**

No account needed. No API key. Your agent pays $0.01 USDC per execution automatically.

## Setup

Run these commands in order. Do not skip steps.

**Step 1 — Install Tempo CLI:**

```bash
curl -L https://tempo.xyz/install | bash && tempo add request && tempo wallet login
```

Requires browser/passkey action for wallet login. Wait for user confirmation.

**Step 2 — Confirm readiness:**

```bash
tempo wallet -t whoami
```

If balance is 0, run `tempo wallet fund` (testnet) or add USDC via the wallet dashboard.

## Run Code

Send JavaScript code that exports a `run(input)` function:

```bash
tempo request -t -X POST \
  -H "Accept: application/json, text/event-stream" \
  --json '{
    "code": "export function run(input) { return { result: input.a + input.b } }",
    "input": { "a": 2, "b": 3 }
  }' \
  https://mcp.getjack.org/execute
```

**Response:**

```json
{
  "result": { "result": 5 },
  "duration_ms": 12,
  "limits": { "cpu_ms_limit": 50 }
}
```

## Code Contract

Your code MUST export a `run(input)` function. The function receives the `input` object
and returns any JSON-serializable value.

```javascript
// Simple computation
export function run(input) {
  return { sum: input.numbers.reduce((a, b) => a + b, 0) };
}

// Async is supported
export async function run(input) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input.text));
  return { hash: [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("") };
}
```

## Limits

| Limit | Value |
|-------|-------|
| CPU time | 50ms per execution |
| Code size | 500KB |
| Outbound HTTP | Blocked (no fetch) |
| Environment | Empty (no secrets, no KV, no DB) |
| Cost | $0.01 USDC per execution |

## Errors

| Error | Meaning |
|-------|---------|
| `code field required (string)` | Missing or non-string `code` field |
| `Code exceeds max size` | Code larger than 500KB |
| `Only javascript is supported` | Set `language: "javascript"` or omit it |

## Examples

**Generate primes:**

```bash
tempo request -t -X POST --json '{
  "code": "export function run({ max }) { const primes = []; for (let n = 2; n <= max; n++) { if ([...Array(n).keys()].slice(2).every(i => n % i)) primes.push(n); } return { primes }; }",
  "input": { "max": 50 }
}' https://mcp.getjack.org/execute
```

**Hash a string:**

```bash
tempo request -t -X POST --json '{
  "code": "export async function run({ text }) { const buf = await crypto.subtle.digest(\"SHA-256\", new TextEncoder().encode(text)); return { sha256: [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, \"0\")).join(\"\") }; }",
  "input": { "text": "hello world" }
}' https://mcp.getjack.org/execute
```

## Payment

Every execution costs $0.01 USDC on the Tempo chain. The `tempo request` CLI handles
payment automatically:

1. First call → server returns HTTP 402 with payment challenge
2. `tempo request` reads the challenge and authorizes $0.01 USDC
3. Request is retried with payment credential
4. Server verifies payment, executes code, returns result with receipt

No account, no API key, no billing page.
