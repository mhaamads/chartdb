/**
 * Google Gemini adapter (`v1beta` streamGenerateContent).
 *
 * Streaming format: Gemini returns SSE with the same `data: {...}` lines as
 * a normal generateContent response, one per chunk. No event names.
 *
 * Function calling: Gemini emits complete `functionCall` parts (not chunked
 * args like OpenAI/Anthropic). We surface them as a single
 * `tool-use-start` + `tool-use-end` pair with no intermediate deltas.
 *
 * Tool params use native parametersJsonSchema. Opaque response parts are
 * replayed unchanged so thought signatures remain attached to their parts.
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

interface GeminiPart {
    text?: string;
    thought?: boolean;
    thoughtSignature?: string;
    functionCall?: {
        id?: string;
        name: string;
        args?: Record<string, unknown>;
    };
    functionResponse?: {
        id?: string;
        name: string;
        response: Record<string, unknown>;
    };
}

interface GeminiContent {
    role: 'user' | 'model';
    parts: GeminiPart[];
}

interface GeminiChunk {
    error?: { message?: string };
    promptFeedback?: { blockReason?: string };
    candidates?: Array<{
        content?: GeminiContent;
        finishReason?: string;
    }>;
    usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        thoughtsTokenCount?: number;
        cachedContentTokenCount?: number;
    };
    modelVersion?: string;
}

function mapMessages(messages: AIMessage[]): GeminiContent[] {
    const out: GeminiContent[] = [];
    for (const m of messages) {
        if (m.role === 'system') continue; // handled via systemInstruction
        if (m.role === 'tool') {
            const parts: GeminiPart[] = m.content
                .filter(
                    (b): b is Extract<typeof b, { type: 'tool_result' }> =>
                        b.type === 'tool_result'
                )
                .map((b) => ({
                    functionResponse: {
                        name: extractToolNameFromHistory(messages, b.toolUseId),
                        ...(messages.some((m) =>
                            m.geminiParts?.some(
                                (p) =>
                                    (p as GeminiPart).functionCall?.id ===
                                    b.toolUseId
                            )
                        )
                            ? { id: b.toolUseId }
                            : {}),
                        response:
                            b.result &&
                            typeof b.result === 'object' &&
                            !Array.isArray(b.result)
                                ? (b.result as Record<string, unknown>)
                                : { result: b.result },
                    },
                }));
            if (parts.length > 0) out.push({ role: 'user', parts });
            continue;
        }
        if (m.role === 'assistant') {
            if (m.geminiParts?.length) {
                out.push({
                    role: 'model',
                    parts: m.geminiParts as GeminiPart[],
                });
                continue;
            }
            const parts: GeminiPart[] = [];
            for (const b of m.content) {
                if (b.type === 'text' && b.text) parts.push({ text: b.text });
                else if (b.type === 'tool_use')
                    parts.push({
                        functionCall: {
                            name: b.name,
                            args:
                                b.args && typeof b.args === 'object'
                                    ? (b.args as Record<string, unknown>)
                                    : {},
                        },
                    });
            }
            if (parts.length > 0) out.push({ role: 'model', parts });
            continue;
        }
        // user
        const parts: GeminiPart[] = m.content
            .filter(
                (b): b is { type: 'text'; text: string } => b.type === 'text'
            )
            .map((b) => ({ text: b.text }));
        if (parts.length > 0) out.push({ role: 'user', parts });
    }
    return out;
}

function extractToolNameFromHistory(
    messages: AIMessage[],
    toolUseId: string
): string {
    for (const m of messages) {
        if (m.role !== 'assistant') continue;
        for (const b of m.content) {
            if (b.type === 'tool_use' && b.toolUseId === toolUseId) {
                return b.name;
            }
        }
    }
    return 'unknown';
}

function mapStopReason(raw: string | undefined): AIStopReason {
    switch (raw) {
        case 'STOP':
            return 'end_turn';
        case 'MAX_TOKENS':
            return 'max_tokens';
        case 'SAFETY':
        case 'RECITATION':
            return 'error';
        default:
            return 'error';
    }
}

function mapHttpError(status: number, raw: unknown): AIError {
    const message =
        (raw as { error?: { message?: string } })?.error?.message ??
        `Gemini request failed (${status})`;
    let code: AIError['code'] = 'unknown';
    if (status === 401 || status === 403) code = 'auth';
    else if (status === 429) code = 'rate_limit';
    else if (status === 400) code = 'invalid_request';
    else if (status >= 500) code = 'server';
    return { code, message, status, raw };
}

export const geminiAdapter: AIProviderAdapter = {
    id: 'gemini',
    async *stream(
        req: AIRequest,
        signal: AbortSignal
    ): AsyncIterable<AIStreamEvent> {
        const body = {
            contents: mapMessages(req.messages),
            systemInstruction: req.system
                ? { parts: [{ text: req.system }] }
                : undefined,
            generationConfig: {
                temperature: req.temperature,
                maxOutputTokens: req.maxOutputTokens,
            },
            tools:
                req.tools.length > 0
                    ? [
                          {
                              functionDeclarations: req.tools.map((t) => ({
                                  name: t.name,
                                  description: t.description,
                                  parametersJsonSchema: t.inputSchema,
                              })),
                          },
                      ]
                    : undefined,
        };

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
            req.model
        )}:streamGenerateContent?alt=sse`;

        let response: Response;
        try {
            response = await fetchAIResponse(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-goog-api-key': req.apiKey,
                },
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
                error: mapHttpError(response.status, raw),
            };
            return;
        }

        let startEmitted = false;
        let stopReason: AIStopReason | undefined;
        let totalInput = 0;
        let totalOutput = 0;
        let cachedInput: number | undefined;

        try {
            for await (const sse of parseSSE(response, signal)) {
                const chunk = parseJSONSafe<GeminiChunk>(sse.data);
                if (!chunk) throw new Error('Invalid JSON in Gemini stream.');
                if (chunk.error || chunk.promptFeedback?.blockReason) {
                    yield {
                        type: 'error',
                        error: {
                            code: chunk.error ? 'server' : 'content_filter',
                            message:
                                chunk.error?.message ??
                                `Gemini blocked the prompt: ${chunk.promptFeedback?.blockReason}`,
                        },
                    };
                    return;
                }

                if (!startEmitted) {
                    startEmitted = true;
                    yield {
                        type: 'message-start',
                        messageId: crypto.randomUUID(),
                        model: chunk.modelVersion,
                    };
                }

                const candidate = chunk.candidates?.[0];
                const parts = candidate?.content?.parts ?? [];
                if (parts.length)
                    yield {
                        type: 'gemini-parts',
                        parts: parts as Record<string, unknown>[],
                    };
                for (const part of parts) {
                    if (part.thought) continue;
                    if (typeof part.text === 'string' && part.text) {
                        yield { type: 'text-delta', text: part.text };
                    } else if (part.functionCall) {
                        const id = part.functionCall.id ?? crypto.randomUUID();
                        yield {
                            type: 'tool-use-start',
                            toolUseId: id,
                            name: part.functionCall.name,
                        };
                        yield {
                            type: 'tool-use-end',
                            toolUseId: id,
                            args: part.functionCall.args ?? {},
                        };
                    }
                }
                if (candidate?.finishReason) {
                    stopReason = mapStopReason(candidate.finishReason);
                }
                if (chunk.usageMetadata) {
                    totalInput =
                        chunk.usageMetadata.promptTokenCount ?? totalInput;
                    totalOutput =
                        (chunk.usageMetadata.candidatesTokenCount ?? 0) +
                        (chunk.usageMetadata.thoughtsTokenCount ?? 0);
                    cachedInput =
                        chunk.usageMetadata.cachedContentTokenCount ??
                        cachedInput;
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

        if (totalInput || totalOutput) {
            yield {
                type: 'usage',
                usage: {
                    inputTokens: totalInput,
                    outputTokens: totalOutput,
                    cachedInputTokens: cachedInput,
                },
            };
        }
        if (signal.aborted)
            yield { type: 'message-end', stopReason: 'aborted' };
        else if (!stopReason || stopReason === 'error')
            yield {
                type: 'error',
                error: {
                    code: stopReason === 'error' ? 'content_filter' : 'network',
                    message:
                        stopReason === 'error'
                            ? 'Gemini could not complete the response (blocked or invalid function call).'
                            : 'Gemini stream ended without a finish reason. No tools were executed.',
                },
            };
        else yield { type: 'message-end', stopReason };
    },
};
