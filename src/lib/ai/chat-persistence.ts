import type { AIMessage } from './types';
import type { ChatTurnUsage } from './chat-session';

const KEY_PREFIX = 'chartdb:ai-chat:';
const SCHEMA_VERSION = 1;
const MAX_MESSAGES = 200;

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
        return parsed;
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
        const capped =
            messages.length > MAX_MESSAGES
                ? messages.slice(messages.length - MAX_MESSAGES)
                : messages;
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
