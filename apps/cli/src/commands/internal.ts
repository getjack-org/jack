import { readProjectLink } from "../lib/project-link.ts";
import { uploadDeltaSessionTranscript } from "../lib/session-transcript.ts";
import { dirname, resolve } from "node:path";

/**
 * Internal commands used by Claude Code hooks.
 * Not exposed in the help text — these are implementation details.
 */
export default async function internal(subcommand?: string): Promise<void> {
	if (subcommand === "session-start") {
		await handleSessionStart();
		return;
	}

	if (subcommand === "post-deploy") {
		await handlePostDeploy();
		return;
	}

	// Unknown subcommand — exit silently (hooks must never error visibly)
	process.exit(0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseJsonString(value: string): unknown | null {
	const trimmed = value.trim();
	if (!trimmed) return null;
	try {
		return JSON.parse(trimmed);
	} catch {
		return null;
	}
}

function looksLikeDeploymentId(value: unknown): value is string {
	return typeof value === "string" && /^dep_[A-Za-z0-9-]+$/.test(value);
}

function extractDeploymentIdFromUnknown(value: unknown, depth = 0): string | null {
	if (depth > 8 || value == null) return null;

	if (looksLikeDeploymentId(value)) return value;

	if (typeof value === "string") {
		const parsed = parseJsonString(value);
		if (parsed != null) {
			const nested = extractDeploymentIdFromUnknown(parsed, depth + 1);
			if (nested) return nested;
		}

		const inline = value.match(/\bdep_[A-Za-z0-9-]+\b/);
		return inline?.[0] ?? null;
	}

	if (Array.isArray(value)) {
		for (const item of value) {
			const nested = extractDeploymentIdFromUnknown(item, depth + 1);
			if (nested) return nested;
		}
		return null;
	}

	if (!isRecord(value)) return null;

	const direct = value.deploymentId ?? value.deployment_id;
	if (looksLikeDeploymentId(direct)) return direct;

	for (const key of ["data", "result", "response", "payload", "content", "tool_response"]) {
		if (!(key in value)) continue;
		const nested = extractDeploymentIdFromUnknown(value[key], depth + 1);
		if (nested) return nested;
	}

	for (const nestedValue of Object.values(value)) {
		const nested = extractDeploymentIdFromUnknown(nestedValue, depth + 1);
		if (nested) return nested;
	}

	return null;
}

function extractProjectPathFromUnknown(value: unknown, depth = 0): string | null {
	if (depth > 6 || value == null) return null;

	if (typeof value === "string") {
		const parsed = parseJsonString(value);
		if (parsed != null) return extractProjectPathFromUnknown(parsed, depth + 1);
		return null;
	}

	if (!isRecord(value)) return null;

	const direct = value.project_path ?? value.projectPath;
	if (typeof direct === "string" && direct.trim().length > 0) {
		return direct.trim();
	}

	for (const key of ["data", "payload", "input", "arguments"]) {
		if (!(key in value)) continue;
		const nested = extractProjectPathFromUnknown(value[key], depth + 1);
		if (nested) return nested;
	}

	return null;
}

function isDeployProjectToolName(value: unknown): boolean {
	if (typeof value !== "string") return false;
	const toolName = value.trim();
	return toolName === "deploy_project" || toolName.endsWith("__deploy_project");
}

async function findNearestLinkedProjectDir(startDir: string): Promise<string | null> {
	let current = resolve(startDir);
	while (true) {
		const link = await readProjectLink(current).catch(() => null);
		if (link) return current;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return null;
}

// Exported for unit tests.
export const __internalPostDeployParsing = {
	isDeployProjectToolName,
	extractDeploymentIdFromUnknown,
	extractProjectPathFromUnknown,
};

/**
 * SessionStart hook handler.
 *
 * Previously wrote CLAUDE_TRANSCRIPT_PATH to $CLAUDE_ENV_FILE, but that
 * mechanism is broken upstream (GitHub #15840). Transcript path is now
 * obtained via PostToolUse hooks or filesystem discovery instead.
 *
 * This handler is kept as a no-op so existing hook configs don't error.
 */
async function handleSessionStart(): Promise<void> {
	// No-op — transcript path is handled by PostToolUse hooks now
}

/**
 * PostToolUse hook handler for deploy_project.
 *
 * Claude Code passes JSON via stdin:
 *   { hook_event_name, tool_name, tool_input, tool_response, transcript_path, cwd, session_id }
 *
 * We extract the deployment_id + project_id and upload the transcript.
 */
async function handlePostDeploy(): Promise<void> {
	try {
		const raw = await readStdin();
		if (!raw) return;

		const payload = JSON.parse(raw) as Record<string, unknown>;

		// Only handle deploy_project tool calls
		if (!isDeployProjectToolName(payload.tool_name)) return;

		const transcriptPath = payload.transcript_path as string | undefined;

		// Parse multiple possible hook response shapes to get deploymentId.
		const deploymentId =
			extractDeploymentIdFromUnknown(payload.tool_response) ??
			extractDeploymentIdFromUnknown(payload.tool_result) ??
			extractDeploymentIdFromUnknown(payload.response);
		if (!deploymentId) return;

		// Resolve project root from tool input or nearest linked parent from cwd.
		const cwd = (payload.cwd as string | undefined) ?? process.cwd();
		const toolInput =
			payload.tool_input ??
			payload.input ??
			(payload.arguments as Record<string, unknown> | undefined);
		const projectPath = extractProjectPathFromUnknown(toolInput);
		const candidateDir = projectPath ? resolve(cwd, projectPath) : cwd;
		const linkedProjectDir = await findNearestLinkedProjectDir(candidateDir);
		if (!linkedProjectDir) return;

		const link = await readProjectLink(linkedProjectDir).catch(() => null);
		if (!link || link.deploy_mode !== "managed") return;

		await uploadDeltaSessionTranscript({
			projectId: link.project_id,
			deploymentId,
			transcriptPath,
			projectDir: linkedProjectDir,
		});
	} catch {
		// Never surface errors from hooks
	}
}

async function readStdin(): Promise<string | null> {
	try {
		const chunks: Buffer[] = [];
		for await (const chunk of process.stdin) {
			chunks.push(chunk as Buffer);
		}
		return Buffer.concat(chunks).toString("utf8").trim() || null;
	} catch {
		return null;
	}
}
