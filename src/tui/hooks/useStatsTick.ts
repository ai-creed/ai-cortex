import { useCallback, useEffect, useRef, useState } from "react";

export type UseStatsTickResult<T> = {
	data: T | null;
	refresh: () => void;
};

export function useStatsTick<T>(
	read: () => T | Promise<T>,
	intervalMs: number,
): UseStatsTickResult<T> {
	const [data, setData] = useState<T | null>(null);
	const inFlight = useRef(false);
	const readRef = useRef(read);
	readRef.current = read;

	const tick = useCallback(async () => {
		if (inFlight.current) return;
		inFlight.current = true;
		try {
			const v = await readRef.current();
			setData(v);
		} finally {
			inFlight.current = false;
		}
	}, []);

	useEffect(() => {
		void tick();
		const id = setInterval(tick, intervalMs);
		return () => clearInterval(id);
	}, [intervalMs, tick]);

	return { data, refresh: () => void tick() };
}
