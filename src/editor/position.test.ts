import { offsetToPosition } from './position';

describe('offsetToPosition', () => {
	const source = 'const a = 1;\nconsole.log(a);\n\nend';

	it.each([
		[0, { row: 0, column: 0 }],
		[6, { row: 0, column: 6 }],
		[13, { row: 1, column: 0 }],
		[21, { row: 1, column: 8 }],
		[29, { row: 2, column: 0 }],
		[30, { row: 3, column: 0 }],
		[source.length, { row: 3, column: 3 }],
	])('offset %i', (offset, position) => {
		expect(offsetToPosition(source, offset)).toEqual(position);
	});

	it('clamps a negative offset to the start', () => {
		expect(offsetToPosition(source, -4)).toEqual({ row: 0, column: 0 });
	});
});
