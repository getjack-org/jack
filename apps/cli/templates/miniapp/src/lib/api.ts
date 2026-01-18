import { hc } from "hono/client";
import type { AppType } from "../worker";

// Create Hono RPC client
// Note: Type inference may show 'unknown' in IDE but works at runtime
// The explicit response types below ensure type safety for API consumers
const client = hc<AppType>("/");

// Export typed client - if AppType inference fails, these explicit types provide safety
export const api = client as {
	api: {
		guestbook: {
			$get: () => Promise<
				Response & {
					json: () => Promise<{
						entries: Array<{
							id: number;
							fid: number;
							username: string;
							display_name: string | null;
							pfp_url: string | null;
							message: string;
							created_at: string;
						}>;
					}>;
				}
			>;
			$post: (options: {
				json: {
					fid: number;
					username: string;
					displayName?: string;
					pfpUrl?: string;
					message: string;
				};
			}) => Promise<
				Response & {
					json: () => Promise<{
						entry?: {
							id: number;
							fid: number;
							username: string;
							display_name: string | null;
							pfp_url: string | null;
							message: string;
							created_at: string;
						};
						error?: string;
					}>;
				}
			>;
		};
		ai: {
			generate: {
				$post: (options: {
					json: { prompt: string; schema?: object };
				}) => Promise<
					Response & {
						json: () => Promise<{
							result?: string;
							provider?: "openai" | "workers-ai";
							error?: string;
						}>;
					}
				>;
			};
		};
		notifications: {
			$get: (options?: {
				query: { fid: string };
			}) => Promise<Response & { json: () => Promise<unknown> }>;
		};
	};
};
