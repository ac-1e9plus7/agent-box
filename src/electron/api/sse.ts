import { t } from "../../shared/i18n"

export interface SseMessage {
  event?: string
  data: string
}

const MAX_SSE_EVENT_CHARACTERS = 5 * 1024 * 1024

/** Incrementally parses an SSE response without assuming chunk boundaries. */
export async function* parseSse(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SseMessage> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventName: string | undefined
  let dataLines: string[] = []
  let dataCharacters = 0

  const dispatch = (): SseMessage | undefined => {
    if (dataLines.length === 0) {
      eventName = undefined
      return undefined
    }
    const message = { event: eventName, data: dataLines.join('\n') }
    eventName = undefined
    dataLines = []
    dataCharacters = 0
    return message
  }

  try {
    while (true) {
      const { value, done } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })

      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex >= 0) {
        let line = buffer.slice(0, newlineIndex)
        buffer = buffer.slice(newlineIndex + 1)
        if (line.endsWith('\r')) line = line.slice(0, -1)

        if (line === '') {
          const message = dispatch()
          if (message) yield message
        } else if (!line.startsWith(':')) {
          const separatorIndex = line.indexOf(':')
          const field = separatorIndex < 0 ? line : line.slice(0, separatorIndex)
          let fieldValue = separatorIndex < 0 ? '' : line.slice(separatorIndex + 1)
          if (fieldValue.startsWith(' ')) fieldValue = fieldValue.slice(1)
          if (field === 'event') eventName = fieldValue
          if (field === 'data') {
            dataCharacters += fieldValue.length
            if (dataCharacters > MAX_SSE_EVENT_CHARACTERS) {
              throw new Error(t("A streaming event returned by the provider exceeds the size limit."))
            }
            dataLines.push(fieldValue)
          }
        }

        newlineIndex = buffer.indexOf('\n')
      }

      if (buffer.length > MAX_SSE_EVENT_CHARACTERS) {
        throw new Error(t("A streaming data line returned by the provider exceeds the size limit."))
      }

      if (done) break
    }

    if (buffer) {
      const line = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer
      if (line.startsWith('data:')) {
        const fieldValue = line.slice(5).trimStart()
        dataCharacters += fieldValue.length
        if (dataCharacters > MAX_SSE_EVENT_CHARACTERS) {
          throw new Error(t("A streaming event returned by the provider exceeds the size limit."))
        }
        dataLines.push(fieldValue)
      }
    }
    const finalMessage = dispatch()
    if (finalMessage) yield finalMessage
  } finally {
    reader.releaseLock()
  }
}
