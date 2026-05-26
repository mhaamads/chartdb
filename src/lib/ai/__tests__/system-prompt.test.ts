import { describe, it, expect } from 'vitest';
import { serializeSchemaCompact } from '@/lib/ai/system-prompt';
import { DatabaseType } from '@/lib/domain/database-type';
import type { DBTable } from '@/lib/domain/db-table';
import type { DBField } from '@/lib/domain/db-field';
import type { DBRelationship } from '@/lib/domain/db-relationship';

function field(over: Partial<DBField> & Pick<DBField, 'id' | 'name'>): DBField {
    return {
        type: { id: 'int', name: 'int' },
        primaryKey: false,
        unique: false,
        nullable: true,
        createdAt: 0,
        ...over,
    } as DBField;
}

function table(
    over: Partial<DBTable> & Pick<DBTable, 'id' | 'name' | 'fields'>
): DBTable {
    return {
        x: 0,
        y: 0,
        indexes: [],
        color: '#000',
        isView: false,
        createdAt: 0,
        ...over,
    } as DBTable;
}

const baseCtx = {
    databaseType: DatabaseType.POSTGRESQL,
    diagramName: 'Test',
    areas: [],
    notes: [],
};

describe('serializeSchemaCompact', () => {
    it('emits tables with pk + nullable flags', () => {
        const out = serializeSchemaCompact({
            ...baseCtx,
            tables: [
                table({
                    id: 't1',
                    name: 'users',
                    fields: [
                        field({
                            id: 'f1',
                            name: 'id',
                            primaryKey: true,
                            nullable: false,
                        }),
                        field({ id: 'f2', name: 'email', unique: true }),
                    ],
                }),
            ],
            relationships: [],
        });
        expect(out.counts.tables).toBe(1);
        expect(out.tables[0].fields?.[0].pk).toBe(true);
        expect(out.tables[0].fields?.[0].nullable).toBe(false);
        expect(out.tables[0].fields?.[1].unique).toBe(true);
    });

    it('attaches fk metadata to the many side', () => {
        const rel: DBRelationship = {
            id: 'r1',
            name: 'fk_orders_user',
            sourceTableId: 't_orders',
            sourceFieldId: 'f_user_id',
            targetTableId: 't_users',
            targetFieldId: 'f_id',
            sourceCardinality: 'many',
            targetCardinality: 'one',
            createdAt: 0,
        };
        const out = serializeSchemaCompact({
            ...baseCtx,
            tables: [
                table({
                    id: 't_users',
                    name: 'users',
                    fields: [
                        field({ id: 'f_id', name: 'id', primaryKey: true }),
                    ],
                }),
                table({
                    id: 't_orders',
                    name: 'orders',
                    fields: [
                        field({ id: 'f_id2', name: 'id', primaryKey: true }),
                        field({ id: 'f_user_id', name: 'user_id' }),
                    ],
                }),
            ],
            relationships: [rel],
        });
        const ordersFields = out.tables.find(
            (t) => t.id === 't_orders'
        )!.fields!;
        const fk = ordersFields.find((f) => f.id === 'f_user_id')!;
        expect(fk.fk).toEqual({ table: 't_users', field: 'f_id' });
        expect(out.relationships?.[0].cardinality).toBe('many-to-one');
    });

    it('omits relationships when includeRelationships=false', () => {
        const out = serializeSchemaCompact(
            {
                ...baseCtx,
                tables: [],
                relationships: [],
            },
            { includeRelationships: false }
        );
        expect(out.relationships).toBeUndefined();
    });
});
