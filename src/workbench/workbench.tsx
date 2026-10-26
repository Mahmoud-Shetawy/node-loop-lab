import { useState, type FC } from 'react';
import { AlertTriangle, Info } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { CodeEditor } from '@/editor/codeEditor';
import { REPOSITORY } from '@/header/header';
import { useI18n, type Messages } from '@/i18n';
import { shortLabel } from '@/player/labels';
import { usePlayerStore } from '@/player/player';
import { SceneConsole } from '@/scene/sceneConsole';
import { EXAMPLES, FIRST_EXAMPLE, type ExampleKey } from '@/examples';
import { Panel } from '@/ui/panel';
import { RichText } from '@/ui/richText';
import { PlayerControls } from './playerControls';

const ISSUES_URL = `${REPOSITORY}/issues`;

/** `phase.timers` -> messages.narration.phase.timers */
const narrationText = (messages: Messages, key: string) => {
	const value = key
		.split('.')
		.reduce<unknown>(
			(node, part) => (node as Record<string, unknown> | undefined)?.[part],
			messages.narration
		);
	return typeof value === 'string' ? value : '';
};

/** The sentence that explains the step the player just showed. */
export const Narration: FC = () => {
	const narration = usePlayerStore((state) => state.view.narration);
	const internal = usePlayerStore((state) => state.view.internal);
	const status = usePlayerStore((state) => state.status);
	const [showInside, setShowInside] = useState(false);
	const { m, format } = useI18n();
	const idle = status === 'idle';
	// the sentence names callbacks the way their cards do
	const sentence = narration
		? format(narrationText(m, narration.key), {
				...narration.params,
				...(typeof narration.params.value === 'string' && {
					value: shortLabel(narration.params.value),
				}),
			})
		: '…';

	// the live region stays mounted: screen readers ignore regions added late
	return (
		<div
			className={
				idle
					? 'sr-only'
					: 'flex flex-col gap-2 rounded-xl border border-border/70 bg-secondary/40 px-4 py-3'
			}
			data-testid="narration"
		>
			<AnimatePresence mode="wait" initial={false}>
				<motion.p
					key={sentence}
					initial={{ opacity: 0, y: 6 }}
					animate={{ opacity: 1, y: 0 }}
					exit={{ opacity: 0, y: -6 }}
					transition={{ duration: 0.2 }}
					className="m-0 min-h-[3.4em] text-[17px] leading-relaxed text-foreground"
					aria-live="polite"
				>
					<bdi>{idle ? '' : sentence}</bdi>
				</motion.p>
			</AnimatePresence>
			{!idle && (
				<div className="flex flex-col gap-1">
					<button
						type="button"
						onClick={() => setShowInside((v) => !v)}
						aria-expanded={showInside}
						className="self-start text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
						data-testid="inside-toggle"
					>
						{showInside ? m.scene.hideInside : m.scene.showInside}
					</button>
					{showInside && internal && (
						<code
							className="code-text break-words text-[12.5px] text-muted-foreground"
							dir="ltr"
							data-testid="internal-calls"
						>
							{internal.calls}
						</code>
					)}
				</div>
			)}
		</div>
	);
};

const Messages: FC<{ example: ExampleKey }> = ({ example }) => {
	const error = usePlayerStore((state) => state.error);
	const status = usePlayerStore((state) => state.status);
	// known as soon as the simulation is loaded, not only at its last step
	const truncated = usePlayerStore((state) => {
		const end = state.steps.at(-1);
		return end?.type === 'end' && end.truncated;
	});
	const { m, format } = useI18n();

	if (error)
		return (
			<div
				role="alert"
				data-testid="simulation-error"
				className="flex gap-2 rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm"
			>
				<AlertTriangle className="size-4 shrink-0 text-destructive mt-0.5" />
				<div className="flex flex-col gap-1">
					<span className="font-semibold">{m.errors.title}</span>
					<span>{format(m.errors[error.code], error.params)}</span>
					{error.code === 'internal' && (
						<a
							className="underline"
							href={ISSUES_URL}
							target="_blank"
							rel="noreferrer"
						>
							{m.errors.report}
						</a>
					)}
				</div>
			</div>
		);

	if (truncated)
		return (
			<div
				role="status"
				data-testid="simulation-notice"
				className="flex gap-2 rounded-lg border border-warning/50 bg-warning/10 p-3 text-sm"
			>
				<Info className="size-4 shrink-0 text-warning mt-0.5" />
				<span>{m.notices.truncated}</span>
			</div>
		);

	const note =
		EXAMPLES[example].hasNote &&
		m.exampleNotes[example as keyof Messages['exampleNotes']];
	if (note && status === 'idle')
		return (
			<div
				data-testid="example-note"
				className="flex gap-2 rounded-lg border border-border bg-secondary/60 p-3 text-xs text-muted-foreground"
			>
				<Info className="size-4 shrink-0 mt-0.5" />
				<span>{note}</span>
			</div>
		);

	return null;
};

/** Left column: pick or write code, run it, read what it printed. */
export function Workbench() {
	const [example, setExample] = useState<ExampleKey>(FIRST_EXAMPLE);
	const [code, setCode] = useState(EXAMPLES[FIRST_EXAMPLE].code);
	const { m } = useI18n();

	const chooseExample = (key: ExampleKey) => {
		setExample(key);
		setCode(EXAMPLES[key].code);
	};

	return (
		<Panel
			title={m.sections.editor.title}
			about={<RichText content={m.sections.editor.description} />}
		>
			<PlayerControls code={code} example={example} onExample={chooseExample} />
			<Narration />
			<Messages example={example} />
			<CodeEditor code={code} onChange={setCode} />
			{/* what the program prints, right under the code that printed it */}
			<SceneConsole />
		</Panel>
	);
}
