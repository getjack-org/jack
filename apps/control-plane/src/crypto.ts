/**
 * Server-side decryption for secrets encrypted by the CLI.
 *
 * Uses hybrid RSA-OAEP + AES-GCM: the CLI generates an ephemeral AES key,
 * encrypts the plaintext with AES-GCM, then wraps the AES key with the
 * server's RSA-OAEP public key. This module reverses the process.
 */

export interface EncryptedEnvelope {
	__encrypted: true;
	kid: string;
	wrappedKey: string; // base64url
	iv: string; // base64url
	ciphertext: string; // base64url
}

/** Type guard: is this value an encrypted envelope? */
export function isEncryptedEnvelope(value: unknown): value is EncryptedEnvelope {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as Record<string, unknown>).__encrypted === true &&
		typeof (value as Record<string, unknown>).wrappedKey === "string" &&
		typeof (value as Record<string, unknown>).iv === "string" &&
		typeof (value as Record<string, unknown>).ciphertext === "string"
	);
}

function base64urlDecode(s: string): Uint8Array {
	const base64 = s.replace(/-/g, "+").replace(/_/g, "/");
	const pad = (4 - (base64.length % 4)) % 4;
	const bin = atob(base64 + "=".repeat(pad));
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) {
		bytes[i] = bin.charCodeAt(i);
	}
	return bytes;
}

/** Import the RSA-OAEP private key from JWK stored as a worker secret. */
async function importPrivateKey(privateKeyJwk: JsonWebKey): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"jwk",
		privateKeyJwk,
		{ name: "RSA-OAEP", hash: "SHA-256" },
		false,
		["decrypt"],
	);
}

/** Decrypt a single encrypted envelope back to plaintext string. */
export async function decryptSecretValue(
	envelope: EncryptedEnvelope,
	privateKeyJwk: JsonWebKey,
): Promise<string> {
	const rsaKey = await importPrivateKey(privateKeyJwk);

	// Unwrap the ephemeral AES key
	const wrappedKeyBytes = base64urlDecode(envelope.wrappedKey);
	const rawAesKey = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, rsaKey, wrappedKeyBytes);

	// Import ephemeral AES key
	const aesKey = await crypto.subtle.importKey("raw", rawAesKey, { name: "AES-GCM" }, false, [
		"decrypt",
	]);

	// Decrypt the ciphertext
	const iv = base64urlDecode(envelope.iv);
	const ciphertext = base64urlDecode(envelope.ciphertext);
	const plainBytes = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, aesKey, ciphertext);

	return new TextDecoder().decode(plainBytes);
}

/**
 * Decrypt an encrypted secrets map (used during deploy upload).
 * The entire Record<string, string> is serialized as JSON, then encrypted as one envelope.
 */
export async function decryptSecrets(
	envelope: EncryptedEnvelope,
	privateKeyJwk: JsonWebKey,
): Promise<Record<string, string>> {
	const json = await decryptSecretValue(envelope, privateKeyJwk);
	return JSON.parse(json);
}
