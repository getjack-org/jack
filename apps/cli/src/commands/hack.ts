const reset = "\x1b[0m";
const bright = "\x1b[1m";
const dim = "\x1b[2m";
const cyan = "\x1b[38;2;0;255;255m";
const dimCyan = "\x1b[38;2;0;180;180m";
const green = "\x1b[38;2;0;200;0m";

const matrixChars = "░▒▓█▀▄■□◆◇●◐◑◒◓ｦｱｳｴｵｶｷｸｹｺ";

function randomChar(): string {
	return matrixChars[Math.floor(Math.random() * matrixChars.length)];
}

async function sleep(ms: number) {
	await new Promise((r) => setTimeout(r, ms));
}

async function type(text: string, delay = 30) {
	for (const char of text) {
		process.stdout.write(char);
		await sleep(delay);
	}
}

async function typeLine(text: string, delay = 30) {
	await type(text, delay);
	console.log();
}

async function matrixDecode(text: string, indent = "") {
	const frames = 30;
	const delay = 50;
	const len = text.length;

	for (let frame = 0; frame <= frames; frame++) {
		const resolvedCount = Math.floor((frame / frames) * len);
		let line = indent;

		for (let i = 0; i < len; i++) {
			if (i < resolvedCount) {
				line += `${bright}${cyan}${text[i]}${reset}`;
			} else {
				line += `${dimCyan}${randomChar()}${reset}`;
			}
		}

		process.stdout.write(`\x1b[2K\r${line}`);
		await sleep(delay);
	}

	process.stdout.write(`\x1b[2K\r${indent}${bright}${cyan}${text}${reset}\n`);
}

async function bootSequence() {
	const modulePool = [
		"consciousness.ko",
		"cyberspace.ko",
		"deploy.ko",
		"neural.ko",
		"ice-breaker.ko",
		"daemon.ko",
		"matrix.ko",
		"decrypt.ko",
		"intrusion.ko",
		"phantom.ko",
	];
	const modules = pickRandom(modulePool, 3);

	console.log();
	console.log(`${dim}JACK OS v1.0${reset}`);
	console.log(`${dim}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${reset}`);
	await sleep(300);

	await typeLine(`${green}Initializing...${reset}`, 20);
	for (const mod of modules) {
		await type(`  ${dim}├─${reset} ${mod}`, 15);
		await sleep(100 + Math.random() * 200);
		console.log(`  ${green}[OK]${reset}`);
	}
	await sleep(200);
}

function pickRandom<T>(arr: T[], count: number): T[] {
	const shuffled = [...arr].sort(() => Math.random() - 0.5);
	return shuffled.slice(0, count);
}

async function traceRoute() {
	const username = process.env.USER || process.env.USERNAME || "user";

	const serverPool = [
		"node.chiba.city",
		"relay.freeside.orbital",
		"proxy.night.city",
		"vault.zaibatsu.corp",
		"node.sprawl.net",
		"relay.tessier-ashpool.ice",
		"cache.construct.sim",
		"gate.zion.cluster",
		"hub.screaming.fist",
		"core.wintermute.ai",
		"edge.straylight.run",
		"sync.maelstrom.net",
	];

	const midHops = pickRandom(serverPool, 3);
	const hops = [
		["localhost", "0.1"],
		[`${username}.meat.space`, String(10 + Math.floor(Math.random() * 20))],
		[midHops[0], String(50 + Math.floor(Math.random() * 50))],
		[midHops[1], String(100 + Math.floor(Math.random() * 100))],
		[midHops[2], "███"],
	];

	console.log();
	await typeLine(`${green}Tracing route...${reset}`, 20);

	for (let i = 0; i < hops.length; i++) {
		const [host, ms] = hops[i];
		await type(`  ${dim}${i + 1}${reset}  ${host}`, 10);
		await sleep(150 + Math.random() * 300);
		console.log(`  ${dimCyan}${ms}ms${reset}`);
	}
	await sleep(200);
}

async function sshConnect(target: string) {
	console.log();
	await typeLine(`${green}Connecting to ${target}:22...${reset}`, 15);
	await sleep(300);
	await type(`${dim}RSA fingerprint: ${reset}${dimCyan}`);
	for (let i = 0; i < 12; i++) {
		process.stdout.write(randomChar());
		await sleep(30);
	}
	console.log(`${reset}`);
	await sleep(400);
	console.log(`${bright}${green}ACCESS GRANTED${reset}`);
	await sleep(500);
}

export default async function hack(): Promise<void> {
	const quotes = [
		// Sneakers (1992)
		"The world isn't run by weapons anymore. It's run by ones and zeroes.",
		"No more secrets.",
		// Gibson - Neuromancer
		"The sky above the port was the color of television, tuned to a dead channel.",
		"Cyberspace. A consensual hallucination.",
		// Gibson - various
		"The future is already here — it's just not evenly distributed.",
		// Cyberpunk 2077 - Johnny Silverhand
		"Wake the fuck up, Samurai. We have a city to burn.",
		// Hackers (1995)
		"Mess with the best, die like the rest.",
		"Hack the planet!",
		// Hacker wisdom
		"Playfully doing something difficult, whether useful or not, that is hacking.",
		"There's nothing more permanent than a temporary hack.",
		// jack philosophy - from SPIRIT.md
		"Context-switching to dashboards is violence.",
		"GUIs are for browsing. CLIs are for flow.",
		"The best infrastructure is invisible.",
		"Every friction point is a creative thought lost.",
		"Create and ship before your first commit.",
		"Don't punish exploration. Creation is free.",
	];
	const quote = quotes[Math.floor(Math.random() * quotes.length)];

	const serverPool = [
		"node.chiba.city",
		"relay.freeside.orbital",
		"proxy.night.city",
		"vault.zaibatsu.corp",
		"node.sprawl.net",
		"relay.tessier-ashpool.ice",
		"cache.construct.sim",
		"gate.zion.cluster",
		"hub.screaming.fist",
		"core.wintermute.ai",
		"edge.straylight.run",
		"sync.maelstrom.net",
	];
	const target = serverPool[Math.floor(Math.random() * serverPool.length)];

	await bootSequence();
	await traceRoute();
	await sshConnect(target);

	console.log();
	console.log(`${dim}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${reset}`);
	console.log();
	await matrixDecode(`"${quote}"`);
	console.log();
}
