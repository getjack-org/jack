import { getTelemetryConfig, setTelemetryEnabled } from "../lib/telemetry.ts";

export default async function telemetry(subcommand?: string): Promise<void> {
	// Get current telemetry config
	const config = await getTelemetryConfig();

	// Handle subcommands
	if (subcommand === "enable") {
		await setTelemetryEnabled(true);
		console.log("✓ Telemetry enabled");
		return;
	}

	if (subcommand === "disable") {
		await setTelemetryEnabled(false);
		console.log("✗ Telemetry disabled");
		return;
	}

	// Default: show status (handles 'status', undefined, and null)
	if (!subcommand || subcommand === "status") {
		if (config.enabled) {
			console.log("✓ Telemetry enabled");
			console.log(`Anonymous ID: ${config.anonymousId}`);
			console.log("");
			console.log("Opt out: jack telemetry disable");
		} else {
			console.log("✗ Telemetry disabled");
			console.log(`Anonymous ID: ${config.anonymousId}`);
			console.log("");
			console.log("Opt in: jack telemetry enable");
		}
		return;
	}

	// Unknown subcommand - show usage
	console.error(`Unknown subcommand: ${subcommand}`);
	console.error("");
	console.error("Usage:");
	console.error("  jack telemetry          Show telemetry status");
	console.error("  jack telemetry status   Show telemetry status");
	console.error("  jack telemetry enable   Enable telemetry");
	console.error("  jack telemetry disable  Disable telemetry");
}
