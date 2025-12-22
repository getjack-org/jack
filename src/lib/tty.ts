export function restoreTty(): void {
	if (!process.stdin.isTTY) return;

	try {
		process.stdin.setRawMode(false);
	} catch {
		// Ignore if stdin does not support raw mode
	}

	process.stdin.pause();

	if (process.stderr.isTTY) {
		process.stderr.write("\x1b[?25h");
	}
}
