import { describe, expect, it } from 'vitest';
import { AI_MODELS } from '@/lib/ai/models';
import {
    buildDeepSeekChatUrl,
    buildDeepSeekModelsUrl,
} from '@/lib/ai/providers/deepseek';

describe('DeepSeek integration', () => {
    it('uses the current model ids and endpoints', () => {
        expect(
            AI_MODELS.filter((model) => model.provider === 'deepseek').map(
                (model) => model.id
            )
        ).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro']);
        expect(buildDeepSeekChatUrl(undefined)).toBe(
            'https://api.deepseek.com/chat/completions'
        );
        expect(buildDeepSeekChatUrl('https://api.deepseek.com/v1')).toBe(
            'https://api.deepseek.com/v1/chat/completions'
        );
        expect(buildDeepSeekModelsUrl(undefined)).toBe(
            'https://api.deepseek.com/models'
        );
    });
});
