/**
 * Cron schedule testing logic for jack services cron test
 *
 * Validates expression, shows human-readable description and next times.
 * Optionally triggers the schedule on production (managed projects only).
 */

import { triggerCronSchedule as triggerCronScheduleApi } from "../control-plane.ts";
import { readProjectLink } from "../project-link.ts";
import {
	describeCronExpression,
	getNextScheduledTimes,
	validateCronExpression,
} from "./cron-utils.ts";

export interface CronTestOptions {
	triggerProduction?: boolean;
	interactive?: boolean;
}

export interface CronTestResult {
	valid: boolean;
	error?: string;
	expression?: string;
	description?: string;
	nextTimes?: Date[];
	triggerResult?: {
		triggered: boolean;
		status: string;
		durationMs: number;
	};
}

/**
 * Test a cron expression: validate, describe, and show next run times.
 * Optionally trigger the schedule handler on production.
 */
export async function testCronExpression(
	projectDir: string,
	expression: string,
	options: CronTestOptions = {},
): Promise<CronTestResult> {
	// Validate expression
	const validation = validateCronExpression(expression);
	if (!validation.valid) {
		return {
			valid: false,
			error: validation.error,
		};
	}

	const normalizedExpression = validation.normalized!;

	// Get description and next times
	const description = describeCronExpression(normalizedExpression);
	const nextTimes = getNextScheduledTimes(normalizedExpression, 5);

	const result: CronTestResult = {
		valid: true,
		expression: normalizedExpression,
		description,
		nextTimes,
	};

	// Optionally trigger production
	if (options.triggerProduction) {
		const link = await readProjectLink(projectDir);
		if (!link || link.deploy_mode !== "managed") {
			throw new Error("Production trigger is only available for Jack Cloud (managed) projects.");
		}

		const triggerResponse = await triggerCronScheduleApi(link.project_id, normalizedExpression);
		result.triggerResult = {
			triggered: triggerResponse.triggered,
			status: triggerResponse.status,
			durationMs: triggerResponse.duration_ms,
		};
	}

	return result;
}

/**
 * Common cron expression patterns for help output.
 */
export const COMMON_CRON_PATTERNS = [
	{ expression: "*/15 * * * *", description: "Every 15 minutes" },
	{ expression: "0 * * * *", description: "Every hour" },
	{ expression: "0 0 * * *", description: "Daily at midnight" },
	{ expression: "0 9 * * *", description: "Daily at 9am" },
	{ expression: "0 9 * * 1", description: "Every Monday at 9am" },
	{ expression: "0 0 1 * *", description: "First day of every month" },
];
