// Symbol fixture: every TS/JS kind in TS_SYMBOL_KINDS (A2.1 TS column).
export function plain(a: number): number {
	return a;
}

export function over(a: string): string;
export function over(a: number): number;
export function over(a: unknown): unknown {
	return a;
}

export const arrow = (x: number) => x * 2;
const fnExpr = function (y: number) {
	return y;
};

export default function () {
	return plain(1);
}

export class Service {
	count = 0;
	run(): number {
		return this.count;
	}
}

export abstract class Base {
	abstract shape(): string;
}

export const Expr = class {};

export interface Shape {
	area: number;
	describe(): string;
}

export type Id = string | number;

export enum Color {
	Red,
	Green = "green",
}

export const limit = 10;
let counter = 0;
export const { left, right } = { left: 1, right: 2 };

export namespace Geo {
	export function dist(): number {
		return 0;
	}
	export const origin = 0;
}

declare function external(): void;

export { fnExpr, counter };
