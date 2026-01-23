import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readdirSync, statSync } from "fs";
import { join, resolve } from "path";

function discoverWidgetEntries(): Record<string, string> {
	const widgetsDir = resolve(__dirname, "src/widgets");
	const entries: Record<string, string> = {};

	try {
		const widgetFolders = readdirSync(widgetsDir);

		for (const folder of widgetFolders) {
			const folderPath = join(widgetsDir, folder);
			const stat = statSync(folderPath);

			if (stat.isDirectory()) {
				const indexPath = join(folderPath, "index.html");
				try {
					statSync(indexPath);
					entries[folder] = indexPath;
				} catch {
					// No index.html in this folder, skip
				}
			}
		}
	} catch {
		// widgets directory doesn't exist yet
	}

	return entries;
}

export default defineConfig({
	plugins: [react(), tailwindcss()],
	build: {
		outDir: "dist/widgets",
		rollupOptions: {
			input: discoverWidgetEntries(),
			output: {
				// Keep assets next to HTML for easier serving
				assetFileNames: "assets/[name]-[hash][extname]",
				chunkFileNames: "assets/[name]-[hash].js",
				entryFileNames: "assets/[name]-[hash].js",
			},
		},
	},
});
