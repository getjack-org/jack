import { indexLatestDeploymentSource, markCodeIndexEnqueued } from "./ask-code-index";
import type { Bindings, Deployment } from "./types";

export interface AskIndexQueueMessage {
	version: 1;
	projectId: string;
	deploymentId: string;
	enqueuedAt: string;
	reason: "deploy" | "rollback";
}

const MAX_ATTEMPTS = 4;
const RETRY_BACKOFF_SECONDS = [10, 45, 180, 600];

function isPermanentIndexError(message: string): boolean {
	const lower = message.toLowerCase();
	return (
		lower.includes("has no artifact bucket key") ||
		lower.includes("source.zip not found") ||
		lower.includes("invalid message body shape")
	);
}

function isAskIndexQueueMessage(value: unknown): value is AskIndexQueueMessage {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return (
		record.version === 1 &&
		typeof record.projectId === "string" &&
		record.projectId.length > 0 &&
		typeof record.deploymentId === "string" &&
		record.deploymentId.length > 0 &&
		typeof record.enqueuedAt === "string" &&
		(record.reason === "deploy" || record.reason === "rollback")
	);
}

function parseQueueMessage(raw: unknown): AskIndexQueueMessage | null {
	if (!isAskIndexQueueMessage(raw)) return null;
	return raw;
}

function retryDelayForAttempt(attempts: number): number {
	const index = Math.max(0, Math.min(RETRY_BACKOFF_SECONDS.length - 1, attempts - 1));
	return RETRY_BACKOFF_SECONDS[index] ?? 60;
}

async function getDeploymentForIndexMessage(
	env: Bindings,
	message: AskIndexQueueMessage,
): Promise<Deployment | null> {
	return env.DB.prepare("SELECT * FROM deployments WHERE id = ? AND project_id = ?")
		.bind(message.deploymentId, message.projectId)
		.first<Deployment>();
}

export async function enqueueAskIndexJob(
	env: Bindings,
	message: AskIndexQueueMessage,
): Promise<void> {
	if (!env.ASK_INDEX_QUEUE) {
		throw new Error("ASK_INDEX_QUEUE binding is not configured");
	}

	await env.ASK_INDEX_QUEUE.send(message, { contentType: "json" });
	await markCodeIndexEnqueued(env, {
		projectId: message.projectId,
		deploymentId: message.deploymentId,
		queueAttempts: 1,
	});
}

export async function consumeAskIndexBatch(
	batch: MessageBatch<unknown>,
	env: Bindings,
): Promise<void> {
	for (const message of batch.messages) {
		const parsed = parseQueueMessage(message.body);
		if (!parsed) {
			console.error("ask_project index queue: invalid message body shape");
			message.ack();
			continue;
		}

		try {
			const deployment = await getDeploymentForIndexMessage(env, parsed);
			if (!deployment) {
				console.warn(
					`ask_project index queue: deployment ${parsed.deploymentId} not found for project ${parsed.projectId}`,
				);
				message.ack();
				continue;
			}

			if (deployment.status !== "live") {
				console.info(
					`ask_project index queue: skip deployment ${deployment.id} because status=${deployment.status}`,
				);
				message.ack();
				continue;
			}

			await indexLatestDeploymentSource(env, {
				projectId: parsed.projectId,
				deployment,
				queueAttempts: message.attempts,
				rethrowOnFailure: true,
			});
			message.ack();
		} catch (error) {
			const messageText = error instanceof Error ? error.message : String(error);
			const shouldRetry = message.attempts < MAX_ATTEMPTS && !isPermanentIndexError(messageText);
			console.error(
				`ask_project index queue: job failed for deployment ${parsed.deploymentId} attempt=${message.attempts}: ${messageText}`,
			);
			if (shouldRetry) {
				message.retry({
					delaySeconds: retryDelayForAttempt(message.attempts),
				});
			} else {
				message.ack();
			}
		}
	}
}
