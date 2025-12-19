export default async function hack(): Promise<void> {
	const quotes = [
		// Gibson - Neuromancer
		"The sky above the port was the color of television, tuned to a dead channel.",
		"Cyberspace. A consensual hallucination.",
		// Gibson - various
		"The future is already here — it's just not evenly distributed.",
		"The street finds its own uses for things.",
		// Sterling
		"Anything that can be done to a rat can be done to a human being.",
		// Stephenson - Snow Crash
		"The Metaverse. It's a fictional structure made out of code.",
		// Generic cyberpunk vibes
		"We are all cyborgs now.",
	];
	const quote = quotes[Math.floor(Math.random() * quotes.length)];
	console.error(`\n  "${quote}"\n`);
}
