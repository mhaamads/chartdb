import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAIResponse } from '../http';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});
const init = () => ({ method: 'POST', signal: new AbortController().signal });

describe('AI HTTP retries', () => {
    it('retries transient rejections and honours Retry-After', async () => {
        vi.useFakeTimers();
        const fetch = vi
            .fn()
            .mockResolvedValueOnce(
                new Response('', {
                    status: 429,
                    headers: { 'Retry-After': '2' },
                })
            )
            .mockResolvedValueOnce(new Response('ok'));
        vi.stubGlobal('fetch', fetch);
        const request = fetchAIResponse('https://provider.test', init());
        await vi.advanceTimersByTimeAsync(1999);
        expect(fetch).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect((await request).ok).toBe(true);
        expect(fetch).toHaveBeenCalledTimes(2);
    });
    it.each([400, 401, 403])('does not retry HTTP %s', async (status) => {
        const fetch = vi.fn(async () => new Response('', { status }));
        vi.stubGlobal('fetch', fetch);
        expect(
            (await fetchAIResponse('https://provider.test', init())).status
        ).toBe(status);
        expect(fetch).toHaveBeenCalledTimes(1);
    });
    it('bounds retries and leaves long Retry-After responses for the UI', async () => {
        vi.useFakeTimers();
        const fetch = vi.fn(async () => new Response('', { status: 503 }));
        vi.stubGlobal('fetch', fetch);
        const request = fetchAIResponse('https://provider.test', init());
        await vi.advanceTimersByTimeAsync(3000);
        expect((await request).status).toBe(503);
        expect(fetch).toHaveBeenCalledTimes(3);
        fetch.mockResolvedValue(
            new Response('', { status: 429, headers: { 'Retry-After': '120' } })
        );
        await fetchAIResponse('https://provider.test', init());
        expect(fetch).toHaveBeenCalledTimes(4);
    });
    it('cancels while waiting to retry', async () => {
        vi.useFakeTimers();
        const controller = new AbortController();
        const fetch = vi.fn(async () => new Response('', { status: 503 }));
        vi.stubGlobal('fetch', fetch);
        const request = fetchAIResponse('https://provider.test', {
            signal: controller.signal,
        });
        const rejected = expect(request).rejects.toThrow();
        await vi.advanceTimersByTimeAsync(10);
        controller.abort();
        await rejected;
        await vi.advanceTimersByTimeAsync(5000);
        expect(fetch).toHaveBeenCalledTimes(1);
    });
});
