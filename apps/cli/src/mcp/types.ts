/**
 * MCP tool response format
 * Provides structured, machine-readable responses for AI agents
 */
export interface McpToolResponse<T = unknown> {
	success: boolean;
	data?: T;
	notes?: string[]; // Situational context for AI agents (e.g. eventual consistency caveats)
	error?: {
		code: string; // Machine-readable: 'AUTH_FAILED', 'PROJECT_NOT_FOUND'
		message: string; // Human-readable description
		suggestion?: string; // What to do next
	};
	meta?: {
		duration_ms: number;
		jack_version: string;
	};
}

/**
 * Error codes for MCP tool responses
 */
export { JackErrorCode as McpErrorCode } from "../lib/errors.ts";

/**
 * MCP server configuration options
 */
export interface McpServerOptions {
	projectPath?: string;
	debug?: boolean;
}

/**
 * Debug logger function type
 */
export type DebugLogger = (message: string, data?: unknown) => void;
