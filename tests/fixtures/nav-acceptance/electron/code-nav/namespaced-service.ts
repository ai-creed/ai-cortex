import type { Keys } from "./types";

export namespace N {
	export class C {
		open(keys: Keys): number {
			return keys.repoKey.length;
		}

		run(keys: Keys): number {
			return this.open(keys);
		}
	}

	export function open(): number {
		return 0;
	}
}
