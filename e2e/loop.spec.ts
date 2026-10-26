import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
	await page.goto('./');
});

test('plays the I/O puzzle in the order real Node prints it', async ({
	page,
}) => {
	await page.getByTestId('example-select').selectOption('ioPuzzle');
	await page.getByTestId('run-button').click();
	await page.getByTestId('pause-button').click();

	const counter = page.getByTestId('step-counter');
	const paused = await counter.textContent();
	await page.getByTestId('next-button').click();
	await expect(counter).not.toHaveText(paused ?? '');
	await page.getByTestId('back-button').click();
	await expect(counter).toHaveText(paused ?? '');

	// fastest speed, then to the end
	await page.getByTestId('speed').fill('4');
	await page.getByTestId('play-button').click();
	await expect(page.getByTestId('process-exit')).toContainText('code 0', {
		timeout: 60_000,
	});
	const printed = (await page.getByRole('log').innerText())
		.split('\n')
		.map((line) => line.replace(/^>\s*/, '').trim())
		.filter(Boolean);
	expect(printed).toEqual([
		'nextTick in fs',
		'setImmediate',
		'nextTick in setImmediate',
		'Promise in setImmediate',
		'setTimeout',
		'nextTick in setTimeout',
	]);

	// start over replays the same run from the first step
	await page.getByTestId('restart-button').click();
	await expect(page.getByRole('log')).not.toContainText('nextTick in fs');
});

test('reports an infinite loop instead of freezing the page', async ({
	page,
}) => {
	await page.locator('.ace_text-input').focus();
	await page.keyboard.press('ControlOrMeta+A');
	await page.keyboard.type('while (true) {}');
	await page.getByTestId('run-button').click();
	await expect(page.getByTestId('simulation-error')).toContainText(
		'infinite loop'
	);
});

test('switches to Arabic, right to left', async ({ page }) => {
	await page.getByTestId('language-toggle').click();
	await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
	await expect(page.getByTestId('run-button')).toHaveText('تشغيل');
	// code and its output stay left to right
	await expect(page.locator('.code-editor')).toHaveAttribute('dir', 'ltr');
});

test('remembers dark or light mode', async ({ page }) => {
	const html = page.locator('html');
	const wasDark = (await html.getAttribute('class'))?.includes('dark');
	await page.getByTestId('scheme-toggle').click();
	await page.reload();
	if (wasDark) await expect(html).not.toHaveClass(/dark/);
	else await expect(html).toHaveClass(/dark/);
});
