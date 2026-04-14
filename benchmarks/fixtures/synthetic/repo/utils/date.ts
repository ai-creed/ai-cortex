export function now(): Date {
	return new Date();
}

export function formatDate(date: Date): string {
	return date.toISOString().slice(0, 10);
}

export function daysAgo(n: number): Date {
	const d = now();
	d.setDate(d.getDate() - n);
	return d;
}
