import { humanId } from "human-id";

/**
 * Generate a Heroku-style project name
 * Examples: "brave-moon-7xz", "calm-star-2ab"
 */
export function generateProjectName(): string {
	return humanId({
		separator: "-",
		capitalize: false,
	});
}
