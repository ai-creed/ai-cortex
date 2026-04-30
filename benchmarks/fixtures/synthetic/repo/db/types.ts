export type QueryResult<T> = { rows: T[]; rowCount: number };

export type Paginated<T> = {
	items: T[];
	total: number;
	page: number;
	pageSize: number;
};

export function paginate<T>(
	items: T[],
	page: number,
	pageSize: number,
): Paginated<T> {
	const start = (page - 1) * pageSize;
	return {
		items: items.slice(start, start + pageSize),
		total: items.length,
		page,
		pageSize,
	};
}
