import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: [
        'src/electron/browser/browser-policy.ts',
        'src/electron/storage/encrypted-store.ts',
        'src/electron/storage/vault-schema.ts',
        'src/electron/mcp/mcp-client.ts',
        'src/electron/mcp/tool-policy.ts',
        'src/electron/api/agent-runtime.ts',
        'src/electron/api/provider-stream*.ts',
        'src/renderer/src/hooks/useChatStream.ts',
        'src/renderer/src/hooks/useConversationTitles.ts',
        'src/renderer/src/stream-event-batcher.ts',
      ],
    },
  },
})
