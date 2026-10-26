/**
 * Short names for callbacks, so a card reads at a glance. The engine labels
 * are source excerpts (`() => { console.log('a'); process.nextTick(…) }`);
 * the full text stays available as a tooltip.
 */

const MAX = 28;

/** First call inside a function body: `console.log('a')` -> `log('a')`. */
const firstCall = (body: string) => {
	const callee = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\(/.exec(body);
	if (!callee) return null;
	// read the arguments up to the matching parenthesis (they may nest)
	let depth = 0;
	let end = -1;
	const open = callee.index + callee[0].length - 1;
	for (let i = open; i < body.length; i++) {
		if (body[i] === '(') depth++;
		else if (body[i] === ')' && --depth === 0) {
			end = i;
			break;
		}
	}
	const name = callee[1].replace(/^console\./, '');
	const args = end === -1 ? '…' : body.slice(open + 1, end).trim();
	return args.length > 18 ? `${name}(…)` : `${name}(${args})`;
};

export const shortLabel = (label: string): string => {
	const text = label.trim();

	// fs syscall stages: `fs.readFile('a') · open`, `fs.readFile('a'): open ✓ → fstat`
	const stage = /^fs(?:\.promises)?\.(\w+)\([^)]*\)(?: · |: )(.+)$/.exec(text);
	if (stage)
		return stage[2].includes('✓') ? stage[2] : `${stage[1]} · ${stage[2]}`;

	// function declarations / expressions with a name: `function greet() {…}`
	const named = /^(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/.exec(text);
	if (named) return `${named[1]}()`;

	// anonymous functions and arrows: show what they do first
	const isFunction =
		/^(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(text) ||
		/^(?:async\s+)?function\b/.test(text);
	if (isFunction) {
		const arrow = text.indexOf('=>');
		const body =
			arrow === -1 ? text.slice(text.indexOf('{') + 1) : text.slice(arrow + 2);
		const call = firstCall(body);
		const params = /^(?:async\s*)?\(([^)]*)\)/.exec(text)?.[1] ?? '';
		const head = `(${params.length > 8 ? '…' : params}) =>`;
		return call ? `${head} ${call}` : `${head} {…}`;
	}

	if (text.length <= MAX) return text;

	// a long call: keep the callee, fold the arguments
	const call = /^([A-Za-z_$][\w$.]*)\(/.exec(text);
	if (call) return `${call[1]}(…)`;
	return `${text.slice(0, MAX - 1)}…`;
};
