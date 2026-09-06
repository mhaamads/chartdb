import { describe, it, expect, vi } from 'vitest';
import { ChatSession } from '@/lib/ai/chat-session';
import type {
    AIProviderAdapter,
    AIStreamEvent,
    AIToolDefinition,
} from '@/lib/ai/types';

function makeAdapter(scripts: AIStreamEvent[][]): AIProviderAdapter {
    let turn = 0;
    return {
        async *stream() {
            const events = scripts[turn] ?? [];
            turn += 1;
            for (const ev of events) yield ev;
        },
    } as unknown as AIProviderAdapter;
}

const fakeTool: AIToolDefinition = {
    name: 'echo',
    description: 'Echoes back the input.',
    destructive: false,
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
    },
    execute: async (args: unknown) => ({
        result: { echoed: (args as { text: string }).text },
    }),
} as unknown as AIToolDefinition;

function buildSession(
    adapter: AIProviderAdapter,
    overrides: Partial<ConstructorParameters<typeof ChatSession>[0]> = {}
) {
    return new ChatSession({
        provider: 'openai',
        model: 'gpt-4.1-mini',
        adapter,
        tools: [fakeTool],
        getApiKey: () => 'sk-test',
        getSystemPrompt: () => 'system',
        buildToolContext: () => ({}) as never,
        temperature: 0,
        maxOutputTokens: 100,
        maxIterations: 5,
        requiresApproval: () => false,
        ...overrides,
    });
}

const usage = (input: number, output: number): AIStreamEvent => ({
    type: 'usage',
    usage: { inputTokens: input, outputTokens: output, cachedInputTokens: 0 },
});

describe('ChatSession.send', () => {
    it('appends an assistant message after a single text turn', async () => {
        const adapter = makeAdapter([
            [
                { type: 'message-start', messageId: 'm1' },
                { type: 'text-delta', text: 'Hello' },
                { type: 'text-delta', text: ', world!' },
                usage(10, 5),
                { type: 'message-end', stopReason: 'end_turn' },
            ],
        ]);
        const session = buildSession(adapter);
        await session.send('Hi');
        const state = session.getState();
        expect(state.messages).toHaveLength(2);
        expect(state.messages[1].role).toBe('assistant');
        expect(state.messages[1].content[0]).toMatchObject({
            type: 'text',
            text: 'Hello, world!',
        });
        expect(state.isBusy).toBe(false);
        expect(state.totalUsage.inputTokens).toBe(10);
        expect(state.totalUsage.outputTokens).toBe(5);
    });

    it('executes a tool and loops back to the model', async () => {
        const adapter = makeAdapter([
            [
                { type: 'message-start', messageId: 'm1' },
                {
                    type: 'tool-use-start',
                    toolUseId: 'tu1',
                    name: 'echo',
                },
                {
                    type: 'tool-use-end',
                    toolUseId: 'tu1',
                    args: { text: 'hi' },
                },
                usage(5, 2),
                { type: 'message-end', stopReason: 'tool_use' },
            ],
            [
                { type: 'message-start', messageId: 'm2' },
                { type: 'text-delta', text: 'done' },
                usage(3, 1),
                { type: 'message-end', stopReason: 'end_turn' },
            ],
        ]);
        const session = buildSession(adapter);
        await session.send('run echo');
        const state = session.getState();
        const roles = state.messages.map((m) => m.role);
        expect(roles).toEqual(['user', 'assistant', 'tool', 'assistant']);
        const lastAssistant = state.messages[3];
        expect(lastAssistant.content[0]).toMatchObject({
            type: 'text',
            text: 'done',
        });
        expect(state.totalUsage.inputTokens).toBe(8);
    });

    it('surfaces tool execution errors as tool_result with isError', async () => {
        const erroringTool: AIToolDefinition = {
            ...fakeTool,
            name: 'boom',
            execute: vi.fn().mockRejectedValue(new Error('kaboom')),
        } as unknown as AIToolDefinition;
        const adapter = makeAdapter([
            [
                { type: 'message-start', messageId: 'm1' },
                {
                    type: 'tool-use-start',
                    toolUseId: 'tu1',
                    name: 'boom',
                },
                { type: 'tool-use-end', toolUseId: 'tu1', args: {} },
                usage(1, 1),
                { type: 'message-end', stopReason: 'tool_use' },
            ],
            [
                { type: 'message-start', messageId: 'm2' },
                { type: 'text-delta', text: 'recovered' },
                usage(1, 1),
                { type: 'message-end', stopReason: 'end_turn' },
            ],
        ]);
        const session = buildSession(adapter, { tools: [erroringTool] });
        await session.send('try');
        const toolMsg = session
            .getState()
            .messages.find((m) => m.role === 'tool');
        expect(toolMsg).toBeDefined();
        const block = toolMsg!.content[0];
        if (block.type !== 'tool_result')
            throw new Error('expected tool_result');
        expect(block.isError).toBe(true);
    });
});

const toolTurn = (ids = ['call']): AIStreamEvent[] => [
    ...ids.flatMap((toolUseId): AIStreamEvent[] => [
        { type: 'tool-use-start', toolUseId, name: 'echo' },
        { type: 'tool-use-end', toolUseId, args: { text: 'hi' } },
    ]),
    { type: 'message-end', stopReason: 'tool_use' },
];
const doneTurn: AIStreamEvent[] = [
    { type: 'text-delta', text: 'done' },
    { type: 'message-end', stopReason: 'end_turn' },
];

describe('tool failure recovery', () => {
    it.each(['max_tokens', 'error'] as const)(
        'does not execute a %s response',
        async (stopReason) => {
            const execute = vi.fn();
            const session = buildSession(
                makeAdapter([
                    [
                        ...toolTurn().slice(0, -1),
                        { type: 'message-end', stopReason },
                    ],
                ]),
                {
                    tools: [{ ...fakeTool, execute }],
                }
            );
            await session.send('change');
            expect(execute).not.toHaveBeenCalled();
            expect(session.getState().status).toBe('error');
            expect(session.getState().messages).toHaveLength(1);
        }
    );

    it('rejects incomplete calls and abrupt EOF', async () => {
        for (const events of [
            toolTurn().slice(0, -1),
            [toolTurn()[0], toolTurn().at(-1)!],
        ]) {
            const execute = vi.fn();
            const session = buildSession(makeAdapter([events]), {
                tools: [{ ...fakeTool, execute }],
            });
            await session.send('change');
            expect(execute).not.toHaveBeenCalled();
            expect(session.getState().status).toBe('error');
        }
    });

    it('records completed and skipped calls on cancellation, then accepts another turn', async () => {
        const execute = vi.fn(async () => {
            session.abort();
            return { created: 'id' };
        });
        const adapter = makeAdapter([toolTurn(['first', 'second']), doneTurn]);
        const session = buildSession(adapter, {
            tools: [{ ...fakeTool, execute }],
        });
        await session.send('change');
        expect(execute).toHaveBeenCalledTimes(1);
        expect(session.getState().messages[2].content).toEqual([
            expect.objectContaining({
                toolUseId: 'first',
                result: { created: 'id' },
            }),
            expect.objectContaining({ toolUseId: 'second', isError: true }),
        ]);
        await session.send('continue');
        expect(session.getState().error).toBeNull();
    });

    it('enforces approval even when the tool never asks for it', async () => {
        const execute = vi.fn(async () => ({ ok: true }));
        const session = buildSession(makeAdapter([toolTurn(), doneTurn]), {
            tools: [{ ...fakeTool, execute }],
            requiresApproval: () => true,
        });
        const sending = session.send('change');
        await vi.waitFor(() =>
            expect(session.getState().pendingApproval).not.toBeNull()
        );
        expect(execute).not.toHaveBeenCalled();
        session.resolveApproval(false);
        await sending;
        expect(execute).not.toHaveBeenCalled();
        expect(session.getState().messages[2].content[0]).toMatchObject({
            isError: true,
        });
    });

    it.each(['dry-run', 'readonly'] as const)(
        'blocks writes in %s',
        async (mode) => {
            const execute = vi.fn();
            const session = buildSession(makeAdapter([toolTurn(), doneTurn]), {
                tools: [{ ...fakeTool, readOnly: false, execute }],
                getSafetyMode: () => (mode === 'dry-run' ? 'dry-run' : 'auto'),
                buildToolContext: () =>
                    ({ chartdb: { readonly: mode === 'readonly' } }) as never,
            });
            await session.send('change');
            expect(execute).not.toHaveBeenCalled();
            expect(session.getState().messages[2].content[0]).toMatchObject({
                isError: true,
            });
        }
    );

    it('cancels pending approval without leaving dangling calls', async () => {
        const session = buildSession(makeAdapter([toolTurn()]), {
            requiresApproval: () => true,
        });
        const sending = session.send('change');
        await vi.waitFor(() =>
            expect(session.getState().pendingApproval).not.toBeNull()
        );
        session.abort();
        await sending;
        expect(session.getState()).toMatchObject({
            isBusy: false,
            pendingApproval: null,
            status: 'idle',
        });
        expect(session.getState().messages[2].content[0]).toMatchObject({
            toolUseId: 'call',
            isError: true,
        });
    });

    it('does not restore cleared history when an in-flight mutation finishes', async () => {
        let finish!: (value: unknown) => void;
        const execute = vi.fn(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                })
        );
        const session = buildSession(makeAdapter([toolTurn(), doneTurn]), {
            tools: [{ ...fakeTool, execute }],
        });
        const sending = session.send('change');
        await vi.waitFor(() => expect(execute).toHaveBeenCalled());
        session.clear();
        await session.send('new chat');
        finish({ ok: true });
        await sending;
        expect(session.getState().messages).toHaveLength(2);
        expect(session.getState().messages[0].content[0]).toMatchObject({
            text: 'new chat',
        });
    });

    it('reports round exhaustion while retaining the last tool result', async () => {
        const session = buildSession(makeAdapter([toolTurn()]), {
            maxIterations: 1,
        });
        await session.send('change');
        expect(session.getState().error?.message).toContain('round limit');
        expect(session.getState().messages.at(-1)?.role).toBe('tool');
    });

    it('includes tool schemas and output reserve in context checks', async () => {
        const stream = vi.fn(makeAdapter([doneTurn]).stream);
        const session = buildSession(
            { id: 'lmstudio', stream },
            {
                model: 'local-model',
                maxOutputTokens: 8192,
                tools: [{ ...fakeTool, description: 'x'.repeat(110_000) }],
            }
        );
        await session.send('hello');
        expect(stream).not.toHaveBeenCalled();
        expect(session.getState()).toMatchObject({
            status: 'error',
            isBusy: false,
            error: { code: 'context_length' },
        });
    });

    it('prunes complete turns per request without deleting visible history', async () => {
        const initialMessages = [
            {
                id: 'old',
                role: 'user' as const,
                content: [{ type: 'text' as const, text: 'x'.repeat(110_000) }],
                createdAt: 0,
            },
            {
                id: 'call',
                role: 'assistant' as const,
                content: [
                    {
                        type: 'tool_use' as const,
                        toolUseId: 'old-call',
                        name: 'echo',
                        args: {},
                    },
                ],
                createdAt: 0,
            },
            {
                id: 'result',
                role: 'tool' as const,
                content: [
                    {
                        type: 'tool_result' as const,
                        toolUseId: 'old-call',
                        result: {},
                    },
                ],
                createdAt: 0,
            },
        ];
        const stream = vi.fn(makeAdapter([doneTurn]).stream);
        const session = buildSession(
            { id: 'lmstudio', stream },
            { model: 'local-model', maxOutputTokens: 8192, initialMessages }
        );
        await session.send('new turn');
        expect(stream.mock.calls[0][0].messages.map((m) => m.role)).toEqual([
            'user',
        ]);
        expect(session.getState().messages).toHaveLength(5);
    });
});

it('rejects invalid settings and invalid arguments before prompting approval', async () => {
    const stream = vi.fn(makeAdapter([doneTurn]).stream);
    const invalidSession = buildSession(
        { id: 'openai', stream },
        { maxIterations: 0 }
    );
    await invalidSession.send('hello');
    expect(stream).not.toHaveBeenCalled();
    expect(invalidSession.getState().error?.message).toContain(
        'Invalid AI settings'
    );
    const execute = vi.fn();
    const approvals = vi.fn(() => true);
    const session = buildSession(makeAdapter([toolTurn(), doneTurn]), {
        tools: [
            {
                ...fakeTool,
                validateArgs: () => {
                    throw new Error('invalid arguments');
                },
                execute,
            },
        ],
        requiresApproval: approvals,
    });
    await session.send('change');
    expect(execute).not.toHaveBeenCalled();
    expect(approvals).not.toHaveBeenCalled();
    expect(session.getState().messages[2].content[0]).toMatchObject({
        isError: true,
        result: { error: 'invalid arguments' },
    });
});
