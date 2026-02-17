import {
	findRouteMatchesForEndpoint,
	getLatestCodeIndexStatus,
	searchLatestCodeIndex,
	searchSourceFallback,
} from "./ask-code-index";
import { CloudflareClient } from "./cloudflare-api";
import { DeploymentService } from "./deployment-service";
import { ProvisioningService } from "./provisioning";
import type { Bindings, Deployment } from "./types";

export interface AskProjectHints {
	endpoint?: string;
	method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	deployment_id?: string;
}

export interface AskProjectRequest {
	question: string;
	hints?: AskProjectHints;
}

export interface AskProjectEvidence {
	id: string;
	type:
		| "endpoint_test"
		| "log_event"
		| "sql_result"
		| "deployment_event"
		| "env_snapshot"
		| "code_chunk"
		| "code_symbol"
		| "index_status";
	source: string;
	summary: string;
	timestamp: string;
	relation: "supports" | "conflicts" | "gap";
	meta?: Record<string, unknown>;
}

export interface AskProjectResponse {
	answer: string;
	evidence: AskProjectEvidence[];
}

interface AskProjectInput {
	env: Bindings;
	project: {
		id: string;
		slug: string;
		owner_username: string | null;
	};
	question: string;
	hints?: AskProjectHints;
}

interface EndpointCheckResult {
	status: number;
	durationMs: number;
	bodyExcerpt: string;
}

function toIsoTimestamp(value?: string | null): string {
	if (!value) return new Date().toISOString();
	if (value.includes("T")) return value;
	return `${value.replace(" ", "T")}Z`;
}

function redactText(input: string): string {
	return input
		.replace(/\b(sk|pk|rk|jkt)_[A-Za-z0-9_-]+\b/g, "[redacted-token]")
		.replace(/\b(password|secret|token|api[_-]?key)\b\s*[:=]\s*["'][^"']+["']/gi, "$1=[redacted]");
}

function isWhyShippedQuestion(question: string): boolean {
	const q = question.toLowerCase();
	return q.includes("why did we ship") || q.includes("why we shipped") || q.includes("why shipped");
}

function isChangeQuestion(question: string): boolean {
	const q = question.toLowerCase();
	return q.includes("what changed") || q.includes("recently") || q.includes("caused this");
}

function extractEndpointFromQuestion(question: string): string | null {
	const match = question.match(/(\/[a-zA-Z0-9._~:/?#\[\]@!$&'()*+,;=-]+)/);
	return match?.[1] ?? null;
}

function looksLikeFailureQuestion(question: string): boolean {
	const q = question.toLowerCase();
	return (
		q.includes("500") ||
		q.includes("error") ||
		q.includes("broken") ||
		q.includes("fail") ||
		q.includes("not working")
	);
}

function tokenizeQuestion(input: string): string[] {
	const stopwords = new Set([
		"why",
		"did",
		"we",
		"ship",
		"shipped",
		"how",
		"what",
		"the",
		"this",
		"that",
		"with",
		"from",
		"into",
		"for",
		"and",
		"our",
		"your",
		"was",
		"were",
		"is",
		"are",
	]);

	return input
		.toLowerCase()
		.replace(/[^a-z0-9/_-]+/g, " ")
		.split(/\s+/)
		.filter((token) => token.length >= 3 && !stopwords.has(token));
}

function inferDeploymentFromQuestion(
	question: string,
	deployments: Deployment[],
): Deployment | null {
	const tokens = tokenizeQuestion(question);
	if (tokens.length === 0) return null;

	let best: { deployment: Deployment; score: number } | null = null;
	for (const deployment of deployments) {
		const message = deployment.message?.toLowerCase();
		if (!message) continue;

		let score = 0;
		for (const token of tokens) {
			if (message.includes(token)) score += 1;
		}
		if (score === 0) continue;

		if (!best || score > best.score) {
			best = { deployment, score };
		}
	}

	return best?.deployment ?? null;
}

class EvidenceCollector {
	private index = 1;
	private readonly list: AskProjectEvidence[] = [];

	add(
		type: AskProjectEvidence["type"],
		source: string,
		summary: string,
		relation: AskProjectEvidence["relation"],
		meta?: Record<string, unknown>,
		timestamp?: string,
	): void {
		this.list.push({
			id: `ev_${String(this.index).padStart(3, "0")}`,
			type,
			source,
			summary: redactText(summary).slice(0, 500),
			relation,
			timestamp: timestamp ?? new Date().toISOString(),
			meta,
		});
		this.index += 1;
	}

	values(): AskProjectEvidence[] {
		return this.list;
	}
}

async function runEndpointCheck(
	baseUrl: string,
	path: string,
	method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
): Promise<EndpointCheckResult> {
	const normalized = path.startsWith("/") ? path : `/${path}`;
	const url = new URL(normalized, baseUrl);
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 8000);
	const startedAt = Date.now();
	try {
		const response = await fetch(url.toString(), {
			method,
			redirect: "follow",
			signal: controller.signal,
		});
		const body = (await response.text()).slice(0, 600);
		return {
			status: response.status,
			durationMs: Date.now() - startedAt,
			bodyExcerpt: body,
		};
	} finally {
		clearTimeout(timeout);
	}
}

function summarizeDeploymentMessage(deployment: Deployment): string {
	const createdAt = toIsoTimestamp(deployment.created_at);
	if (deployment.message) {
		return `Deployment ${deployment.id} (${deployment.status}) at ${createdAt}: ${deployment.message}`;
	}
	return `Deployment ${deployment.id} (${deployment.status}) at ${createdAt} has no deploy message`;
}

function pickAnswer(params: {
	question: string;
	latestDeployment: Deployment | null;
	endpointPath: string | null;
	endpointCheck: EndpointCheckResult | null;
	missingTableName: string | null;
	tableMissingConfirmed: boolean;
	routeMatches: Array<{ path: string; signature: string | null }>;
	deployMessage: string | null;
	hasInsufficientEvidence: boolean;
}): string {
	const {
		question,
		latestDeployment,
		endpointPath,
		endpointCheck,
		missingTableName,
		tableMissingConfirmed,
		routeMatches,
		deployMessage,
		hasInsufficientEvidence,
	} = params;

	if (isWhyShippedQuestion(question)) {
		if (deployMessage) {
			return `The latest deployment appears to have been shipped for: "${deployMessage}".`;
		}
		return "I can't determine why it was shipped from deployment metadata because the deploy message is missing.";
	}

	if (tableMissingConfirmed && missingTableName && endpointPath) {
		return `The likely root cause is a missing D1 table "${missingTableName}" for endpoint ${endpointPath}.`;
	}

	if (endpointCheck && endpointPath) {
		if (endpointCheck.status >= 500) {
			if (routeMatches.length > 0) {
				const files = routeMatches
					.map((m) => m.path)
					.filter((v, i, arr) => arr.indexOf(v) === i)
					.slice(0, 3)
					.join(", ");
				return `Endpoint ${endpointPath} is returning ${endpointCheck.status}. Likely related route code is in: ${files}.`;
			}
			return `Endpoint ${endpointPath} is returning ${endpointCheck.status}. I can confirm a runtime failure but route mapping evidence is limited.`;
		}
		if (
			endpointCheck.status >= 200 &&
			endpointCheck.status < 500 &&
			looksLikeFailureQuestion(question)
		) {
			return `I could not reproduce a server failure for ${endpointPath}; current status is ${endpointCheck.status}.`;
		}
	}

	if (isChangeQuestion(question) && latestDeployment) {
		if (latestDeployment.message) {
			return `The most recent change is deployment ${latestDeployment.id} with message: "${latestDeployment.message}".`;
		}
		return `Deployment ${latestDeployment.id} is the most recent change, but it has no deploy message.`;
	}

	if (hasInsufficientEvidence) {
		return "I can’t determine this confidently with the current evidence. See gaps in evidence for what’s missing.";
	}

	return "Based on current evidence, I can provide partial debugging context but not a high-confidence root cause yet.";
}

export async function answerProjectQuestion(input: AskProjectInput): Promise<AskProjectResponse> {
	const { env, project, question, hints } = input;
	const evidence = new EvidenceCollector();
	const deploymentService = new DeploymentService(env);
	const provisioning = new ProvisioningService(env);

	const latestDeployment = await deploymentService.getLatestDeployment(project.id);
	const deployments = (await deploymentService.listDeployments(project.id)).slice(0, 10);

	if (!latestDeployment) {
		evidence.add(
			"deployment_event",
			"deployments",
			"No live deployment found for this project.",
			"gap",
		);
		return {
			answer: "I can't answer this because there is no live deployment for this project yet.",
			evidence: evidence.values(),
		};
	}

	const hintedDeploymentId = hints?.deployment_id?.trim();
	const hintedDeployment = hintedDeploymentId
		? deployments.find((d) => d.id === hintedDeploymentId || d.id.endsWith(hintedDeploymentId))
		: undefined;
	const inferredDeployment =
		!hintedDeployment && isWhyShippedQuestion(question)
			? inferDeploymentFromQuestion(question, deployments)
			: null;
	const targetDeployment = hintedDeployment ?? inferredDeployment ?? latestDeployment;

	evidence.add(
		"deployment_event",
		"deployments",
		summarizeDeploymentMessage(targetDeployment),
		"supports",
		{
			deployment_id: targetDeployment.id,
			status: targetDeployment.status,
			source: targetDeployment.source,
		},
		toIsoTimestamp(targetDeployment.created_at),
	);

	const historicalDeployments = deployments.filter((d) => d.id !== targetDeployment.id).slice(0, 4);
	for (const deployment of historicalDeployments) {
		evidence.add(
			"deployment_event",
			"deployments",
			summarizeDeploymentMessage(deployment),
			"supports",
			{
				deployment_id: deployment.id,
				status: deployment.status,
				source: deployment.source,
			},
			toIsoTimestamp(deployment.created_at),
		);
	}

	const resources = await provisioning.getProjectResources(project.id);
	evidence.add(
		"env_snapshot",
		"resources",
		`Project has ${resources.length} active resources.`,
		"supports",
		{
			resource_types: resources.map((r) => r.resource_type),
		},
	);

	const latestIndex = await getLatestCodeIndexStatus(env, project.id);
	if (!latestIndex) {
		evidence.add("index_status", "code_index_latest", "No latest code index found yet.", "gap");
	} else if (latestIndex.status !== "ready") {
		evidence.add(
			"index_status",
			"code_index_latest",
			`Latest code index status is ${latestIndex.status}.`,
			"gap",
			{
				deployment_id: latestIndex.deploymentId,
			},
			latestIndex.indexedAt,
		);
	} else if (latestIndex.deploymentId !== latestDeployment.id) {
		evidence.add(
			"index_status",
			"code_index_latest",
			`Latest code index is stale (indexed deployment ${latestIndex.deploymentId}, latest live ${latestDeployment.id}).`,
			"gap",
			{
				indexed_deployment_id: latestIndex.deploymentId,
				latest_deployment_id: latestDeployment.id,
			},
			latestIndex.indexedAt,
		);
	} else {
		evidence.add(
			"index_status",
			"code_index_latest",
			`Latest code index is ready for deployment ${latestDeployment.id}.`,
			"supports",
			{
				deployment_id: latestIndex.deploymentId,
				file_count: latestIndex.fileCount,
				symbol_count: latestIndex.symbolCount,
				chunk_count: latestIndex.chunkCount,
				last_duration_ms: latestIndex.lastDurationMs,
				queue_attempts: latestIndex.queueAttempts,
			},
			latestIndex.indexedAt,
		);
	}

	const endpointPath = hints?.endpoint ?? extractEndpointFromQuestion(question);
	const endpointMethod = hints?.method ?? "GET";
	let liveChecks = 0;
	let endpointCheck: EndpointCheckResult | null = null;
	let missingTableName: string | null = null;
	let tableMissingConfirmed = false;

	if (endpointPath && liveChecks < 4) {
		const baseUrl = project.owner_username
			? `https://${project.owner_username}-${project.slug}.runjack.xyz`
			: `https://${project.slug}.runjack.xyz`;

		try {
			liveChecks += 1;
			endpointCheck = await runEndpointCheck(baseUrl, endpointPath, endpointMethod);
			const relation = endpointCheck.status >= 500 ? "supports" : "conflicts";
			evidence.add(
				"endpoint_test",
				"live_endpoint_check",
				`${endpointMethod} ${endpointPath} returned ${endpointCheck.status} in ${endpointCheck.durationMs}ms.`,
				relation,
				{
					status: endpointCheck.status,
					duration_ms: endpointCheck.durationMs,
					body_excerpt: redactText(endpointCheck.bodyExcerpt).slice(0, 240),
				},
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			evidence.add(
				"endpoint_test",
				"live_endpoint_check",
				`Failed to test ${endpointMethod} ${endpointPath}: ${message}`,
				"gap",
			);
		}
	}

	if (endpointCheck?.status && endpointCheck.status >= 500 && liveChecks < 4) {
		const missingTable = endpointCheck.bodyExcerpt.match(/no such table:\s*([A-Za-z0-9_]+)/i);
		if (missingTable?.[1]) {
			missingTableName = missingTable[1];
			const d1Resource = await env.DB.prepare(
				"SELECT provider_id FROM resources WHERE project_id = ? AND resource_type = 'd1' AND status != 'deleted' ORDER BY created_at ASC LIMIT 1",
			)
				.bind(project.id)
				.first<{ provider_id: string }>();

			if (d1Resource) {
				try {
					liveChecks += 1;
					const cfClient = new CloudflareClient(env);
					const result = await cfClient.executeD1Query(
						d1Resource.provider_id,
						"SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
						[missingTableName],
					);
					const found = (result.results?.length ?? 0) > 0;
					tableMissingConfirmed = !found;
					evidence.add(
						"sql_result",
						"d1_table_check",
						found
							? `Table "${missingTableName}" exists in D1.`
							: `Table "${missingTableName}" does not exist in D1.`,
						found ? "conflicts" : "supports",
						{
							table: missingTableName,
							exists: found,
						},
					);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					evidence.add(
						"sql_result",
						"d1_table_check",
						`Failed to verify table "${missingTableName}" in D1: ${message}`,
						"gap",
					);
				}
			} else {
				evidence.add(
					"sql_result",
					"d1_table_check",
					"Could not verify missing-table error because project has no D1 resource.",
					"gap",
				);
			}
		}
	}

	const codeQuery = endpointPath ?? question;
	const routeMatches =
		endpointPath && latestIndex?.status === "ready"
			? await findRouteMatchesForEndpoint(env, project.id, endpointPath, 4)
			: [];

	if (routeMatches.length > 0) {
		for (const match of routeMatches.slice(0, 3)) {
			evidence.add(
				"code_symbol",
				"code_index_latest",
				`Route match in ${match.path}: ${match.signature ?? match.symbol}`,
				"supports",
				{
					path: match.path,
					line_start: match.lineStart,
					line_end: match.lineEnd,
				},
			);
		}
	} else if (endpointPath) {
		evidence.add(
			"code_symbol",
			"code_index_latest",
			`No route symbol match found for endpoint ${endpointPath}.`,
			"gap",
		);
	}

	let codeHits =
		latestIndex?.status === "ready"
			? await searchLatestCodeIndex(env, project.id, codeQuery, 3)
			: [];

	if (codeHits.length === 0) {
		const fallback = await searchSourceFallback(env, targetDeployment, codeQuery, 3);
		if (fallback.length > 0) {
			codeHits = fallback;
			evidence.add(
				"index_status",
				"source_fallback",
				"Used source fallback search because latest code index had no hits.",
				"gap",
			);
		}
	}

	for (const hit of codeHits.slice(0, 3)) {
		evidence.add(
			"code_chunk",
			"code_search",
			`Possible relevant code in ${hit.path}: ${hit.snippet}`,
			"supports",
			{
				path: hit.path,
				line_start: hit.lineStart,
				line_end: hit.lineEnd,
			},
		);
	}

	if (codeHits.length === 0) {
		evidence.add(
			"code_chunk",
			"code_search",
			"No relevant code chunks were found for this query.",
			"gap",
		);
	}

	const hasInsufficientEvidence = evidence.values().some((e) => e.relation === "gap");
	const answer = pickAnswer({
		question,
		latestDeployment,
		endpointPath,
		endpointCheck,
		missingTableName,
		tableMissingConfirmed,
		routeMatches,
		deployMessage: targetDeployment.message,
		hasInsufficientEvidence,
	});

	return {
		answer,
		evidence: evidence.values(),
	};
}
