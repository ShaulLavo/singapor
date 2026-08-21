import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        // Tests that import '@singapor/core/*' by name resolve through the
        // exports map to dist/, which is what public-api.test.ts is for — it
        // checks the published facade rather than the source behind it. The
        // build is ordered ahead of the tests in turbo.json so that artifact is
        // current; running vitest here directly reads whatever was last built.
        test: {
          name: 'dom',
          environment: 'happy-dom',
          include: ['test/**/*.test.ts'],
          exclude: ['test/**/*.browser.test.ts'],
        },
      },
      {
        // Geometry that only a real engine can answer: caret rects, hit tests
        // and measured advances under a CSS transform. happy-dom reports every
        // rect empty, so these assertions are meaningless anywhere else.
        test: {
          name: 'browser',
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }],
          },
          include: ['test/**/*.browser.test.ts'],
        },
      },
    ],
  },
})
