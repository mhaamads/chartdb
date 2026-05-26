import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { zodToToolSchema } from '@/lib/ai/json-schema';

describe('zodToToolSchema', () => {
    it('produces an object schema without $schema or definitions', () => {
        const schema = z.object({
            name: z.string().describe('Table name'),
            count: z.number().int().optional(),
        });
        const json = zodToToolSchema(schema);
        expect(json.type).toBe('object');
        expect((json as Record<string, unknown>).$schema).toBeUndefined();
        expect((json as Record<string, unknown>).definitions).toBeUndefined();
        const props = (json as { properties: Record<string, unknown> })
            .properties;
        expect(props.name).toBeDefined();
        expect(props.count).toBeDefined();
    });

    it('marks required fields', () => {
        const schema = z.object({
            id: z.string(),
            note: z.string().optional(),
        });
        const json = zodToToolSchema(schema) as {
            required?: string[];
        };
        expect(json.required).toEqual(['id']);
    });
});
