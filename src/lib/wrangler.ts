import { $ } from "bun";
import { error, spinner } from "./output.ts";

/**
 * Check if wrangler is installed (without installing)
 */
export async function hasWrangler(): Promise<boolean> {
	const check = await $`which wrangler`.nothrow().quiet();
	return check.exitCode === 0;
}

/**
 * Check if user is authenticated with Cloudflare (without prompting login)
 */
export async function isAuthenticated(): Promise<boolean> {
	const hasIt = await hasWrangler();
	if (!hasIt) return false;

	const check = await $`wrangler whoami`.nothrow().quiet();
	return check.exitCode === 0 && !check.stdout.toString().includes("not authenticated");
}

/**
 * Ensures wrangler CLI is installed globally
 */
export async function ensureWrangler(): Promise<void> {
	const check = await $`which wrangler`.nothrow().quiet();

	if (check.exitCode !== 0) {
		const spin = spinner("Installing wrangler...");
		const install = await $`bun add -g wrangler`.nothrow().quiet();

		if (install.exitCode !== 0) {
			spin.error("Failed to install wrangler");
			process.exit(1);
		}
		spin.success("Installed wrangler");
	}
}

/**
 * Ensures user is authenticated with Cloudflare
 */
export async function ensureAuth(): Promise<void> {
	const check = await $`wrangler whoami`.nothrow().quiet();

	if (check.exitCode !== 0 || check.stderr.toString().includes("not authenticated")) {
		const spin = spinner("Opening Cloudflare login...");
		spin.stop();

		// Login is interactive, can't be quiet
		const login = await $`wrangler login`.nothrow();

		if (login.exitCode !== 0) {
			error("Failed to authenticate with Cloudflare");
			process.exit(1);
		}
	}
}
