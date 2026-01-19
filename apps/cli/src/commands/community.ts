/**
 * jack community - Open the jack community Discord
 */

import { $ } from "bun";
import { error } from "../lib/output.ts";

const COMMUNITY_URL = "https://community.getjack.org";

export default async function community(): Promise<void> {
	console.error("");
	console.error("  Chat with other vibecoders and the jack team.");
	console.error("");
	console.error(`  Press Enter to open the browser or visit ${COMMUNITY_URL}`);

	// Wait for Enter key
	await waitForEnter();

	// Open browser using platform-specific command
	const cmd =
		process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";

	try {
		await $`${cmd} ${COMMUNITY_URL}`;
	} catch (err) {
		error(`Failed to open browser: ${err instanceof Error ? err.message : String(err)}`);
		console.error(`  Visit: ${COMMUNITY_URL}`);
	}
}

async function waitForEnter(): Promise<void> {
	return new Promise((resolve) => {
		if (!process.stdin.isTTY) {
			// Non-interactive, just resolve immediately
			resolve();
			return;
		}

		process.stdin.setRawMode(true);
		process.stdin.resume();
		process.stdin.once("data", () => {
			process.stdin.setRawMode(false);
			process.stdin.pause();
			resolve();
		});
	});
}
