import { Range, type Ace } from 'ace-builds';
import { offsetToPosition } from './position';

/**
 * The highlights the simulation draws in the editor: the code running now,
 * or the range an engine error points at. Offsets refer to `source`, the
 * code the simulation was built from (the editor may have changed since).
 */
let editor: Ace.Editor | null = null;
let source = '';
let ids: number[] = [];

const mark = (range: [number, number], className: string) => {
	const session = editor?.getSession();
	if (!session) return;
	const from = offsetToPosition(source, range[0]);
	// an empty range still gets one visible character
	const to = offsetToPosition(source, Math.max(range[1], range[0] + 1));
	ids.push(
		session.addMarker(
			new Range(from.row, from.column, to.row, to.column),
			className,
			'text'
		)
	);
};

export const marks = {
	attach(next: Ace.Editor | null) {
		editor = next;
	},
	setSource(next: string) {
		source = next;
	},
	clear() {
		const session = editor?.getSession();
		if (session) ids.forEach((id) => session.removeMarker(id));
		ids = [];
	},
	running(range: [number, number] | undefined) {
		marks.clear();
		if (range) mark(range, 'marker-running');
	},
	error(range: [number, number]) {
		marks.clear();
		mark(range, 'marker-error');
	},
};
