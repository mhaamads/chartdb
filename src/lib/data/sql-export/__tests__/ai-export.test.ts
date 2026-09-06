import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportSQL } from '../export-sql-script';
import { DatabaseType } from '@/lib/domain/database-type';
import type { Diagram } from '@/lib/domain/diagram';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText, streamText } from 'ai';
import { setInCache } from '../export-sql-cache';

vi.mock('@ai-sdk/openai', () => ({
    createOpenAI: vi.fn(() =>
        Object.assign(
            vi.fn(() => 'responses-model'),
            { chat: vi.fn(() => 'chat-model') }
        )
    ),
}));
vi.mock('ai', () => ({ generateText: vi.fn(), streamText: vi.fn() }));
vi.mock('../export-sql-cache', () => ({
    generateCacheKey: vi.fn(async () => 'cache-key'),
    getFromCache: vi.fn(() => null),
    setInCache: vi.fn(),
}));
const diagram: Diagram = {
    id: 'd',
    name: 'test',
    databaseType: DatabaseType.POSTGRESQL,
    tables: [],
    createdAt: new Date(),
    updatedAt: new Date(),
};
const previousEnv = window.env;
afterEach(() => {
    window.env = previousEnv;
    vi.clearAllMocks();
});

describe('AI SQL export', () => {
    it.each([false, true])(
        'uses the configured compatible endpoint and cancellation (stream=%s)',
        async (stream) => {
            window.env = {
                OPENAI_API_KEY: 'test-key',
                OPENAI_API_ENDPOINT: 'http://localhost:1234/v1',
                LLM_MODEL_NAME: 'local',
            };
            vi.mocked(generateText).mockResolvedValue({ text: 'SQL' } as never);
            vi.mocked(streamText).mockReturnValue({
                textStream: (async function* () {
                    yield 'SQL';
                })(),
                text: Promise.resolve('SQL'),
            } as never);
            const controller = new AbortController();
            const onResultStream = vi.fn();
            expect(
                await exportSQL(diagram, DatabaseType.SQLITE, {
                    stream,
                    signal: controller.signal,
                    onResultStream,
                })
            ).toBe('SQL');
            expect(createOpenAI).toHaveBeenCalledWith({
                apiKey: 'test-key',
                baseURL: 'http://localhost:1234/v1',
            });
            expect(stream ? streamText : generateText).toHaveBeenCalledWith(
                expect.objectContaining({
                    model: 'chat-model',
                    abortSignal: controller.signal,
                })
            );
            if (stream) expect(onResultStream).toHaveBeenCalledWith('SQL');
            expect(setInCache).toHaveBeenCalledWith('cache-key', 'SQL');
        }
    );
});
