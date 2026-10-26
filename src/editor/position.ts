/** A source offset as Ace's zero-based { row, column }. */
export const offsetToPosition = (source: string, offset: number) => {
	const before = source.slice(0, Math.max(0, offset));
	const row = before.split('\n').length - 1;
	return { row, column: before.length - (before.lastIndexOf('\n') + 1) };
};
