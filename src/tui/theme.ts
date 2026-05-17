export const THEME = {
	accent: "#D97757", // Claude terracotta
	ok: "green",
	warn: "yellow",
	err: "red",
	muted: "gray",
} as const;

export const TYPE_PALETTE = [
	"#D97757",
	"#E5544B",
	"#5FB3C9",
	"#7FB069",
	"#B589D6",
	"#E0A93B",
	"#4FAF8E",
	"#6F9FD9",
] as const;

const KNOWN_TYPE_COLOR: Record<string, string> = {
	decision: "#D97757",
	gotcha: "#E5544B",
	feedback: "#5FB3C9",
	project: "#7FB069",
	reference: "#B589D6",
	pattern: "#E0A93B",
	"how-to": "#4FAF8E",
	user: "#6F9FD9",
};

export function typeColor(type: string): string {
	const known = KNOWN_TYPE_COLOR[type];
	if (known) return known;
	let h = 0;
	for (let i = 0; i < type.length; i++) {
		h = (h * 31 + type.charCodeAt(i)) >>> 0;
	}
	return TYPE_PALETTE[h % TYPE_PALETTE.length];
}
