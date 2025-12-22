function stripJsonc(input: string): string {
	let output = "";
	let inString = false;
	let stringChar = "";
	let escaped = false;
	let inLineComment = false;
	let inBlockComment = false;

	for (let i = 0; i < input.length; i++) {
		const char = input[i] ?? "";
		const next = input[i + 1] ?? "";

		if (inLineComment) {
			if (char === "\n") {
				inLineComment = false;
				output += char;
			}
			continue;
		}

		if (inBlockComment) {
			if (char === "*" && next === "/") {
				inBlockComment = false;
				i++;
			}
			continue;
		}

		if (inString) {
			output += char;
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === stringChar) {
				inString = false;
				stringChar = "";
			}
			continue;
		}

		if (char === '"' || char === "'") {
			inString = true;
			stringChar = char;
			output += char;
			continue;
		}

		if (char === "/" && next === "/") {
			inLineComment = true;
			i++;
			continue;
		}

		if (char === "/" && next === "*") {
			inBlockComment = true;
			i++;
			continue;
		}

		output += char;
	}

	return output;
}

function removeTrailingCommas(input: string): string {
	let output = "";
	let inString = false;
	let stringChar = "";
	let escaped = false;

	for (let i = 0; i < input.length; i++) {
		const char = input[i] ?? "";

		if (inString) {
			output += char;
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === stringChar) {
				inString = false;
				stringChar = "";
			}
			continue;
		}

		if (char === '"' || char === "'") {
			inString = true;
			stringChar = char;
			output += char;
			continue;
		}

		if (char === ",") {
			let nextIndex = i + 1;
			while (nextIndex < input.length && /\s/.test(input[nextIndex] ?? "")) {
				nextIndex++;
			}
			const nextChar = input[nextIndex] ?? "";
			if (nextChar === "}" || nextChar === "]") {
				continue;
			}
		}

		output += char;
	}

	return output;
}

export function parseJsonc<T = unknown>(input: string): T {
	const withoutComments = stripJsonc(input);
	const withoutTrailingCommas = removeTrailingCommas(withoutComments);
	return JSON.parse(withoutTrailingCommas) as T;
}
