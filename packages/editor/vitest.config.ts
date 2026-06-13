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
        test: {
          name: 'dom',
          browser: {
            headless: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }],
          },
          environment: 'happy-dom',
          include: ['test/**/*.test.ts'],
        },
      },
    ],
  },
})
