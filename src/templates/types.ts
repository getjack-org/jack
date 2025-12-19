// Hook action types
export type HookAction =
	| { action: "message"; text: string }
	| { action: "box"; title: string; lines: string[] } // boxed info panel
	| { action: "link"; url: string; label?: string; prompt?: boolean } // show link, optionally ask to open
	| { action: "open"; url: string } // auto-open (use sparingly)
	| { action: "checkSecret"; secret: string; message?: string; setupUrl?: string }
	| { action: "checkEnv"; env: string; message?: string }
	| { action: "copy"; text: string; message?: string }
	| { action: "wait"; message?: string } // press enter to continue
	| { action: "run"; command: string; cwd?: "project"; message?: string }; // run shell command

export interface TemplateHooks {
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

export interface Template {
	files: Record<string, string>; // path -> content
	secrets?: string[]; // required secret keys (e.g., ["NEYNAR_API_KEY"])
	capabilities?: Capability[]; // infrastructure requirements (deprecated, use requires)
	requires?: ServiceTypeKey[]; // service requirements (DB, KV, CRON, QUEUE, STORAGE)
	description?: string; // for help text
	hooks?: TemplateHooks;
	agentContext?: AgentContext;
}
