import type { Bindings } from "../types.ts";
import { chargeSession, withReceipt } from "../mpp-session.ts";
import { ok, err } from "../utils.ts";

const MAX_CODE_SIZE = 500 * 1024;

export async function executeCode(
	env: Bindings,
	params: { code: string; input?: unknown; language?: string },
	extra: { _meta?: Record<string, unknown> },
) {
	if (!params.code || typeof params.code !== "string") {
		return err("VALIDATION_ERROR", "code field required (string)");
	}

	if (new TextEncoder().encode(params.code).byteLength > MAX_CODE_SIZE) {
		return err("SIZE_LIMIT", `Code exceeds ${MAX_CODE_SIZE / 1024}KB limit`);
	}

	const language = params.language || "javascript";
	if (language !== "javascript") {
		return err("VALIDATION_ERROR", "Only javascript is supported");
	}

	// Charge -- throws McpError(-32042) if payment needed
	const payment = await chargeSession(env, extra, "0.01");

	// Hash code for stable worker ID
	const hashBuffer = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(params.code),
	);
	const workerId = Array.from(new Uint8Array(hashBuffer))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");

	// Wrap agent code in a WorkerEntrypoint so getEntrypoint().run() works.
	// Agent writes: export function run(input) { ... }
	// We wrap it as: class _ extends WorkerEntrypoint { async run(input) { return agentRun(input); } }
	const wrappedCode = `
import { WorkerEntrypoint } from "cloudflare:workers";
const __mod = await import("./user-code.js");
const __run = __mod.run || __mod.default?.run || __mod.default;
export default class extends WorkerEntrypoint {
  async run(input) {
    if (typeof __run !== "function") throw new Error("Code must export a run(input) function");
    return __run(input);
  }
}`;

	const startTime = Date.now();
	try {
		const worker = await env.LOADER.get(workerId, async () => ({
			mainModule: "agent.js",
			modules: {
				"agent.js": wrappedCode,
				"user-code.js": params.code,
			},
			compatibilityDate: "2026-03-01",
			compatibilityFlags: ["nodejs_compat"],
			env: {},
			globalOutbound: null,
		}));

		const entrypoint = worker.getEntrypoint();
		const result = await entrypoint.run(params.input ?? {});
		const durationMs = Date.now() - startTime;

		return withReceipt(
			ok({ result, duration_ms: durationMs, limits: { cpu_ms_limit: 50 } }),
			payment.receipt,
		);
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Execution failed";
		return withReceipt(err("EXECUTION_FAILED", message), payment.receipt);
	}
}
