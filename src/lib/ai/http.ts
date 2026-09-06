/** Retry only rejected HTTP requests, before any streamed output or tool runs. */
export async function fetchAIResponse(
    url: string,
    init: RequestInit & { signal: AbortSignal }
): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
        init.signal.throwIfAborted();
        const response = await fetch(url, {
            ...init,
            signal: AbortSignal.any([
                init.signal,
                AbortSignal.timeout(120_000),
            ]),
        });
        if (
            attempt >= 2 ||
            ![429, 500, 502, 503, 504, 529].includes(response.status)
        ) {
            return response;
        }
        const retryAfter = response.headers.get('retry-after');
        const seconds = retryAfter === null ? NaN : Number(retryAfter);
        const delay = Number.isFinite(seconds)
            ? seconds * 1000
            : retryAfter
              ? Date.parse(retryAfter) - Date.now()
              : NaN;
        // Surface long rate-limit waits instead of holding the UI indefinitely.
        if (delay > 30_000) return response;
        await response.body?.cancel();
        await new Promise<void>((resolve, reject) => {
            const abort = () => {
                clearTimeout(timer);
                reject(init.signal.reason);
            };
            const timer = setTimeout(
                () => {
                    init.signal.removeEventListener('abort', abort);
                    resolve();
                },
                Number.isFinite(delay)
                    ? Math.max(0, delay)
                    : 500 * 2 ** attempt + Math.random() * 250
            );
            init.signal.addEventListener('abort', abort, { once: true });
            if (init.signal.aborted) abort();
        });
    }
}
