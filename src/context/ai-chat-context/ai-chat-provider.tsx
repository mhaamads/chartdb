import React, { useEffect, useMemo, useRef, useState } from 'react';
import { aiChatContext, type AIChatContextValue } from './ai-chat-context';
import { useAIConfig } from '@/hooks/use-ai-config';
import { useChartDB } from '@/hooks/use-chartdb';
import { useCanvas } from '@/hooks/use-canvas';
import { ChatSession, type ChatState } from '@/lib/ai/chat-session';
import { AI_TOOLS } from '@/lib/ai/tools';
import { getAdapter } from '@/lib/ai/providers';
import {
    buildSystemPrompt,
    serializeSchemaCompact,
} from '@/lib/ai/system-prompt';
import type { AIToolDefinition } from '@/lib/ai/types';
import { isLocalProvider } from '@/lib/ai/types';
import { i18n } from '@/i18n/i18n';
import { loadChat, saveChat, clearChat } from '@/lib/ai/chat-persistence';

export const AIChatProvider: React.FC<{ children: React.ReactNode }> = ({
    children,
}) => {
    const aiConfig = useAIConfig();
    const chartdb = useChartDB();
    const { reorderTables } = useCanvas();

    const provider = aiConfig.provider;
    const model = aiConfig.modelByProvider[provider];
    const apiKey = aiConfig.apiKeys[provider];
    const local = isLocalProvider(provider);

    const ready = Boolean(aiConfig.ready && model && (apiKey || local));
    // For local providers we don't need an API key, so treat them as
    // "set up" as long as the user has selected a model.
    const needsSetup = aiConfig.ready && !aiConfig.hasAnyKey && !local;

    // Latest ChartDB snapshot is held in a ref so the session callbacks see
    // up-to-date state without recreating the session on every diagram edit.
    const chartdbRef = useRef(chartdb);
    chartdbRef.current = chartdb;

    const aiConfigRef = useRef(aiConfig);
    aiConfigRef.current = aiConfig;

    const [state, setState] = useState<ChatState>(() => ({
        messages: [],
        status: 'idle',
        streaming: null,
        error: null,
        totalUsage: {
            inputTokens: 0,
            outputTokens: 0,
            cachedInputTokens: 0,
            cost: 0,
        },
        lastTurnUsage: null,
        pendingApproval: null,
        isBusy: false,
    }));

    // Session is recreated when the provider, model, or diagram id changes —
    // otherwise we mutate options through `updateOptions` to avoid losing
    // in-flight history.
    const [session, setSession] = useState<ChatSession | null>(null);
    useEffect(() => {
        if (!ready || !model || (!apiKey && !isLocalProvider(provider))) {
            setSession(null);
            setState((prev) => ({
                ...prev,
                messages: [],
                isBusy: false,
                status: 'idle',
                streaming: null,
                pendingApproval: null,
                error: null,
            }));
            return;
        }
        const tools = AI_TOOLS;
        const adapter = getAdapter(provider);
        const persisted = loadChat(chartdb.diagramId);
        const requiresApproval = (
            tool: AIToolDefinition,
            args: unknown
        ): boolean => {
            const safety = aiConfigRef.current.safetyMode;
            if (safety === 'dry-run') return false; // runtime blocks writes
            if (safety === 'auto') return false;
            // 'ask' mode
            if (tool.name === 'apply_schema_patch') {
                // Confirm destructive batches and larger groups once.
                const ops = (args as { ops?: unknown[] })?.ops;
                return (
                    Array.isArray(ops) &&
                    (ops.length >= 3 ||
                        ops.some(
                            (op) =>
                                !!op &&
                                typeof op === 'object' &&
                                'op' in op &&
                                String(op.op).startsWith('remove_')
                        ))
                );
            }
            return !!tool.destructive;
        };
        const s = new ChatSession({
            provider,
            model,
            adapter,
            tools,
            getApiKey: () => aiConfigRef.current.apiKeys[provider],
            getBaseUrl: () => aiConfigRef.current.baseUrlByProvider[provider],
            getSystemPrompt: () =>
                buildSystemPrompt({
                    databaseType: chartdbRef.current.databaseType,
                    diagramName: chartdbRef.current.diagramName,
                    locale: i18n.language,
                    // Keep the inline snapshot small for large diagrams. The
                    // model can request exact fields with get_table.
                    schemaSnapshot: serializeSchemaCompact(chartdbRef.current, {
                        includeFields: chartdbRef.current.tables.length <= 30,
                    }),
                    safetyMode: aiConfigRef.current.safetyMode,
                }),
            buildToolContext: (signal) => ({
                get chartdb() {
                    signal.throwIfAborted();
                    if (chartdbRef.current.diagramId !== chartdb.diagramId) {
                        throw new Error(
                            'The active diagram changed. Start a new turn.'
                        );
                    }
                    return chartdbRef.current;
                },
                diagramId: chartdb.diagramId,
            }),
            temperature: aiConfigRef.current.temperature,
            maxOutputTokens: aiConfigRef.current.maxOutputTokens,
            maxIterations: aiConfigRef.current.maxIterations,
            requiresApproval,
            getSafetyMode: () => aiConfigRef.current.safetyMode,
            initialMessages: persisted?.messages,
            initialTotalUsage: persisted?.totalUsage,
        });
        setSession(s);
        setState(s.getState());
        const unsubscribe = s.subscribe(setState);
        return () => {
            unsubscribe();
            s.abort();
            const final = s.getState();
            saveChat(chartdb.diagramId, final.messages, final.totalUsage);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [provider, model, ready, chartdb.diagramId]);

    // Push live option changes into the session without recreating it.
    useEffect(() => {
        if (!session) return;
        session.updateOptions({
            temperature: aiConfig.temperature,
            maxOutputTokens: aiConfig.maxOutputTokens,
            maxIterations: aiConfig.maxIterations,
        });
    }, [
        session,
        aiConfig.temperature,
        aiConfig.maxOutputTokens,
        aiConfig.maxIterations,
    ]);

    // Persist messages to localStorage (debounced) whenever they change while
    // the session is idle — avoids thrashing during streaming.
    const diagramId = chartdb.diagramId;
    useEffect(() => {
        if (!session || !diagramId) return;
        if (state !== session.getState() || state.isBusy) return;
        const handle = window.setTimeout(() => {
            saveChat(diagramId, state.messages, state.totalUsage);
        }, 300);
        return () => window.clearTimeout(handle);
    }, [session, diagramId, state]);

    // Auto-arrange tables when the AI creates or removes tables.
    // Track the table count at the start of each turn; when the turn
    // completes and the count changed, reorder without adding a history
    // entry (the schema changes already created their own history entries).
    const prevBusyRef = useRef(false);
    const tableCountAtTurnStart = useRef(0);
    useEffect(() => {
        const nowBusy = state.isBusy;
        if (!prevBusyRef.current && nowBusy) {
            // Turn starting — snapshot current table count.
            tableCountAtTurnStart.current = chartdbRef.current.tables.length;
        } else if (
            prevBusyRef.current &&
            !nowBusy &&
            state.status === 'idle' &&
            !state.error
        ) {
            // Turn completed without error — rearrange if table count changed.
            if (
                chartdbRef.current.tables.length !==
                tableCountAtTurnStart.current
            ) {
                reorderTables({ updateHistory: false });
            }
        }
        prevBusyRef.current = nowBusy;
    }, [state.isBusy, state.status, state.error, reorderTables]);

    const value: AIChatContextValue = useMemo(
        () => ({
            state,
            session,
            ready,
            needsSetup,
            error: state.error,
            pendingApproval: state.pendingApproval,
            send: async (text) => {
                if (!session) return;
                await session.send(text);
            },
            abort: () => session?.abort(),
            resolveApproval: (approved) => session?.resolveApproval(approved),
            clear: () => {
                session?.clear();
                clearChat(chartdbRef.current.diagramId);
            },
        }),
        [state, session, ready, needsSetup]
    );

    return (
        <aiChatContext.Provider value={value}>
            {children}
        </aiChatContext.Provider>
    );
};
