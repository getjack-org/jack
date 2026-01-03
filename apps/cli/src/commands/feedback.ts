/**
 * jack feedback - Submit feedback to the jack team
 *
 * Works without login. Auto-collects metadata.
 * Free-form text input, no categories.
 */

import pkg from "../../package.json";
import { getCredentials } from "../lib/auth/store.ts";
import { getControlApiUrl } from "../lib/control-plane.ts";
import { error, info, output, success } from "../lib/output.ts";
import { getProject } from "../lib/registry.ts";
import { getProjectNameFromDir } from "../lib/storage/index.ts";
import { getTelemetryConfig } from "../lib/telemetry.ts";

interface FeedbackMetadata {
	jack_version: string;
	os: string;
	project_name: string | null;
	deploy_mode: "managed" | "byo" | null;
}

/**
 * Check if user has allowed telemetry (respects privacy preferences)
 */
async function shouldAttachPersonalInfo(): Promise<boolean> {
	if (process.env.DO_NOT_TRACK === "1") return false;
	if (process.env.CI === "true") return false;
	if (process.env.JACK_TELEMETRY_DISABLED === "1") return false;

	try {
		const config = await getTelemetryConfig();
		return config.enabled;
	} catch {
		return true;
	}
}

export default async function feedback(): Promise<void> {
	// Check for interactive terminal
	if (!process.stdin.isTTY) {
		error("Feedback requires interactive input.");
		info("Run in a terminal, or open an issue at github.com/getjack-org/jack");
		process.exit(1);
	}

	// Show prompt
	console.error("");
	info("Share feedback, report a bug, or suggest a feature.");
	info("Press Enter on an empty line to submit. Escape to cancel.");
	console.error("");

	// Read multi-line input
	const message = await readMultilineInput();

	if (!message.trim()) {
		info("No feedback provided.");
		return;
	}

	// Check privacy preferences
	const attachPersonalInfo = await shouldAttachPersonalInfo();

	// Collect metadata (respects privacy settings)
	const metadata = await collectMetadata(attachPersonalInfo);

	// Get email if logged in AND telemetry is enabled
	let email: string | null = null;
	if (attachPersonalInfo) {
		const creds = await getCredentials();
		email = creds?.user?.email ?? null;
	}

	// Submit
	output.start("Sending feedback...");

	try {
		const response = await fetch(`${getControlApiUrl()}/v1/feedback`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				message: message.trim(),
				email,
				metadata,
			}),
		});

		output.stop();

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}

		success("Done! Thanks for your feedback.");
	} catch (err) {
		output.stop();

		// Network errors
		if (err instanceof TypeError && err.message.includes("fetch")) {
			error("Could not reach jack servers.");
			info("Check your internet connection and try again.");
		} else {
			error("Failed to submit feedback.");
			info("Try again later, or open an issue at github.com/getjack-org/jack");
		}
		process.exit(1);
	}
}

async function readMultilineInput(): Promise<string> {
	const lines: string[] = [];
	const rl = await import("node:readline");

	// Enable keypress events on stdin
	rl.emitKeypressEvents(process.stdin);

	const readline = rl.createInterface({
		input: process.stdin,
		output: process.stderr,
		prompt: "> ",
	});

	return new Promise((resolve) => {
		let emptyLineCount = 0;
		let cancelled = false;

		// Listen for Escape key
		const onKeypress = (_ch: string, key: { name: string; ctrl?: boolean }) => {
			if (key?.name === "escape") {
				cancelled = true;
				readline.close();
			}
		};
		process.stdin.on("keypress", onKeypress);

		readline.prompt();

		readline.on("line", (line) => {
			if (line === "") {
				emptyLineCount++;
				if (emptyLineCount >= 1 && lines.length > 0) {
					// Empty line after content = submit
					readline.close();
					return;
				}
			} else {
				emptyLineCount = 0;
				lines.push(line);
			}
			readline.prompt();
		});

		readline.on("close", () => {
			process.stdin.removeListener("keypress", onKeypress);
			resolve(cancelled ? "" : lines.join("\n"));
		});

		// Handle Ctrl+C gracefully
		readline.on("SIGINT", () => {
			cancelled = true;
			readline.close();
		});
	});
}

async function collectMetadata(attachPersonalInfo: boolean): Promise<FeedbackMetadata> {
	let projectName: string | null = null;
	let deployMode: "managed" | "byo" | null = null;

	// Only collect project info if telemetry is enabled
	if (attachPersonalInfo) {
		try {
			projectName = await getProjectNameFromDir(process.cwd());
			if (projectName) {
				const project = await getProject(projectName);
				deployMode = project?.deploy_mode ?? null;
			}
		} catch {
			// Not in a project directory, that's fine
		}
	}

	return {
		jack_version: pkg.version,
		os: process.platform,
		project_name: projectName,
		deploy_mode: deployMode,
	};
}
