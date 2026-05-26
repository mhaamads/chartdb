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
 * Tool params: Gemini accepts a subset of JSON Schema, but requires `type`
 * lowercased and some keywords stripped (e.g. `additionalProperties`,
 * `$schema`). `cleanGeminiSchema` does that walk.
 */

import type {
    AIError,
    AIProviderAdapter,
    AIRequest,
    AIStopReason,
    AIStreamEvent,
    AIMessage,
    AIToolJSONSchema,
} from '../types';
import { parseJSONSafe, parseSSE } from '../sse';

interface GeminiPart {
    text?: string;
    functionCall?: { name: string; args?: Record<string, unknown> };
    functionResponse?: {
        name: string;
        response: Record<string, unknown>;
    };
}

interface GeminiContent {
    role: 'user' | 'model';
    parts: GeminiPart[];
}

interface GeminiChunk {
    candidates?: Array<{
        content?: GeminiContent;
        finishReason?: string;
    }>;
    usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        cachedContentTokenCount?: number;
    };
    modelVersion?: string;
}

/**
 * Keys that the Gemini Schema object does not support.
 * See: https://ai.google.dev/api/caching#Schema
 *
 * Gemini Schema supports: type, format, title, description, nullable, enum,
 * maxItems, minItems, properties, required, minProperties, maxProperties,
 * minLength, maxLength, pattern, example, anyOf, propertyOrdering, default,
 * items, minimum, maximum.
 *
 * NOT supported: additionalProperties, $schema, $ref, $id, $defs,
 * exclusiveMinimum, exclusiveMaximum, multipleOf, allOf, not, if/then/else,
 * unevaluatedProperties, definitions.
 */
const STRIP_KEYWORDS = new Set([
    '$schema',
    '$ref',
    '$id',
    '$defs',
    '$anchor',
    'additionalProperties',
    'definitions',
    'examples', // plural — singular 'example' is OK
    'multipleOf',
    'unevaluatedProperties',
    'allOf',
    'not',
    'if',
    'then',
    'else',
]);

function cleanGeminiSchema(schema: AIToolJSONSchema): AIToolJSONSchema {
    if (!schema || typeof schema !== 'object') return schema;
    if (Array.isArray(schema)) {
        return schema.map((s) =>
            cleanGeminiSchema(s as AIToolJSONSchema)
        ) as unknown as AIToolJSONSchema;
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema)) {
        if (STRIP_KEYWORDS.has(key)) continue;

        // draft-07 number form: exclusiveMinimum: 0 → minimum: 0
        // Gemini Schema only supports inclusive minimum/maximum.
        // We accept the slight semantic loosening for tool schemas.
        if (key === 'exclusiveMinimum') {
            if (typeof value === 'number') {
                // Only set if minimum isn't already present or is larger.
                const existing = out.minimum as number | undefined;
                out.minimum =
                    existing !== undefined ? Math.min(existing, value) : value;
            }
            // boolean form (draft-4): { minimum: N, exclusiveMinimum: true }
            // The minimum key is kept separately; just drop this boolean flag.
            continue;
        }
        if (key === 'exclusiveMaximum') {
            if (typeof value === 'number') {
                const existing = out.maximum as number | undefined;
                out.maximum =
                    existing !== undefined ? Math.max(existing, value) : value;
            }
            continue;
        }

        if (key === 'type' && typeof value === 'string') {
            // Gemini Schema uses uppercase type names (STRING, NUMBER, …)
            out.type = value.toUpperCase();
        } else if (value !== null && typeof value === 'object') {
            out[key] = cleanGeminiSchema(value as AIToolJSONSchema);
        } else {
            out[key] = value;
        }
    }
    return out as AIToolJSONSchema;
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
                        // Gemini matches by name, not id.
                        name: extractToolNameFromHistory(messages, b.toolUseId),
                        response:
                            b.result && typeof b.result === 'object'
                                ? (b.result as Record<string, unknown>)
                                : { result: b.result },
                    },
                }));
            if (parts.length > 0) out.push({ role: 'user', parts });
            continue;
        }
        if (m.role === 'assistant') {
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
            return 'content_filter' as AIStopReason;
        default:
            return 'end_turn';
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
                                  parameters: cleanGeminiSchema(t.inputSchema),
                              })),
                          },
                      ]
                    : undefined,
        };

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
            req.model
        )}:streamGenerateContent?alt=sse&key=${encodeURIComponent(req.apiKey)}`;

        let response: Response;
        try {
            response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
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
                if (!chunk) continue;

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
                for (const part of parts) {
                    if (typeof part.text === 'string' && part.text) {
                        yield { type: 'text-delta', text: part.text };
                    } else if (part.functionCall) {
                        const id = crypto.randomUUID();
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
                        chunk.usageMetadata.candidatesTokenCount ?? totalOutput;
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
        yield { type: 'message-end', stopReason };
    },
};
