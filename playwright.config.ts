import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;

export default defineConfig({
	testDir: './e2e',
	fullyParallel: true,
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? 'github' : 'list',
	use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure' },
	projects: [
		{ name: 'chromium', use: devices['Desktop Chrome'] },
		{ name: 'webkit', use: devices['Desktop Safari'] },
	],
	// the production build, as GitHub Pages serves it
	webServer: {
		command: `npm run build && npx vite preview --port ${PORT} --strictPort`,
		url: `http://localhost:${PORT}`,
		reuseExistingServer: !process.env.CI,
		timeout: 120_000,
	},
});
