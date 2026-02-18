import { defineConfig } from "vocs";

const miniappMeta = JSON.stringify({
	version: "1",
	imageUrl: "https://docs.getjack.org/jack-demo.gif",
	button: {
		title: "Open Docs",
		action: {
			type: "launch_miniapp",
			name: "jack",
			url: "https://docs.getjack.org",
			splashImageUrl: "https://docs.getjack.org/icon.png",
			splashBackgroundColor: "#0a0a0a",
		},
	},
});

export default defineConfig({
	rootDir: "docs",
	title: "jack",
	description: "The deployment platform for Claude Code.",
	logoUrl: {
		light: "/logo-light.svg",
		dark: "/logo-dark.svg",
	},
	iconUrl: "/jack-logo.png",
	ogImageUrl: "/og.png",
	font: {
		default: { google: "Inter" },
		mono: { google: "JetBrains Mono" },
	},
	theme: {
		accentColor: "oklch(0.72 0.15 220)",
		colorScheme: "dark",
		variables: {
			color: {
				// Background hierarchy
				background: "oklch(0.06 0.01 250)",
				background2: "oklch(0.10 0.012 250)",
				background3: "oklch(0.10 0.012 250)",
				background4: "oklch(0.14 0.013 250)",
				background5: "oklch(0.18 0.015 250)",
				backgroundDark: "oklch(0.06 0.01 250)",
				backgroundDarkTint: "oklch(0.10 0.012 250)",

				// Text hierarchy
				heading: "oklch(0.95 0.008 250)",
				title: "oklch(0.95 0.008 250)",
				text: "oklch(0.60 0.015 250)",
				text2: "oklch(0.55 0.015 250)",
				text3: "oklch(0.45 0.015 250)",
				text4: "oklch(0.35 0.015 250)",
				textHover: "oklch(0.95 0.008 250)",

				// Borders
				border: "oklch(0.25 0.015 250)",
				border2: "oklch(0.30 0.015 250)",

				// Accent (blue primary)
				backgroundAccent: "oklch(0.72 0.15 220)",
				backgroundAccentHover: "oklch(0.65 0.15 220)",
				backgroundAccentText: "oklch(0.06 0.01 250)",
				textAccent: "oklch(0.72 0.15 220)",
				textAccentHover: "oklch(0.65 0.15 220)",
				borderAccent: "oklch(0.72 0.15 220)",

				// Green (brand accent)
				textGreen: "oklch(0.72 0.18 150)",
				textGreenHover: "oklch(0.65 0.18 150)",

				// Kill shadows
				shadow: "transparent",
				shadow2: "transparent",

				// Inverted for buttons
				inverted: "oklch(0.95 0.008 250)",
			},
			// Code block & inline code (semantic)
			// codeBlockBackground → card bg
			// codeInlineBackground → muted bg
		},
	},
	topNav: [
		{ text: "Quickstart", link: "/quickstart" },
		{ text: "Templates", link: "/templates" },
		{ text: "Commands", link: "/commands" },
		{ text: "npm", link: "https://www.npmjs.com/package/@getjack/jack" },
	],
	sidebar: [
		{
			text: "Introduction",
			items: [
				{ text: "What is jack?", link: "/" },
				{ text: "Quickstart", link: "/quickstart" },
				{ text: "Getting Started", link: "/getting-started" },
			],
		},
		{
			text: "Templates",
			items: [
				{ text: "Overview", link: "/templates" },
				{ text: "Browse All", link: "https://dash.getjack.org/templates" },
				{ text: "miniapp", link: "/templates/miniapp" },
				{ text: "api", link: "/templates/api" },
				{ text: "ai-chat", link: "/templates/ai-chat" },
				{ text: "semantic-search", link: "/templates/semantic-search" },
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
				{ text: "OpenClaw / Claude Code", link: "/guides/openclaw" },
				{ text: "AI & Vectorize Bindings", link: "/guides/ai-vectorize" },
			{ text: "Durable Objects", link: "/guides/durable-objects" },
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
    sdk.actions.ready();
  }).catch(() => {});
</script>
</head>`,
					);
				},
			},
			{
				name: "inject-posthog",
				transformIndexHtml(html) {
					return html.replace(
						"</head>",
						`<script>
  !function(t,e){var o,n,p,r;e.__SV||(window.posthog && window.posthog.__loaded)||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init rs ls yi ns us ts ss capture Hi calculateEventProperties vs register register_once register_for_session unregister unregister_for_session gs getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSurveysLoaded onSessionId getSurveys getActiveMatchingSurveys renderSurvey displaySurvey cancelPendingSurvey canRenderSurvey canRenderSurveyAsync identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException startExceptionAutocapture stopExceptionAutocapture loadToolbar get_property getSessionProperty fs ds createPersonProfile ps Qr opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing get_explicit_consent_status is_capturing clear_opt_in_out_capturing hs debug O cs getPageViewId captureTraceFeedback captureTraceMetric Kr".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
  posthog.init('phc_2zIliK38M1ziZQCFUHFE3BRGx7gRiMuQzo1qnFSwsnA', {
    api_host: 'https://eu.i.posthog.com',
    defaults: '2025-11-30',
    person_profiles: 'identified_only'
  });
</script>
</head>`,
					);
				},
			},
		],
	},
});
