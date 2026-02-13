#!/usr/bin/env bun
/**
 * One-time script to generate RSA-4096 keypair for secrets encryption.
 *
 * Outputs:
 * - Public key JWK (embed in CLI source code)
 * - Private key JWK (set as worker secret via `wrangler secret put`)
 */

const keypair = await crypto.subtle.generateKey(
	{
		name: "RSA-OAEP",
		modulusLength: 4096,
		publicExponent: new Uint8Array([1, 0, 1]),
		hash: "SHA-256",
	},
	true,
	["encrypt", "decrypt"],
);

const publicKeyJwk = await crypto.subtle.exportKey("jwk", keypair.publicKey);
const privateKeyJwk = await crypto.subtle.exportKey("jwk", keypair.privateKey);

console.log("=== PUBLIC KEY (embed in apps/cli/src/lib/crypto.ts) ===\n");
console.log(JSON.stringify(publicKeyJwk, null, "\t"));

console.log(
	"\n=== PRIVATE KEY (set via: wrangler secret put SECRETS_ENCRYPTION_PRIVATE_KEY) ===\n",
);
console.log(JSON.stringify(privateKeyJwk));

console.log("\n=== Instructions ===");
console.log("1. Copy the PUBLIC KEY into apps/cli/src/lib/crypto.ts as PUBLIC_KEY_JWK");
console.log(
	"2. Run: echo '<PRIVATE_KEY_JSON>' | wrangler secret put SECRETS_ENCRYPTION_PRIVATE_KEY --cwd apps/control-plane",
);
