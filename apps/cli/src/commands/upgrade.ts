/**
 * jack upgrade - Show billing dashboard URL to upgrade plan
 */

import { info } from "../lib/output.ts";

const BILLING_URL = "https://dash.getjack.org";

export default async function upgrade(): Promise<void> {
	console.error("");
	info("Upgrade your plan at:");
	console.error(`  ${BILLING_URL}`);
	console.error("");
}
