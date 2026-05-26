import React, {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import { aiConfigContext } from './ai-config-context';
import type { AIConfigContextValue } from './ai-config-context';
import type { AIProvider, AISafetyMode } from '@/lib/ai/types';
import { AI_PROVIDERS } from '@/lib/ai/types';
import {
    getDefaultBaseUrl,
    getDefaultModel,
    PROVIDER_DEFAULT_BASE_URL,
} from '@/lib/ai/models';
import {
    decryptString,
    encryptString,
    wipeEncryptionKey,
} from '@/lib/ai/crypto';

const STORAGE_PREFIX = 'chartdb.ai.';
const K = {
    provider: `${STORAGE_PREFIX}provider`,
    model: (p: AIProvider) => `${STORAGE_PREFIX}model.${p}`,
    apiKey: (p: AIProvider) => `${STORAGE_PREFIX}key.${p}`,
    baseUrl: (p: AIProvider) => `${STORAGE_PREFIX}baseUrl.${p}`,
    safetyMode: `${STORAGE_PREFIX}safetyMode`,
    temperature: `${STORAGE_PREFIX}temperature`,
    maxOutputTokens: `${STORAGE_PREFIX}maxOutputTokens`,
    maxIterations: `${STORAGE_PREFIX}maxIterations`,
    showCost: `${STORAGE_PREFIX}showCost`,
};

const DEFAULT_MODELS: Record<AIProvider, string> = AI_PROVIDERS.reduce(
    (acc, p) => {
        acc[p] = getDefaultModel(p).id;
        return acc;
    },
    {} as Record<AIProvider, string>
);

const EMPTY_KEYS: Record<AIProvider, string> = AI_PROVIDERS.reduce(
    (acc, p) => {
        acc[p] = '';
        return acc;
    },
    {} as Record<AIProvider, string>
);

function readNumber(key: string, fallback: number): number {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
}

function readBoolean(key: string, fallback: boolean): boolean {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return raw === 'true';
}

export const AIConfigProvider: React.FC<React.PropsWithChildren> = ({
    children,
}) => {
    // ---------- non-secret state (synchronous load) ----------
    const [provider, setProviderState] = useState<AIProvider>(() => {
        const stored = localStorage.getItem(K.provider) as AIProvider | null;
        return stored && AI_PROVIDERS.includes(stored) ? stored : 'openai';
    });

    const [modelByProvider, setModelByProvider] = useState<
        Record<AIProvider, string>
    >(() =>
        AI_PROVIDERS.reduce(
            (acc, p) => {
                acc[p] = localStorage.getItem(K.model(p)) || DEFAULT_MODELS[p];
                return acc;
            },
            {} as Record<AIProvider, string>
        )
    );

    const [baseUrlByProvider, setBaseUrlByProvider] = useState<
        Partial<Record<AIProvider, string>>
    >(() => {
        const initial: Partial<Record<AIProvider, string>> = {};
        for (const p of AI_PROVIDERS) {
            const stored = localStorage.getItem(K.baseUrl(p));
            const fallback = getDefaultBaseUrl(p);
            if (stored) initial[p] = stored;
            else if (fallback) initial[p] = fallback;
        }
        return initial;
    });

    const [safetyMode, setSafetyModeState] = useState<AISafetyMode>(() => {
        const v = localStorage.getItem(K.safetyMode);
        return v === 'auto' || v === 'ask' || v === 'dry-run' ? v : 'ask';
    });

    const [temperature, setTemperatureState] = useState<number>(() =>
        readNumber(K.temperature, 0.2)
    );
    const [maxOutputTokens, setMaxOutputTokensState] = useState<number>(() =>
        readNumber(K.maxOutputTokens, 4096)
    );
    const [maxIterations, setMaxIterationsState] = useState<number>(() =>
        readNumber(K.maxIterations, 8)
    );
    const [showCost, setShowCostState] = useState<boolean>(() =>
        readBoolean(K.showCost, true)
    );

    // ---------- secret state (async load) ----------
    const [apiKeys, setApiKeys] = useState<Record<AIProvider, string>>(() => ({
        ...EMPTY_KEYS,
    }));
    const [ready, setReady] = useState(false);
    const cancelledRef = useRef(false);

    useEffect(() => {
        cancelledRef.current = false;
        const load = async () => {
            const next: Record<AIProvider, string> = { ...EMPTY_KEYS };
            for (const p of AI_PROVIDERS) {
                const stored = localStorage.getItem(K.apiKey(p));
                if (!stored) continue;
                try {
                    next[p] = await decryptString(stored);
                } catch (err) {
                    console.warn(`[ai-config] decrypt failed for ${p}`, err);
                }
            }
            if (cancelledRef.current) return;
            setApiKeys(next);
            setReady(true);
        };
        load();
        return () => {
            cancelledRef.current = true;
        };
    }, []);

    // ---------- persistence side-effects ----------
    useEffect(() => {
        localStorage.setItem(K.provider, provider);
    }, [provider]);

    useEffect(() => {
        for (const p of AI_PROVIDERS) {
            localStorage.setItem(K.model(p), modelByProvider[p]);
        }
    }, [modelByProvider]);

    useEffect(() => {
        for (const p of AI_PROVIDERS) {
            const v = baseUrlByProvider[p];
            if (v && v.length > 0) {
                localStorage.setItem(K.baseUrl(p), v);
            } else {
                localStorage.removeItem(K.baseUrl(p));
            }
        }
    }, [baseUrlByProvider]);

    useEffect(() => {
        localStorage.setItem(K.safetyMode, safetyMode);
    }, [safetyMode]);

    useEffect(() => {
        localStorage.setItem(K.temperature, String(temperature));
    }, [temperature]);

    useEffect(() => {
        localStorage.setItem(K.maxOutputTokens, String(maxOutputTokens));
    }, [maxOutputTokens]);

    useEffect(() => {
        localStorage.setItem(K.maxIterations, String(maxIterations));
    }, [maxIterations]);

    useEffect(() => {
        localStorage.setItem(K.showCost, String(showCost));
    }, [showCost]);

    // ---------- callbacks ----------
    const setProvider = useCallback((p: AIProvider) => setProviderState(p), []);

    const setModel = useCallback((p: AIProvider, modelId: string) => {
        setModelByProvider((prev) => ({ ...prev, [p]: modelId }));
    }, []);

    const setApiKey = useCallback(async (p: AIProvider, key: string) => {
        const trimmed = key.trim();
        setApiKeys((prev) => ({ ...prev, [p]: trimmed }));
        if (trimmed.length === 0) {
            localStorage.removeItem(K.apiKey(p));
            return;
        }
        try {
            const encrypted = await encryptString(trimmed);
            localStorage.setItem(K.apiKey(p), encrypted);
        } catch (err) {
            console.error('[ai-config] encryption failed', err);
            // Fall back to plain text rather than silently losing the key.
            localStorage.setItem(K.apiKey(p), trimmed);
        }
    }, []);

    const setBaseUrl = useCallback((p: AIProvider, url: string) => {
        const trimmed = url.trim().replace(/\/+$/u, '');
        setBaseUrlByProvider((prev) => ({ ...prev, [p]: trimmed }));
    }, []);

    const clearAll = useCallback(async () => {
        for (const p of AI_PROVIDERS) {
            localStorage.removeItem(K.apiKey(p));
            localStorage.removeItem(K.model(p));
            localStorage.removeItem(K.baseUrl(p));
        }
        localStorage.removeItem(K.provider);
        localStorage.removeItem(K.safetyMode);
        localStorage.removeItem(K.temperature);
        localStorage.removeItem(K.maxOutputTokens);
        localStorage.removeItem(K.maxIterations);
        localStorage.removeItem(K.showCost);
        wipeEncryptionKey();
        setApiKeys({ ...EMPTY_KEYS });
        setBaseUrlByProvider({ ...PROVIDER_DEFAULT_BASE_URL });
        setProviderState('openai');
        setModelByProvider(DEFAULT_MODELS);
        setSafetyModeState('ask');
        setTemperatureState(0.2);
        setMaxOutputTokensState(4096);
        setMaxIterationsState(8);
        setShowCostState(true);
    }, []);

    const hasAnyKey = useMemo(
        () => Object.values(apiKeys).some((v) => v.length > 0),
        [apiKeys]
    );

    const value = useMemo<AIConfigContextValue>(
        () => ({
            ready,
            provider,
            setProvider,
            modelByProvider,
            setModel,
            apiKeys,
            setApiKey,
            hasAnyKey,
            baseUrlByProvider,
            setBaseUrl,
            safetyMode,
            setSafetyMode: setSafetyModeState,
            temperature,
            setTemperature: setTemperatureState,
            maxOutputTokens,
            setMaxOutputTokens: setMaxOutputTokensState,
            maxIterations,
            setMaxIterations: setMaxIterationsState,
            showCost,
            setShowCost: setShowCostState,
            clearAll,
        }),
        [
            ready,
            provider,
            setProvider,
            modelByProvider,
            setModel,
            apiKeys,
            setApiKey,
            hasAnyKey,
            baseUrlByProvider,
            setBaseUrl,
            safetyMode,
            temperature,
            maxOutputTokens,
            maxIterations,
            showCost,
            clearAll,
        ]
    );

    return (
        <aiConfigContext.Provider value={value}>
            {children}
        </aiConfigContext.Provider>
    );
};
