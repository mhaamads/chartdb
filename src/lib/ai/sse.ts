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
    let data = '';

    try {
        while (true) {
            if (signal?.aborted) {
                await reader.cancel();
                return;
            }
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let newlineIndex: number;
            while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
                const rawLine = buffer.slice(0, newlineIndex);
                buffer = buffer.slice(newlineIndex + 1);
                const line = rawLine.replace(/\r$/u, '');
                if (line === '') {
                    if (data !== '') {
                        yield { event, data };
                    }
                    event = '';
                    data = '';
                    continue;
                }
                if (line.startsWith(':')) continue; // comment
                if (line.startsWith('event:')) {
                    event = line.slice(6).trimStart();
                } else if (line.startsWith('data:')) {
                    const chunk = line.slice(5).trimStart();
                    data = data === '' ? chunk : `${data}\n${chunk}`;
                }
            }
        }
        if (data !== '') yield { event, data };
    } finally {
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
