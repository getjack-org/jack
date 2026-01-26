#!/usr/bin/env bun
import meow from "meow";
import pkg from "../package.json";
import { enableDebug } from "./lib/debug.ts";
import { isJackError } from "./lib/errors.ts";
import { info, error as printError } from "./lib/output.ts";
import { identify, shutdown, withTelemetry } from "./lib/telemetry.ts";

const cli = meow(
	`
  jack — deploy from the command line

  Usage
    $ jack <command> [options]

  Getting Started
    init                Set up jack (run once)
    new <name> [path]   Create and deploy a project
    vibe "<phrase>"     Create from an idea
    ship                Push changes to production

  Projects
    open [name]         Open in browser
    logs                Stream live logs
    down [name]         Undeploy from cloud
    ls                  List all projects
    info [name]         Show project details
    publish             Make your project forkable by others

  Cloud & Sync
    clone <project>     Pull from cloud backup
    sync                Sync to cloud storage

  Account
    login               Sign in
    logout              Sign out
    whoami              Show current user
    update              Update jack to latest version

  Project Management
    link [name]         Link directory to a project
    unlink              Remove project link
    tag                 Manage project tags

  Advanced
    agents              Manage AI agent configs
    secrets             Manage project secrets
    domain              Manage custom domains
    skills              Install and run agent skills
    services            Manage databases
    mcp                 MCP server for AI agents
    telemetry           Usage data settings
    feedback            Share feedback or report issues
    community           Join the jack Discord

  Run 'jack <command> --help' for command-specific options.

  Examples
    $ jack init           Set up once
    $ jack new my-app     Create and deploy
    $ jack ship           Push changes live
`,
	{
		importMeta: import.meta,
		flags: {
			template: {
				type: "string",
				shortFlag: "t",
			},
			message: {
				type: "string",
				shortFlag: "m",
			},
			debug: {
				type: "boolean",
				shortFlag: "d",
				default: false,
			},
			verbose: {
				type: "boolean",
				default: false,
			},
			dryRun: {
				type: "boolean",
				default: false,
			},
			force: {
				type: "boolean",
				default: false,
			},
			as: {
				type: "string",
			},
			label: {
				type: "string",
			},
			dash: {
				type: "boolean",
				default: false,
			},
			logs: {
				type: "boolean",
				default: false,
			},
			yes: {
				type: "boolean",
				default: false,
			},
			local: {
				type: "boolean",
				default: false,
			},
			deployed: {
				type: "boolean",
				default: false,
			},
			cloud: {
				type: "boolean",
				default: false,
			},
			all: {
				type: "boolean",
				shortFlag: "a",
				default: false,
			},
			status: {
				type: "string",
			},
			json: {
				type: "boolean",
				default: false,
			},
			project: {
				type: "string",
				shortFlag: "p",
			},
			skipMcp: {
				type: "boolean",
				default: false,
			},
			managed: {
				type: "boolean",
				default: false,
			},
			byo: {
				type: "boolean",
				default: false,
			},
			ci: {
				type: "boolean",
				default: false,
			},
			tag: {
				type: "string",
				isMultiple: true,
			},
			includeBackup: {
				type: "boolean",
				default: false,
			},
			open: {
				type: "boolean",
				default: false,
			},
			noOpen: {
				type: "boolean",
				default: false,
			},
			write: {
				type: "boolean",
				shortFlag: "w",
				default: false,
			},
			file: {
				type: "string",
				shortFlag: "f",
			},
			db: {
				type: "string",
			},
		},
	},
);

// Enable debug mode if flag is set
if (cli.flags.debug) {
	enableDebug();
}

const [command, ...args] = cli.input;

// Identify user properties for telemetry (dedupe to once per day)
(async () => {
	try {
		const { getTelemetryConfig, saveTelemetryConfig } = await import("./lib/telemetry-config.ts");
		const config = await getTelemetryConfig();
		const today = new Date().toISOString().split("T")[0]; // "YYYY-MM-DD"

		if (config.lastIdentifyDate === today) {
			return; // Already identified today
		}

		identify({
			jack_version: pkg.version,
			os: process.platform,
			arch: process.arch,
			node_version: process.version,
		});

		// Update lastIdentifyDate
		config.lastIdentifyDate = today;
		await saveTelemetryConfig(config);
	} catch {
		// Fallback: just call identify without deduping
		identify({
			jack_version: pkg.version,
			os: process.platform,
			arch: process.arch,
			node_version: process.version,
		});
	}
})();

// Start non-blocking version check (skip for update command, CI, and help)
const skipVersionCheck =
	!command ||
	command === "update" ||
	command === "upgrade" ||
	process.env.CI ||
	process.env.JACK_NO_UPDATE_CHECK;

let updateCheckPromise: Promise<string | null> | null = null;
if (!skipVersionCheck) {
	const { checkForUpdate } = await import("./lib/version-check.ts");
	updateCheckPromise = checkForUpdate().catch(() => null);
}

try {
	switch (command) {
		case "init": {
			const { default: init } = await import("./commands/init.ts");
			await withTelemetry("init", init)({ skipMcp: cli.flags.skipMcp });
			break;
		}
		case "new":
		case "in": {
			const { default: newProject } = await import("./commands/new.ts");
			await withTelemetry("new", newProject)(args[0], args[1], {
				template: cli.flags.template,
				intent: cli.flags.message,
				managed: cli.flags.managed,
				byo: cli.flags.byo,
				ci: cli.flags.ci,
				open: cli.flags.open,
				noOpen: cli.flags.noOpen,
			});
			break;
		}
		case "vibe": {
			const { default: newProject } = await import("./commands/new.ts");
			// vibe always treats first arg as intent phrase
			await withTelemetry("vibe", newProject)(undefined, undefined, {
				template: cli.flags.template,
				intent: args[0],
			});
			break;
		}
		case "shit": {
			// Easter egg for typo
			console.error("💩💩💩");
			// Fall through to ship
		}
		case "ship":
		case "push":
		case "up":
		case "deploy": {
			const { default: ship } = await import("./commands/ship.ts");
			await withTelemetry(
				"ship",
				ship,
			)({
				managed: cli.flags.managed,
				byo: cli.flags.byo,
				dryRun: cli.flags.dryRun,
			});
			break;
		}
		case "logs":
		case "tail": {
			const { default: logs } = await import("./commands/logs.ts");
			await withTelemetry("logs", logs)({ label: cli.flags.label });
			break;
		}
		case "agents": {
			const { default: agents } = await import("./commands/agents.ts");
			await withTelemetry("agents", agents, { subcommand: args[0] })(args[0], args.slice(1), {
				project: cli.flags.project,
			});
			break;
		}
		case "tag": {
			const { default: tag } = await import("./commands/tag.ts");
			await withTelemetry("tag", tag, { subcommand: args[0] })(args[0], args.slice(1));
			break;
		}
		case "sync": {
			const { default: sync } = await import("./commands/sync.ts");
			await withTelemetry(
				"sync",
				sync,
			)({
				verbose: cli.flags.verbose,
				dryRun: cli.flags.dryRun,
				force: cli.flags.force,
			});
			break;
		}
		case "clone": {
			const { default: clone } = await import("./commands/clone.ts");
			await withTelemetry("clone", clone)(args[0], { as: cli.flags.as });
			break;
		}
		case "telemetry": {
			const { default: telemetry } = await import("./commands/telemetry.ts");
			await telemetry(args[0]);
			break;
		}
		case "about": {
			const { default: about } = await import("./commands/about.ts");
			await withTelemetry("about", about)();
			break;
		}
		case "hack": {
			const { default: hack } = await import("./commands/hack.ts");
			await withTelemetry("hack", hack)();
			break;
		}
		case "down": {
			const { default: down } = await import("./commands/down.ts");
			await withTelemetry("down", down)(args[0], {
				force: cli.flags.force,
				includeBackup: cli.flags.includeBackup,
			});
			break;
		}
		case "publish": {
			const { default: publish } = await import("./commands/publish.ts");
			await withTelemetry("publish", publish)();
			break;
		}
		case "open": {
			const { default: open } = await import("./commands/open.ts");
			await withTelemetry("open", open)(args[0], { dash: cli.flags.dash, logs: cli.flags.logs });
			break;
		}
		case "projects": {
			const { default: projects } = await import("./commands/projects.ts");
			const projectArgs = [...args.slice(1)];
			if (cli.flags.local) projectArgs.push("--local");
			if (cli.flags.deployed) projectArgs.push("--deployed");
			if (cli.flags.cloud) projectArgs.push("--cloud");
			if (cli.flags.yes) projectArgs.push("--yes");
			if (cli.flags.force) projectArgs.push("--force");
			await withTelemetry("projects", projects, { subcommand: args[0] })(args[0], projectArgs);
			break;
		}
		case "services": {
			const { default: services } = await import("./commands/services.ts");
			const serviceArgs = [...args.slice(1)];
			if (cli.flags.write) serviceArgs.push("--write");
			if (cli.flags.file) serviceArgs.push("--file", cli.flags.file);
			if (cli.flags.db) serviceArgs.push("--db", cli.flags.db);

			// Build subcommand: "db create", "storage list", or just "db"
			const subcommand = args[0] ? (args[1] ? `${args[0]} ${args[1]}` : args[0]) : undefined;

			await withTelemetry("services", services, { subcommand })(args[0], serviceArgs, {
				project: cli.flags.project,
			});
			break;
		}
		case "secrets": {
			const { default: secrets } = await import("./commands/secrets.ts");
			await withTelemetry("secrets", secrets, { subcommand: args[0] })(args[0], args.slice(1), {
				project: cli.flags.project,
			});
			break;
		}
		case "domain": {
			const { default: domain } = await import("./commands/domain.ts");
			await withTelemetry("domain", domain, { subcommand: args[0] })(args[0], args.slice(1));
			break;
		}
		case "domains": {
			const { default: domains } = await import("./commands/domains.ts");
			await withTelemetry("domains", domains)({ json: cli.flags.json });
			break;
		}
		case "mcp": {
			const { default: mcp } = await import("./commands/mcp.ts");
			// Note: Don't use withTelemetry wrapper for MCP serve - it runs indefinitely
			await mcp(args[0], { project: cli.flags.project, debug: cli.flags.debug });
			break;
		}
		case "ls": {
			const { default: projects } = await import("./commands/projects.ts");
			const lsArgs: string[] = [];
			if (cli.flags.local) lsArgs.push("--local");
			if (cli.flags.deployed) lsArgs.push("--deployed");
			if (cli.flags.cloud) lsArgs.push("--cloud");
			if (cli.flags.all) lsArgs.push("--all");
			if (cli.flags.json) lsArgs.push("--json");
			if (cli.flags.status) lsArgs.push("--status", cli.flags.status);
			if (cli.flags.tag) {
				for (const t of cli.flags.tag) {
					lsArgs.push("--tag", t);
				}
			}
			await withTelemetry("projects", projects, { subcommand: "list" })("list", lsArgs);
			break;
		}
		case "info": {
			const { default: projects } = await import("./commands/projects.ts");
			await withTelemetry("projects", projects, { subcommand: "info" })("info", args);
			break;
		}
		case "login": {
			const { default: login } = await import("./commands/login.ts");
			await withTelemetry("login", login)();
			break;
		}
		case "logout": {
			const { default: logout } = await import("./commands/logout.ts");
			await withTelemetry("logout", logout)();
			break;
		}
		case "whoami": {
			const { default: whoami } = await import("./commands/whoami.ts");
			await withTelemetry("whoami", whoami)();
			break;
		}
		case "update": {
			const { default: update } = await import("./commands/update.ts");
			await withTelemetry("update", update)();
			break;
		}
		case "upgrade": {
			const { default: upgrade } = await import("./commands/upgrade.ts");
			await withTelemetry("upgrade", upgrade)();
			break;
		}
		case "feedback": {
			const { default: feedback } = await import("./commands/feedback.ts");
			await withTelemetry("feedback", feedback)();
			break;
		}
		case "community":
		case "discord": {
			const { default: community } = await import("./commands/community.ts");
			await withTelemetry("community", community)();
			break;
		}
		case "link": {
			const { default: link } = await import("./commands/link.ts");
			await withTelemetry("link", link)(args[0], { byo: cli.flags.byo });
			break;
		}
		case "unlink": {
			const { default: unlink } = await import("./commands/unlink.ts");
			await withTelemetry("unlink", unlink)();
			break;
		}
		case "skillz":
		case "skills": {
			const { default: skills } = await import("./commands/skills.ts");
			await withTelemetry("skills", skills, { subcommand: args[0] })(args[0], args.slice(1));
			break;
		}
		default:
			cli.showHelp(command ? 1 : 0);
	}

	// Show update notification if available (non-blocking check completed)
	if (updateCheckPromise) {
		const latestVersion = await updateCheckPromise;
		if (latestVersion) {
			info("");
			info(`Update available: v${pkg.version} → v${latestVersion}`);
			info("Run: jack update");
		}
	}
} catch (err) {
	if (isJackError(err)) {
		printError(err.message);
		if (err.suggestion) {
			info(err.suggestion);
		}
		await shutdown();
		process.exit(err.meta?.exitCode ?? 1);
	}
	// Re-throw non-JackError errors for stack trace
	throw err;
}

await shutdown();

// Ensure clean exit (stdin listeners from prompts can keep event loop alive)
process.exit(0);
