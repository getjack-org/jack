#!/usr/bin/env bun
import meow from "meow";
import pkg from "../package.json";
import { enableDebug } from "./lib/debug.ts";
import { identify, shutdown, withTelemetry } from "./lib/telemetry.ts";

const cli = meow(
	`
  jack — deploy from the command line

  Usage
    $ jack <command> [options]

  Commands
    init                Jack in (one-time setup)
    new [name]          Create and deploy a project
    vibe "<phrase>"     Quick project from intent (alias for new --intent)
    ship                Push to production
    logs                Stream live logs
    agents              Manage AI agent templates
    sync                Sync to cloud storage
    clone <project>     Pull project from cloud
    cloud               Manage cloud storage
    down [name]         Undeploy from cloud
    open [name]         Open project in browser
    projects            Manage project registry
    services            Manage project services
    mcp serve           Start MCP server for AI agents
    mcp test            Test MCP server connectivity
    telemetry           Manage anonymous usage data
    about               The story behind jack

  Aliases
    ls                  List all projects (jack projects list)
    info [name]         Show project details (jack projects info)

  Options
    -t, --template  Template: miniapp (default), api, or user/repo
    -m, --message   Intent phrase for project customization
    -d, --debug     Show timing and debug logs
    --verbose       Show detailed output
    --dry-run       Preview changes without applying
    --force         Force operation
    --as <name>     Clone to different directory name
    --dash          Open cloud dashboard
    --logs          Open logs page
    --yes           Skip confirmation prompts
    --local         Filter by local projects
    --deployed      Filter by deployed projects
    --cloud         Filter by backup projects
    --skip-mcp      Skip MCP config installation during init

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
			project: {
				type: "string",
				shortFlag: "p",
			},
			skipMcp: {
				type: "boolean",
				default: false,
			},
		},
	},
);

// Enable debug mode if flag is set
if (cli.flags.debug) {
	enableDebug();
}

const [command, ...args] = cli.input;

// Identify user properties for telemetry
identify({
	jack_version: pkg.version,
	os: process.platform,
	arch: process.arch,
	node_version: process.version,
	is_ci: !!process.env.CI,
});

switch (command) {
	case "init": {
		const { default: init } = await import("./commands/init.ts");
		await withTelemetry("init", init)({ skipMcp: cli.flags.skipMcp });
		break;
	}
	case "new":
	case "in": {
		const { default: newProject } = await import("./commands/new.ts");
		await withTelemetry("new", newProject)(args[0], {
			template: cli.flags.template,
			intent: cli.flags.message,
		});
		break;
	}
	case "vibe": {
		const { default: newProject } = await import("./commands/new.ts");
		// vibe always treats first arg as intent phrase
		await withTelemetry("vibe", newProject)(undefined, {
			template: cli.flags.template,
			intent: args[0],
		});
		break;
	}
	case "ship":
	case "push":
	case "up":
	case "deploy": {
		const { default: ship } = await import("./commands/ship.ts");
		await withTelemetry("ship", ship)();
		break;
	}
	case "logs":
	case "tail": {
		const { default: logs } = await import("./commands/logs.ts");
		await withTelemetry("logs", logs)();
		break;
	}
	case "agents": {
		const { default: agents } = await import("./commands/agents.ts");
		await withTelemetry("agents", agents)(args[0], args.slice(1), {
			project: cli.flags.project,
		});
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
	case "cloud": {
		const { default: cloud } = await import("./commands/cloud.ts");
		await withTelemetry("cloud", cloud)(args[0], args.slice(1));
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
		await withTelemetry("down", down)(args[0], { force: cli.flags.force });
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
		await withTelemetry("projects", projects)(args[0], projectArgs);
		break;
	}
	case "services": {
		const { default: services } = await import("./commands/services.ts");
		await withTelemetry("services", services)(args[0], args.slice(1), {
			project: cli.flags.project,
		});
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
		await withTelemetry("projects", projects)("list", lsArgs);
		break;
	}
	case "info": {
		const { default: projects } = await import("./commands/projects.ts");
		await withTelemetry("projects", projects)("info", args);
		break;
	}
	default:
		cli.showHelp(command ? 1 : 0);
}

await shutdown();
