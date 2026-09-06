import { describe, it, expect } from 'vitest';
import { parseSSE, parseJSONSafe } from '@/lib/ai/sse';

function makeResponse(text: string): Response {
    const stream = new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(text));
            controller.close();
        },
    });
    return new Response(stream);
}

async function collect(text: string) {
    const out: { event: string; data: string }[] = [];
    for await (const ev of parseSSE(makeResponse(text))) {
        out.push(ev);
    }
    return out;
}

describe('parseSSE', () => {
    it('parses simple data events terminated by blank lines', async () => {
        const out = await collect('data: hello\n\ndata: world\n\n');
        expect(out).toEqual([
            { event: '', data: 'hello' },
            { event: '', data: 'world' },
        ]);
    });

    it('captures event: names alongside data', async () => {
        const out = await collect(
            'event: message_start\ndata: {"a":1}\n\nevent: ping\ndata: ok\n\n'
        );
        expect(out[0]).toEqual({ event: 'message_start', data: '{"a":1}' });
        expect(out[1]).toEqual({ event: 'ping', data: 'ok' });
    });

    it('joins multi-line data fields with newlines', async () => {
        const out = await collect('data: line1\ndata: line2\n\n');
        expect(out).toEqual([{ event: '', data: 'line1\nline2' }]);
    });

    it('ignores comment lines starting with :', async () => {
        const out = await collect(': keep-alive\ndata: hello\n\n');
        expect(out).toEqual([{ event: '', data: 'hello' }]);
    });
});

describe('parseJSONSafe', () => {
    it('returns parsed value for valid JSON', () => {
        expect(parseJSONSafe<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
    });

    it('returns undefined for invalid JSON', () => {
        expect(parseJSONSafe('not json')).toBeUndefined();
    });
});

it('handles byte-split UTF-8 and CRLF without stripping payload spaces', async () => {
    const bytes = new TextEncoder().encode('data:  مرحبا\r\n\r\ndata:\r\n\r\n');
    const stream = new ReadableStream({
        start(controller) {
            for (const byte of bytes)
                controller.enqueue(new Uint8Array([byte]));
            controller.close();
        },
    });
    const out = [];
    for await (const event of parseSSE(new Response(stream))) out.push(event);
    expect(out).toEqual([
        { event: '', data: ' مرحبا' },
        { event: '', data: '' },
    ]);
});

it('discards unterminated events and supports CR-only boundaries', async () => {
    expect(await collect('data: ok\r\rdata: partial\n')).toEqual([
        { event: '', data: 'ok' },
    ]);
});

it('cancels a stalled read and releases the stream', async () => {
    let cancelled = false;
    const controller = new AbortController();
    const stream = new ReadableStream({
        cancel() {
            cancelled = true;
        },
    });
    const parser = parseSSE(new Response(stream), controller.signal);
    const reading = parser.next();
    controller.abort();
    expect(await reading).toMatchObject({ done: true });
    expect(cancelled).toBe(true);
    expect(stream.locked).toBe(false);
});
