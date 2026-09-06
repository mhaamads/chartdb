import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
    sanitizeDeepSeekToolSchema,
    zodToToolSchema,
} from '@/lib/ai/json-schema';
import { AI_TOOLS } from '@/lib/ai/tools';

function expectDeepSeekObjects(value: unknown): void {
    if (Array.isArray(value)) {
        value.forEach(expectDeepSeekObjects);
        return;
    }
    if (typeof value !== 'object' || value === null) return;

    const schema = value as Record<string, unknown>;
    if (schema.type === 'object') {
        const properties = schema.properties as Record<string, unknown>;
        for (const key of (schema.required as string[] | undefined) ?? [])
            expect(properties).toHaveProperty(key);
        expect(schema.additionalProperties).toBe(false);
    }
    expect(schema).not.toHaveProperty('nullable');
    for (const [key, child] of Object.entries(schema)) {
        if (key === 'properties')
            Object.values(child as Record<string, unknown>).forEach(
                expectDeepSeekObjects
            );
        else expectDeepSeekObjects(child);
    }
}

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
                    args: {
                        properties: Record<string, unknown>;
                        required: string[];
                        additionalProperties: false;
                    };
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
        expect(schema.items.properties.args.required).toBeUndefined();
        expect(schema.items.properties.args.additionalProperties).toBe(false);
    });

    it('removes OpenAPI constraints DeepSeek does not accept', () => {
        const schema = sanitizeDeepSeekToolSchema({
            type: 'object',
            properties: {
                nested: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', minLength: 1 },
                        count: {
                            type: 'number',
                            minimum: 0,
                            exclusiveMinimum: true,
                        },
                        tags: {
                            type: 'array',
                            minItems: 1,
                            maxItems: 2,
                            items: { type: 'string', maxLength: 4 },
                        },
                        value: { type: 'string', nullable: true },
                    },
                },
            },
        }) as {
            required: string[];
            additionalProperties: false;
            properties: {
                nested: {
                    required: string[];
                    properties: {
                        count: Record<string, unknown>;
                    };
                };
            };
        };

        expect(schema.required).toBeUndefined();
        expect(schema.additionalProperties).toBe(false);
        expect(schema.properties.nested.required).toBeUndefined();
        expect(schema.properties.nested.properties.count).toEqual({
            type: 'number',
            exclusiveMinimum: 0,
        });
        const serialized = JSON.stringify(schema);
        expect(serialized).not.toContain('minLength');
        expect(serialized).not.toContain('maxLength');
        expect(serialized).not.toContain('minItems');
        expect(serialized).not.toContain('maxItems');
    });

    it('sanitizes the apply_schema_patch catalog entry', () => {
        const tool = AI_TOOLS.find(
            (entry) => entry.name === 'apply_schema_patch'
        );
        expect(tool).toBeDefined();
        const schema = sanitizeDeepSeekToolSchema(tool!.inputSchema);
        const serialized = JSON.stringify(schema);
        expect(serialized).not.toContain('anyOf');
        expect(serialized).not.toContain('minLength');
        expect(serialized).not.toContain('maxLength');
        expect(serialized).not.toContain('minItems');
        expect(serialized).not.toContain('maxItems');
        expect(serialized).not.toContain('"exclusiveMinimum":true');
        expectDeepSeekObjects(schema);
    });
});

it('preserves property names that collide with schema keywords and leaves updates optional', () => {
    const schema = sanitizeDeepSeekToolSchema(
        zodToToolSchema(
            z.object({
                nullable: z.boolean().optional(),
                minLength: z.string().min(1).optional(),
                anyOf: z.string().optional(),
            })
        )
    );
    expect(schema.properties).toEqual({
        nullable: { type: 'boolean' },
        minLength: { type: 'string' },
        anyOf: { type: 'string' },
    });
    expect(schema.required ?? []).toEqual([]);
    const fieldTool = AI_TOOLS.find((t) => t.name === 'update_field')!;
    const converted = sanitizeDeepSeekToolSchema(fieldTool.inputSchema);
    expect(converted).toHaveProperty('properties.patch.properties.nullable', {
        type: 'boolean',
        description: 'Default true unless primaryKey.',
    });
});
