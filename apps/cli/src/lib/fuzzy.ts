/**
 * Simple fuzzy matching for project filtering
 *
 * Scoring priority:
 * 1. Exact prefix match (highest)
 * 2. Substring match (medium)
 * 3. Character-by-character fuzzy (lower)
 *
 * Returns 0 for no match.
 */

const SCORE_EXACT_PREFIX = 1000;
const SCORE_SUBSTRING = 500;
const SCORE_FUZZY_BASE = 100;

/**
 * Calculate fuzzy match score between query and target.
 * Higher score = better match. 0 = no match.
 */
export function fuzzyMatch(query: string, target: string): number {
	if (!query || !target) return 0;

	const q = query.toLowerCase();
	const t = target.toLowerCase();

	// Exact prefix match (highest priority)
	if (t.startsWith(q)) {
		// Bonus for exact match
		if (t === q) return SCORE_EXACT_PREFIX + 100;
		return SCORE_EXACT_PREFIX;
	}

	// Substring match (medium priority)
	if (t.includes(q)) {
		return SCORE_SUBSTRING;
	}

	// Character-by-character fuzzy match
	// All query characters must appear in order in target
	let targetIdx = 0;
	let matchedChars = 0;
	let consecutiveBonus = 0;
	let lastMatchIdx = -2;

	for (let i = 0; i < q.length; i++) {
		const char = q[i];
		let found = false;

		while (targetIdx < t.length) {
			if (t[targetIdx] === char) {
				matchedChars++;
				// Bonus for consecutive matches
				if (targetIdx === lastMatchIdx + 1) {
					consecutiveBonus += 10;
				}
				lastMatchIdx = targetIdx;
				targetIdx++;
				found = true;
				break;
			}
			targetIdx++;
		}

		if (!found) {
			return 0; // Query char not found, no match
		}
	}

	// Base score plus bonuses
	// More matched chars and consecutive matches = higher score
	const lengthRatio = matchedChars / t.length;
	return Math.floor(SCORE_FUZZY_BASE * lengthRatio + consecutiveBonus);
}

/**
 * Filter and sort items by fuzzy match score.
 * Returns only items with score > 0, sorted by score descending.
 */
export function fuzzyFilter<T>(
	query: string,
	items: T[],
	getText: (item: T) => string,
): T[] {
	if (!query) return items;

	const scored = items
		.map((item) => ({
			item,
			score: fuzzyMatch(query, getText(item)),
		}))
		.filter(({ score }) => score > 0);

	// Sort by score descending
	scored.sort((a, b) => b.score - a.score);

	return scored.map(({ item }) => item);
}
