/**
 * DeepSeek adapter.
 *
 * DeepSeek (https://deepseek.com) exposes an OpenAI-compatible HTTP API
 * on `https://api.deepseek.com/v1`. It supports streaming, tool calling,
 * JSON mode, and KV-cache-based context caching.
 *
 * Key differences vs. OpenAI:
 *   - KV-cache (automatic prefix caching): Cache hits are reported in
 *     `usage.prompt_cache_hit_tokens` rather than the OpenAI
 *     `prompt_tokens_details.cached_tokens`. The adapter normalizes both.
 *   - `max_tokens` default is 4096, beta allows up to 8192.
 *   - Thinking mode (`reasoning_content` in delta) is available on
 *     deepseek-reasoner — we ignore it here so the UI doesn't surface
 *     chain-of-thought to the user.
 *   - Beta features (FIM, 8K max_tokens, prefix completion) require
 *     `base_url=https://api.deepseek.com/beta`.
 *
 * Docs: https://api-docs.deepseek.com
 */

import type { AIProviderAdapter, AIRequest, AIStreamEvent } from '../types';
import { DEFAULT_DEEPSEEK_BASE_URL } from '../models';
import { streamOpenAICompatible } from './openai';

export function buildDeepSeekChatUrl(baseUrl: string | undefined): string {
    const trimmed = (baseUrl ?? DEFAULT_DEEPSEEK_BASE_URL).replace(/\/+$/u, '');
    // DeepSeek's public endpoint is /v1/chat/completions
    if (/\/v1$/u.test(trimmed)) return `${trimmed}/chat/completions`;
    return `${trimmed}/v1/chat/completions`;
}

export const deepSeekAdapter: AIProviderAdapter = {
    id: 'deepseek',
    stream(req: AIRequest, signal: AbortSignal): AsyncIterable<AIStreamEvent> {
        return streamOpenAICompatible(req, signal, {
            chatCompletionsUrl: buildDeepSeekChatUrl(req.baseUrl),
            requireAuth: true,
            providerLabel: 'DeepSeek',
            // DeepSeek supports stream_options.include_usage for per-chunk
            // usage reporting (like OpenAI).
            requestUsage: true,
        });
    },
};
