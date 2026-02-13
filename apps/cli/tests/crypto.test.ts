import { describe, expect, test } from "bun:test";

/**
 * Round-trip encryption tests: encrypt with CLI module, decrypt with control-plane module.
 * Generates a fresh keypair per test suite so we don't depend on the embedded production key.
 */

// Import control-plane decrypt functions directly (they use standard Web Crypto)
import {
	decryptSecretValue,
	decryptSecrets,
	isEncryptedEnvelope,
} from "../../control-plane/src/crypto";

// We can't use the CLI encrypt functions directly since they use the embedded production key.
// Instead, re-implement the encryption logic here with a test keypair.

async function generateTestKeypair() {
	const keypair = await crypto.subtle.generateKey(
		{
			name: "RSA-OAEP",
			modulusLength: 2048, // Smaller for faster tests
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: "SHA-256",
		},
		true,
		["encrypt", "decrypt"],
	);
	const publicKeyJwk = await crypto.subtle.exportKey("jwk", keypair.publicKey);
	const privateKeyJwk = await crypto.subtle.exportKey("jwk", keypair.privateKey);
	return { publicKeyJwk, privateKeyJwk };
}

function base64urlEncode(bytes: ArrayBuffer | Uint8Array): string {
	const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let bin = "";
	for (let i = 0; i < u8.length; i++) {
		bin += String.fromCharCode(u8[i]);
	}
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function testEncrypt(
	plaintext: string,
	publicKeyJwk: JsonWebKey,
): Promise<{
	__encrypted: true;
	kid: string;
	wrappedKey: string;
	iv: string;
	ciphertext: string;
}> {
	const rsaKey = await crypto.subtle.importKey(
		"jwk",
		publicKeyJwk,
		{ name: "RSA-OAEP", hash: "SHA-256" },
		false,
		["encrypt"],
	);

	const aesKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
		"encrypt",
	]);

	const iv = crypto.getRandomValues(new Uint8Array(12));
	const plainBytes = new TextEncoder().encode(plaintext);
	const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, plainBytes);

	const rawAesKey = await crypto.subtle.exportKey("raw", aesKey);
	const wrappedKey = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, rsaKey, rawAesKey);

	return {
		__encrypted: true,
		kid: "v1",
		wrappedKey: base64urlEncode(wrappedKey),
		iv: base64urlEncode(iv),
		ciphertext: base64urlEncode(ciphertext),
	};
}

describe("secrets encryption", () => {
	test("round-trip: encrypt then decrypt a simple string", async () => {
		const { publicKeyJwk, privateKeyJwk } = await generateTestKeypair();
		const plaintext = "my-secret-api-key-12345";

		const envelope = await testEncrypt(plaintext, publicKeyJwk);
		const decrypted = await decryptSecretValue(envelope, privateKeyJwk);

		expect(decrypted).toBe(plaintext);
	});

	test("round-trip: empty string", async () => {
		const { publicKeyJwk, privateKeyJwk } = await generateTestKeypair();

		const envelope = await testEncrypt("", publicKeyJwk);
		const decrypted = await decryptSecretValue(envelope, privateKeyJwk);

		expect(decrypted).toBe("");
	});

	test("round-trip: unicode characters", async () => {
		const { publicKeyJwk, privateKeyJwk } = await generateTestKeypair();
		const plaintext = "🔑 secret with émojis and ñ characters 日本語";

		const envelope = await testEncrypt(plaintext, publicKeyJwk);
		const decrypted = await decryptSecretValue(envelope, privateKeyJwk);

		expect(decrypted).toBe(plaintext);
	});

	test("round-trip: multi-line PEM key", async () => {
		const { publicKeyJwk, privateKeyJwk } = await generateTestKeypair();
		const plaintext = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MhgHcTz6sE2I2yPB
aFDfMVPERMg4OCx+RLYKXZ/70FPdMcUk2H5PYBuDQz3m6q/w0N/fFQG+K/fYXyOD
-----END RSA PRIVATE KEY-----`;

		const envelope = await testEncrypt(plaintext, publicKeyJwk);
		const decrypted = await decryptSecretValue(envelope, privateKeyJwk);

		expect(decrypted).toBe(plaintext);
	});

	test("round-trip: large secret (>446 bytes, confirms hybrid encryption works)", async () => {
		const { publicKeyJwk, privateKeyJwk } = await generateTestKeypair();
		// 1KB of data — too large for RSA-OAEP direct encryption
		const plaintext = "A".repeat(1024);

		const envelope = await testEncrypt(plaintext, publicKeyJwk);
		const decrypted = await decryptSecretValue(envelope, privateKeyJwk);

		expect(decrypted).toBe(plaintext);
	});

	test("round-trip: decrypt a full secrets map", async () => {
		const { publicKeyJwk, privateKeyJwk } = await generateTestKeypair();
		const secrets = {
			API_KEY: "sk-123456",
			DATABASE_URL: "postgres://user:pass@host/db",
			WEBHOOK_SECRET: "whsec_abc",
		};

		const envelope = await testEncrypt(JSON.stringify(secrets), publicKeyJwk);
		const decrypted = await decryptSecrets(envelope, privateKeyJwk);

		expect(decrypted).toEqual(secrets);
	});

	test("isEncryptedEnvelope: correctly identifies encrypted envelopes", () => {
		expect(
			isEncryptedEnvelope({
				__encrypted: true,
				kid: "v1",
				wrappedKey: "abc",
				iv: "def",
				ciphertext: "ghi",
			}),
		).toBe(true);
	});

	test("isEncryptedEnvelope: rejects plaintext objects", () => {
		expect(isEncryptedEnvelope({ API_KEY: "sk-123" })).toBe(false);
		expect(isEncryptedEnvelope("just a string")).toBe(false);
		expect(isEncryptedEnvelope(null)).toBe(false);
		expect(isEncryptedEnvelope(undefined)).toBe(false);
		expect(isEncryptedEnvelope(42)).toBe(false);
	});

	test("isEncryptedEnvelope: rejects partial envelopes", () => {
		expect(isEncryptedEnvelope({ __encrypted: true })).toBe(false);
		expect(isEncryptedEnvelope({ __encrypted: true, wrappedKey: "abc" })).toBe(false);
		expect(isEncryptedEnvelope({ __encrypted: true, wrappedKey: "abc", iv: "def" })).toBe(false);
	});

	test("backward compat: plaintext values pass through isEncryptedEnvelope check", () => {
		// Simulates the control plane backward-compat logic
		const plaintextValue = "my-plain-secret";
		const secretsMap = { API_KEY: "sk-123" };

		// Control plane checks isEncryptedEnvelope first
		expect(isEncryptedEnvelope(plaintextValue)).toBe(false);
		expect(isEncryptedEnvelope(secretsMap)).toBe(false);

		// So it falls through to use the value as-is
	});
});
