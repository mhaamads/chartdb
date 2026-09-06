/**
 * OpenAI Chat Completions adapter.
 *
 * We use the bare `fetch` API + SSE parser instead of the `openai` SDK so:
 *   - the bundle stays small (the SDK is ~150kB gz);
 *   - we don't have to opt into `dangerouslyAllowBrowser`;
 *   - error handling is uniform across providers.
 *
 * Tool calling: OpenAI splits a single tool call across many `delta` chunks
 * (`tool_calls[i].function.arguments` grows incrementally). We buffer per
 * `index` and emit `tool-use-delta` events for the UI plus a final
 * `tool-use-end` once `finish_reason === 'tool_calls'`.
 */

import type {
    AIError,
    AIProviderAdapter,
    AIRequest,
    AIStopReason,
    AIStreamEvent,
    AIMessage,
} from '../types';
import { sanitizeDeepSeekToolSchema } from '../json-schema';
import { parseJSONSafe, parseSSE } from '../sse';

interface PendingToolCall {
    id: string;
    name: string;
    args: string;
}

interface OpenAIChunkChoice {
    index: number;
    delta: {
        role?: string;
        content?: string | null;
        tool_calls?: Array<{
            index: number;
            id?: string;
            function?: { name?: string; arguments?: string };
        }>;
    };
    finish_reason?: string | null;
}

interface OpenAIChunk {
    id?: string;
    model?: string;
    choices: OpenAIChunkChoice[];
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        /** OpenAI: cached tokens via prompt_tokens_details. */
        prompt_tokens_details?: { cached_tokens?: number };
        /** DeepSeek: KV-cache hit tokens reported directly on usage. */
        prompt_cache_hit_tokens?: number;
    };
}

interface OpenAIRequestMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content?: string | Array<{ type: 'text'; text: string }>;
    tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
    }>;
    tool_call_id?: string;
    name?: string;
}

function mapMessages(
    system: string,
    messages: AIMessage[]
): OpenAIRequestMessage[] {
    const out: OpenAIRequestMessage[] = [];
    if (system) out.push({ role: 'system', content: system });
    for (const m of messages) {
        if (m.role === 'system') continue; // handled above
        if (m.role === 'tool') {
            // Each tool_result block becomes its own `tool` message.
            for (const block of m.content) {
                if (block.type !== 'tool_result') continue;
                out.push({
                    role: 'tool',
                    tool_call_id: block.toolUseId,
                    content: JSON.stringify(block.result),
                });
            }
            continue;
        }
        if (m.role === 'assistant') {
            const texts = m.content
                .filter(
                    (b): b is { type: 'text'; text: string } =>
                        b.type === 'text'
                )
                .map((b) => b.text)
                .join('');
            const tools = m.content
                .filter(
                    (b): b is Extract<typeof b, { type: 'tool_use' }> =>
                        b.type === 'tool_use'
                )
                .map((b) => ({
                    id: b.toolUseId,
                    type: 'function' as const,
                    function: {
                        name: b.name,
                        arguments: JSON.stringify(b.args ?? {}),
                    },
                }));
            const msg: OpenAIRequestMessage = {
                role: 'assistant',
                content: texts || undefined,
            };
            if (tools.length > 0) msg.tool_calls = tools;
            out.push(msg);
            continue;
        }
        // user
        const text = m.content
            .filter(
                (b): b is { type: 'text'; text: string } => b.type === 'text'
            )
            .map((b) => b.text)
            .join('');
        out.push({ role: 'user', content: text });
    }
    return out;
}

function mapStopReason(raw: string | null | undefined): AIStopReason {
    switch (raw) {
        case 'stop':
            return 'end_turn';
        case 'tool_calls':
            return 'tool_use';
        case 'length':
            return 'max_tokens';
        case 'content_filter':
            return 'end_turn';
        default:
            return 'end_turn';
    }
}

function mapHttpError(
    status: number,
    raw: unknown,
    providerLabel: string
): AIError {
    const message =
        (raw as { error?: { message?: string } })?.error?.message ??
        `${providerLabel} request failed (${status})`;
    let code: AIError['code'] = 'unknown';
    if (status === 401 || status === 403) code = 'auth';
    else if (status === 429) code = 'rate_limit';
    else if (status === 400) code = 'invalid_request';
    else if (status >= 500) code = 'server';
    return { code, message, status, raw };
}

export interface OpenAICompatibleConfig {
    /**
     * Full chat completions URL. Defaults to OpenAI's hosted endpoint.
     * For LM Studio: `${baseUrl}/v1/chat/completions`.
     */
    chatCompletionsUrl: string;
    /** Whether to send an `Authorization: Bearer …` header. */
    requireAuth: boolean;
    /** Provider label used in error messages. */
    providerLabel: string;
    /**
     * When true, request usage stats via `stream_options.include_usage`.
     * LM Studio ignores this — it always returns `usage` on the final
     * chunk — but sending it on OpenAI is required.
     */
    requestUsage: boolean;
    /** Request field name used for the output-token limit. */
    maxTokensField?: 'max_tokens' | 'max_completion_tokens';
    /** Optional thinking-mode override for compatible providers. */
    thinking?: 'enabled' | 'disabled';
    /** DeepSeek rejects unions such as the `apply_schema_patch` schema. */
    sanitizeToolSchemas?: boolean;
}

export async function* streamOpenAICompatible(
    req: AIRequest,
    signal: AbortSignal,
    config: OpenAICompatibleConfig
): AsyncIterable<AIStreamEvent> {
    const maxTokensField = config.maxTokensField ?? 'max_completion_tokens';
    const body: Record<string, unknown> = {
        model: req.model,
        messages: mapMessages(req.system, req.messages),
        temperature: req.temperature,
        // OpenAI deprecated `max_tokens` in favour of `max_completion_tokens`.
        // LM Studio accepts both — using the new name keeps us forward-compat.
        [maxTokensField]: req.maxOutputTokens,
        stream: true,
        tools:
            req.tools.length > 0
                ? req.tools.map((t) => ({
                      type: 'function' as const,
                      function: {
                          name: t.name,
                          description: t.description,
                          parameters: config.sanitizeToolSchemas
                              ? sanitizeDeepSeekToolSchema(t.inputSchema)
                              : t.inputSchema,
                      },
                  }))
                : undefined,
    };
    if (config.thinking) {
        body.thinking = { type: config.thinking };
    }
    if (config.requestUsage) {
        body.stream_options = { include_usage: true };
    }

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
    };
    if (config.requireAuth || req.apiKey) {
        // LM Studio allows an optional bearer token; only send if provided.
        if (req.apiKey) headers.Authorization = `Bearer ${req.apiKey}`;
    }

    let response: Response;
    try {
        response = await fetch(config.chatCompletionsUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal,
        });
    } catch (err) {
        if (signal.aborted) {
            yield { type: 'message-end', stopReason: 'aborted' };
            return;
        }
        yield {
            type: 'error',
            error: {
                code: 'network',
                message: err instanceof Error ? err.message : String(err),
            },
        };
        return;
    }

    if (!response.ok) {
        const raw = await response.json().catch(() => undefined);
        yield {
            type: 'error',
            error: mapHttpError(response.status, raw, config.providerLabel),
        };
        return;
    }

    const pending = new Map<number, PendingToolCall>();
    let stopReason: AIStopReason | undefined;
    let startEmitted = false;

    try {
        for await (const sse of parseSSE(response, signal)) {
            if (sse.data === '[DONE]') break;
            const chunk = parseJSONSafe<OpenAIChunk>(sse.data);
            if (!chunk) continue;

            if (!startEmitted) {
                startEmitted = true;
                yield {
                    type: 'message-start',
                    messageId: chunk.id ?? crypto.randomUUID(),
                    model: chunk.model,
                };
            }

            const choice = chunk.choices?.[0];
            if (choice) {
                const delta = choice.delta;
                if (typeof delta.content === 'string' && delta.content) {
                    yield { type: 'text-delta', text: delta.content };
                }
                if (delta.tool_calls) {
                    for (const tc of delta.tool_calls) {
                        let pendingCall = pending.get(tc.index);
                        if (!pendingCall) {
                            pendingCall = {
                                id: tc.id ?? crypto.randomUUID(),
                                name: tc.function?.name ?? '',
                                args: '',
                            };
                            pending.set(tc.index, pendingCall);
                            if (pendingCall.name) {
                                yield {
                                    type: 'tool-use-start',
                                    toolUseId: pendingCall.id,
                                    name: pendingCall.name,
                                };
                            }
                        } else if (tc.id && pendingCall.id !== tc.id) {
                            pendingCall.id = tc.id;
                        }
                        if (tc.function?.name && !pendingCall.name) {
                            pendingCall.name = tc.function.name;
                            yield {
                                type: 'tool-use-start',
                                toolUseId: pendingCall.id,
                                name: pendingCall.name,
                            };
                        }
                        const argDelta = tc.function?.arguments;
                        if (argDelta) {
                            pendingCall.args += argDelta;
                            yield {
                                type: 'tool-use-delta',
                                toolUseId: pendingCall.id,
                                argsDelta: argDelta,
                            };
                        }
                    }
                }
                if (choice.finish_reason) {
                    stopReason = mapStopReason(choice.finish_reason);
                }
            }

            if (chunk.usage) {
                // Normalize across OpenAI (prompt_tokens_details.cached_tokens)
                // and DeepSeek (prompt_cache_hit_tokens) cache-hit reporting.
                const cached =
                    chunk.usage.prompt_tokens_details?.cached_tokens ??
                    chunk.usage.prompt_cache_hit_tokens;
                yield {
                    type: 'usage',
                    usage: {
                        inputTokens: chunk.usage.prompt_tokens ?? 0,
                        outputTokens: chunk.usage.completion_tokens ?? 0,
                        cachedInputTokens: cached,
                    },
                };
            }
        }
    } catch (err) {
        if (signal.aborted) {
            yield { type: 'message-end', stopReason: 'aborted' };
            return;
        }
        yield {
            type: 'error',
            error: {
                code: 'network',
                message: err instanceof Error ? err.message : String(err),
            },
        };
        return;
    }

    // Flush completed tool calls.
    for (const call of pending.values()) {
        const args = parseJSONSafe(call.args) ?? {};
        yield { type: 'tool-use-end', toolUseId: call.id, args };
    }

    yield { type: 'message-end', stopReason };
}

export const openAIAdapter: AIProviderAdapter = {
    id: 'openai',
    stream(req, signal) {
        return streamOpenAICompatible(req, signal, {
            chatCompletionsUrl: 'https://api.openai.com/v1/chat/completions',
            requireAuth: true,
            providerLabel: 'OpenAI',
            requestUsage: true,
        });
    },
};
