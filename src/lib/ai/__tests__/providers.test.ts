import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAdapter } from '../providers';
import { ChatSession } from '../chat-session';
import { AI_TOOLS } from '../tools';
import type { AIProvider, AIRequest, AIStreamEvent } from '../types';

const req: AIRequest = {
    apiKey: 'test-key',
    model: 'test-model',
    system: 'system',
    messages: [
        {
            id: 'user',
            role: 'user',
            content: [{ type: 'text', text: 'hello' }],
            createdAt: 0,
        },
    ],
    tools: AI_TOOLS,
    temperature: 0.2,
    maxOutputTokens: 100,
};
const sse = (data: unknown, event?: string) =>
    `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`;
const openAITool = (args = '{"query":"users"}', finish = 'tool_calls') =>
    sse({
        choices: [
            {
                delta: {
                    tool_calls: [
                        {
                            index: 0,
                            id: 'call',
                            function: {
                                name: 'find_tables_by_name',
                                arguments: args,
                            },
                        },
                    ],
                },
                finish_reason: finish,
            },
        ],
    }) + 'data: [DONE]\n\n';
const openAIText =
    sse({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }) +
    'data: [DONE]\n\n';
const anthropicTool = (args = '{"query":"users"}') =>
    sse({ message: { id: 'm', usage: { input_tokens: 5 } } }, 'message_start') +
    sse(
        {
            index: 0,
            content_block: {
                type: 'tool_use',
                id: 'call',
                name: 'find_tables_by_name',
            },
        },
        'content_block_start'
    ) +
    sse(
        { index: 0, delta: { type: 'input_json_delta', partial_json: args } },
        'content_block_delta'
    ) +
    sse({ index: 0 }, 'content_block_stop') +
    sse(
        { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } },
        'message_delta'
    ) +
    sse({}, 'message_stop');
const anthropicText =
    sse(
        { index: 0, delta: { type: 'text_delta', text: 'done' } },
        'content_block_delta'
    ) +
    sse({ delta: { stop_reason: 'end_turn' } }, 'message_delta') +
    sse({}, 'message_stop');
const geminiParts = [
    { text: 'private summary', thought: true, thoughtSignature: 'opaque-text' },
    {
        functionCall: {
            id: 'call',
            name: 'find_tables_by_name',
            args: { query: 'users' },
        },
        thoughtSignature: 'opaque-call',
    },
];
const geminiTool = sse({
    candidates: [
        {
            content: { role: 'model', parts: geminiParts },
            finishReason: 'STOP',
        },
    ],
});
const geminiText = sse({
    candidates: [
        { content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' },
    ],
});
const fixtures: Record<AIProvider, [string, string]> = {
    openai: [openAITool(), openAIText],
    deepseek: [openAITool(), openAIText],
    lmstudio: [openAITool(), openAIText],
    anthropic: [anthropicTool(), anthropicText],
    gemini: [geminiTool, geminiText],
};
async function collect(
    provider: AIProvider,
    text: string,
    override: Partial<AIRequest> = {}
) {
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(text))
    );
    const out: AIStreamEvent[] = [];
    for await (const event of getAdapter(provider).stream(
        { ...req, ...override },
        new AbortController().signal
    ))
        out.push(event);
    return out;
}
afterEach(() => vi.unstubAllGlobals());

describe('provider wire contracts', () => {
    it.each(Object.keys(fixtures) as AIProvider[])(
        '%s completes a real adapter → tool → adapter loop',
        async (provider) => {
            const fetch = vi
                .fn()
                .mockResolvedValueOnce(new Response(fixtures[provider][0]))
                .mockResolvedValueOnce(new Response(fixtures[provider][1]));
            vi.stubGlobal('fetch', fetch);
            const session = new ChatSession({
                provider,
                model: 'test-model',
                adapter: getAdapter(provider),
                tools: AI_TOOLS,
                getApiKey: () => req.apiKey,
                getSystemPrompt: () => 'system',
                buildToolContext: () =>
                    ({ diagramId: 'd', chartdb: { tables: [] } }) as never,
                temperature: 0.2,
                maxOutputTokens: 100,
                maxIterations: 4,
                requiresApproval: () => false,
            });
            await session.send('find users');
            expect(session.getState().error).toBeNull();
            expect(session.getState().messages.map((m) => m.role)).toEqual([
                'user',
                'assistant',
                'tool',
                'assistant',
            ]);
            expect(session.getState().messages[2].content[0]).toMatchObject({
                result: [],
                isError: false,
            });
            expect(fetch).toHaveBeenCalledTimes(2);
            const first = JSON.parse(fetch.mock.calls[0][1].body);
            const second = JSON.parse(fetch.mock.calls[1][1].body);
            if (provider === 'gemini') {
                expect(first.tools[0].functionDeclarations[0]).toHaveProperty(
                    'parametersJsonSchema'
                );
                expect(second.contents[1].parts).toEqual(geminiParts);
                expect(
                    second.contents[2].parts[0].functionResponse
                ).toMatchObject({
                    id: 'call',
                    name: 'find_tables_by_name',
                    response: { result: [] },
                });
                expect(
                    session.getState().messages[1].content
                ).not.toContainEqual(
                    expect.objectContaining({ text: 'private summary' })
                );
                expect(fetch.mock.calls[0][0]).not.toContain('test-key');
            } else if (provider === 'anthropic') {
                expect(second.messages[2]).toMatchObject({
                    role: 'user',
                    content: [{ type: 'tool_result', tool_use_id: 'call' }],
                });
            } else {
                expect(second.messages.at(-1)).toMatchObject({
                    role: 'tool',
                    tool_call_id: 'call',
                });
                expect(first.parallel_tool_calls).toBe(false);
                if (provider !== 'openai') expect(first.max_tokens).toBe(100);
                if (provider === 'deepseek')
                    expect(first.thinking).toEqual({ type: 'disabled' });
            }
        }
    );

    it.each([
        'openai',
        'deepseek',
        'lmstudio',
        'anthropic',
        'gemini',
    ] as AIProvider[])(
        '%s detects an abruptly ended response',
        async (provider) => {
            const incomplete =
                provider === 'anthropic'
                    ? anthropicTool().replace(sse({}, 'message_stop'), '')
                    : provider === 'gemini'
                      ? sse({
                            candidates: [{ content: { parts: geminiParts } }],
                        })
                      : openAITool().replace(
                            '"finish_reason":"tool_calls"',
                            '"finish_reason":null'
                        );
            const out = await collect(provider, incomplete);
            expect(out.at(-1)?.type).toBe('error');
        }
    );

    it.each(['openai', 'anthropic'] as const)(
        '%s preserves malformed arguments for validation instead of replacing with an empty object',
        async (provider) => {
            const out = await collect(
                provider,
                provider === 'openai'
                    ? openAITool('{broken')
                    : anthropicTool('{broken')
            );
            expect(out.find((e) => e.type === 'tool-use-end')).toMatchObject({
                args: '{broken',
            });
        }
    );

    it('reports HTTP-200 stream errors and content filtering', async () => {
        const out = await collect(
            'openai',
            sse({ error: { message: 'overloaded' } })
        );
        expect(out.at(-1)).toMatchObject({
            type: 'error',
            error: { message: 'overloaded' },
        });
        const blocked = await collect(
            'gemini',
            sse({ promptFeedback: { blockReason: 'SAFETY' } })
        );
        expect(blocked.at(-1)).toMatchObject({
            type: 'error',
            error: { code: 'content_filter' },
        });
    });

    it('keeps final OpenAI usage after the finish chunk', async () => {
        const out = await collect(
            'openai',
            openAIText.replace(
                'data: [DONE]\n\n',
                sse({
                    choices: [],
                    usage: {
                        prompt_tokens: 20,
                        completion_tokens: 5,
                        prompt_tokens_details: { cached_tokens: 10 },
                    },
                }) + 'data: [DONE]\n\n'
            )
        );
        expect(out.find((e) => e.type === 'usage')).toMatchObject({
            usage: { inputTokens: 20, outputTokens: 5, cachedInputTokens: 10 },
        });
    });

    it('handles late tool ids and fragmented function names', async () => {
        const out = await collect(
            'openai',
            sse({
                choices: [
                    {
                        delta: {
                            tool_calls: [
                                {
                                    index: 0,
                                    function: {
                                        name: 'find_',
                                        arguments: '{"query":',
                                    },
                                },
                            ],
                        },
                    },
                ],
            }) +
                sse({
                    choices: [
                        {
                            delta: {
                                tool_calls: [
                                    {
                                        index: 0,
                                        id: 'late-id',
                                        function: {
                                            name: 'tables_by_name',
                                            arguments: '"users"}',
                                        },
                                    },
                                ],
                            },
                            finish_reason: 'tool_calls',
                        },
                    ],
                })
        );
        expect(out.find((e) => e.type === 'tool-use-start')).toMatchObject({
            toolUseId: 'late-id',
            name: 'find_tables_by_name',
        });
        expect(out.find((e) => e.type === 'tool-use-end')).toMatchObject({
            toolUseId: 'late-id',
            args: { query: 'users' },
        });
    });

    it('omits unsupported temperature on OpenAI reasoning models', async () => {
        await collect('openai', openAIText, { model: 'o3' });
        const body = JSON.parse(
            vi.mocked(fetch).mock.calls[0][1]!.body as string
        );
        expect(body).not.toHaveProperty('temperature');
    });
});

it('omits deprecated Claude sampling settings while respecting legacy limits', async () => {
    await collect('anthropic', anthropicText, { model: 'claude-opus-4-7' });
    expect(
        JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)
    ).not.toHaveProperty('temperature');
    await collect('anthropic', anthropicText, {
        model: 'claude-sonnet-4-5',
        temperature: 2,
    });
    expect(
        JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)
            .temperature
    ).toBe(1);
});
