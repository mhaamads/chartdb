import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
    sanitizeDeepSeekToolSchema,
    zodToToolSchema,
} from '@/lib/ai/json-schema';
import { AI_TOOLS } from '@/lib/ai/tools';

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

    it('merges object unions for DeepSeek tool schemas', () => {
        const schema = sanitizeDeepSeekToolSchema({
            type: 'array',
            items: {
                anyOf: [
                    {
                        type: 'object',
                        properties: {
                            op: { type: 'string', enum: ['create_table'] },
                            args: {
                                type: 'object',
                                properties: { name: { type: 'string' } },
                                required: ['name'],
                                additionalProperties: false,
                            },
                        },
                        required: ['op', 'args'],
                        additionalProperties: false,
                    },
                    {
                        type: 'object',
                        properties: {
                            op: { type: 'string', enum: ['remove_table'] },
                            args: {
                                type: 'object',
                                properties: { tableId: { type: 'string' } },
                                required: ['tableId'],
                                additionalProperties: false,
                            },
                        },
                        required: ['op', 'args'],
                        additionalProperties: false,
                    },
                ],
            },
        }) as {
            items: {
                anyOf?: unknown;
                required?: string[];
                properties: {
                    op: { enum: string[] };
                    args: { properties: Record<string, unknown> };
                };
            };
        };

        expect(schema.items.anyOf).toBeUndefined();
        expect(schema.items.required).toEqual(['op', 'args']);
        expect(schema.items.properties.op.enum).toEqual([
            'create_table',
            'remove_table',
        ]);
        expect(schema.items.properties.args.properties).toEqual({
            name: { type: 'string' },
            tableId: { type: 'string' },
        });
    });

    it('sanitizes the apply_schema_patch catalog entry', () => {
        const tool = AI_TOOLS.find(
            (entry) => entry.name === 'apply_schema_patch'
        );
        expect(tool).toBeDefined();
        expect(
            JSON.stringify(sanitizeDeepSeekToolSchema(tool!.inputSchema))
        ).not.toContain('anyOf');
    });
});
