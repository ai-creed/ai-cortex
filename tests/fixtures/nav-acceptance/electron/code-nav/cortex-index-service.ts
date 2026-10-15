import { Mode } from "./types";
import type { DefinitionHit, Keys } from "./types";

export interface WorktreeStatus {
	dirty: boolean;
	indexSeq: number;
}

export class CortexIndexService {
	private mode: Mode = Mode.Fast;

	open(keys: Keys): { close(): void } {
		return { close() {} };
	}

	findDefinitions(keys: Keys, name: string): DefinitionHit[] {
		const db = this.open(keys);
		db.close();
		return [{ file: name, line: 1 }];
	}

	status(): WorktreeStatus {
		return { dirty: false, indexSeq: Mode.Deep };
	}
}

export function makeService(): CortexIndexService {
	return new CortexIndexService();
}
