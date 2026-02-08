/**
 * Cron schedule deletion logic for jack services cron delete
 *
 * Finds schedule by expression and deletes via control plane API.
 * Only supported for managed (Jack Cloud) projects.
 */

import {
	deleteCronSchedule as deleteCronScheduleApi,
	listCronSchedules as listCronSchedulesApi,
} from "../control-plane.ts";
import { readProjectLink } from "../project-link.ts";
import { normalizeCronExpression } from "./cron-utils.ts";

export interface DeleteCronScheduleOptions {
	interactive?: boolean;
}

export interface DeleteCronScheduleResult {
	expression: string;
	deleted: boolean;
}

/**
 * Delete a cron schedule by its expression.
 *
 * For managed projects: finds the schedule by expression and calls DELETE API
 * For BYO projects: throws error (not supported)
 */
export async function deleteCronSchedule(
	projectDir: string,
	expression: string,
	options: DeleteCronScheduleOptions = {},
): Promise<DeleteCronScheduleResult> {
	const normalizedExpression = normalizeCronExpression(expression);

	// Must be managed mode
	const link = await readProjectLink(projectDir);
	if (!link || link.deploy_mode !== "managed") {
		throw new Error(
			"Cron schedules are only supported for Jack Cloud (managed) projects.\n" +
				"BYO projects can use native Cloudflare cron triggers in wrangler.toml.",
		);
	}

	// Find the schedule by expression
	const schedules = await listCronSchedulesApi(link.project_id);
	const schedule = schedules.find(
		(s) => normalizeCronExpression(s.expression) === normalizedExpression,
	);

	if (!schedule) {
		throw new Error(
			`No cron schedule found with expression "${normalizedExpression}".\n` +
				"Use 'jack services cron list' to see all schedules.",
		);
	}

	// Delete via control plane
	await deleteCronScheduleApi(link.project_id, schedule.id);

	return {
		expression: normalizedExpression,
		deleted: true,
	};
}
