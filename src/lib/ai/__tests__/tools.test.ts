import { describe, it, expect, vi } from 'vitest';
import { getTool } from '../tools';
import type { AIToolContext } from '../types';
import type { ChartDBContext } from '@/context/chartdb-context/chartdb-context';
import { DatabaseType } from '@/lib/domain/database-type';
import { DBCustomTypeKind } from '@/lib/domain/db-custom-type';
import type { DBTable } from '@/lib/domain/db-table';
import { defaultNoteColor } from '@/lib/colors';

function context(overrides: Partial<ChartDBContext> = {}): AIToolContext {
    return {
        diagramId: 'diagram',
        signal: new AbortController().signal,
        chartdb: {
            databaseType: DatabaseType.POSTGRESQL,
            customTypes: [],
            tables: [],
            relationships: [],
            areas: [],
            notes: [],
            ...overrides,
        } as ChartDBContext,
    };
}
const run = (name: string, args: unknown, ctx: AIToolContext) =>
    getTool(name)!.execute(args, ctx);

describe('AI tools', () => {
    it('validates the whole patch before any operation runs', async () => {
        const createTable = vi.fn();
        await expect(
            run(
                'apply_schema_patch',
                {
                    summary: 'create',
                    ops: [
                        { op: 'create_table', args: { name: 'users' } },
                        { op: 'create_table', args: {} },
                    ],
                },
                context({ createTable })
            )
        ).rejects.toThrow('Invalid arguments');
        expect(createTable).not.toHaveBeenCalled();
    });

    it('returns completed operation ids in partial failures and validates batch deletes', async () => {
        const createTable = vi.fn(async () => ({
            id: 'created',
            name: 'users',
            fields: [],
        })) as unknown as ChartDBContext['createTable'];
        const removeTable = vi.fn();
        await expect(
            run(
                'apply_schema_patch',
                {
                    summary: 'changes',
                    ops: [
                        { op: 'create_table', args: { name: 'users' } },
                        { op: 'remove_table', args: { tableId: 'missing' } },
                    ],
                },
                context({ createTable, getTable: () => null, removeTable })
            )
        ).rejects.toMatchObject({
            details: {
                applied: 1,
                failedIndex: 1,
                results: [
                    {
                        op: 'create_table',
                        ok: true,
                        result: { id: 'created', name: 'users', fields: [] },
                    },
                ],
            },
        });
        expect(removeTable).not.toHaveBeenCalled();
    });

    it('discovers custom types and accepts their ids', async () => {
        const createTable = vi.fn(async (attrs) => ({
            ...attrs,
            id: 'created',
        })) as unknown as ChartDBContext['createTable'];
        const ctx = context({
            createTable,
            customTypes: [
                {
                    id: 'enum-id',
                    name: 'status',
                    kind: DBCustomTypeKind.enum,
                    values: ['active'],
                },
            ],
        });
        expect(
            await run('list_data_types', { query: 'status' }, ctx)
        ).toMatchObject({ customTypes: [{ id: 'enum-id' }] });
        await run(
            'create_table',
            {
                name: 'users',
                fields: [
                    {
                        name: 'status',
                        type: 'enum-id',
                        primaryKey: true,
                        nullable: true,
                    },
                ],
            },
            ctx
        );
        expect(createTable).toHaveBeenCalledWith(
            expect.objectContaining({
                fields: [
                    expect.objectContaining({
                        type: { id: 'enum-id', name: 'status' },
                        nullable: false,
                    }),
                ],
            })
        );
        expect(vi.mocked(createTable).mock.calls[0][0]).not.toHaveProperty(
            'color'
        );
    });

    it('checks cancellation and write policy between batch operations', async () => {
        const assertCanWrite = vi
            .fn()
            .mockImplementationOnce(() => {})
            .mockImplementationOnce(() => {})
            .mockImplementation(() => {
                throw new Error('dry-run');
            });
        const createNote = vi.fn(async () => ({
            id: 'first',
        })) as unknown as ChartDBContext['createNote'];
        const ctx = { ...context({ createNote }), assertCanWrite };
        await expect(
            run(
                'apply_schema_patch',
                {
                    summary: 'notes',
                    ops: [
                        { op: 'add_note', args: { content: 'one' } },
                        { op: 'add_note', args: { content: 'two' } },
                    ],
                },
                ctx
            )
        ).rejects.toMatchObject({ details: { applied: 1 } });
        expect(createNote).toHaveBeenCalledTimes(1);
    });

    it('honours overview field and position flags', async () => {
        const ctx = context({
            tables: [
                {
                    id: 't',
                    name: 'users',
                    x: 12,
                    y: 34,
                    fields: [],
                    indexes: [],
                },
            ] as never,
        });
        expect(
            await run('get_schema_overview', { includePositions: true }, ctx)
        ).toMatchObject({ tables: [{ id: 't', x: 12, y: 34 }] });
        expect(
            (
                (await run('get_schema_overview', {}, ctx)) as {
                    tables: unknown[];
                }
            ).tables[0]
        ).not.toHaveProperty('fields');
    });
});

it('creates a complete relationship with one mutation', async () => {
    const addRelationship = vi.fn();
    const createRelationship = vi.fn();
    const updateRelationship = vi.fn();
    const getTable = vi.fn((id: string) => ({
        id,
        name: id,
        schema: 'public',
        fields: [{ id: `${id}-field`, name: 'id' }],
    })) as unknown as ChartDBContext['getTable'];
    await run(
        'create_relationship',
        {
            sourceTableId: 'source',
            sourceFieldId: 'source-field',
            targetTableId: 'target',
            targetFieldId: 'target-field',
            sourceCardinality: 'many',
            targetCardinality: 'one',
            name: 'fk',
        },
        context({
            getTable,
            addRelationship,
            createRelationship,
            updateRelationship,
        })
    );
    expect(addRelationship).toHaveBeenCalledWith(
        expect.objectContaining({
            name: 'fk',
            sourceCardinality: 'many',
            targetCardinality: 'one',
            sourceSchema: 'public',
            targetSchema: 'public',
        })
    );
    expect(createRelationship).not.toHaveBeenCalled();
    expect(updateRelationship).not.toHaveBeenCalled();
});

describe('database feature tools', () => {
    const table = {
        id: 'users',
        name: 'users',
        schema: 'public',
        x: 0,
        y: 0,
        color: '#ffffff',
        isView: false,
        createdAt: 0,
        fields: [
            {
                id: 'id',
                name: 'id',
                type: { id: 'uuid', name: 'uuid' },
                primaryKey: true,
                unique: false,
                nullable: false,
            },
            {
                id: 'email',
                name: 'email',
                type: { id: 'varchar', name: 'varchar' },
                primaryKey: false,
                unique: false,
                nullable: false,
            },
        ],
        indexes: [],
        checkConstraints: [],
    } as unknown as DBTable;

    it('creates and validates indexes against existing fields', async () => {
        const addIndex = vi.fn();
        const ctx = context({
            getTable: () => table,
            addIndex,
        });
        const result = await run(
            'create_index',
            {
                tableId: 'users',
                fieldIds: ['email'],
                unique: true,
            },
            ctx
        );
        expect(result).toMatchObject({
            name: expect.stringContaining('users'),
        });
        expect(addIndex).toHaveBeenCalledWith(
            'users',
            expect.objectContaining({
                fieldIds: ['email'],
                unique: true,
            })
        );
        await expect(
            run(
                'create_index',
                { tableId: 'users', fieldIds: ['missing'] },
                ctx
            )
        ).rejects.toThrow('unknown field');
        await expect(
            run(
                'create_index',
                { tableId: 'users', fieldIds: ['email'], type: 'gin' },
                ctx
            )
        ).rejects.toThrow('GIN indexes require');
    });

    it('creates check constraints and custom types', async () => {
        const addCheckConstraint = vi.fn();
        const createCustomType = vi.fn(async (attributes) => ({
            id: 'status-id',
            ...attributes,
        }));
        const ctx = context({
            getTable: () => table,
            addCheckConstraint,
            createCustomType,
        });
        await run(
            'create_check_constraint',
            { tableId: 'users', expression: "email <> ''" },
            ctx
        );
        expect(addCheckConstraint).toHaveBeenCalledWith(
            'users',
            expect.objectContaining({ expression: "email <> ''" })
        );
        await expect(
            run(
                'create_check_constraint',
                { tableId: 'users', expression: 'email >' },
                ctx
            )
        ).rejects.toThrow('Invalid check constraint expression');
        await expect(
            run(
                'create_custom_type',
                {
                    name: 'status',
                    kind: 'enum',
                    values: ['active', 'disabled'],
                },
                ctx
            )
        ).resolves.toMatchObject({ id: 'status-id', name: 'status' });
        expect(createCustomType).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: 'enum',
                values: ['active', 'disabled'],
            })
        );
    });

    it('refuses removing a custom type still used by a field', async () => {
        const removeCustomType = vi.fn();
        const used = {
            ...table,
            fields: [
                {
                    id: 'id',
                    name: 'id',
                    type: { id: 'status-id', name: 'status' },
                    primaryKey: true,
                    unique: false,
                    nullable: false,
                },
            ],
        } as unknown as DBTable;
        await expect(
            run(
                'remove_custom_type',
                { customTypeId: 'status-id' },
                context({
                    tables: [used],
                    customTypes: [
                        { id: 'status-id', name: 'status', kind: 'enum' },
                    ] as never,
                    removeCustomType,
                })
            )
        ).rejects.toThrow('it is used');
        expect(removeCustomType).not.toHaveBeenCalled();
    });

    it('lists module areas and groups tables into titled colored areas', async () => {
        const area = {
            id: 'identity-area',
            name: 'Identity',
            x: 10,
            y: 20,
            width: 400,
            height: 300,
            color: '#8eb7ff',
        };
        expect(
            await run(
                'list_areas',
                {},
                context({
                    areas: [area],
                    tables: [{ ...table, parentAreaId: area.id }],
                })
            )
        ).toEqual([
            expect.objectContaining({
                id: area.id,
                name: 'Identity',
                tableIds: ['users'],
            }),
        ]);

        const addAreas = vi.fn();
        const updateTablesState = vi.fn(
            async (
                updateFn: (tables: DBTable[]) => PartialExcept<DBTable, 'id'>[]
            ) => {
                expect(updateFn([table])[0]).toMatchObject({
                    parentAreaId: expect.any(String),
                    x: expect.any(Number),
                    y: expect.any(Number),
                });
            }
        ) as unknown as ChartDBContext['updateTablesState'];
        const result = await run(
            'group_tables_by_module',
            {
                modules: [
                    {
                        name: 'Identity',
                        tableIds: ['users'],
                        color: '#8eb7ff',
                    },
                ],
            },
            context({
                getTable: () => table,
                tables: [table],
                addAreas,
                updateTablesState,
            })
        );
        expect(result).toMatchObject({
            tableCount: 1,
            modules: [
                expect.objectContaining({
                    name: 'Identity',
                    color: '#8eb7ff',
                    tableIds: ['users'],
                }),
            ],
        });
        expect(addAreas).toHaveBeenCalledWith([
            expect.objectContaining({ name: 'Identity', color: '#8eb7ff' }),
        ]);
    });

    it('rejects assigning one table to multiple modules before mutation', async () => {
        const addAreas = vi.fn();
        await expect(
            run(
                'group_tables_by_module',
                {
                    modules: [
                        { name: 'Identity', tableIds: ['users'] },
                        { name: 'Accounts', tableIds: ['users'] },
                    ],
                },
                context({ getTable: () => table, addAreas })
            )
        ).rejects.toThrow('more than one module');
        expect(addAreas).not.toHaveBeenCalled();
    });

    it('adds context-generated notes for areas and tables in one batch', async () => {
        const area = {
            id: 'identity-area',
            name: 'Identity',
            x: 10,
            y: 20,
            width: 400,
            height: 300,
            color: '#8eb7ff',
        };
        const addNotes = vi.fn();
        const tableInArea = { ...table, parentAreaId: area.id };
        const ctx = context({
            areas: [area],
            tables: [tableInArea],
            getTable: () => tableInArea,
            addNotes,
        });
        const result = await run(
            'add_context_notes',
            {
                context: 'Owns sign-in and session data.',
                placement: 'next_to',
                notes: [
                    { areaId: area.id },
                    { tableId: table.id, content: '## Users\n\nAccount data.' },
                ],
            },
            ctx
        );

        expect(result).toMatchObject({ count: 2 });
        expect(addNotes).toHaveBeenCalledWith([
            expect.objectContaining({
                content: expect.stringContaining('Owns sign-in'),
                color: area.color,
            }),
            expect.objectContaining({
                content: '## Users\n\nAccount data.',
                color: area.color,
            }),
        ]);
        expect(addNotes.mock.calls[0][0][0]).toMatchObject({
            x: expect.any(Number),
            y: expect.any(Number),
            width: 200,
            height: 150,
        });
    });

    it('uses the shared note palette for the legacy add_note fallback', async () => {
        const createNote = vi.fn(async (attributes) => ({
            id: 'note',
            ...attributes,
        })) as unknown as ChartDBContext['createNote'];
        await run(
            'add_note',
            { content: 'Legacy note' },
            context({ createNote })
        );
        expect(createNote).toHaveBeenCalledWith(
            expect.objectContaining({ color: defaultNoteColor })
        );
    });

    it('rejects context notes without exactly one target before mutation', async () => {
        const addNotes = vi.fn();
        await expect(
            run(
                'add_context_notes',
                {
                    notes: [{ content: 'orphan note' }],
                },
                context({ addNotes })
            )
        ).rejects.toThrow('exactly one area or table');
        expect(addNotes).not.toHaveBeenCalled();
    });
});
