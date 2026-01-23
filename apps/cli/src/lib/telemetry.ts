import type { TelemetryConfig } from "./telemetry-config.ts";
import { getTelemetryConfig, setTelemetryEnabled } from "./telemetry-config.ts";

// Telemetry proxy endpoint (keeps PostHog API key secret)
// Override with TELEMETRY_PROXY_URL for local testing
const TELEMETRY_PROXY = process.env.TELEMETRY_PROXY_URL || "https://telemetry.getjack.org";

// Session ID - unique per CLI invocation, groups related events
const SESSION_ID = crypto.randomUUID();

// ============================================
// EVENT REGISTRY
// ============================================
export const Events = {
	AUTH_GATE_RESOLVED: "auth_gate_resolved",
	COMMAND_INVOKED: "command_invoked",
	COMMAND_COMPLETED: "command_completed",
	COMMAND_FAILED: "command_failed",
	PROJECT_CREATED: "project_created",
	DEPLOY_STARTED: "deploy_started",
	CONFIG_CHANGED: "config_changed",
	INTENT_MATCHED: "intent_matched",
	INTENT_NO_MATCH: "intent_no_match",
	INTENT_CUSTOMIZATION_STARTED: "intent_customization_started",
	INTENT_CUSTOMIZATION_COMPLETED: "intent_customization_completed",
	INTENT_CUSTOMIZATION_FAILED: "intent_customization_failed",
	DEPLOY_MODE_SELECTED: "deploy_mode_selected",
	MANAGED_PROJECT_CREATED: "managed_project_created",
	MANAGED_DEPLOY_STARTED: "managed_deploy_started",
	MANAGED_DEPLOY_COMPLETED: "managed_deploy_completed",
	MANAGED_DEPLOY_FAILED: "managed_deploy_failed",
	// Auto-detect events
	AUTO_DETECT_SUCCESS: "auto_detect_success",
	AUTO_DETECT_FAILED: "auto_detect_failed",
	AUTO_DETECT_REJECTED: "auto_detect_rejected",
	// Service events
	SERVICE_CREATED: "service_created",
	SERVICE_DELETED: "service_deleted",
	SQL_EXECUTED: "sql_executed",
	// AARRR lifecycle events
	USER_INSTALLED: "user_installed",
	USER_ACTIVATED: "user_activated",
	// BYO deploy events (parity with managed)
	BYO_DEPLOY_STARTED: "byo_deploy_started",
	BYO_DEPLOY_COMPLETED: "byo_deploy_completed",
	BYO_DEPLOY_FAILED: "byo_deploy_failed",
} as const;

type EventName = (typeof Events)[keyof typeof Events];

export { getTelemetryConfig, setTelemetryEnabled };

// ============================================
// STATE
// ============================================
let telemetryConfig: TelemetryConfig | null = null;
let enabledCache: boolean | null = null;
let userProps: Partial<UserProperties> = {};

// ============================================
// FIRE-AND-FORGET SEND (detached subprocess)
// ============================================
function send(url: string, data: object): void {
	const payload = Buffer.from(JSON.stringify(data)).toString("base64");

	// Spawn detached process that sends HTTP and exits
	// Parent doesn't wait - child outlives parent
	const proc = Bun.spawn(
		[
			"bun",
			"-e",
			`await fetch("${url}",{method:"POST",headers:{"Content-Type":"application/json"},body:Buffer.from("${payload}","base64").toString()}).catch(()=>{})`,
		],
		{
			detached: true,
			stdio: ["ignore", "ignore", "ignore"],
		},
	);
	proc.unref();
}

// ============================================
// HELPERS
// ============================================
async function isEnabled(): Promise<boolean> {
	if (enabledCache !== null) return enabledCache;

	if (
		process.env.DO_NOT_TRACK === "1" ||
		process.env.CI === "true" ||
		process.env.JACK_TELEMETRY_DISABLED === "1"
	) {
		enabledCache = false;
		return false;
	}

	try {
		const config = await getTelemetryConfig();
		telemetryConfig = config;
		enabledCache = config.enabled;
		return config.enabled;
	} catch {
		enabledCache = true;
		return true;
	}
}

async function getAnonymousId(): Promise<string> {
	if (!telemetryConfig) {
		telemetryConfig = await getTelemetryConfig();
	}
	return telemetryConfig.anonymousId;
}

// ============================================
// USER PROPERTIES
// ============================================
export interface UserProperties {
	jack_version: string;
	os: string;
	arch: string;
	node_version: string;
	is_ci: boolean;
	shell?: string;
	terminal?: string;
	terminal_width?: number;
	is_tty?: boolean;
	locale?: string;
	config_style?: "byoc" | "jack-cloud";
}

// Detect environment properties (for user profile - stable properties)
export function getEnvironmentProps(): Pick<
	UserProperties,
	"shell" | "terminal" | "terminal_width" | "is_tty" | "locale"
> {
	return {
		shell: process.env.SHELL?.split("/").pop(), // e.g., /bin/zsh -> zsh
		terminal: process.env.TERM_PROGRAM, // e.g., iTerm.app, vscode, Apple_Terminal
		terminal_width: process.stdout.columns,
		is_tty: process.stdout.isTTY ?? false,
		locale: Intl.DateTimeFormat().resolvedOptions().locale,
	};
}

// ============================================
// INVOCATION CONTEXT (per-event, not per-user)
// ============================================
export interface InvocationContext {
	is_tty: boolean;
	is_ci: boolean;
	terminal?: string;
	shell?: string;
}

export function getInvocationContext(): InvocationContext {
	return {
		is_tty: process.stdout.isTTY ?? false,
		is_ci: !!process.env.CI,
		terminal: process.env.TERM_PROGRAM,
		shell: process.env.SHELL?.split("/").pop(),
	};
}

export async function identify(properties: Partial<UserProperties>): Promise<void> {
	userProps = { ...userProps, ...properties };
	if (!(await isEnabled())) return;

	try {
		const distinctId = await getAnonymousId();
		send(`${TELEMETRY_PROXY}/identify`, {
			distinctId,
			properties: userProps,
			setOnce: { first_seen: new Date().toISOString() }, // Only sets on first identify
		});
	} catch {
		// Silent
	}
}

/**
 * Link a logged-in user to their pre-login anonymous events.
 * This should be called after successful authentication.
 *
 * @param userId - The WorkOS user ID (user.id)
 * @param properties - Optional user properties like email
 */
export async function identifyUser(userId: string, properties?: { email?: string }): Promise<void> {
	if (!(await isEnabled())) return;

	try {
		const anonymousId = await getAnonymousId();

		// Identify with real user ID
		send(`${TELEMETRY_PROXY}/identify`, {
			distinctId: userId,
			properties: { ...properties, ...userProps },
		});

		// Alias to merge pre-login anonymous events with identified user
		send(`${TELEMETRY_PROXY}/alias`, {
			distinctId: userId,
			alias: anonymousId,
		});
	} catch {
		// Silent
	}
}

// ============================================
// TRACK
// ============================================
export async function track(event: EventName, properties?: Record<string, unknown>): Promise<void> {
	if (!(await isEnabled())) return;

	try {
		const distinctId = await getAnonymousId();
		send(`${TELEMETRY_PROXY}/t`, {
			distinctId,
			event,
			properties: {
				...properties,
				...userProps,
				$session_id: SESSION_ID, // Groups events from same CLI invocation
			},
			timestamp: Date.now(),
		});
	} catch {
		// Silent
	}
}

export async function trackActivationIfFirst(deployMode: "managed" | "byo"): Promise<void> {
	try {
		const { getTelemetryConfig, saveTelemetryConfig } = await import("./telemetry-config.ts");
		const config = await getTelemetryConfig();

		// Already activated? Skip
		if (config.firstDeployAt) {
			return;
		}

		const now = new Date();
		const firstSeen = config.firstSeenAt ? new Date(config.firstSeenAt) : now;
		const daysToActivate = Math.floor((now.getTime() - firstSeen.getTime()) / (1000 * 60 * 60 * 24));

		// Fire activation event
		track(Events.USER_ACTIVATED, {
			deploy_mode: deployMode,
			days_to_activate: daysToActivate,
		});

		// Save activation timestamp
		config.firstDeployAt = now.toISOString();
		await saveTelemetryConfig(config);
	} catch {
		// Ignore - telemetry should not break CLI
	}
}

// ============================================
// WRAPPER
// ============================================
export interface TelemetryOptions {
	platform?: "cli" | "mcp";
	subcommand?: string;
}

// biome-ignore lint/suspicious/noExplicitAny: Required for flexible command wrapping
export function withTelemetry<T extends (...args: any[]) => Promise<any>>(
	commandName: string,
	fn: T,
	options?: TelemetryOptions,
): T {
	const platform = options?.platform ?? "cli";
	const subcommand = options?.subcommand;

	return (async (...args: Parameters<T>) => {
		const context = getInvocationContext();
		track(Events.COMMAND_INVOKED, { command: commandName, platform, ...(subcommand && { subcommand }), ...context });
		const start = Date.now();

		try {
			const result = await fn(...args);
			track(Events.COMMAND_COMPLETED, {
				command: commandName,
				platform,
				...(subcommand && { subcommand }),
				duration_ms: Date.now() - start,
				...context,
			});
			return result;
		} catch (error) {
			track(Events.COMMAND_FAILED, {
				command: commandName,
				platform,
				...(subcommand && { subcommand }),
				error_type: classifyError(error),
				duration_ms: Date.now() - start,
				...context,
			});
			throw error;
		}
	}) as T;
}

// ============================================
// SHUTDOWN - No-op (detached processes handle themselves)
// ============================================
export async function shutdown(): Promise<void> {
	// No-op - detached subprocesses send telemetry independently
}

// ============================================
// ERROR CLASSIFICATION
// ============================================
function classifyError(error: unknown): string {
	const combined = `${(error as Error)?.message || ""} ${String(error)}`.toLowerCase();

	if (/validation|invalid|required|missing/.test(combined)) return "validation";
	if (/enotfound|etimedout|econnrefused|network|fetch/.test(combined)) return "network";
	if (/vite|build|compile|bundle/.test(combined)) return "build";
	if (/deploy|publish|upload/.test(combined)) return "deploy";
	if (/wrangler|config|toml|json/.test(combined)) return "config";
	return "unknown";
}
