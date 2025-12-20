import { defineConfig } from "vocs";

export default defineConfig({
  rootDir: "docs",
  title: "jack",
  description:
    "Ship before you forget why you started. The vibecoder's deployment CLI.",
  logoUrl: {
    light: "/logo-light.svg",
    dark: "/logo-dark.svg",
  },
  iconUrl: "/favicon.ico",
  // basePath: "/jack", // Not needed with custom domain
  topNav: [
    { text: "Guide", link: "/getting-started" },
    { text: "Templates", link: "/templates" },
    { text: "Commands", link: "/commands" },
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
        { text: "ls", link: "/commands/ls" },
        { text: "open", link: "/commands/open" },
        { text: "services", link: "/commands/services" },
      ],
    },
    {
      text: "Guides",
      items: [{ text: "Using with AI Agents", link: "/guides/ai-agents" }],
    },
  ],
  socials: [
    {
      icon: "github",
      link: "https://github.com/getjack-org/jack",
    },
    {
      icon: "discord",
      link: "https://discord.gg/fb64krv48R",
    },
  ],
});
