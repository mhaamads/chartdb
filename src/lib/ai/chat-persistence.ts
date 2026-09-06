import { z } from 'zod';
import { capChatHistory, repairToolHistory } from './history';
import type { AIMessage } from './types';
import type { ChatTurnUsage } from './chat-session';

const KEY_PREFIX = 'chartdb:ai-chat:';
const SCHEMA_VERSION = 1;
const MAX_MESSAGES = 200;
const messageSchema = z
    .object({
        id: z.string(),
        role: z.enum(['user', 'assistant', 'system', 'tool']),
        createdAt: z.number(),
        content: z
            .array(
                z.discriminatedUnion('type', [
                    z.object({ type: z.literal('text'), text: z.string() }),
                    z.object({
                        type: z.literal('tool_use'),
                        toolUseId: z.string(),
                        name: z.string(),
                        args: z.unknown(),
                    }),
                    z.object({
                        type: z.literal('tool_result'),
                        toolUseId: z.string(),
                        result: z.unknown(),
                        isError: z.boolean().optional(),
                    }),
                ])
            )
            .min(1),
        model: z.string().optional(),
        geminiParts: z.array(z.record(z.unknown())).optional(),
    })
    .passthrough();
const usageSchema = z.object({
    inputTokens: z.number().nonnegative(),
    outputTokens: z.number().nonnegative(),
    cachedInputTokens: z.number().nonnegative(),
    cost: z.number().nonnegative(),
});

export interface PersistedChat {
    v: number;
    diagramId: string;
    messages: AIMessage[];
    totalUsage: ChatTurnUsage;
    updatedAt: number;
}

function storageKey(diagramId: string): string {
    return `${KEY_PREFIX}${diagramId}`;
}

function safeStorage(): Storage | null {
    try {
        if (typeof localStorage === 'undefined') return null;
        return localStorage;
    } catch {
        return null;
    }
}

export function loadChat(diagramId: string): PersistedChat | null {
    if (!diagramId) return null;
    const store = safeStorage();
    if (!store) return null;
    try {
        const raw = store.getItem(storageKey(diagramId));
        if (!raw) return null;
        const parsed = JSON.parse(raw) as PersistedChat;
        if (parsed.v !== SCHEMA_VERSION) return null;
        if (parsed.diagramId !== diagramId) return null;
        if (
            !z.array(messageSchema).safeParse(parsed.messages).success ||
            !usageSchema.safeParse(parsed.totalUsage).success
        )
            return null;
        return { ...parsed, messages: repairToolHistory(parsed.messages) };
    } catch {
        return null;
    }
}

export function saveChat(
    diagramId: string,
    messages: AIMessage[],
    totalUsage: ChatTurnUsage
): void {
    if (!diagramId) return;
    const store = safeStorage();
    if (!store) return;
    try {
        // Cap retained history to keep localStorage bounded.
        const capped = capChatHistory(messages, MAX_MESSAGES);
        const data: PersistedChat = {
            v: SCHEMA_VERSION,
            diagramId,
            messages: capped,
            totalUsage,
            updatedAt: Date.now(),
        };
        store.setItem(storageKey(diagramId), JSON.stringify(data));
    } catch {
        // Quota errors etc. swallowed — chat history is best-effort.
    }
}

export function clearChat(diagramId: string): void {
    if (!diagramId) return;
    const store = safeStorage();
    if (!store) return;
    try {
        store.removeItem(storageKey(diagramId));
    } catch {
        // best-effort
    }
}
