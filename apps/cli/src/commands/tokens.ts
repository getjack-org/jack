/**
 * jack tokens - Manage API tokens for headless authentication
 *
 * Tokens are account-level (not project-scoped).
 * Set JACK_API_TOKEN in your environment for CI/CD and automated pipelines.
 */

import { error, info, success } from "../lib/output.ts";
import {
	type TokenInfo,
	createApiToken,
	listApiTokens,
	revokeApiToken,
} from "../lib/services/token-operations.ts";
import { Events, track } from "../lib/telemetry.ts";

export default async function tokens(
	subcommand?: string,
	args: string[] = [],
	flags: Record<string, unknown> = {},
): Promise<void> {
	if (!subcommand) {
		return showHelp();
	}

	if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
		return showHelp();
	}

	switch (subcommand) {
		case "create":
		case "new":
			return await createToken(args, flags);
		case "list":
		case "ls":
			return await listTokens();
		case "revoke":
		case "rm":
		case "delete":
			return await revokeToken(args);
		default:
			error(`Unknown subcommand: ${subcommand}`);
			info("Available: create, list, revoke");
			process.exit(1);
	}
}

function showHelp(): void {
	console.error("");
	info("jack tokens - Manage API tokens for headless authentication");
	console.error("");
	console.error("Commands:");
	console.error("  create [name]             Create a new API token");
	console.error("  list                      List active tokens");
	console.error("  revoke <id>               Revoke a token");
	console.error("");
	console.error("Usage:");
	console.error("  Set JACK_API_TOKEN in your environment for headless auth.");
	console.error("  Tokens work in CI/CD, Docker, and automated pipelines.");
	console.error("");
}

async function createToken(args: string[], flags: Record<string, unknown> = {}): Promise<void> {
	// Accept name from --name flag or first positional arg
	let name = "CLI Token";
	if (flags.name && typeof flags.name === "string") {
		name = flags.name;
	} else if (args[0] && !args[0].startsWith("-")) {
		name = args[0];
	}

	const data = await createApiToken(name);

	track(Events.TOKEN_CREATED);

	success("Token created");
	console.error("");
	console.error(`  ${data.token}`);
	console.error("");
	console.error("  Save this token -- it will not be shown again.");
	console.error("");
	console.error("  Usage:");
	console.error("    export JACK_API_TOKEN=<token>");
	console.error("    jack ship");
	console.error("");
}

async function listTokens(): Promise<void> {
	const tokenList = await listApiTokens();

	if (tokenList.length === 0) {
		info("No active tokens");
		return;
	}

	console.error("");
	for (const t of tokenList) {
		const lastUsed = t.last_used_at ? `last used ${t.last_used_at}` : "never used";
		console.error(`  ${t.id}  ${t.name}  (${lastUsed})`);
	}
	console.error("");
}

async function revokeToken(args: string[]): Promise<void> {
	const tokenId = args[0];

	if (!tokenId) {
		error("Missing token ID");
		info("Usage: jack tokens revoke <token-id>");
		info("Run 'jack tokens list' to see token IDs");
		process.exit(1);
	}

	await revokeApiToken(tokenId);

	track(Events.TOKEN_REVOKED);

	success(`Token revoked: ${tokenId}`);
}
