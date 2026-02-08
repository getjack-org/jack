/**
 * Cron schedule creation logic for jack services cron create
 *
 * Validates cron expression, checks minimum interval, and calls control plane API.
 * Only supported for managed (Jack Cloud) projects.
 */

import { createCronSchedule as createCronScheduleApi } from "../control-plane.ts";
import { readProjectLink } from "../project-link.ts";
import { checkMinimumInterval, validateCronExpression } from "./cron-utils.ts";

// Minimum interval between cron runs (in minutes)
const MIN_INTERVAL_MINUTES = 15;

export interface CreateCronScheduleOptions {
	interactive?: boolean;
}

export interface CreateCronScheduleResult {
	id: string;
	expression: string;
	description: string;
	nextRunAt: string;
	created: boolean;
}

/**
 * Create a cron schedule for the current project.
 *
 * For managed projects: calls control plane POST /v1/projects/:id/crons
 * For BYO projects: throws error (not supported)
 */
export async function createCronSchedule(
	projectDir: string,
	expression: string,
	options: CreateCronScheduleOptions = {},
): Promise<CreateCronScheduleResult> {
	// Validate expression
	const validation = validateCronExpression(expression);
	if (!validation.valid) {
		throw new Error(`Invalid cron expression: ${validation.error}`);
	}

	const normalizedExpression = validation.normalized!;

	// Check minimum interval (15 minutes)
	if (!checkMinimumInterval(normalizedExpression, MIN_INTERVAL_MINUTES)) {
		throw new Error(
			`Cron schedules must run at least ${MIN_INTERVAL_MINUTES} minutes apart. ` +
				"This limit helps ensure reliable execution.",
		);
	}

	// Must be managed mode
	const link = await readProjectLink(projectDir);
	if (!link || link.deploy_mode !== "managed") {
		throw new Error(
			"Cron schedules are only supported for Jack Cloud (managed) projects.\n" +
				"BYO projects can use native Cloudflare cron triggers in wrangler.toml.",
		);
	}

	// Create via control plane
	const result = await createCronScheduleApi(link.project_id, normalizedExpression);

	return {
		id: result.id,
		expression: result.expression,
		description: result.description,
		nextRunAt: result.next_run_at,
		created: true,
	};
}
