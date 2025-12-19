const adjectives = [
	"swift",
	"bright",
	"calm",
	"bold",
	"cool",
	"fast",
	"keen",
	"neat",
	"warm",
	"wise",
];

const nouns = [
	"wave",
	"spark",
	"cloud",
	"star",
	"leaf",
	"stone",
	"wind",
	"flame",
	"brook",
	"ridge",
];

export function generateProjectName(): string {
	const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
	const noun = nouns[Math.floor(Math.random() * nouns.length)];
	const suffix = Math.random().toString(16).slice(2, 6);
	return `${adj}-${noun}-${suffix}`;
}
