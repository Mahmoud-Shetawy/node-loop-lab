import { Languages, Moon, Sun } from 'lucide-react';
import { useI18n } from '@/i18n';
import { useScheme } from '@/theme';
import { Button } from '@/ui/button';

export const REPOSITORY = 'https://github.com/Mahmoud-Shetawy/node-loop-lab';

/** The loop mark: three phases on a ring, the colors of their callbacks. */
function Logo() {
	return (
		<svg viewBox="0 0 64 64" className="size-9 shrink-0" aria-hidden="true">
			<rect width="64" height="64" rx="14" className="fill-secondary" />
			<circle
				cx="32"
				cy="32"
				r="18"
				fill="none"
				strokeWidth="5"
				className="stroke-border"
			/>
			<path
				d="M32 14a18 18 0 0 1 17.3 13"
				fill="none"
				stroke="var(--cat-timer-s)"
				strokeWidth="5"
				strokeLinecap="round"
			/>
			<path
				d="M49.3 37A18 18 0 0 1 32 50"
				fill="none"
				stroke="var(--cat-io-s)"
				strokeWidth="5"
				strokeLinecap="round"
			/>
			<path
				d="M23 47.6A18 18 0 0 1 14.7 27"
				fill="none"
				stroke="var(--cat-immediate-s)"
				strokeWidth="5"
				strokeLinecap="round"
			/>
			<circle cx="32" cy="32" r="5" fill="var(--cat-tick-s)" />
		</svg>
	);
}

function GitHubMark() {
	return (
		<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
			<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
		</svg>
	);
}

export function Header() {
	const { m, language, setLanguage } = useI18n();
	const scheme = useScheme((state) => state.scheme);
	const setScheme = useScheme((state) => state.setScheme);
	const other = language === 'ar' ? 'en' : 'ar';
	const nextScheme = scheme === 'dark' ? 'light' : 'dark';

	return (
		<header className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b bg-background/80 px-4 py-2.5 backdrop-blur lg:px-6">
			<div className="flex min-w-0 items-center gap-3">
				<Logo />
				<div className="flex min-w-0 flex-col">
					<h1 className="m-0 truncate text-[17px] font-semibold tracking-tight">
						{m.app.title}
					</h1>
					<p className="m-0 hidden items-center gap-2 text-xs text-muted-foreground sm:flex">
						{m.app.subtitle}
						<span className="rounded-md bg-accent/15 px-1.5 py-px text-[10.5px] font-semibold text-accent">
							{m.app.version}
						</span>
					</p>
				</div>
			</div>
			<nav className="flex items-center gap-1">
				<a
					href={REPOSITORY}
					target="_blank"
					rel="noreferrer"
					aria-label={m.header.github}
					title={m.header.github}
					className="inline-flex size-8 items-center justify-center rounded-lg hover:bg-secondary [&_svg]:size-[18px]"
				>
					<GitHubMark />
				</a>
				<Button
					look="ghost"
					onClick={() => setLanguage(other)}
					aria-label={m.header.language}
					data-testid="language-toggle"
				>
					<Languages />
					<span lang={other}>{m.header.languageName}</span>
				</Button>
				<Button
					look="ghost"
					icon
					onClick={() => setScheme(nextScheme)}
					aria-label={m.header.scheme[nextScheme]}
					title={m.header.scheme[nextScheme]}
					data-testid="scheme-toggle"
				>
					{scheme === 'dark' ? <Sun /> : <Moon />}
				</Button>
			</nav>
		</header>
	);
}
