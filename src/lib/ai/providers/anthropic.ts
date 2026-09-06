/**
 * Anthropic Messages adapter (Claude).
 *
 * Streaming events: Anthropic uses named SSE events
 *   - message_start          → emit `message-start`
 *   - content_block_start    → if `tool_use`, emit `tool-use-start`
 *   - content_block_delta    → `text_delta` → `text-delta`,
 *                              `input_json_delta` → `tool-use-delta`
 *   - content_block_stop     → for tool_use blocks, emit `tool-use-end`
 *   - message_delta          → carries final stop_reason + output tokens
 *   - message_stop           → emit `message-end`
 *
 * Browser CORS: Anthropic requires the
 * `anthropic-dangerous-direct-browser-access: true` header to skip the
 * CORS preflight rejection from `x-api-key`. BYOK users opt into this
 * explicitly via the settings dialog.
 */

import type {
    AIError,
    AIProviderAdapter,
    AIRequest,
    AIStopReason,
    AIStreamEvent,
    AIMessage,
} from '../types';
import { parseJSONSafe, parseSSE } from '../sse';
import { fetchAIResponse } from '../http';

const ANTHROPIC_VERSION = '2023-06-01';

interface AnthropicRequestMessage {
    role: 'user' | 'assistant';
    content: Array<
        | { type: 'text'; text: string }
        | { type: 'tool_use'; id: string; name: string; input: unknown }
        | {
              type: 'tool_result';
              tool_use_id: string;
              content: string;
              is_error?: boolean;
          }
    >;
}

function mapMessages(messages: AIMessage[]): AnthropicRequestMessage[] {
    // Anthropic does not have a `tool` role — tool_results belong on a `user`
    // message immediately following the assistant's tool_use.
    const out: AnthropicRequestMessage[] = [];
    for (const m of messages) {
        if (m.role === 'system') continue;
        if (m.role === 'tool') {
            const blocks = m.content
                .filter(
                    (b): b is Extract<typeof b, { type: 'tool_result' }> =>
                        b.type === 'tool_result'
                )
                .map((b) => ({
                    type: 'tool_result' as const,
                    tool_use_id: b.toolUseId,
                    content: JSON.stringify(b.result),
                    ...(b.isError ? { is_error: true } : {}),
                }));
            if (blocks.length > 0) out.push({ role: 'user', content: blocks });
            continue;
        }
        if (m.role === 'assistant') {
            const blocks: AnthropicRequestMessage['content'] = [];
            for (const b of m.content) {
                if (b.type === 'text' && b.text)
                    blocks.push({ type: 'text', text: b.text });
                else if (b.type === 'tool_use')
                    blocks.push({
                        type: 'tool_use',
                        id: b.toolUseId,
                        name: b.name,
                        input: b.args ?? {},
                    });
            }
            if (blocks.length > 0)
                out.push({ role: 'assistant', content: blocks });
            continue;
        }
        // user
        const blocks: AnthropicRequestMessage['content'] = m.content
            .filter(
                (b): b is { type: 'text'; text: string } => b.type === 'text'
            )
            .map((b) => ({ type: 'text' as const, text: b.text }));
        if (blocks.length > 0) out.push({ role: 'user', content: blocks });
    }
    return out;
}

function mapStopReason(raw: string | undefined | null): AIStopReason {
    switch (raw) {
        case 'end_turn':
            return 'end_turn';
        case 'tool_use':
            return 'tool_use';
        case 'max_tokens':
            return 'max_tokens';
        case 'stop_sequence':
            return 'stop_sequence';
        default:
            return 'end_turn';
    }
}

function mapHttpError(status: number, raw: unknown): AIError {
    const message =
        (raw as { error?: { message?: string } })?.error?.message ??
        `Anthropic request failed (${status})`;
    let code: AIError['code'] = 'unknown';
    if (status === 401 || status === 403) code = 'auth';
    else if (status === 429) code = 'rate_limit';
    else if (status === 400) code = 'invalid_request';
    else if (status >= 500) code = 'server';
    return { code, message, status, raw };
}

interface BlockState {
    type: 'text' | 'tool_use';
    toolUseId?: string;
    name?: string;
    argsBuffer?: string;
}

export const anthropicAdapter: AIProviderAdapter = {
    id: 'anthropic',
    async *stream(
        req: AIRequest,
        signal: AbortSignal
    ): AsyncIterable<AIStreamEvent> {
        const body = {
            model: req.model,
            system: req.system,
            messages: mapMessages(req.messages),
            max_tokens: req.maxOutputTokens,
            // New Claude models reject sampling overrides; only send to known legacy families.
            temperature:
                /^claude-(?:3|(?:sonnet|haiku)-4|opus-4-[56](?:-|$))/u.test(
                    req.model
                )
                    ? Math.min(1, Math.max(0, req.temperature))
                    : undefined,
            stream: true,
            tools:
                req.tools.length > 0
                    ? req.tools.map((t) => ({
                          name: t.name,
                          description: t.description,
                          input_schema: t.inputSchema,
                      }))
                    : undefined,
        };

        let response: Response;
        try {
            response = await fetchAIResponse(
                'https://api.anthropic.com/v1/messages',
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-api-key': req.apiKey,
                        'anthropic-version': ANTHROPIC_VERSION,
                        'anthropic-dangerous-direct-browser-access': 'true',
                    },
                    body: JSON.stringify(body),
                    signal,
                }
            );
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
                error: mapHttpError(response.status, raw),
            };
            return;
        }

        const blocks = new Map<number, BlockState>();
        let stopReason: AIStopReason | undefined;
        let inputTokens = 0;
        let outputTokens = 0;

        try {
            for await (const sse of parseSSE(response, signal)) {
                const data = parseJSONSafe<Record<string, unknown>>(sse.data);
                if (!data) throw new Error('Invalid JSON in Anthropic stream.');

                switch (sse.event) {
                    case 'message_start': {
                        const msg = (
                            data as {
                                message?: {
                                    id?: string;
                                    model?: string;
                                    usage?: { input_tokens?: number };
                                };
                            }
                        ).message;
                        inputTokens = msg?.usage?.input_tokens ?? 0;
                        yield {
                            type: 'message-start',
                            messageId: msg?.id ?? crypto.randomUUID(),
                            model: msg?.model,
                        };
                        break;
                    }
                    case 'content_block_start': {
                        const idx = (data.index as number) ?? 0;
                        const block = data.content_block as
                            | { type: string; id?: string; name?: string }
                            | undefined;
                        if (block?.type === 'tool_use') {
                            const toolUseId = block.id ?? crypto.randomUUID();
                            const name = block.name ?? '';
                            blocks.set(idx, {
                                type: 'tool_use',
                                toolUseId,
                                name,
                                argsBuffer: '',
                            });
                            yield {
                                type: 'tool-use-start',
                                toolUseId,
                                name,
                            };
                        } else {
                            blocks.set(idx, { type: 'text' });
                        }
                        break;
                    }
                    case 'content_block_delta': {
                        const idx = (data.index as number) ?? 0;
                        const delta = data.delta as
                            | {
                                  type: string;
                                  text?: string;
                                  partial_json?: string;
                              }
                            | undefined;
                        if (!delta) break;
                        if (delta.type === 'text_delta' && delta.text) {
                            yield { type: 'text-delta', text: delta.text };
                        } else if (
                            delta.type === 'input_json_delta' &&
                            delta.partial_json
                        ) {
                            const state = blocks.get(idx);
                            if (state && state.type === 'tool_use') {
                                state.argsBuffer =
                                    (state.argsBuffer ?? '') +
                                    delta.partial_json;
                                yield {
                                    type: 'tool-use-delta',
                                    toolUseId: state.toolUseId ?? '',
                                    argsDelta: delta.partial_json,
                                };
                            }
                        }
                        break;
                    }
                    case 'content_block_stop': {
                        const idx = (data.index as number) ?? 0;
                        const state = blocks.get(idx);
                        if (state && state.type === 'tool_use') {
                            const args = state.argsBuffer
                                ? (parseJSONSafe(state.argsBuffer) ??
                                  state.argsBuffer)
                                : {};
                            yield {
                                type: 'tool-use-end',
                                toolUseId: state.toolUseId ?? '',
                                args,
                            };
                        }
                        blocks.delete(idx);
                        break;
                    }
                    case 'message_delta': {
                        const delta = data.delta as
                            | { stop_reason?: string }
                            | undefined;
                        const usage = data.usage as
                            | { output_tokens?: number }
                            | undefined;
                        if (delta?.stop_reason) {
                            stopReason = mapStopReason(delta.stop_reason);
                        }
                        if (usage?.output_tokens) {
                            outputTokens = usage.output_tokens;
                        }
                        break;
                    }
                    case 'message_stop': {
                        yield {
                            type: 'usage',
                            usage: { inputTokens, outputTokens },
                        };
                        yield { type: 'message-end', stopReason };
                        return;
                    }
                    case 'error': {
                        const err = data.error as
                            | { type?: string; message?: string }
                            | undefined;
                        yield {
                            type: 'error',
                            error: {
                                code:
                                    err?.type === 'overloaded_error'
                                        ? 'server'
                                        : 'unknown',
                                message: err?.message ?? 'Anthropic error',
                                raw: err,
                            },
                        };
                        return;
                    }
                    default:
                        // ignore ping / other events
                        break;
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

        if (signal.aborted)
            yield { type: 'message-end', stopReason: 'aborted' };
        else
            yield {
                type: 'error',
                error: {
                    code: 'network',
                    message:
                        'Anthropic stream ended before message_stop. No tools were executed.',
                },
            };
    },
};
