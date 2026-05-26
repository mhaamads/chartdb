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
    inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
    },
    execute: async (_ctx: unknown, args: unknown) => ({
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
