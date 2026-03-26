import { DurableObject } from "cloudflare:workers";
import { Mppx, Transport, tempo } from "mppx/server";

interface SessionEnv {
	MPP_SECRET_KEY: string;
	TEMPO_RECIPIENT: string;
}

export class ComputeSession extends DurableObject<SessionEnv> {
	// biome-ignore lint: complex generic not worth spelling out
	private mppx: any = null;

	private getMppx() {
		if (this.mppx) return this.mppx;

		const storage = this.ctx.storage;
		const store = {
			async get(key: string) {
				return (await storage.get(key)) ?? null;
			},
			async put(key: string, value: unknown) {
				await storage.put(key, value);
			},
			async delete(key: string) {
				await storage.delete(key);
			},
		};

		this.mppx = Mppx.create({
			secretKey: this.env.MPP_SECRET_KEY,
			transport: Transport.mcp(),
			methods: [
				tempo.session({
					currency:
						"0x20c000000000000000000000b9537d11c60e8b50" as `0x${string}`,
					recipient: this.env.TEMPO_RECIPIENT as `0x${string}`,
					store,
					suggestedDeposit: "5",
					minVoucherDelta: "0.01",
					unitType: "execution",
				}),
			],
		});

		return this.mppx;
	}

	async fetch(request: Request): Promise<Response> {
		try {
			const { credential, chargeAmount } = (await request.json()) as {
				credential: unknown;
				chargeAmount: string;
			};

			const mppx = this.getMppx();

			// Build JSON-RPC shaped input that Transport.mcp() expects
			const input = {
				method: "tools/call",
				params: {
					_meta: credential
						? { "org.paymentauth/credential": credential }
						: {},
				},
				id: crypto.randomUUID(),
			};

			const handler = (mppx as any).session({
				amount: chargeAmount,
				unitType: "execution",
			});
			const result = await handler(input);

			// Transport.mcp() returns JSON-RPC response objects
			if ("error" in result) {
				return Response.json(
					{
						status: 402,
						challenge: (result as any).error.data,
					},
					{ status: 402 },
				);
			}

			const receipt = (result as any).result?._meta?.[
				"org.paymentauth/receipt"
			];
			return Response.json({ status: 200, receipt });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return Response.json({ status: 500, error: message }, { status: 500 });
		}
	}
}
