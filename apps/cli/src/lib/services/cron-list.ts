/**
 * Cron schedule listing logic for jack services cron list
 *
 * Fetches cron schedules from control plane API.
 * Only supported for managed (Jack Cloud) projects.
 */

import {
	type CronScheduleInfo,
	listCronSchedules as listCronSchedulesApi,
} from "../control-plane.ts";
import { readProjectLink } from "../project-link.ts";

export interface CronScheduleListEntry {
	id: string;
	expression: string;
	description: string;
	enabled: boolean;
	nextRunAt: string;
	lastRunAt: string | null;
	lastRunStatus: string | null;
	lastRunDurationMs: number | null;
	consecutiveFailures: number;
	createdAt: string;
}

/**
 * List all cron schedules for the current project.
 *
 * For managed projects: calls control plane GET /v1/projects/:id/crons
 * For BYO projects: throws error (not supported)
 */
export async function listCronSchedules(projectDir: string): Promise<CronScheduleListEntry[]> {
	// Must be managed mode
	const link = await readProjectLink(projectDir);
	if (!link || link.deploy_mode !== "managed") {
		throw new Error(
			"Cron schedules are only supported for Jack Cloud (managed) projects.\n" +
				"BYO projects can use native Cloudflare cron triggers in wrangler.toml.",
		);
	}

	// Fetch from control plane
	const schedules = await listCronSchedulesApi(link.project_id);

	// Map to our format
	return schedules.map((s: CronScheduleInfo) => ({
		id: s.id,
		expression: s.expression,
		description: s.description,
		enabled: s.enabled,
		nextRunAt: s.next_run_at,
		lastRunAt: s.last_run_at,
		lastRunStatus: s.last_run_status,
		lastRunDurationMs: s.last_run_duration_ms,
		consecutiveFailures: s.consecutive_failures,
		createdAt: s.created_at,
	}));
}
