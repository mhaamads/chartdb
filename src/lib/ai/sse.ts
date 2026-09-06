/**
 * Minimal Server-Sent-Events parser that yields `{ event, data }` objects
 * over an async iterable. Works against the raw `ReadableStream` returned
 * by `fetch` (no extra deps).
 *
 * Compatible with the SSE flavours emitted by OpenAI, Anthropic, and Gemini.
 * All three providers send `data: <json>` lines terminated by blank lines.
 * Anthropic also prefixes events with `event: <name>` lines — we capture
 * those too. OpenAI signals end-of-stream with a literal `data: [DONE]`.
 */

export interface SSEEvent {
    /** Event name (e.g. "message_start"). Empty string when absent. */
    event: string;
    /** Raw `data:` payload. Multiple `data:` lines are joined with `\n`. */
    data: string;
}

export async function* parseSSE(
    response: Response,
    signal?: AbortSignal
): AsyncGenerator<SSEEvent> {
    if (!response.body) {
        throw new Error('Response has no body.');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let event = '';
    let data: string[] = [];
    const abort = () => {
        void reader.cancel().catch(() => {});
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
        while (!signal?.aborted) {
            let timedOut = false;
            const timer = setTimeout(() => {
                timedOut = true;
                abort();
            }, 120_000);
            let chunk: ReadableStreamReadResult<Uint8Array>;
            try {
                chunk = await reader.read();
            } finally {
                clearTimeout(timer);
            }
            if (timedOut)
                throw new Error(
                    'The provider stream was inactive for 120 seconds.'
                );
            const { value, done } = chunk;
            if (signal?.aborted) return;
            buffer += done
                ? decoder.decode()
                : decoder.decode(value, { stream: true });
            let match: RegExpExecArray | null;
            while ((match = /[\r\n]/u.exec(buffer))) {
                const index = match.index;
                // A CRLF pair may itself span network chunks.
                if (
                    !done &&
                    buffer[index] === '\r' &&
                    index === buffer.length - 1
                )
                    break;
                const line = buffer.slice(0, index);
                const width =
                    buffer[index] === '\r' && buffer[index + 1] === '\n'
                        ? 2
                        : 1;
                buffer = buffer.slice(index + width);
                if (line === '') {
                    if (data.length) yield { event, data: data.join('\n') };
                    event = '';
                    data = [];
                    continue;
                }
                if (line.startsWith(':')) continue;
                const colon = line.indexOf(':');
                const field = colon < 0 ? line : line.slice(0, colon);
                const value =
                    colon < 0 ? '' : line.slice(colon + 1).replace(/^ /u, '');
                if (field === 'event') event = value;
                else if (field === 'data') data.push(value);
            }
            // An event without its blank-line terminator is incomplete.
            if (done) break;
        }
    } finally {
        signal?.removeEventListener('abort', abort);
        await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}

export function parseJSONSafe<T = unknown>(raw: string): T | undefined {
    try {
        return JSON.parse(raw) as T;
    } catch {
        return undefined;
    }
}
