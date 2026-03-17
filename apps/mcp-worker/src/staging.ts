/**
 * File staging for multi-call deploys.
 *
 * Uses KV to accumulate file changes across multiple stage_file calls,
 * then deploy reads and clears the staged changes. This works around
 * LLM output token limits that prevent sending large files in a single
 * tool call.
 *
 * Keys: staged:{project_id}
 * TTL: 10 minutes (auto-cleanup if deploy is never called)
 */

const STAGING_PREFIX = "staged:";
const STAGING_TTL = 600; // 10 minutes

export interface StagedChanges {
	files: Record<string, string | null>;
	updated_at: string;
}

function stagingKey(projectId: string): string {
	return `${STAGING_PREFIX}${projectId}`;
}

export async function getStagedChanges(
	kv: KVNamespace,
	projectId: string,
): Promise<StagedChanges | null> {
	return kv.get<StagedChanges>(stagingKey(projectId), "json");
}

export async function stageFile(
	kv: KVNamespace,
	projectId: string,
	path: string,
	content: string | null,
): Promise<StagedChanges> {
	const existing = await getStagedChanges(kv, projectId);
	const files = existing?.files ?? {};
	files[path] = content;

	const staged: StagedChanges = {
		files,
		updated_at: new Date().toISOString(),
	};

	await kv.put(stagingKey(projectId), JSON.stringify(staged), {
		expirationTtl: STAGING_TTL,
	});

	return staged;
}

export async function clearStagedChanges(
	kv: KVNamespace,
	projectId: string,
): Promise<void> {
	await kv.delete(stagingKey(projectId));
}
