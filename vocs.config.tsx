import { defineConfig } from "vocs";

const miniappMeta = JSON.stringify({
	version: "1",
	imageUrl: "https://docs.getjack.org/jack-demo.gif",
	button: {
		title: "Open Docs",
		action: {
			type: "launch_miniapp",
			name: "jack",
			splashImageUrl: "https://docs.getjack.org/icon.png",
			splashBackgroundColor: "#0a0a0a",
		},
	},
});

export default defineConfig({
	rootDir: "docs",
	title: "jack",
	description: "Ship before you forget why you started. The vibecoder's deployment CLI.",
	logoUrl: {
		light: "/logo-light.svg",
		dark: "/logo-dark.svg",
	},
	iconUrl: "/jack-logo.png",
	ogImageUrl: "/og.png",
	topNav: [
		{ text: "Guide", link: "/getting-started" },
		{ text: "Templates", link: "/templates" },
		{ text: "Commands", link: "/commands" },
		{ text: "npm", link: "https://www.npmjs.com/package/@getjack/jack" },
	],
	sidebar: [
		{
			text: "Introduction",
			items: [
				{ text: "What is jack?", link: "/" },
				{ text: "Getting Started", link: "/getting-started" },
			],
		},
		{
			text: "Templates",
			items: [
				{ text: "Overview", link: "/templates" },
				{ text: "miniapp", link: "/templates/miniapp" },
				{ text: "api", link: "/templates/api" },
			],
		},
		{
			text: "Commands",
			items: [
				{ text: "new", link: "/commands/new" },
				{ text: "ship", link: "/commands/ship" },
				{ text: "publish", link: "/commands/publish" },
				{ text: "ls", link: "/commands/ls" },
				{ text: "projects", link: "/commands/projects" },
				{ text: "open", link: "/commands/open" },
				{ text: "services", link: "/commands/services" },
				{ text: "secrets", link: "/commands/secrets" },
				{ text: "feedback", link: "/commands/feedback" },
			],
		},
		{
			text: "Guides",
			items: [
				{ text: "Using with AI Agents", link: "/guides/ai-agents" },
				{ text: "Troubleshooting", link: "/guides/troubleshooting" },
			],
		},
	],
	socials: [
		{
			icon: "github",
			link: "https://github.com/getjack-org/jack",
		},
		{
			icon: "discord",
			link: "https://community.getjack.org",
		},
	],
	vite: {
		plugins: [
			{
				name: "inject-farcaster-meta",
				transformIndexHtml(html) {
					return html.replace(
						"</head>",
						`<meta name="fc:miniapp" content='${miniappMeta}' />
<script type="module">
  import('https://esm.sh/@farcaster/miniapp-sdk@0.2.1').then(({ sdk }) => {
    if (document.readyState === 'complete') {
      sdk.actions.ready();
    } else {
      window.addEventListener('load', () => sdk.actions.ready());
    }
  }).catch(() => {});
</script>
</head>`,
					);
				},
			},
		],
	},
});
