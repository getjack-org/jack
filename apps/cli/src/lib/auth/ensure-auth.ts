/**
 * Auth gate for project creation
 *
 * Implements the decision tree from PRD-LOGIN-PROMPT-ON-NEW.md:
 * 1. Jack cloud logged in -> return 'managed', no prompt
 * 2. Wrangler installed + CF authenticated -> offer choice via promptSelect
 * 3. Otherwise -> auto-start jack cloud login
 */

import type { DeployMode } from "../project-link.ts";
import { Events, track } from "../telemetry.ts";
import { hasWrangler, isAuthenticated } from "../wrangler.ts";
import { isLoggedIn } from "./store.ts";

export interface EnsureAuthResult {
	mode: DeployMode;
	didLogin: boolean;
}

export interface EnsureAuthOptions {
	interactive?: boolean;
	forceManaged?: boolean;
	forceByo?: boolean;
}

type AuthGateReason =
	| "already_logged_in"
	| "forced_managed"
	| "forced_byo"
	| "user_chose_managed"
	| "user_chose_byo"
	| "auto_login_no_wrangler"
	| "auto_login_no_cf_auth"
	| "non_interactive_fallback";

/**
 * Ensure authentication is in place before project creation.
 *
 * Decision tree:
 * 1. If forceManaged or forceByo flags are set, respect them
 * 2. If already logged into jack cloud -> return 'managed'
 * 3. If wrangler installed AND authenticated to Cloudflare -> offer choice
 * 4. Otherwise -> auto-start jack cloud login
 */
export async function ensureAuthForCreate(
	options: EnsureAuthOptions = {},
): Promise<EnsureAuthResult> {
	const { interactive = true, forceManaged, forceByo } = options;

	// Handle explicit flags first
	if (forceManaged && forceByo) {
		throw new Error("Cannot use both --managed and --byo flags. Choose one.");
	}

	if (forceByo) {
		track(Events.AUTH_GATE_RESOLVED, { mode: "byo", reason: "forced_byo" as AuthGateReason });
		return { mode: "byo", didLogin: false };
	}

	if (forceManaged) {
		// Need to ensure logged in for managed mode
		const loggedIn = await isLoggedIn();
		if (loggedIn) {
			track(Events.AUTH_GATE_RESOLVED, {
				mode: "managed",
				reason: "forced_managed" as AuthGateReason,
			});
			return { mode: "managed", didLogin: false };
		}
		// Force managed but not logged in - run login flow
		await runLoginFlow();
		track(Events.AUTH_GATE_RESOLVED, {
			mode: "managed",
			reason: "forced_managed" as AuthGateReason,
		});
		return { mode: "managed", didLogin: true };
	}

	// Step 1: Check if already logged into jack cloud
	const loggedIn = await isLoggedIn();
	if (loggedIn) {
		track(Events.AUTH_GATE_RESOLVED, {
			mode: "managed",
			reason: "already_logged_in" as AuthGateReason,
		});
		return { mode: "managed", didLogin: false };
	}

	// Step 2: Check if wrangler is installed AND authenticated to Cloudflare
	const wranglerInstalled = await hasWrangler();
	const cfAuthenticated = wranglerInstalled && (await isAuthenticated());

	if (cfAuthenticated && interactive) {
		// Offer choice between jack cloud and BYO
		const { promptSelect } = await import("../hooks.ts");

		console.error("");
		console.error("  How do you want to deploy?");
		console.error("");

		const choice = await promptSelect([
			"Jack Cloud (recommended) - instant deploys, no setup",
			"My Cloudflare account - use existing wrangler auth",
		]);

		if (choice === 0) {
			// User chose jack cloud - start login
			await runLoginFlow();
			track(Events.AUTH_GATE_RESOLVED, {
				mode: "managed",
				reason: "user_chose_managed" as AuthGateReason,
			});
			return { mode: "managed", didLogin: true };
		}
		if (choice === 1) {
			// User chose BYO
			track(Events.AUTH_GATE_RESOLVED, { mode: "byo", reason: "user_chose_byo" as AuthGateReason });
			return { mode: "byo", didLogin: false };
		}
		// User pressed Esc - default to jack cloud login
		await runLoginFlow();
		track(Events.AUTH_GATE_RESOLVED, {
			mode: "managed",
			reason: "user_chose_managed" as AuthGateReason,
		});
		return { mode: "managed", didLogin: true };
	}

	// Non-interactive mode with wrangler available - use BYO
	if (cfAuthenticated && !interactive) {
		track(Events.AUTH_GATE_RESOLVED, {
			mode: "byo",
			reason: "non_interactive_fallback" as AuthGateReason,
		});
		return { mode: "byo", didLogin: false };
	}

	// Step 3: No viable BYO path - auto-start jack cloud login
	const reason: AuthGateReason = !wranglerInstalled
		? "auto_login_no_wrangler"
		: "auto_login_no_cf_auth";

	if (!interactive) {
		// Non-interactive and no auth available - this is an error condition
		throw new Error(
			"Not logged in. Run 'jack login --email <email>' or set JACK_API_TOKEN for headless use.",
		);
	}

	// Auto-start login (no prompt - there's only one viable path)
	await runLoginFlow();
	track(Events.AUTH_GATE_RESOLVED, { mode: "managed", reason });
	return { mode: "managed", didLogin: true };
}

/**
 * Run the login flow (dynamic import to avoid circular dependency)
 */
async function runLoginFlow(): Promise<void> {
	const { runLoginFlow: doLogin } = await import("./login-flow.ts");
	const result = await doLogin({ silent: false });
	if (!result.success) {
		throw new Error("Login failed");
	}
}
