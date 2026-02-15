import { estimateTokenCount } from "tokenx";
import type { AIUsageDataPoint } from "./types";

/**
 * Metering service for AI and Vectorize usage tracking.
 *
 * Writes to the same Analytics Engine dataset (jack_usage) as dispatch-worker,
 * with different blob values to distinguish binding types from HTTP requests.
 *
 * Data Point Schema (extends dispatch-worker schema):
 * - indexes: [project_id]
 * - blobs:
 *   1. org_id
 *   2. tier (always "free" for now)
 *   3. binding_type ("ai" | "vectorize")
 *   4. model (for AI) or index_name (for Vectorize)
 *   5. operation ("run" for AI, "query"/"upsert"/"delete" for Vectorize)
 *   6-10. reserved for future use
 * - doubles:
 *   1. count (always 1)
 *   2. duration_ms
 *   3. tokens_in (estimated from input)
 *   4. tokens_out (estimated from output)
 */
export class MeteringService {
	constructor(private ae: AnalyticsEngineDataset) {}

	/**
	 * Estimate token count from text using tokenx library.
	 * Provides ~94% accuracy with language-aware heuristics in a 2kB bundle.
	 * Much better than simple character/4 approximation.
	 */
	static estimateTokens(text: string): number {
		if (!text) return 0;
		return estimateTokenCount(text);
	}

	/**
	 * Estimate tokens from AI input (messages array or prompt string)
	 * Uses tokenx for ~94% accuracy with language-aware heuristics.
	 */
	static estimateInputTokens(inputs: unknown): number {
		if (!inputs) return 0;

		// Handle messages array (chat format)
		if (typeof inputs === "object" && inputs !== null) {
			const obj = inputs as Record<string, unknown>;

			// Chat messages format: { messages: [{ role, content }] }
			if (Array.isArray(obj.messages)) {
				// Concatenate all message content for token estimation
				const allContent: string[] = [];
				for (const msg of obj.messages) {
					if (typeof msg === "object" && msg !== null) {
						const content = (msg as Record<string, unknown>).content;
						if (typeof content === "string") {
							allContent.push(content);
						}
					}
				}
				return estimateTokenCount(allContent.join(" "));
			}

			// Simple prompt format: { prompt: "..." }
			if (typeof obj.prompt === "string") {
				return MeteringService.estimateTokens(obj.prompt);
			}
		}

		// Raw string input
		if (typeof inputs === "string") {
			return MeteringService.estimateTokens(inputs);
		}

		return 0;
	}

	/**
	 * Log AI binding call to Analytics Engine
	 */
	logAICall(data: AIUsageDataPoint): void {
		try {
			this.ae.writeDataPoint({
				indexes: [data.project_id],
				blobs: [
					data.org_id, // blob1: org for aggregation
					"free", // blob2: tier (extend later)
					"ai", // blob3: binding type
					data.model, // blob4: model name
					"run", // blob5: operation
					data.identity_source || "", // blob6: identity source ("props" | "headers")
					"", // blob7: reserved
					"", // blob8: reserved
					"", // blob9: reserved
					"", // blob10: reserved
				],
				doubles: [
					1, // double1: request count
					data.duration_ms, // double2: latency
					data.tokens_in || 0, // double3: input tokens
					data.tokens_out || 0, // double4: output tokens
				],
			});
		} catch (error) {
			// Non-fatal: metering failed but request succeeded
			console.error("Failed to log AI usage:", error);
		}
	}

	/**
	 * Log Vectorize binding call to Analytics Engine
	 */
	logVectorizeCall(data: {
		project_id: string;
		org_id: string;
		index_name: string;
		operation: "query" | "upsert" | "deleteByIds" | "getByIds" | "describe";
		duration_ms: number;
		vector_count?: number;
		identity_source?: string;
	}): void {
		try {
			this.ae.writeDataPoint({
				indexes: [data.project_id],
				blobs: [
					data.org_id, // blob1
					"free", // blob2
					"vectorize", // blob3
					data.index_name, // blob4
					data.operation, // blob5
					data.identity_source || "", // blob6: identity source ("props" | "headers")
					"",
					"",
					"",
					"",
				],
				doubles: [
					1, // double1: request count
					data.duration_ms, // double2: latency
					data.vector_count || 0, // double3: vector count
					0, // double4: reserved
				],
			});
		} catch (error) {
			console.error("Failed to log Vectorize usage:", error);
		}
	}
}
