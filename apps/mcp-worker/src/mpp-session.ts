import { McpError } from "@modelcontextprotocol/sdk/types.js";
import type { McpToolResult } from "./utils.ts";

const CREDENTIAL_KEY = "org.paymentauth/credential";
const RECEIPT_KEY = "org.paymentauth/receipt";

export async function chargeSession(
	env: { COMPUTE_SESSION: DurableObjectNamespace },
	extra: { _meta?: Record<string, unknown> },
	amount: string,
): Promise<{ receipt: unknown }> {
	const credential = extra?._meta?.[CREDENTIAL_KEY];

	const channelId = extractChannelId(credential) || "default";
	const doId = env.COMPUTE_SESSION.idFromName(channelId);
	const stub = env.COMPUTE_SESSION.get(doId);

	const response = await stub.fetch("http://session/charge", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			credential: credential ?? null,
			chargeAmount: amount,
		}),
	});

	const result = (await response.json()) as {
		status: number;
		challenge?: unknown;
		receipt?: unknown;
		error?: string;
	};

	if (result.status === 402) {
		throw new McpError(-32042, "Payment required", result.challenge);
	}

	if (result.status === 500) {
		throw new McpError(-32603, `Payment error: ${result.error}`);
	}

	if (!result.receipt) {
		throw new McpError(-32042, "Payment required — no valid receipt received");
	}

	return { receipt: result.receipt };
}

export function withReceipt(
	result: McpToolResult,
	receipt: unknown,
): McpToolResult & { _meta: Record<string, unknown> } {
	return {
		...result,
		_meta: { [RECEIPT_KEY]: receipt },
	};
}

function extractChannelId(credential: unknown): string | null {
	if (!credential || typeof credential !== "object") return null;
	const cred = credential as { payload?: { channelId?: string } };
	return cred.payload?.channelId ?? null;
}
