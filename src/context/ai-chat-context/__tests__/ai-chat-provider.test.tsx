import React, { useContext } from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AIChatProvider } from '../ai-chat-provider';
import { aiChatContext, type AIChatContextValue } from '../ai-chat-context';
import type { AIStreamEvent } from '@/lib/ai/types';

const mocks = vi.hoisted(() => ({
    diagram: {
        diagramId: 'a',
        diagramName: 'a',
        databaseType: 'postgresql',
        tables: [],
        relationships: [],
        notes: [],
        areas: [],
        removeTable: vi.fn(),
    },
    config: {
        ready: true,
        provider: 'openai',
        modelByProvider: { openai: 'gpt-4.1-mini' },
        apiKeys: { openai: 'test' },
        hasAnyKey: true,
        baseUrlByProvider: {},
        safetyMode: 'ask',
        temperature: 0,
        maxOutputTokens: 100,
        maxIterations: 3,
    },
    stream: vi.fn(),
}));
vi.mock('@/hooks/use-chartdb', () => ({ useChartDB: () => mocks.diagram }));
vi.mock('@/hooks/use-ai-config', () => ({ useAIConfig: () => mocks.config }));
vi.mock('@/hooks/use-canvas', () => ({
    useCanvas: () => ({ reorderTables: vi.fn() }),
}));
vi.mock('@/i18n/i18n', () => ({ i18n: { language: 'en' } }));
vi.mock('@/lib/ai/providers', () => ({
    getAdapter: () => ({ id: 'openai', stream: mocks.stream }),
}));
vi.mock('@/lib/ai/chat-persistence', () => ({
    loadChat: () => null,
    saveChat: vi.fn(),
    clearChat: vi.fn(),
}));

describe('AI chat session lifecycle', () => {
    it('aborts the previous diagram session and clears its approval on navigation', async () => {
        mocks.stream.mockImplementation(
            async function* (): AsyncIterable<AIStreamEvent> {
                yield {
                    type: 'tool-use-start',
                    name: 'remove_table',
                    toolUseId: 'call',
                };
                yield {
                    type: 'tool-use-end',
                    toolUseId: 'call',
                    args: { tableId: 'table-a' },
                };
                yield { type: 'message-end', stopReason: 'tool_use' };
            }
        );
        let value!: AIChatContextValue;
        function Probe() {
            value = useContext(aiChatContext);
            return null;
        }
        const view = render(
            <AIChatProvider>
                <Probe />
            </AIChatProvider>
        );
        await waitFor(() => expect(value.session).not.toBeNull());
        const oldSession = value.session!;
        let sending!: Promise<void>;
        act(() => {
            sending = value.send('delete');
        });
        await waitFor(() => expect(value.pendingApproval).not.toBeNull());
        mocks.diagram = { ...mocks.diagram, diagramId: 'b', diagramName: 'b' };
        view.rerender(
            <AIChatProvider>
                <Probe />
            </AIChatProvider>
        );
        await act(async () => {
            await sending;
        });
        expect(value.session).not.toBe(oldSession);
        expect(value.state.messages).toEqual([]);
        expect(value.pendingApproval).toBeNull();
        expect(oldSession.getState().isBusy).toBe(false);
        expect(mocks.diagram.removeTable).not.toHaveBeenCalled();
        view.unmount();
    });
});
