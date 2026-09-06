/**
 * DeepSeek adapter.
 *
 * DeepSeek (https://deepseek.com) exposes an OpenAI-compatible HTTP API
 * on `https://api.deepseek.com`. It supports streaming, tool calling,
 * JSON mode, and KV-cache-based context caching.
 *
 * Key differences vs. OpenAI:
 *   - KV-cache (automatic prefix caching): Cache hits are reported in
 *     `usage.prompt_cache_hit_tokens` rather than the OpenAI
 *     `prompt_tokens_details.cached_tokens`. The adapter normalizes both.
 *   - The current V4 models use `max_tokens` and enable thinking by default.
 *     We explicitly disable thinking because this client does not persist
 *     DeepSeek's private `reasoning_content` between tool-call rounds.
 *   - Beta-only completion features require
 *     `base_url=https://api.deepseek.com/beta`.
 *
 * Docs: https://api-docs.deepseek.com
 */

import type { AIProviderAdapter, AIRequest, AIStreamEvent } from '../types';
import { DEFAULT_DEEPSEEK_BASE_URL } from '../models';
import { streamOpenAICompatible } from './openai';

export function buildDeepSeekChatUrl(baseUrl: string | undefined): string {
    const trimmed = (baseUrl ?? DEFAULT_DEEPSEEK_BASE_URL).replace(/\/+$/u, '');
    if (/\/chat\/completions$/u.test(trimmed)) return trimmed;
    return `${trimmed}/chat/completions`;
}

export function buildDeepSeekModelsUrl(baseUrl: string | undefined): string {
    const trimmed = (baseUrl ?? DEFAULT_DEEPSEEK_BASE_URL).replace(/\/+$/u, '');
    return `${trimmed}/models`;
}

export const deepSeekAdapter: AIProviderAdapter = {
    id: 'deepseek',
    stream(req: AIRequest, signal: AbortSignal): AsyncIterable<AIStreamEvent> {
        return streamOpenAICompatible(req, signal, {
            chatCompletionsUrl: buildDeepSeekChatUrl(req.baseUrl),
            requireAuth: true,
            providerLabel: 'DeepSeek',
            requestUsage: true,
            maxTokensField: 'max_tokens',
            thinking: 'disabled',
            sanitizeToolSchemas: true,
        });
    },
};
