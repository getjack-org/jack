export default {
	async fetch() {
		return new Response(
			JSON.stringify({
				message: "Hello from jack!",
				timestamp: new Date().toISOString(),
			}),
			{ headers: { "Content-Type": "application/json" } },
		);
	},
};
