/**
 * Curated registry of recommended AI models per provider.
 *
 * This is intentionally a hand-maintained list rather than a live API call
 * because:
 *   - the three providers expose their model catalog at different URLs,
 *     with different schemas, and the lists include hundreds of variants
 *     most of which we don't want to surface;
 *   - users still need to pick the right model for cost/quality balance;
 *   - pricing is not exposed on any provider's models endpoint.
 *
 * Pricing is per 1M tokens in USD as of the latest known public rates.
 * Users can also enter a free-form model id in settings, so this list is
 * a "fast path" — not a hard restriction.
 */

import type { AIModel, AIProvider } from './types';

export const AI_MODELS: AIModel[] = [
    // --- OpenAI --------------------------------------------------------
    {
        id: 'gpt-4.1-mini',
        label: 'GPT-4.1 mini',
        provider: 'openai',
        contextWindow: 1_000_000,
        maxOutputTokens: 32_768,
        supportsTools: true,
        inputCostPer1M: 0.4,
        outputCostPer1M: 1.6,
        description: 'Balanced quality/cost for everyday schema work.',
        recommended: true,
    },
    {
        id: 'gpt-4.1',
        label: 'GPT-4.1',
        provider: 'openai',
        contextWindow: 1_000_000,
        maxOutputTokens: 32_768,
        supportsTools: true,
        inputCostPer1M: 2.0,
        outputCostPer1M: 8.0,
        description: 'Highest quality reasoning for complex refactors.',
    },
    {
        id: 'gpt-4.1-nano',
        label: 'GPT-4.1 nano',
        provider: 'openai',
        contextWindow: 1_000_000,
        maxOutputTokens: 32_768,
        supportsTools: true,
        inputCostPer1M: 0.1,
        outputCostPer1M: 0.4,
        description: 'Cheapest tier — great for quick edits.',
    },
    // --- Anthropic -----------------------------------------------------
    {
        id: 'claude-sonnet-4-5',
        label: 'Claude Sonnet 4.5',
        provider: 'anthropic',
        contextWindow: 200_000,
        maxOutputTokens: 64_000,
        supportsTools: true,
        inputCostPer1M: 3.0,
        outputCostPer1M: 15.0,
        description: 'Strong tool use and code reasoning.',
        recommended: true,
    },
    {
        id: 'claude-haiku-4-5',
        label: 'Claude Haiku 4.5',
        provider: 'anthropic',
        contextWindow: 200_000,
        maxOutputTokens: 32_000,
        supportsTools: true,
        inputCostPer1M: 1.0,
        outputCostPer1M: 5.0,
        description: 'Fast and cheap for simple operations.',
    },
    {
        id: 'claude-opus-4-7',
        label: 'Claude Opus 4.7',
        provider: 'anthropic',
        contextWindow: 1_000_000,
        maxOutputTokens: 64_000,
        supportsTools: true,
        inputCostPer1M: 5.0,
        outputCostPer1M: 25.0,
        description: 'Highest capability — use sparingly.',
    },
    // --- Google Gemini -------------------------------------------------
    {
        id: 'gemini-2.5-pro',
        label: 'Gemini 2.5 Pro',
        provider: 'gemini',
        contextWindow: 1_048_576,
        maxOutputTokens: 65_536,
        supportsTools: true,
        inputCostPer1M: 1.25,
        outputCostPer1M: 10.0,
        description: 'Huge context window, strong reasoning.',
        recommended: true,
    },
    {
        id: 'gemini-2.5-flash',
        label: 'Gemini 2.5 Flash',
        provider: 'gemini',
        contextWindow: 1_048_576,
        maxOutputTokens: 65_536,
        supportsTools: true,
        inputCostPer1M: 0.3,
        outputCostPer1M: 2.5,
        description: 'Fast tier — best balance of cost and capability.',
    },
    // --- DeepSeek ------------------------------------------------------
    // DeepSeek API is OpenAI-compatible. Prices are off-peak per 1M tokens;
    // DeepSeek's current pricing varies between off-peak and peak hours.
    // https://api-docs.deepseek.com/quick_start/pricing
    {
        id: 'deepseek-v4-flash',
        label: 'DeepSeek V4 Flash',
        provider: 'deepseek',
        contextWindow: 1_000_000,
        maxOutputTokens: 384_000,
        supportsTools: true,
        inputCostPer1M: 0.22,
        outputCostPer1M: 0.66,
        description: 'Fast, affordable latest model with tool calling.',
    },
    {
        id: 'deepseek-v4-pro',
        label: 'DeepSeek V4 Pro',
        provider: 'deepseek',
        contextWindow: 1_000_000,
        maxOutputTokens: 384_000,
        supportsTools: true,
        inputCostPer1M: 0.66,
        outputCostPer1M: 1.98,
        description: 'Highest-capability latest model with tool calling.',
        recommended: true,
    },
    // --- LM Studio (local) --------------------------------------------
    // LM Studio runs any GGUF/MLX model the user has downloaded, so we
    // ship a single generic entry. The model id is editable in settings
    // and is also auto-populated from the live `/v1/models` listing.
    {
        id: 'local-model',
        label: 'Local model (LM Studio)',
        provider: 'lmstudio',
        contextWindow: 32_000,
        maxOutputTokens: 8_192,
        supportsTools: true,
        inputCostPer1M: 0,
        outputCostPer1M: 0,
        description:
            'Any model loaded in LM Studio. Tool calling depends on the underlying model (Qwen, Llama 3.1+, gpt-oss…).',
        recommended: true,
    },
];

export function getModel(id: string): AIModel | undefined {
    return AI_MODELS.find((m) => m.id === id);
}

export function getModelsForProvider(provider: AIProvider): AIModel[] {
    return AI_MODELS.filter((m) => m.provider === provider);
}

export function getDefaultModel(provider: AIProvider): AIModel {
    const models = getModelsForProvider(provider);
    return models.find((m) => m.recommended) ?? models[0];
}

/**
 * Friendly provider labels for UI. Kept separate from the type union so
 * adding a new provider doesn't immediately need translations everywhere.
 */
export const PROVIDER_LABELS: Record<AIProvider, string> = {
    openai: 'OpenAI',
    anthropic: 'Anthropic',
    gemini: 'Google Gemini',
    deepseek: 'DeepSeek',
    lmstudio: 'LM Studio (local)',
};

export const PROVIDER_API_KEY_HINTS: Record<AIProvider, string> = {
    openai: 'Starts with sk-… · platform.openai.com/api-keys',
    anthropic: 'Starts with sk-ant-… · console.anthropic.com/settings/keys',
    gemini: 'Get a key at aistudio.google.com/apikey',
    deepseek: 'Starts with sk-… · platform.deepseek.com/api_keys',
    lmstudio:
        'Runs on your machine. Optional bearer token if you enabled one in LM Studio Developer settings.',
};

/** Default base URL for OpenAI-compatible local providers. */
export const DEFAULT_LMSTUDIO_BASE_URL = 'http://localhost:1234';

/** DeepSeek API base URL. */
export const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

export const PROVIDER_DEFAULT_BASE_URL: Partial<Record<AIProvider, string>> = {
    deepseek: DEFAULT_DEEPSEEK_BASE_URL,
    lmstudio: DEFAULT_LMSTUDIO_BASE_URL,
};

export function getDefaultBaseUrl(provider: AIProvider): string | undefined {
    return PROVIDER_DEFAULT_BASE_URL[provider];
}

/**
 * Estimate cost in USD given token usage and a model id.
 * Returns 0 when the model is unknown.
 */
export function estimateCost(
    modelId: string,
    inputTokens: number,
    outputTokens: number
): number {
    const model = getModel(modelId);
    if (!model) return 0;
    return (
        (inputTokens * model.inputCostPer1M) / 1_000_000 +
        (outputTokens * model.outputCostPer1M) / 1_000_000
    );
}
