import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react(), tailwindcss(), cloudflare()],
	resolve: {
		alias: {
			"@": resolve(__dirname, "./src/client"),
		},
	},
});
