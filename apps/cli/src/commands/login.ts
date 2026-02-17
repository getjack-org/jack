import { type LoginFlowOptions, runLoginFlow } from "../lib/auth/login-flow.ts";
import { error, info } from "../lib/output.ts";

interface LoginOptions {
	/** Skip the initial "Logging in..." message (used when called from auto-login) */
	silent?: boolean;
	/** Email address for magic auth flow (headless login) */
	email?: string;
	/** 6-digit verification code (skip send step, verify directly) */
	code?: string;
}

export default async function login(options: LoginOptions = {}): Promise<void> {
	const email = options.email;

	// --code without --email is a mistake
	if (options.code && !email) {
		error("--code requires --email");
		info("Usage: jack login --email you@example.com --code 123456");
		process.exit(1);
	}

	if (email) {
		const { runMagicAuthFlow } = await import("../lib/auth/login-flow.ts");
		const result = await runMagicAuthFlow({
			email,
			code: options.code,
			silent: options.silent,
		});
		if (!result.success) process.exit(1);

		// Print token to stdout so agents can capture it programmatically
		if (result.token && (!process.stdout.isTTY || process.env.CI)) {
			process.stdout.write(`${result.token}\n`);
		}
		return;
	}

	// TTY guardrail: fail fast if no browser possible (CI counts as non-interactive)
	if (!process.stdout.isTTY || process.env.CI) {
		error("Cannot open browser in this environment.");
		info("Use: jack login --email you@example.com");
		info("Or set JACK_API_TOKEN for headless use.");
		process.exit(1);
	}

	// Existing device flow
	const flowOptions: LoginFlowOptions = {
		silent: options.silent,
	};

	const result = await runLoginFlow(flowOptions);

	if (!result.success) {
		process.exit(1);
	}
}
