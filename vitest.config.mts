import { defineConfig } from 'vitest/config';
import * as path from 'path';

export default defineConfig({
	resolve: {
		alias: {
			vscode: path.resolve(import.meta.dirname, 'src/test/__mocks__/vscode.ts')
		}
	},
	test: {
		globals: true,
		environment: 'node',
		include: ['src/test/**/*.test.ts'],
		coverage: {
			provider: 'v8',
			reporter: ['text', 'html', 'json-summary'],
			include: ['src/**/*.ts'],
			exclude: [
				'src/test/**',
				'src/core/types.ts'
			],
			thresholds: {
				lines: 75,
				functions: 75,
				branches: 75,
				statements: 75
			}
		}
	}
});
