import { createContext } from 'react';
import type {
    ChatSession,
    ChatState,
    PendingApproval,
} from '@/lib/ai/chat-session';
import type { AIError } from '@/lib/ai/types';

export interface AIChatContextValue {
    state: ChatState;
    session: ChatSession | null;
    /** True when provider + model + key are all set. */
    ready: boolean;
    /** True when the user has not yet set any API key. */
    needsSetup: boolean;
    error: AIError | null;
    pendingApproval: PendingApproval | null;
    send: (text: string) => Promise<void>;
    abort: () => void;
    resolveApproval: (approved: boolean) => void;
    clear: () => void;
}

const noop = (): void => {};
const asyncNoop = async (): Promise<void> => {};

export const aiChatContext = createContext<AIChatContextValue>({
    state: {
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
    },
    session: null,
    ready: false,
    needsSetup: true,
    error: null,
    pendingApproval: null,
    send: asyncNoop,
    abort: noop,
    resolveApproval: noop,
    clear: noop,
});
