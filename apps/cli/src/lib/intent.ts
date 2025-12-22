import { BUILTIN_TEMPLATES, resolveTemplateWithOrigin } from "../templates/index.ts";

export interface IntentMatchResult {
	template: string;
	matchedKeywords: string[];
}

/**
 * Match an intent phrase against template keywords
 * Uses case-insensitive partial matching
 */
export function matchTemplateByIntent(
	phrase: string,
	templates: Array<{ name: string; keywords: string[] }>,
): IntentMatchResult[] {
	const normalizedPhrase = phrase.toLowerCase();
	const matches: IntentMatchResult[] = [];

	for (const template of templates) {
		const matchedKeywords: string[] = [];

		for (const keyword of template.keywords) {
			// Case-insensitive partial match - keyword appears anywhere in phrase
			if (normalizedPhrase.includes(keyword.toLowerCase())) {
				matchedKeywords.push(keyword);
			}
		}

		if (matchedKeywords.length > 0) {
			matches.push({
				template: template.name,
				matchedKeywords,
			});
		}
	}

	return matches;
}

/**
 * Detect if the first arg is an intent phrase vs a project name
 * Heuristics:
 * - Contains spaces -> intent phrase
 * - Contains special characters (except hyphen/underscore) -> intent phrase
 * - Matches common intent indicator words -> intent phrase
 * - Otherwise -> project name
 */
export function isIntentPhrase(arg: string): boolean {
	// Contains spaces -> definitely intent
	if (arg.includes(" ")) return true;

	// Contains special chars (except hyphen/underscore) -> intent
	if (/[^a-zA-Z0-9_-]/.test(arg)) return true;

	// Common intent indicator words (single words that suggest intent)
	const intentWords = ["api", "webhook", "miniapp", "dashboard", "frontend", "backend", "endpoint"];
	const lower = arg.toLowerCase();

	// Exact match or compound word containing the intent word
	for (const word of intentWords) {
		if (lower === word) return true;
	}

	return false;
}

/**
 * Load all templates and extract their intent keywords
 */
export async function loadTemplateKeywords(): Promise<Array<{ name: string; keywords: string[] }>> {
	const templates: Array<{ name: string; keywords: string[] }> = [];

	for (const name of BUILTIN_TEMPLATES) {
		try {
			const { template } = await resolveTemplateWithOrigin(name);
			if (template.intent?.keywords && template.intent.keywords.length > 0) {
				templates.push({
					name,
					keywords: template.intent.keywords,
				});
			}
		} catch {
			// Skip templates that fail to load
		}
	}

	return templates;
}
