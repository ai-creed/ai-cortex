export interface Keys {
	repoKey: string;
	worktreeKey: string;
}
export type DefinitionHit = { file: string; line: number };
export enum Mode {
	Fast,
	Deep = 2,
}
