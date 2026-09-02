import { Buffer } from 'node:buffer'
import { createServer } from 'node:http'

/**
 * Deterministic loopback mock for the pinned DeepSeek chat adapter.
 *
 * The upstream adapter only speaks SSE at `<baseURL>/chat/completions` with
 * `stream: true`; a valid turn needs at least one non-empty content delta, a
 * finish chunk with usage, and a terminating `data: [DONE]`.
 */
export function createMockLlm() {
  const requests = []
  let replyIndex = 0
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || !request.url.endsWith('/chat/completions')) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'unexpected path' }))
      return
    }
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      replyIndex += 1
      const reply = `mock-llm-reply-${replyIndex}`
      requests.push({
        url: request.url,
        authorization: request.headers.authorization ?? '',
        body: Buffer.concat(chunks).toString('utf8'),
      })
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      })
      response.write(
        `data: ${JSON.stringify({
          choices: [
            { index: 0, delta: { role: 'assistant', content: reply }, finish_reason: null },
          ],
        })}\n\n`,
      )
      response.write(
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
        })}\n\n`,
      )
      response.write('data: [DONE]\n\n')
      response.end()
    })
  })

  const started = new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('mock LLM could not bind a loopback port'))
        return
      }
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })

  return {
    started,
    get requests() {
      return requests
    },
    get baseURL() {
      return server.address() === null ? undefined : `http://127.0.0.1:${server.address().port}`
    },
    async stop() {
      await new Promise((resolve) => server.close(() => resolve(undefined)))
    },
  }
}
