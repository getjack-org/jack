// Convert an ArrayBuffer to hex string
function bufferToHex(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	const hexChars: string[] = [];
	for (const byte of bytes) {
		hexChars.push(byte.toString(16).padStart(2, "0"));
	}
	return hexChars.join("");
}

// Verify HMAC-SHA256 webhook signature
// Expected header format: sha256=<hex-encoded-signature>
export async function verifyWebhookSignature(
	payload: string,
	signatureHeader: string,
	secret: string,
): Promise<boolean> {
	if (!signatureHeader || !secret) {
		return false;
	}

	// Parse the signature header
	const parts = signatureHeader.split("=");
	if (parts.length !== 2 || parts[0] !== "sha256") {
		return false;
	}

	const receivedSignature = parts[1];
	if (!receivedSignature) {
		return false;
	}

	// Import the secret as a CryptoKey
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);

	// Sign the payload
	const signatureBuffer = await crypto.subtle.sign(
		"HMAC",
		key,
		encoder.encode(payload),
	);

	// Convert to hex and compare
	const expectedSignature = bufferToHex(signatureBuffer);

	// Constant-time comparison
	if (receivedSignature.length !== expectedSignature.length) {
		return false;
	}

	let mismatch = 0;
	for (let i = 0; i < receivedSignature.length; i++) {
		mismatch |=
			receivedSignature.charCodeAt(i) ^ expectedSignature.charCodeAt(i);
	}

	return mismatch === 0;
}

export interface WebhookEventInput {
	source?: string;
	eventType?: string;
	payload: string;
}

// Log a webhook event to D1
export async function logWebhookEvent(
	db: D1Database,
	input: WebhookEventInput,
): Promise<string> {
	const id = crypto.randomUUID();
	const now = Math.floor(Date.now() / 1000);

	await db
		.prepare(
			"INSERT INTO webhook_events (id, source, event_type, payload, status, created_at) VALUES (?, ?, ?, ?, 'received', ?)",
		)
		.bind(
			id,
			input.source || "unknown",
			input.eventType || null,
			input.payload,
			now,
		)
		.run();

	return id;
}
