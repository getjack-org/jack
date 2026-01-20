// Hook action types
export type HookAction =
	| { action: "message"; text: string }
	| { action: "box"; title: string; lines: string[] } // boxed info panel
	| { action: "url"; url: string; label?: string; open?: boolean; prompt?: boolean }
	| { action: "clipboard"; text: string; message?: string }
	| { action: "shell"; command: string; cwd?: "project"; message?: string }
	| { action: "pause"; message?: string } // press enter to continue
	| {
			action: "prompt";
			message: string;
			validate?: "json" | "accountAssociation";
			required?: boolean;
			secret?: boolean; // Mask input (for sensitive values like API keys)
			successMessage?: string;
			writeJson?: {
				path: string;
				set: Record<string, string | { from: "input" }>;
			};
			deployAfter?: boolean; // Redeploy after successful input (only if user provided input)
			deployMessage?: string; // Message to show during deploy (default: "Deploying...")
	  }
	| {
			action: "writeJson";
			path: string;
			set: Record<string, string>;
			successMessage?: string;
	  }
	| {
			action: "require";
			source: "secret" | "env";
			key: string;
			message?: string;
			setupUrl?: string;
			onMissing?: "fail" | "prompt" | "generate";
			promptMessage?: string;
			generateCommand?: string;
	  }
	| {
			action: "stripe-setup";
			message?: string;
			plans: Array<{
				name: string;
				priceKey: string; // Secret key to store price ID (e.g., "STRIPE_PRO_PRICE_ID")
				amount: number; // in cents
				interval: "month" | "year";
				description?: string;
			}>;
	  };

export interface TemplateHooks {
	preCreate?: HookAction[];
	preDeploy?: HookAction[];
	postDeploy?: HookAction[];
}

// Supported infrastructure capabilities
export type Capability = "db" | "kv" | "r2" | "queue" | "ai";

// Service type key from services library
import type { ServiceTypeKey } from "../lib/services/index.ts";

export interface AgentContext {
	summary: string;
	full_text: string;
}

export interface OptionalSecret {
	name: string;
	description: string;
	setupUrl?: string;
}

export interface EnvVar {
	name: string;
	description: string;
	required?: boolean;
	defaultValue?: string;
	example?: string;
	setupUrl?: string;
}

export interface IntentMetadata {
	keywords: string[];
	examples?: string[]; // For future telemetry/docs
}

export interface Template {
	files: Record<string, string>; // path -> content
	secrets?: string[]; // required secret keys (e.g., ["NEYNAR_API_KEY"])
	optionalSecrets?: OptionalSecret[]; // optional secret configurations
	envVars?: EnvVar[]; // environment variables (non-secret config)
	capabilities?: Capability[]; // infrastructure requirements (deprecated, use requires)
	requires?: ServiceTypeKey[]; // service requirements (DB, KV, CRON, QUEUE, STORAGE)
	description?: string; // for help text
	hooks?: TemplateHooks;
	agentContext?: AgentContext;
	intent?: IntentMetadata;
}
