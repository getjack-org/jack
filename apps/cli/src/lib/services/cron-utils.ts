/**
 * Cron expression utilities for validation, parsing, and human-readable descriptions.
 */

import parser from "cron-parser";
import cronstrue from "cronstrue";

/**
 * Normalize a cron expression by collapsing whitespace.
 * "0  *  * * *" -> "0 * * * *"
 */
export function normalizeCronExpression(expression: string): string {
	return expression.trim().replace(/\s+/g, " ");
}

/**
 * Validate a cron expression.
 * Returns normalized expression if valid, error message if invalid.
 */
export function validateCronExpression(expression: string): {
	valid: boolean;
	error?: string;
	normalized?: string;
} {
	try {
		const normalized = normalizeCronExpression(expression);
		parser.parseExpression(normalized);
		return { valid: true, normalized };
	} catch (e) {
		return { valid: false, error: e instanceof Error ? e.message : String(e) };
	}
}

/**
 * Check if a cron expression has at least the minimum interval between runs.
 * Returns true if the interval is >= minMinutes.
 */
export function checkMinimumInterval(expression: string, minMinutes: number): boolean {
	try {
		const interval = parser.parseExpression(expression);
		const first = interval.next().toDate();
		const second = interval.next().toDate();
		return (second.getTime() - first.getTime()) / 1000 / 60 >= minMinutes;
	} catch {
		return false;
	}
}

/**
 * Get the next N scheduled times for a cron expression.
 */
export function getNextScheduledTimes(expression: string, count: number): Date[] {
	const interval = parser.parseExpression(expression);
	const times: Date[] = [];
	for (let i = 0; i < count; i++) {
		times.push(interval.next().toDate());
	}
	return times;
}

/**
 * Get a human-readable description of a cron expression.
 * e.g., "0 * * * *" -> "At minute 0"
 */
export function describeCronExpression(expression: string): string {
	try {
		return cronstrue.toString(expression);
	} catch {
		return expression;
	}
}

/**
 * Compute the next run time for a cron expression as ISO string.
 */
export function computeNextRun(expression: string): string {
	return parser.parseExpression(expression).next().toDate().toISOString();
}
