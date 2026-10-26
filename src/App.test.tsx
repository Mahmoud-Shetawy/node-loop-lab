import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useLanguageStore } from '@/i18n';
import { usePlayerStore } from '@/player/player';
import { useScheme } from '@/theme';
import ace from 'ace-builds';
import { App } from './App';

afterEach(() => {
	act(() => {
		usePlayerStore.getState().reset();
		useLanguageStore.getState().setLanguage('en');
	});
});

describe('App', () => {
	it('shows the editor, the console and the event loop', () => {
		render(<App />);
		expect(
			screen.getByRole('heading', { level: 1, name: 'Node Loop Lab' })
		).toBeInTheDocument();
		expect(screen.getByRole('region', { name: 'Code Editor' })).toBeVisible();
		expect(screen.getByRole('region', { name: 'Event loop' })).toBeVisible();
		expect(screen.getByTestId('scene-console')).toBeInTheDocument();
		expect(screen.getByTestId('run-button')).toBeEnabled();
	});

	it('links to the repository', () => {
		render(<App />);
		expect(
			screen.getByRole('link', { name: 'GitHub repository' })
		).toHaveAttribute(
			'href',
			'https://github.com/Mahmoud-Shetawy/node-loop-lab'
		);
	});

	it('lists every example and loads the one picked', () => {
		render(<App />);
		const select = screen.getByTestId('example-select');
		expect(within(select).getAllByRole('option').length).toBeGreaterThan(10);
		fireEvent.change(select, { target: { value: 'crash' } });
		expect(select).toHaveValue('crash');
		const editor = document.querySelector<HTMLElement>('.ace_editor');
		expect(editor && ace.edit(editor).getValue()).toContain(
			"throw new Error('boom')"
		);
	});

	it('explains a panel only when asked', () => {
		render(<App />);
		const editor = screen.getByRole('region', { name: 'Code Editor' });
		const about = within(editor).getByTestId('panel-about');
		expect(about).toHaveAttribute('aria-expanded', 'false');
		fireEvent.click(about);
		expect(about).toHaveAttribute('aria-expanded', 'true');
		expect(editor).toHaveTextContent('files you can read');
	});

	it('switches to Arabic, right to left', () => {
		render(<App />);
		fireEvent.click(screen.getByTestId('language-toggle'));
		expect(document.documentElement).toHaveAttribute('dir', 'rtl');
		expect(document.documentElement).toHaveAttribute('lang', 'ar');
		expect(screen.getByTestId('run-button')).toHaveTextContent('تشغيل');
		fireEvent.click(screen.getByTestId('language-toggle'));
		expect(document.documentElement).toHaveAttribute('dir', 'ltr');
	});

	it('switches between dark and light and remembers it', () => {
		render(<App />);
		const start = useScheme.getState().scheme;
		fireEvent.click(screen.getByTestId('scheme-toggle'));
		const next = start === 'dark' ? 'light' : 'dark';
		expect(useScheme.getState().scheme).toBe(next);
		expect(document.documentElement.classList.contains('dark')).toBe(
			next === 'dark'
		);
		expect(localStorage.getItem('node-loop-lab:scheme')).toBe(next);
	});
});
