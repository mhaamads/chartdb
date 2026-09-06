/**
 * LM Studio adapter.
 *
 * LM Studio (https://lmstudio.ai) exposes an OpenAI-compatible HTTP API
 * on `http://localhost:1234/v1` (configurable). It supports streaming,
 * tool calling, and `/v1/models` listing — so we can reuse the OpenAI
 * adapter's wire format and just swap the URL + auth handling.
 *
 * Differences vs. OpenAI:
 *   - Local — no network, no rate limits, no cost.
 *   - API key is optional. LM Studio's "Developer" panel lets users set
 *     a token; when configured we send it as `Authorization: Bearer …`,
 *     otherwise we send no auth header at all.
 *   - The OpenAI SDK's `stream_options.include_usage` is supported but
 *     not required — LM Studio emits `usage` on the final chunk anyway.
 *   - Some models (especially gpt-oss / Qwen) emit a `reasoning` channel
 *     in `delta.reasoning`. We ignore it here so the UI doesn't surface
 *     chain-of-thought to the user.
 *
 * Docs: https://lmstudio.ai/docs/developer/openai-compat
 */

import type { AIProviderAdapter, AIRequest, AIStreamEvent } from '../types';
import { DEFAULT_LMSTUDIO_BASE_URL } from '../models';
import { streamOpenAICompatible } from './openai';

/** Build a chat completions URL from a (possibly trailing-slashed) base. */
export function buildLMStudioChatUrl(baseUrl: string | undefined): string {
    const trimmed = (baseUrl ?? DEFAULT_LMSTUDIO_BASE_URL).replace(/\/+$/u, '');
    if (/\/chat\/completions$/u.test(trimmed)) return trimmed;
    // The base URL may or may not already include `/v1`. Normalize.
    if (/\/v1$/u.test(trimmed)) return `${trimmed}/chat/completions`;
    return `${trimmed}/v1/chat/completions`;
}

export function buildLMStudioModelsUrl(baseUrl: string | undefined): string {
    const trimmed = (baseUrl ?? DEFAULT_LMSTUDIO_BASE_URL).replace(/\/+$/u, '');
    if (/\/v1$/u.test(trimmed)) return `${trimmed}/models`;
    return `${trimmed}/v1/models`;
}

export const lmStudioAdapter: AIProviderAdapter = {
    id: 'lmstudio',
    stream(req: AIRequest, signal: AbortSignal): AsyncIterable<AIStreamEvent> {
        return streamOpenAICompatible(req, signal, {
            chatCompletionsUrl: buildLMStudioChatUrl(req.baseUrl),
            requireAuth: false,
            providerLabel: 'LM Studio',
            // LM Studio includes usage on the last chunk automatically and
            // tolerates the extra param, so request it for parity.
            requestUsage: true,
            maxTokensField: 'max_tokens',
        });
    },
};

/**
 * List the models currently available on a running LM Studio server.
 * Returns an empty array if the server is unreachable so callers can
 * fall back to manual entry.
 */
export async function listLMStudioModels(
    baseUrl: string | undefined,
    apiKey: string | undefined,
    signal?: AbortSignal
): Promise<Array<{ id: string }>> {
    const url = buildLMStudioModelsUrl(baseUrl);
    const headers: Record<string, string> = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetch(url, { headers, signal });
    if (!res.ok) {
        throw new Error(`LM Studio /v1/models failed: ${res.status}`);
    }
    const data = (await res.json()) as { data?: Array<{ id?: string }> };
    return (data.data ?? [])
        .map((m) => ({ id: String(m.id ?? '').trim() }))
        .filter((m) => m.id.length > 0);
}
