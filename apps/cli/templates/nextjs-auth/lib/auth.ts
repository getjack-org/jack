import { getCloudflareContext } from "@opennextjs/cloudflare";
import { betterAuth } from "better-auth";
import { Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";

export function createAuth(d1: D1Database, env: Record<string, string | undefined>) {
	// biome-ignore lint/suspicious/noExplicitAny: D1 has no typed schema
	const db = new Kysely<any>({
		dialect: new D1Dialect({ database: d1 }),
	});

	return betterAuth({
		database: {
			db,
			type: "sqlite",
		},
		secret: env.BETTER_AUTH_SECRET,
		emailAndPassword: { enabled: true },
		socialProviders: {
			...(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
				? {
						github: {
							clientId: env.GITHUB_CLIENT_ID,
							clientSecret: env.GITHUB_CLIENT_SECRET,
						},
					}
				: {}),
			...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
				? {
						google: {
							clientId: env.GOOGLE_CLIENT_ID,
							clientSecret: env.GOOGLE_CLIENT_SECRET,
						},
					}
				: {}),
		},
	});
}

export async function getAuth() {
	const { env } = await getCloudflareContext();
	return createAuth(env.DB, env as unknown as Record<string, string | undefined>);
}
