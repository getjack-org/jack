/**
 * shell-init command - output shell integration code
 *
 * Usage: jack shell-init
 *
 * Outputs shell code to stdout. Users can:
 * - eval "$(jack shell-init)" for temporary use
 * - Run `jack init` to install permanently (recommended)
 */

import {
	detectShell,
	getRcFileName,
	getRcFilePath,
	getShellCode,
	getShellFileDisplayPath,
	getSourceLine,
} from "../lib/shell-integration.ts";

export default async function shellInit(): Promise<void> {
	const code = getShellCode();

	// If piped (eval), output raw code only
	if (!process.stdout.isTTY) {
		console.log(code);
		return;
	}

	// Interactive: show instructions
	const shell = detectShell();
	const rcFile = getRcFilePath(shell);
	const rcName = rcFile ? getRcFileName(rcFile) : ".bashrc or .zshrc";

	console.log("# Shell integration for jack");
	console.log("#");
	console.log("# Option 1 (recommended): Run 'jack init' to install automatically");
	console.log("#");
	console.log(`# Option 2: Add this line to your ~/${rcName}:`);
	console.log(`#   ${getSourceLine().split("\n")[1]}`);
	console.log(`#   Then create ${getShellFileDisplayPath()} with:`);
	console.log("#");
	console.log(code);
}
