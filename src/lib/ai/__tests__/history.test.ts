import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { capChatHistory, repairToolHistory } from '../history';
import { loadChat, saveChat } from '../chat-persistence';
import type { AIMessage } from '../types';
const user: AIMessage = {
    id: 'u',
    role: 'user',
    content: [{ type: 'text', text: 'hello' }],
    createdAt: 0,
};
const assistant: AIMessage = {
    id: 'a',
    role: 'assistant',
    content: [
        {
            type: 'tool_use',
            toolUseId: 'call',
            name: 'create_table',
            args: { name: 'users' },
        },
    ],
    createdAt: 1,
    geminiParts: [
        {
            thoughtSignature: 'opaque',
            functionCall: { name: 'create_table', args: { name: 'users' } },
        },
    ],
};
const result: AIMessage = {
    id: 'r',
    role: 'tool',
    content: [
        { type: 'tool_result', toolUseId: 'call', result: { id: 'created' } },
    ],
    createdAt: 2,
};
const usage = {
    inputTokens: 1,
    outputTokens: 2,
    cachedInputTokens: 0,
    cost: 0,
};
beforeEach(() => {
    const data = new Map<string, string>();
    vi.stubGlobal('localStorage', {
        getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => data.set(key, value),
        removeItem: (key: string) => data.delete(key),
    });
});
afterEach(() => vi.unstubAllGlobals());

describe('chat history integrity', () => {
    it('repairs missing results without pretending the operation did not happen', () => {
        const repaired = repairToolHistory([
            user,
            assistant,
            { ...user, id: 'u2' },
        ]);
        expect(repaired[2].content[0]).toMatchObject({
            toolUseId: 'call',
            isError: true,
            result: { error: expect.stringContaining('unknown') },
        });
        expect(repairToolHistory(repaired)).toEqual(repaired);
    });
    it('removes orphan results and preserves known outcomes', () => {
        expect(repairToolHistory([result, user, assistant, result])).toEqual([
            user,
            assistant,
            result,
        ]);
    });
    it('cuts on user boundaries and keeps one oversized turn intact', () => {
        expect(
            capChatHistory([user, assistant, result, { ...user, id: 'new' }], 2)
        ).toEqual([{ ...user, id: 'new' }]);
        expect(capChatHistory([user, assistant, result], 2)).toEqual([
            user,
            assistant,
            result,
        ]);
    });
    it('persists opaque Gemini parts and repairs interrupted history on reload', () => {
        saveChat('diagram', [user, assistant], usage);
        const loaded = loadChat('diagram');
        expect(loaded?.messages[1].geminiParts).toEqual(assistant.geminiParts);
        expect(loaded?.messages[2].role).toBe('tool');
    });
    it('rejects malformed stored messages or usage', () => {
        for (const broken of [
            { messages: {} },
            { messages: [{ role: 'assistant', content: null }] },
            { totalUsage: {} },
        ]) {
            localStorage.setItem(
                'chartdb:ai-chat:diagram',
                JSON.stringify({
                    v: 1,
                    diagramId: 'diagram',
                    messages: [user],
                    totalUsage: usage,
                    ...broken,
                })
            );
            expect(loadChat('diagram')).toBeNull();
        }
    });
});
