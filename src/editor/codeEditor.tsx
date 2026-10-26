import { useEffect } from 'react';
import ReactAce from 'react-ace';
import 'ace-builds/src-noconflict/mode-javascript';
import 'ace-builds/src-noconflict/theme-github';
import 'ace-builds/src-noconflict/theme-one_dark';
import { usePlayerStore } from '@/player/player';
import { present } from '@/player/visualState';
import { ACE_THEME, useScheme } from '@/theme';
import { marks } from './marks';

// react-ace ships CommonJS: under Vite the component can arrive as `.default`
const Ace =
	(ReactAce as unknown as { default?: typeof ReactAce }).default ?? ReactAce;

interface CodeEditorProps {
	code: string;
	onChange(code: string): void;
}

export function CodeEditor({ code, onChange }: CodeEditorProps) {
	const scheme = useScheme((state) => state.scheme);
	const status = usePlayerStore((state) => state.status);
	const running = usePlayerStore(
		(state) => present(state.view.queues.callstack).at(-1)?.range
	);
	const locked = status !== 'idle';

	// follow the frame on top of the call stack while a simulation plays
	useEffect(() => {
		if (locked) marks.running(running);
	}, [locked, running]);

	useEffect(() => () => marks.attach(null), []);

	return (
		// code reads left to right in every language
		<div dir="ltr" className="code-editor min-h-[280px] grow">
			<Ace
				mode="javascript"
				theme={ACE_THEME[scheme]}
				value={code}
				onChange={(next) => {
					onChange(next);
					// an error banner describes the code that ran, not the edit
					if (usePlayerStore.getState().error) {
						usePlayerStore.getState().clearError();
						marks.clear();
					}
				}}
				onLoad={(editor) => marks.attach(editor)}
				width="100%"
				height="100%"
				fontSize={14}
				lineHeight={20}
				showPrintMargin={false}
				setOptions={{
					readOnly: locked,
					useWorker: false,
					showGutter: true,
					highlightActiveLine: !locked,
					tabSize: 2,
				}}
				editorProps={{ $blockScrolling: true }}
			/>
		</div>
	);
}
