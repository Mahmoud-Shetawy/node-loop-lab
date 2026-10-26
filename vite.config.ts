import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';

// BASE_PATH is set by the Pages workflow: the site lives under /node-loop-lab/
export default defineConfig({
	base: process.env.BASE_PATH ?? '/',
	plugins: [react(), tailwindcss()],
	resolve: {
		alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
	},
	server: { port: 5173, strictPort: true },
	test: {
		globals: true,
		environment: 'jsdom',
		setupFiles: ['./src/testSetup.ts'],
		include: ['src/**/*.test.{ts,tsx}'],
	},
});
