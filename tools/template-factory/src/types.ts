import { z } from "zod";

/**
 * Supported infrastructure capabilities
 */
export const CapabilitySchema = z.enum(["db", "kv", "r2", "queue", "ai"]);
export type Capability = z.infer<typeof CapabilitySchema>;

/**
 * Service requirements (matches Jack's ServiceTypeKey)
 */
export const ServiceRequirementSchema = z.enum(["DB", "KV", "CRON", "QUEUE", "STORAGE", "AI"]);
export type ServiceRequirement = z.infer<typeof ServiceRequirementSchema>;

/**
 * Framework choices for templates
 */
export const FrameworkSchema = z.enum(["hono", "nextjs", "vite-react", "api-only"]);
export type Framework = z.infer<typeof FrameworkSchema>;

/**
 * Secret configuration
 */
export const SecretConfigSchema = z.object({
	name: z.string(),
	required: z.boolean().default(true),
	description: z.string().optional(),
	setupUrl: z.string().url().optional(),
});
export type SecretConfig = z.infer<typeof SecretConfigSchema>;

/**
 * Validation endpoint
 */
export const EndpointTestSchema = z.object({
	path: z.string(),
	method: z.enum(["GET", "POST", "PUT", "DELETE"]).default("GET"),
	expectedStatus: z.number().default(200),
	bodyContains: z.string().optional(),
});
export type EndpointTest = z.infer<typeof EndpointTestSchema>;

/**
 * Browser test specification
 */
export const BrowserTestSchema = z.object({
	name: z.string(),
	steps: z.array(z.string()),
});
export type BrowserTest = z.infer<typeof BrowserTestSchema>;

/**
 * Technical decision with tradeoffs (for spec document)
 */
export const TechnicalDecisionSchema = z.object({
	area: z.string(), // e.g., "Authentication", "Database", "Payments"
	choice: z.string(), // e.g., "Better Auth"
	reasoning: z.string(), // Why this choice
	tradeoffs: z.string(), // What we're giving up
	alternatives: z.array(z.string()).optional(), // What else was considered
});
export type TechnicalDecision = z.infer<typeof TechnicalDecisionSchema>;

/**
 * Complete template specification
 * This is what gets written to spec.md and consumed by the implementation phase
 */
export const TemplateSpecSchema = z.object({
	// Identity
	name: z.string().regex(/^[a-z0-9-]+$/, "Must be lowercase with hyphens"),
	description: z.string().min(10).max(200),

	// Detailed prose (for spec.md)
	longDescription: z.string().optional(),
	targetAudience: z.string().optional(),
	technicalDecisions: z.array(TechnicalDecisionSchema).optional(),

	// Technical configuration
	framework: FrameworkSchema,
	frontend: z.enum(["vite-react", "nextjs", "none"]).optional(),
	capabilities: z.array(CapabilitySchema),
	requires: z.array(ServiceRequirementSchema),

	// Secrets
	secrets: z.array(SecretConfigSchema),

	// Intent matching (for template selection)
	intent: z
		.object({
			keywords: z.array(z.string()),
			examples: z.array(z.string()).optional(),
		})
		.optional(),

	// Validation criteria
	validation: z.object({
		endpoints: z.array(EndpointTestSchema),
		browserTests: z.array(BrowserTestSchema).optional(),
	}),

	// Hooks (simplified - full hooks generated during implementation)
	suggestedHooks: z
		.object({
			preDeploy: z.array(z.string()).optional(), // e.g., ["require:STRIPE_SECRET_KEY"]
			postDeploy: z.array(z.string()).optional(), // e.g., ["open-dashboard", "copy-url"]
		})
		.optional(),
});
export type TemplateSpec = z.infer<typeof TemplateSpecSchema>;

/**
 * Workflow state persisted in Smithers SQLite
 */
export interface TemplateFactoryState {
	// Phase tracking
	currentPhase: "spec" | "implement" | "validate" | "review" | "finalize";

	// Spec phase
	specDraft?: string; // Raw markdown
	specParsed?: TemplateSpec; // Parsed and validated
	specApproved?: boolean;
	specFeedback?: string[]; // Human feedback from interactive session

	// Implementation phase
	worktreeBranch?: string;
	worktreePath?: string;
	generatedFiles?: string[]; // List of file paths
	typeCheckPassed?: boolean;
	lintPassed?: boolean;

	// Validation phase
	testProjectPath?: string;
	deployUrl?: string;
	endpointResults?: Array<{
		path: string;
		status: number;
		passed: boolean;
		error?: string;
	}>;
	browserTestResults?: Array<{
		name: string;
		passed: boolean;
		error?: string;
	}>;

	// Review phase
	reviewApproved?: boolean;
	reviewFeedback?: string[];

	// Finalize phase
	mergedToMain?: boolean;
	addedToBuiltins?: boolean;
}

/**
 * Initial user intent (passed to factory)
 */
export interface TemplateIntent {
	description: string; // What the user wants, e.g., "SaaS with Stripe payments"
	preferences?: {
		framework?: Framework;
		features?: string[]; // e.g., ["auth", "payments", "dashboard"]
	};
}
