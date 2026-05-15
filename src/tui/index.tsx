import React from "react";
import { render } from "ink";
import { App } from "./App.js";
import type { StatsWindow } from "../lib/stats/types.js";

export function bootStats(opts: {
	window: StatsWindow;
	project: string | null;
	once: boolean;
}): void {
	const { waitUntilExit } = render(
		<App
			initialWindow={opts.window}
			initialProject={opts.project}
			once={opts.once}
		/>,
	);
	if (opts.once) {
		setTimeout(() => process.exit(0), 1000);
	}
	void waitUntilExit();
}
