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
