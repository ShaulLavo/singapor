import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          include: ['src/**/*.test.ts', 'test/**/*.node.test.ts'],
        },
      },
      {
        // Tests that import '@singapore-editor/core/*' by name resolve through the
        // exports map to dist/, which is what public-api.test.ts is for — it
        // checks the published facade rather than the source behind it. The
        // build is ordered ahead of the tests in turbo.json so that artifact is
        // current; running vitest here directly reads whatever was last built.
        test: {
          name: 'dom',
          environment: 'happy-dom',
          include: ['test/**/*.test.ts'],
          exclude: ['test/**/*.browser.test.ts', 'test/**/*.node.test.ts'],
        },
      },
      {
        // Geometry that only a real engine can answer: caret rects, hit tests
        // and measured advances under a CSS transform. happy-dom reports every
        // rect empty, so these assertions are meaningless anywhere else.
        optimizeDeps: { exclude: ['web-tree-sitter'] },
        test: {
          name: 'browser',
          // Keep browser timing probes clear of Node/DOM workers and other browser files.
          sequence: { groupOrder: 1 },
          browser: {
            enabled: true,
            headless: true,
            fileParallelism: false,
            provider: playwright(),
            commands: {
              proofKeyPress: async ({ page }, key: string) => {
                await page.keyboard.press(key)
              },
              proofKeyDown: async ({ page }, key: string) => {
                await page.keyboard.down(key)
              },
              proofKeyUp: async ({ page }, key: string) => {
                await page.keyboard.up(key)
              },
              proofRowScreenshot: async ({ iframe }, hostId: string) => {
                const row = iframe.locator(`#${hostId} [data-editor-virtual-row="0"]`)
                const image = await row.screenshot({ animations: 'disabled' })
                return image.toString('base64')
              },
              proofViewportScreenshot: async ({ iframe }, hostId: string) => {
                const image = await iframe
                  .locator(`#${hostId}`)
                  .screenshot({ animations: 'disabled' })
                return image.toString('base64')
              },
            },
            instances: [{ browser: 'chromium' }],
          },
          include: ['test/**/*.browser.test.ts'],
        },
      },
    ],
  },
})
