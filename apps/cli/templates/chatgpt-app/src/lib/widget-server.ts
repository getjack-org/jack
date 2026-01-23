export async function serveWidget(
	assets: Fetcher,
	widgetName: string
): Promise<Response> {
	const assetPath = `/src/widgets/${widgetName}/index.html`;

	try {
		const assetRequest = new Request(`http://assets${assetPath}`);
		const response = await assets.fetch(assetRequest);

		if (!response.ok) {
			return new Response(`Widget not found: ${widgetName}`, {
				status: 404,
				headers: { "Content-Type": "text/plain" },
			});
		}

		const html = await response.text();

		return new Response(html, {
			status: 200,
			headers: {
				"Content-Type": "text/html+skybridge",
				"Cache-Control": "public, max-age=3600",
			},
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown error";
		return new Response(`Error serving widget: ${message}`, {
			status: 500,
			headers: { "Content-Type": "text/plain" },
		});
	}
}
