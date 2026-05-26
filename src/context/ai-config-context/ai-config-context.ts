import { createContext } from 'react';
import { emptyFn } from '@/lib/utils';
import type { AIProvider, AISafetyMode } from '@/lib/ai/types';

export interface AIConfigContextValue {
    /** True once the encrypted keys have been loaded from storage. */
    ready: boolean;

    provider: AIProvider;
    setProvider: (p: AIProvider) => void;

    /** Selected model id per provider. */
    modelByProvider: Record<AIProvider, string>;
    setModel: (provider: AIProvider, modelId: string) => void;

    /**
     * Decrypted API keys. Empty string means "not configured".
     * Never persist these as plain text — use `setApiKey` which encrypts.
     */
    apiKeys: Record<AIProvider, string>;
    setApiKey: (provider: AIProvider, key: string) => Promise<void>;
    hasAnyKey: boolean;

    /**
     * Per-provider base URL overrides. Only meaningful for self-hosted /
     * OpenAI-compatible providers (currently LM Studio); other providers
     * ignore the value.
     */
    baseUrlByProvider: Partial<Record<AIProvider, string>>;
    setBaseUrl: (provider: AIProvider, url: string) => void;

    safetyMode: AISafetyMode;
    setSafetyMode: (mode: AISafetyMode) => void;

    temperature: number;
    setTemperature: (t: number) => void;

    maxOutputTokens: number;
    setMaxOutputTokens: (n: number) => void;

    /** Max tool-call iterations per user turn. */
    maxIterations: number;
    setMaxIterations: (n: number) => void;

    /** Show cost meter in the assistant UI. */
    showCost: boolean;
    setShowCost: (v: boolean) => void;

    /** Wipe every AI-related setting + encrypted key from this device. */
    clearAll: () => Promise<void>;
}

export const aiConfigContext = createContext<AIConfigContextValue>({
    ready: false,
    provider: 'openai',
    setProvider: emptyFn,
    modelByProvider: {
        openai: 'gpt-4.1-mini',
        anthropic: 'claude-sonnet-4-5',
        gemini: 'gemini-2.5-pro',
        lmstudio: 'local-model',
    },
    setModel: emptyFn,
    apiKeys: { openai: '', anthropic: '', gemini: '', lmstudio: '' },
    setApiKey: async () => {},
    hasAnyKey: false,
    baseUrlByProvider: { lmstudio: 'http://localhost:1234' },
    setBaseUrl: emptyFn,
    safetyMode: 'ask',
    setSafetyMode: emptyFn,
    temperature: 0.2,
    setTemperature: emptyFn,
    maxOutputTokens: 4096,
    setMaxOutputTokens: emptyFn,
    maxIterations: 8,
    setMaxIterations: emptyFn,
    showCost: true,
    setShowCost: emptyFn,
    clearAll: async () => {},
});
