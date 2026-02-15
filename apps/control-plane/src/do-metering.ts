/**
 * Durable Objects enforcement cron.
 *
 * Runs every minute but self-gates to execute every 5 minutes.
 * Skips entirely if no DO projects exist.
 *
 * Queries Analytics Engine for per-project DO wallTime (rolling 24hr)
 * and Cloudflare GraphQL for aggregate DO cost (monthly budget alarm).
 *
 * Enforcement: if rolling 24hr wallTime exceeds threshold, remove DO
 * bindings via updateDispatchScriptSettings (worker stays online for
 * non-DO routes). Stores removed bindings for future restoration.
 *
 * Usage display is NOT handled here — the /do-usage endpoint queries
 * AE directly (same pattern as /usage and /ai-usage).
 */

import { CloudflareClient } from "./cloudflare-api";
import type { Bindings } from "./types";

const DISPATCH_NAMESPACE = "jack-tenants";

/** Rolling 24hr wall-time threshold per project in ms (8 hours at 128MB). */
const DAILY_WALL_TIME_THRESHOLD_MS = 8 * 60 * 60 * 1000; // 28.8M ms

/** Monthly global GB-s budget alarm. $500 @ $12.50/M GB-s. */
const MONTHLY_GLOBAL_WALL_TIME_THRESHOLD_MS = 320_000_000_000;

/** Minimum interval between enforcement checks (5 minutes). */
const MIN_CHECK_INTERVAL_MS = 5 * 60 * 1000;

interface ProjectDoInfo {
	id: string;
	org_id: string;
	slug: string;
	worker_name: string;
}

/**
 * Main entry point for the DO enforcement cron.
 */
export async function processDoMetering(env: Bindings): Promise<void> {
	// Gate: skip if no active DO projects exist
	const hasDoProjects = await env.DB.prepare(
		"SELECT 1 FROM projects WHERE do_migration_tag IS NOT NULL AND status = 'active' LIMIT 1",
	).first();
	if (!hasDoProjects) return;

	// Gate: skip if last check was < 5 minutes ago
	const lastCheck = await env.DB.prepare(
		"SELECT MAX(last_checked_at) as t FROM do_enforcement",
	).first<{ t: string | null }>();

	if (lastCheck?.t) {
		const elapsed = Date.now() - new Date(lastCheck.t).getTime();
		if (elapsed < MIN_CHECK_INTERVAL_MS) return;
	}

	const cfClient = new CloudflareClient(env);

	// 1. Query AE for rolling 24hr per-project DO usage
	const perProjectUsage = await queryRolling24hDoUsage(cfClient);

	// 2. Check thresholds and enforce
	if (perProjectUsage.length > 0) {
		await checkAndEnforce(env.DB, cfClient, perProjectUsage);
	}

	// 3. Query GraphQL for aggregate DO cost (budget alarm)
	const aggregateWallTimeMs = await queryAggregateDoUsageFromGraphQL(
		cfClient,
		env.CLOUDFLARE_ACCOUNT_ID,
	);
	if (aggregateWallTimeMs > MONTHLY_GLOBAL_WALL_TIME_THRESHOLD_MS) {
		console.error(
			`[do-metering] GLOBAL BUDGET ALARM: aggregate DO wallTime ${aggregateWallTimeMs}ms exceeds monthly threshold ${MONTHLY_GLOBAL_WALL_TIME_THRESHOLD_MS}ms`,
		);
		await pauseAllFreeDoProjects(env.DB, cfClient);
	}
}

/**
 * Query AE for per-project DO wallTime in the rolling 24-hour window.
 */
async function queryRolling24hDoUsage(
	cfClient: CloudflareClient,
): Promise<Array<{ project_id: string; wall_time_ms: number; requests: number }>> {
	const sql = `
		SELECT
			index1 AS project_id,
			SUM(double1 * _sample_interval) AS wall_time_ms,
			SUM(_sample_interval) AS requests
		FROM jack_do_usage
		WHERE timestamp > NOW() - INTERVAL '24' HOUR
			AND timestamp < NOW() - INTERVAL '2' MINUTE
		GROUP BY index1
	`;

	try {
		const result = await cfClient.queryAnalyticsEngine(sql);
		return result.data.map((row) => ({
			project_id: String(row.project_id ?? ""),
			wall_time_ms: Number(row.wall_time_ms ?? 0),
			requests: Number(row.requests ?? 0),
		}));
	} catch (error) {
		console.error("[do-metering] AE query failed:", error);
		return [];
	}
}

/**
 * Check per-project usage against threshold and enforce if over limit.
 */
async function checkAndEnforce(
	db: D1Database,
	cfClient: CloudflareClient,
	usage: Array<{ project_id: string; wall_time_ms: number; requests: number }>,
): Promise<void> {
	const now = new Date().toISOString();

	for (const row of usage) {
		// Update enforcement tracking with latest AE data
		await db
			.prepare(
				`INSERT INTO do_enforcement (project_id, daily_wall_time_ms, daily_requests, last_checked_at)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(project_id) DO UPDATE SET
					daily_wall_time_ms = excluded.daily_wall_time_ms,
					daily_requests = excluded.daily_requests,
					last_checked_at = excluded.last_checked_at`,
			)
			.bind(row.project_id, Math.round(row.wall_time_ms), Math.round(row.requests), now)
			.run();

		// Check if over threshold and not already enforced
		if (row.wall_time_ms > DAILY_WALL_TIME_THRESHOLD_MS) {
			const existing = await db
				.prepare("SELECT enforced_at FROM do_enforcement WHERE project_id = ?")
				.bind(row.project_id)
				.first<{ enforced_at: string | null }>();

			if (existing?.enforced_at) continue; // Already enforced

			// Get project details for enforcement
			const project = await db
				.prepare(
					`SELECT p.id, p.org_id, p.slug, r.resource_name as worker_name
					 FROM projects p
					 JOIN resources r ON r.project_id = p.id AND r.resource_type = 'worker'
					 WHERE p.id = ? AND p.status = 'active'`,
				)
				.bind(row.project_id)
				.first<ProjectDoInfo>();

			if (project) {
				await enforceProject(db, cfClient, project, row.wall_time_ms);
			}
		}
	}
}

/**
 * Enforce DO limit for a single project: store bindings, remove DO bindings.
 */
async function enforceProject(
	db: D1Database,
	cfClient: CloudflareClient,
	project: ProjectDoInfo,
	wallTimeMs: number,
	reason?: string,
): Promise<void> {
	try {
		console.error(
			`[do-metering] Enforcing DO limit for project ${project.id} (${project.slug}): ${Math.round(wallTimeMs / 1000)}s wall time in 24h`,
		);

		// Get current bindings
		const settings = await cfClient.getDispatchScriptSettings(
			DISPATCH_NAMESPACE,
			project.worker_name,
		);

		// Store DO bindings before removal (for future restoration)
		const doBindings = settings.bindings.filter((b) => b.type === "durable_object_namespace");
		const filteredBindings = settings.bindings.filter((b) => b.type !== "durable_object_namespace");

		// Remove DO bindings (keep __JACK_USAGE and everything else)
		await cfClient.updateDispatchScriptSettings(
			DISPATCH_NAMESPACE,
			project.worker_name,
			filteredBindings,
		);

		// Record enforcement with stored bindings
		await db
			.prepare(
				`UPDATE do_enforcement
				 SET enforced_at = datetime('now'),
					 enforced_reason = ?,
					 removed_bindings = ?
				 WHERE project_id = ?`,
			)
			.bind(
				reason ||
					`Rolling 24h wall time ${Math.round(wallTimeMs / 1000)}s exceeded ${DAILY_WALL_TIME_THRESHOLD_MS / 1000}s threshold`,
				JSON.stringify(doBindings),
				project.id,
			)
			.run();

		console.error(
			`[do-metering] DO bindings removed for ${project.slug}. Worker still serves non-DO routes.`,
		);
	} catch (error) {
		console.error(`[do-metering] Failed to enforce limit for project ${project.id}:`, error);
	}
}

/**
 * Query Cloudflare GraphQL for aggregate DO duration across the dispatch namespace.
 * Returns total wallTime in microseconds for the current month, converted to ms.
 */
async function queryAggregateDoUsageFromGraphQL(
	cfClient: CloudflareClient,
	accountId: string,
): Promise<number> {
	const now = new Date();
	const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

	const query = `
		query DoAggregateUsage($accountTag: String!, $since: Time!, $until: Time!) {
			viewer {
				accounts(filter: { accountTag: $accountTag }) {
					durableObjectsInvocationsAdaptiveGroups(
						filter: { datetimeMinute_geq: $since, datetimeMinute_leq: $until }
						limit: 1
					) {
						sum { requests wallTime }
					}
				}
			}
		}
	`;

	try {
		const result = await cfClient.queryGraphQL(query, {
			accountTag: accountId,
			since: monthStart.toISOString(),
			until: now.toISOString(),
		});

		const viewer = result.data.viewer as Record<string, unknown> | undefined;
		const accounts = (viewer?.accounts as Array<Record<string, unknown>>) ?? [];
		const groups =
			(accounts[0]?.durableObjectsInvocationsAdaptiveGroups as
				| Array<{ sum?: { wallTime?: number } }>
				| undefined) ?? [];

		if (groups.length === 0) return 0;

		// wallTime from GraphQL is in microseconds, convert to ms
		const wallTimeUs = Number(groups[0]?.sum?.wallTime ?? 0);
		return wallTimeUs / 1000;
	} catch (error) {
		// Fail open — don't disable anyone's DOs if GraphQL is down
		console.error("[do-metering] GraphQL query failed:", error);
		return 0;
	}
}

/**
 * Pause all free-tier projects that use DOs (global budget alarm).
 */
async function pauseAllFreeDoProjects(db: D1Database, cfClient: CloudflareClient): Promise<void> {
	const result = await db
		.prepare(
			`SELECT DISTINCT p.id, p.org_id, p.slug, r.resource_name as worker_name
			 FROM projects p
			 JOIN resources r ON r.project_id = p.id AND r.resource_type = 'worker'
			 LEFT JOIN org_billing ob ON ob.org_id = p.org_id
			 WHERE p.status = 'active'
				AND p.do_migration_tag IS NOT NULL
				AND (ob.plan_tier IS NULL OR ob.plan_tier = 'free')`,
		)
		.all<ProjectDoInfo>();

	if (!result.results?.length) return;

	console.error(
		`[do-metering] GLOBAL BUDGET: pausing ${result.results.length} free-tier DO projects`,
	);

	for (const project of result.results) {
		await enforceProject(db, cfClient, project, 0, "Global monthly DO budget alarm");
	}
}

/**
 * Get DO enforcement status for a project.
 * Used by the deployment service to warn on deploy if enforced.
 */
export async function getDoEnforcementStatus(
	db: D1Database,
	projectId: string,
): Promise<{
	enforced: boolean;
	enforced_at: string | null;
	enforced_reason: string | null;
	daily_wall_time_ms: number;
	daily_requests: number;
} | null> {
	const row = await db
		.prepare("SELECT * FROM do_enforcement WHERE project_id = ?")
		.bind(projectId)
		.first<{
			enforced_at: string | null;
			enforced_reason: string | null;
			daily_wall_time_ms: number;
			daily_requests: number;
		}>();

	if (!row) return null;

	return {
		enforced: row.enforced_at !== null,
		enforced_at: row.enforced_at,
		enforced_reason: row.enforced_reason,
		daily_wall_time_ms: row.daily_wall_time_ms,
		daily_requests: row.daily_requests,
	};
}
