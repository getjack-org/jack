import packageJson from "../../package.json" with { type: "json" };
import { isJackError } from "../lib/errors.ts";
import { McpErrorCode, type McpToolResponse } from "./types.ts";

/**
 * Format a successful MCP tool response
 */
export function formatSuccessResponse<T>(data: T, startTime: number, notes?: string[]): McpToolResponse<T> {
	return {
		success: true,
		data,
		...(notes?.length && { notes }),
		meta: {
			duration_ms: Date.now() - startTime,
			jack_version: packageJson.version,
		},
	};
}

/**
 * Format an error MCP tool response
 */
export function formatErrorResponse(error: unknown, startTime: number): McpToolResponse {
	const message = error instanceof Error ? error.message : String(error);
	const code = classifyMcpError(error);
	const suggestion = isJackError(error)
		? (error.suggestion ?? getSuggestionForError(code))
		: getSuggestionForError(code);

	return {
		success: false,
		error: {
			code,
			message,
			suggestion,
		},
		meta: {
			duration_ms: Date.now() - startTime,
			jack_version: packageJson.version,
		},
	};
}

/**
 * Classify an error into an MCP error code
 */
export function classifyMcpError(error: unknown): McpErrorCode {
	if (isJackError(error)) {
		return error.code as McpErrorCode;
	}

	if (!(error instanceof Error)) {
		return McpErrorCode.INTERNAL_ERROR;
	}

	const message = error.message.toLowerCase();

	// Authentication errors
	if (
		message.includes("not authenticated") ||
		message.includes("authentication failed") ||
		message.includes("invalid token")
	) {
		return McpErrorCode.AUTH_FAILED;
	}

	// Wrangler-specific auth
	if (
		message.includes("wrangler") &&
		(message.includes("auth") || message.includes("login") || message.includes("expired"))
	) {
		return McpErrorCode.WRANGLER_AUTH_EXPIRED;
	}

	// Project not found
	if (
		message.includes("project not found") ||
		message.includes("no project") ||
		message.includes("directory not found")
	) {
		return McpErrorCode.PROJECT_NOT_FOUND;
	}

	// Template not found
	if (message.includes("template not found") || message.includes("invalid template")) {
		return McpErrorCode.TEMPLATE_NOT_FOUND;
	}

	// Build failures
	if (
		message.includes("build failed") ||
		message.includes("compilation error") ||
		message.includes("syntax error")
	) {
		return McpErrorCode.BUILD_FAILED;
	}

	// Deploy failures
	if (
		message.includes("deploy failed") ||
		message.includes("deployment failed") ||
		message.includes("publish failed")
	) {
		return McpErrorCode.DEPLOY_FAILED;
	}

	// Validation errors
	if (
		message.includes("validation") ||
		message.includes("invalid") ||
		message.includes("required")
	) {
		return McpErrorCode.VALIDATION_ERROR;
	}

	return McpErrorCode.INTERNAL_ERROR;
}

/**
 * Get a helpful suggestion for an error code
 */
export function getSuggestionForError(code: McpErrorCode): string {
	switch (code) {
		case McpErrorCode.AUTH_FAILED:
			return "Check your authentication credentials and try again.";

		case McpErrorCode.WRANGLER_AUTH_EXPIRED:
			return "Run 'wrangler login' to re-authenticate with Cloudflare.";

		case McpErrorCode.PROJECT_NOT_FOUND:
			return "Ensure you're in a valid jack project directory or specify the project path.";

		case McpErrorCode.TEMPLATE_NOT_FOUND:
			return "Use a valid template name. Run 'jack new --help' to see available templates.";

		case McpErrorCode.BUILD_FAILED:
			return "Check your code for syntax errors and ensure all dependencies are installed.";

		case McpErrorCode.DEPLOY_FAILED:
			return "Verify your Cloudflare configuration and check the deployment logs for details.";

		case McpErrorCode.VALIDATION_ERROR:
			return "Review the error message and ensure all required fields are provided correctly.";

		default:
			return "Check the error message above for details. If the problem persists, try running the equivalent CLI command directly.";
	}
}
