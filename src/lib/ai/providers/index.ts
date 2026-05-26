/**
 * Adapter registry. Imports are eager because each adapter is a small
 * pure-fetch module (no heavyweight SDKs). If we add heavier providers
 * later, swap to dynamic `import()` keyed on provider id.
 */

import type { AIProvider, AIProviderAdapter } from '../types';
import { openAIAdapter } from './openai';
import { anthropicAdapter } from './anthropic';
import { geminiAdapter } from './gemini';
import { lmStudioAdapter } from './lmstudio';

const ADAPTERS: Record<AIProvider, AIProviderAdapter> = {
    openai: openAIAdapter,
    anthropic: anthropicAdapter,
    gemini: geminiAdapter,
    lmstudio: lmStudioAdapter,
};

export function getAdapter(provider: AIProvider): AIProviderAdapter {
    return ADAPTERS[provider];
}
