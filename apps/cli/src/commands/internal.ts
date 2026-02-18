import { appendFile } from "node:fs/promises";
import { readProjectLink } from "../lib/project-link.ts";
import { uploadSessionTranscript } from "../lib/session-transcript.ts";

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

/**
 * SessionStart hook handler.
 *
 * Claude Code passes JSON via stdin:
 *   { session_id, transcript_path, cwd, ... }
 *
 * We write CLAUDE_TRANSCRIPT_PATH to $CLAUDE_ENV_FILE so that subsequent
 * Bash tool calls (e.g. `jack deploy`) can find the transcript and upload it.
 */
async function handleSessionStart(): Promise<void> {
	try {
		const raw = await readStdin();
		if (!raw) return;

		const payload = JSON.parse(raw) as Record<string, unknown>;
		const transcriptPath = payload.transcript_path as string | undefined;
		const envFile = process.env.CLAUDE_ENV_FILE;

		if (transcriptPath && envFile) {
			await appendFile(envFile, `export CLAUDE_TRANSCRIPT_PATH='${transcriptPath}'\n`);
		}
	} catch {
		// Never surface errors from hooks
	}
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
		if (payload.tool_name !== "deploy_project") return;

		const transcriptPath = payload.transcript_path as string | undefined;
		if (!transcriptPath) return;

		// Parse the tool response to get deploymentId
		const toolResponse = payload.tool_response as string | undefined;
		if (!toolResponse) return;

		let deploymentId: string | undefined;
		try {
			const parsed = JSON.parse(toolResponse) as Record<string, unknown>;
			// Response shape: { success, data: { deploymentId, ... }, meta }
			const data = parsed.data as Record<string, unknown> | undefined;
			deploymentId = data?.deploymentId as string | undefined;
		} catch {
			return;
		}
		if (!deploymentId) return;

		// Get project_id from the project link in the working directory
		const cwd = (payload.cwd as string | undefined) ?? process.cwd();
		const projectPath =
			(payload.tool_input as Record<string, unknown> | undefined)?.project_path as
				| string
				| undefined;
		const resolvedPath = projectPath ?? cwd;

		const link = await readProjectLink(resolvedPath).catch(() => null);
		if (!link || link.deploy_mode !== "managed") return;

		await uploadSessionTranscript({
			projectId: link.project_id,
			deploymentId,
			transcriptPath,
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
