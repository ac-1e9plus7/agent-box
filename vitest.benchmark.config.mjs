import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/performance/*.benchmark.ts'],
    testTimeout: 30_000,
    fileParallelism: false,
  },
})
