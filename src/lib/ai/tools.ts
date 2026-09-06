/**
 * Tool catalog — the AI's hands inside the editor.
 *
 * Each tool:
 *   - has a stable name (snake_case) referenced in the system prompt;
 *   - declares its input schema via Zod (validated before execute());
 *   - exposes a JSON Schema (sent to the provider as `input_schema`);
 *   - returns plain JSON-serializable values fed back to the model as
 *     `tool_result` content blocks.
 *
 * The registry is built lazily so we don't pull the schemas/json-schema
 * helpers into the bundle until the assistant is actually opened.
 */

import type {
    AIToolContext,
    AIToolDefinition,
    AIToolJSONSchema,
} from './types';
import { zodToToolSchema } from './json-schema';
import {
    addAreaArgs,
    addFieldArgs,
    addNoteArgs,
    applySchemaPatchArgs,
    createCheckConstraintArgs,
    createCustomTypeArgs,
    createIndexArgs,
    createRelationshipArgs,
    createTableArgs,
    findTablesByNameArgs,
    getSchemaOverviewArgs,
    getTableArgs,
    removeCheckConstraintArgs,
    removeCustomTypeArgs,
    removeFieldArgs,
    removeIndexArgs,
    removeRelationshipArgs,
    removeTableArgs,
    updateCheckConstraintArgs,
    updateCustomTypeArgs,
    updateFieldArgs,
    updateIndexArgs,
    updateTableArgs,
    type FieldInput,
    type PatchOp,
} from './schemas';
import { serializeSchemaCompact } from './system-prompt';
import { z, type ZodTypeAny } from 'zod';
import { generateId } from '@/lib/utils/utils';
import type { DBField } from '@/lib/domain/db-field';
import type { DBTable } from '@/lib/domain/db-table';
import { dataTypeMap } from '@/lib/data/data-types/data-types';
import type { DataType } from '@/lib/data/data-types/data-types';
import type { DBRelationship } from '@/lib/domain/db-relationship';
import type { DBIndex } from '@/lib/domain/db-index';
import {
    canFieldsUseGinIndex,
    databaseIndexTypes,
} from '@/lib/domain/db-index';
import type { DBCheckConstraint } from '@/lib/domain/db-check-constraint';
import type { DBCustomType } from '@/lib/domain/db-custom-type';
import { validateCheckConstraintWithDetails } from '@/lib/check-constraints/check-constraints-validator';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class ToolError extends Error {
    constructor(
        message: string,
        public hint?: string,
        public details?: unknown
    ) {
        super(message);
        this.name = 'ToolError';
    }
}

function fail(message: string, hint?: string): never {
    throw new ToolError(message, hint);
}

function resolveTable(ctx: AIToolContext, id: string): DBTable {
    const t = ctx.chartdb.getTable(id);
    if (!t) {
        fail(
            `No table with id "${id}".`,
            'Call get_schema_overview to find current table ids.'
        );
    }
    return t;
}

function resolveDataType(ctx: AIToolContext, typeId: string): DataType {
    const lookup = [
        ...dataTypeMap[ctx.chartdb.databaseType],
        ...ctx.chartdb.customTypes.map((t) => ({ id: t.id, name: t.name })),
    ];
    const match = lookup.find(
        (t) =>
            t.id.toLowerCase() === typeId.trim().toLowerCase() ||
            t.name.toLowerCase() === typeId.trim().toLowerCase()
    );
    if (!match) {
        const sample = lookup
            .slice(0, 8)
            .map((t) => t.id)
            .join(', ');
        fail(
            `Unknown data type "${typeId}" for ${ctx.chartdb.databaseType}.`,
            `Call list_data_types for valid ids, including custom types. Examples: ${sample}.`
        );
    }
    return { id: match.id, name: match.name };
}

function buildDBField(ctx: AIToolContext, input: FieldInput): DBField {
    const dataType = resolveDataType(ctx, input.type);
    const isPk = input.primaryKey ?? false;
    return {
        id: generateId(),
        name: input.name,
        type: dataType,
        primaryKey: isPk,
        unique: input.unique ?? false,
        nullable: isPk ? false : (input.nullable ?? true),
        increment: input.increment ?? null,
        isArray: input.isArray ?? null,
        createdAt: Date.now(),
        characterMaximumLength: input.characterMaximumLength ?? null,
        precision: input.precision ?? null,
        scale: input.scale ?? null,
        default: input.default ?? null,
        comments: input.comments ?? null,
    };
}

async function maybeApproveDestructive(
    ctx: AIToolContext,
    toolName: string,
    args: unknown,
    summary: string
): Promise<void> {
    if (!ctx.requestApproval) return;
    const ok = await ctx.requestApproval({ toolName, args, summary });
    ctx.signal.throwIfAborted();
    if (!ok) {
        fail(
            'User declined the destructive operation.',
            'Propose a non-destructive alternative or stop.'
        );
    }
}

// ---------------------------------------------------------------------------
// Generic validator wrapper
// ---------------------------------------------------------------------------

function defineTool<S extends ZodTypeAny>(
    name: string,
    description: string,
    schema: S,
    options: { destructive?: boolean; readOnly?: boolean },
    execute: (
        args: ReturnType<S['parse']>,
        ctx: AIToolContext
    ) => Promise<unknown>
): AIToolDefinition {
    const parseArgs = (rawArgs: unknown) => {
        const parsed = schema.safeParse(rawArgs);
        if (!parsed.success) {
            throw new ToolError(
                `Invalid arguments for ${name}: ${parsed.error.message}`,
                'Check the tool input_schema and resend with corrected args.'
            );
        }
        return parsed.data as ReturnType<S['parse']>;
    };
    let cachedSchema: AIToolJSONSchema | null = null;
    return {
        name,
        description,
        validateArgs: (rawArgs) => {
            parseArgs(rawArgs);
        },
        destructive: options.destructive,
        readOnly: options.readOnly ?? false,
        get inputSchema() {
            cachedSchema ??= zodToToolSchema(schema);
            return cachedSchema;
        },
        execute: async (rawArgs, ctx) => {
            ctx.signal.throwIfAborted();
            if (!options.readOnly) {
                ctx.assertCanWrite?.();
                if (ctx.chartdb.readonly) fail('This diagram is read-only.');
            }
            return execute(parseArgs(rawArgs), ctx);
        },
    };
}

// ---------------------------------------------------------------------------
// READ TOOLS
// ---------------------------------------------------------------------------

const getSchemaOverviewTool = defineTool(
    'get_schema_overview',
    'Returns a compact JSON view of the diagram (tables, fields, relationships). Call this before making changes.',
    getSchemaOverviewArgs,
    { readOnly: true },
    async (args, ctx) => {
        return serializeSchemaCompact(ctx.chartdb, {
            includeFields: args.includeFields ?? false,
            includePositions: args.includePositions ?? false,
            includeRelationships: args.includeRelationships ?? true,
        });
    }
);

const getTableTool = defineTool(
    'get_table',
    'Returns full details for one table including all field properties.',
    getTableArgs,
    { readOnly: true },
    async (args, ctx) => {
        const t = resolveTable(ctx, args.tableId);
        return {
            id: t.id,
            name: t.name,
            schema: t.schema ?? null,
            comments: t.comments ?? null,
            isView: t.isView,
            position: { x: t.x, y: t.y },
            color: t.color,
            fields: t.fields,
            indexes: t.indexes,
            checkConstraints: t.checkConstraints ?? [],
        };
    }
);

const findTablesByNameTool = defineTool(
    'find_tables_by_name',
    'Search tables by case-insensitive name substring. Use when the user refers to a table by name.',
    findTablesByNameArgs,
    { readOnly: true },
    async (args, ctx) => {
        const q = args.query.toLowerCase();
        return ctx.chartdb.tables
            .filter((t) => t.name.toLowerCase().includes(q))
            .map((t) => ({ id: t.id, name: t.name, schema: t.schema ?? null }));
    }
);

const listDataTypesTool = defineTool(
    'list_data_types',
    'List valid data type ids and names for this database, including existing custom types. Use before creating or changing columns when unsure of a type.',
    z.object({
        query: z
            .string()
            .optional()
            .describe('Optional case-insensitive name substring.'),
    }),
    { readOnly: true },
    async (args, ctx) => {
        const query = (args.query ?? '').toLowerCase();
        return {
            databaseType: ctx.chartdb.databaseType,
            types: dataTypeMap[ctx.chartdb.databaseType]
                .filter(
                    (t) =>
                        t.name.toLowerCase().includes(query) ||
                        t.id.toLowerCase().includes(query)
                )
                .map(({ id, name }) => ({ id, name })),
            customTypes: ctx.chartdb.customTypes.filter((t) =>
                t.name.toLowerCase().includes(query)
            ),
        };
    }
);

// ---------------------------------------------------------------------------
// WRITE TOOLS
// ---------------------------------------------------------------------------

async function executeCreateTable(
    args: ReturnType<typeof createTableArgs.parse>,
    ctx: AIToolContext
): Promise<{
    id: string;
    name: string;
    fields: { id: string; name: string }[];
}> {
    const fields = (args.fields ?? []).map((f) => buildDBField(ctx, f));
    const created = await ctx.chartdb.createTable({
        name: args.name,
        schema: args.schema ?? null,
        comments: args.comments ?? null,
        ...(args.color ? { color: args.color } : {}),
        x: args.position?.x ?? 0,
        y: args.position?.y ?? 0,
        isView: args.isView ?? false,
        fields,
        indexes: [],
    });
    ctx.emitProgress?.(`Created table "${created.name}".`);
    return {
        id: created.id,
        name: created.name,
        fields: created.fields.map((f) => ({ id: f.id, name: f.name })),
    };
}

const createTableTool = defineTool(
    'create_table',
    'Create a new table with optional initial columns.',
    createTableArgs,
    {},
    executeCreateTable
);

async function executeUpdateTable(
    args: ReturnType<typeof updateTableArgs.parse>,
    ctx: AIToolContext
): Promise<{ ok: true }> {
    resolveTable(ctx, args.tableId);
    const patch: Partial<DBTable> = {};
    if (args.name !== undefined) patch.name = args.name;
    if (args.schema !== undefined) patch.schema = args.schema;
    if (args.comments !== undefined) patch.comments = args.comments;
    if (args.color !== undefined) patch.color = args.color;
    if (args.position?.x !== undefined) patch.x = args.position.x;
    if (args.position?.y !== undefined) patch.y = args.position.y;
    await ctx.chartdb.updateTable(args.tableId, patch);
    ctx.emitProgress?.('Updated table.');
    return { ok: true };
}

const updateTableTool = defineTool(
    'update_table',
    'Update top-level properties of a table (name, schema, color, position, comments).',
    updateTableArgs,
    {},
    executeUpdateTable
);

async function executeAddField(
    args: ReturnType<typeof addFieldArgs.parse>,
    ctx: AIToolContext
): Promise<{ id: string; name: string }> {
    resolveTable(ctx, args.tableId);
    const field = buildDBField(ctx, args.field);
    await ctx.chartdb.addField(args.tableId, field);
    ctx.emitProgress?.(`Added field "${field.name}".`);
    return { id: field.id, name: field.name };
}

const addFieldTool = defineTool(
    'add_field',
    'Append a column to an existing table.',
    addFieldArgs,
    {},
    executeAddField
);

async function executeUpdateField(
    args: ReturnType<typeof updateFieldArgs.parse>,
    ctx: AIToolContext
): Promise<{ ok: true }> {
    const existing = ctx.chartdb.getField(args.tableId, args.fieldId);
    if (!existing) {
        fail(`No field "${args.fieldId}" on table "${args.tableId}".`);
    }
    const patch: Partial<DBField> = {};
    const p = args.patch;
    if (p.name !== undefined) patch.name = p.name;
    if (p.type !== undefined) patch.type = resolveDataType(ctx, p.type);
    if (p.primaryKey !== undefined) patch.primaryKey = p.primaryKey;
    if (p.unique !== undefined) patch.unique = p.unique;
    if (p.nullable !== undefined) patch.nullable = p.nullable;
    if (p.increment !== undefined) patch.increment = p.increment;
    if (p.isArray !== undefined) patch.isArray = p.isArray;
    if (p.characterMaximumLength !== undefined)
        patch.characterMaximumLength = p.characterMaximumLength;
    if (p.precision !== undefined) patch.precision = p.precision;
    if (p.scale !== undefined) patch.scale = p.scale;
    if (p.default !== undefined) patch.default = p.default;
    if (p.comments !== undefined) patch.comments = p.comments;
    if (patch.primaryKey ?? existing.primaryKey) patch.nullable = false;
    await ctx.chartdb.updateField(args.tableId, args.fieldId, patch);
    ctx.emitProgress?.('Updated field.');
    return { ok: true };
}

const updateFieldTool = defineTool(
    'update_field',
    'Modify properties of an existing column.',
    updateFieldArgs,
    {},
    executeUpdateField
);

async function executeCreateRelationship(
    args: ReturnType<typeof createRelationshipArgs.parse>,
    ctx: AIToolContext
): Promise<{ id: string; name: string }> {
    const sourceTable = resolveTable(ctx, args.sourceTableId);
    const targetTable = resolveTable(ctx, args.targetTableId);
    if (!sourceTable.fields.find((f) => f.id === args.sourceFieldId)) {
        fail(
            `Field "${args.sourceFieldId}" not found on table "${sourceTable.name}".`
        );
    }
    if (!targetTable.fields.find((f) => f.id === args.targetFieldId)) {
        fail(
            `Field "${args.targetFieldId}" not found on table "${targetTable.name}".`
        );
    }
    const created: DBRelationship = {
        id: generateId(),
        name:
            args.name ??
            `${sourceTable.name}_${sourceTable.fields.find((f) => f.id === args.sourceFieldId)!.name}_fk`,
        sourceSchema: sourceTable.schema,
        targetSchema: targetTable.schema,
        sourceTableId: args.sourceTableId,
        sourceFieldId: args.sourceFieldId,
        targetTableId: args.targetTableId,
        targetFieldId: args.targetFieldId,
        sourceCardinality: args.sourceCardinality,
        targetCardinality: args.targetCardinality,
        createdAt: Date.now(),
    };
    await ctx.chartdb.addRelationship(created);
    ctx.emitProgress?.('Created relationship.');
    return { id: created.id, name: args.name ?? created.name };
}

const createRelationshipTool = defineTool(
    'create_relationship',
    'Create a foreign-key relationship between two existing columns. Specify cardinality on both sides.',
    createRelationshipArgs,
    {},
    executeCreateRelationship
);

async function executeAddNote(
    args: ReturnType<typeof addNoteArgs.parse>,
    ctx: AIToolContext
): Promise<{ id: string }> {
    const created = await ctx.chartdb.createNote({
        content: args.content,
        x: args.position?.x ?? 0,
        y: args.position?.y ?? 0,
        color: args.color ?? '#fef08a',
    });
    ctx.emitProgress?.('Added note.');
    return { id: created.id };
}

const addNoteTool = defineTool(
    'add_note',
    'Add a sticky note to the canvas.',
    addNoteArgs,
    {},
    executeAddNote
);

async function executeAddArea(
    args: ReturnType<typeof addAreaArgs.parse>,
    ctx: AIToolContext
): Promise<{ id: string }> {
    const created = await ctx.chartdb.createArea({
        name: args.name,
        x: args.position?.x ?? 0,
        y: args.position?.y ?? 0,
        width: args.width ?? 400,
        height: args.height ?? 300,
        color: args.color ?? '#e0e7ff',
    });
    ctx.emitProgress?.(`Added area "${args.name}".`);
    return { id: created.id };
}

const addAreaTool = defineTool(
    'add_area',
    'Group tables visually by drawing a labelled rectangular area.',
    addAreaArgs,
    {},
    executeAddArea
);

// ---------------------------------------------------------------------------
// DATABASE FEATURES
// ---------------------------------------------------------------------------

function resolveIndex(
    ctx: AIToolContext,
    tableId: string,
    indexId: string
): DBIndex {
    const table = resolveTable(ctx, tableId);
    const index = table.indexes.find((item) => item.id === indexId);
    if (!index) fail(`No index "${indexId}" on table "${table.name}".`);
    return index;
}

function resolveCheckConstraint(
    ctx: AIToolContext,
    tableId: string,
    constraintId: string
): DBCheckConstraint {
    const table = resolveTable(ctx, tableId);
    const constraint = table.checkConstraints?.find(
        (item) => item.id === constraintId
    );
    if (!constraint)
        fail(`No check constraint "${constraintId}" on table "${table.name}".`);
    return constraint;
}

function resolveCustomType(ctx: AIToolContext, id: string): DBCustomType {
    const customType =
        ctx.chartdb.customTypes.find((type) => type.id === id) ??
        ctx.chartdb.getCustomType?.(id);
    if (!customType) {
        fail(
            `No custom type with id "${id}".`,
            'Call list_data_types to find current custom type ids.'
        );
    }
    return customType;
}

function validateIndexFields(table: DBTable, fieldIds: string[]): void {
    if (new Set(fieldIds).size !== fieldIds.length) {
        fail('An index cannot contain the same field more than once.');
    }
    const fields = new Set(table.fields.map((field) => field.id));
    const missing = fieldIds.filter((id) => !fields.has(id));
    if (missing.length > 0) {
        fail(
            `Index references unknown field id(s): ${missing.join(', ')}.`,
            `Call get_table for "${table.name}" and use its field ids.`
        );
    }
}

function validateIndexType(
    ctx: AIToolContext,
    table: DBTable,
    fieldIds: string[],
    type: DBIndex['type']
): void {
    if (!type) return;
    const supported = databaseIndexTypes[ctx.chartdb.databaseType];
    if (supported && !supported.includes(type)) {
        fail(
            `Index type "${type}" is not supported for ${ctx.chartdb.databaseType}.`,
            'Omit type to use the database default or call get_schema_overview for the current dialect.'
        );
    }
    if (type === 'gin') {
        const fields = table.fields.filter((field) =>
            fieldIds.includes(field.id)
        );
        if (!canFieldsUseGinIndex(fields)) {
            fail(
                'GIN indexes require array, json, jsonb, tsvector, or hstore fields.'
            );
        }
    }
}

function validateCheckExpression(expression: string): string {
    const trimmed = expression.trim();
    const result = validateCheckConstraintWithDetails(trimmed);
    if (!result.isValid) {
        fail(
            `Invalid check constraint expression: ${result.error ?? 'syntax error'}.`,
            'Provide a complete SQL boolean expression without the CHECK keyword.'
        );
    }
    return trimmed;
}

async function executeCreateIndex(
    args: ReturnType<typeof createIndexArgs.parse>,
    ctx: AIToolContext
): Promise<{ id: string; name: string }> {
    const table = resolveTable(ctx, args.tableId);
    validateIndexFields(table, args.fieldIds);
    validateIndexType(ctx, table, args.fieldIds, args.type);
    const index: DBIndex = {
        id: generateId(),
        name: args.name ?? `index_${table.name}_${args.fieldIds.join('_')}`,
        fieldIds: args.fieldIds,
        unique: args.isPrimaryKey ? true : (args.unique ?? false),
        createdAt: Date.now(),
        type: args.type ?? null,
        isPrimaryKey: args.isPrimaryKey ?? false,
        comments: args.comments ?? null,
    };
    await ctx.chartdb.addIndex(args.tableId, index);
    ctx.emitProgress?.(`Created index "${index.name}".`);
    return { id: index.id, name: index.name };
}

const createIndexTool = defineTool(
    'create_index',
    'Create an index on one or more existing fields.',
    createIndexArgs,
    {},
    executeCreateIndex
);

async function executeUpdateIndex(
    args: ReturnType<typeof updateIndexArgs.parse>,
    ctx: AIToolContext
): Promise<{ ok: true }> {
    const table = resolveTable(ctx, args.tableId);
    const current = resolveIndex(ctx, args.tableId, args.indexId);
    const patch: Partial<DBIndex> = {};
    const value = args.patch;
    if (value.name !== undefined) patch.name = value.name;
    if (value.fieldIds !== undefined) {
        validateIndexFields(table, value.fieldIds);
        patch.fieldIds = value.fieldIds;
    }
    if (value.unique !== undefined) patch.unique = value.unique;
    if (value.type !== undefined) patch.type = value.type;
    validateIndexType(
        ctx,
        table,
        value.fieldIds ?? current.fieldIds,
        value.type !== undefined ? value.type : current.type
    );
    if (value.isPrimaryKey !== undefined) {
        patch.isPrimaryKey = value.isPrimaryKey;
        if (value.isPrimaryKey) patch.unique = true;
    }
    if (value.comments !== undefined) patch.comments = value.comments;
    if (Object.keys(patch).length === 0) fail('Index update is empty.');
    await ctx.chartdb.updateIndex(args.tableId, current.id, patch);
    ctx.emitProgress?.(`Updated index "${current.name}".`);
    return { ok: true };
}

const updateIndexTool = defineTool(
    'update_index',
    'Update an existing index name, fields, uniqueness, method, or comments.',
    updateIndexArgs,
    {},
    executeUpdateIndex
);

const removeIndexTool = defineTool(
    'remove_index',
    'Delete an index. Destructive.',
    removeIndexArgs,
    { destructive: true },
    async (args, ctx) => {
        const index = resolveIndex(ctx, args.tableId, args.indexId);
        await maybeApproveDestructive(
            ctx,
            'remove_index',
            args,
            `Delete index "${index.name}".`
        );
        await ctx.chartdb.removeIndex(args.tableId, args.indexId);
        ctx.emitProgress?.(`Removed index "${index.name}".`);
        return { ok: true };
    }
);

async function executeCreateCheckConstraint(
    args: ReturnType<typeof createCheckConstraintArgs.parse>,
    ctx: AIToolContext
): Promise<{ id: string }> {
    resolveTable(ctx, args.tableId);
    const constraint: DBCheckConstraint = {
        id: generateId(),
        expression: validateCheckExpression(args.expression),
        createdAt: Date.now(),
    };
    await ctx.chartdb.addCheckConstraint(args.tableId, constraint);
    ctx.emitProgress?.('Created check constraint.');
    return { id: constraint.id };
}

const createCheckConstraintTool = defineTool(
    'create_check_constraint',
    'Add a SQL check constraint to an existing table.',
    createCheckConstraintArgs,
    {},
    executeCreateCheckConstraint
);

async function executeUpdateCheckConstraint(
    args: ReturnType<typeof updateCheckConstraintArgs.parse>,
    ctx: AIToolContext
): Promise<{ ok: true }> {
    const current = resolveCheckConstraint(
        ctx,
        args.tableId,
        args.constraintId
    );
    const patch: Partial<DBCheckConstraint> = {};
    if (args.patch.expression !== undefined) {
        patch.expression = validateCheckExpression(args.patch.expression);
    }
    if (Object.keys(patch).length === 0) fail('Constraint update is empty.');
    await ctx.chartdb.updateCheckConstraint(args.tableId, current.id, patch);
    ctx.emitProgress?.('Updated check constraint.');
    return { ok: true };
}

const updateCheckConstraintTool = defineTool(
    'update_check_constraint',
    'Update an existing check constraint expression.',
    updateCheckConstraintArgs,
    {},
    executeUpdateCheckConstraint
);

const removeCheckConstraintTool = defineTool(
    'remove_check_constraint',
    'Delete a check constraint. Destructive.',
    removeCheckConstraintArgs,
    { destructive: true },
    async (args, ctx) => {
        resolveCheckConstraint(ctx, args.tableId, args.constraintId);
        await maybeApproveDestructive(
            ctx,
            'remove_check_constraint',
            args,
            'Delete a check constraint.'
        );
        await ctx.chartdb.removeCheckConstraint(
            args.tableId,
            args.constraintId
        );
        ctx.emitProgress?.('Removed check constraint.');
        return { ok: true };
    }
);

async function executeCreateCustomType(
    args: ReturnType<typeof createCustomTypeArgs.parse>,
    ctx: AIToolContext
): Promise<{ id: string; name: string; kind: string }> {
    const customType = await ctx.chartdb.createCustomType({
        name: args.name,
        schema: args.schema ?? null,
        kind: args.kind,
        values: args.values ?? null,
        fields: args.fields ?? null,
        order: args.order ?? null,
    });
    ctx.emitProgress?.(`Created custom type "${customType.name}".`);
    return {
        id: customType.id,
        name: customType.name,
        kind: customType.kind,
    };
}

const createCustomTypeTool = defineTool(
    'create_custom_type',
    'Create an enum or composite custom database type.',
    createCustomTypeArgs,
    {},
    executeCreateCustomType
);

const updateCustomTypeTool = defineTool(
    'update_custom_type',
    'Update an existing custom database type.',
    updateCustomTypeArgs,
    {},
    async (args, ctx) => {
        const current = resolveCustomType(ctx, args.customTypeId);
        await ctx.chartdb.updateCustomType(args.customTypeId, args.patch);
        ctx.emitProgress?.(`Updated custom type "${current.name}".`);
        return { ok: true };
    }
);

const removeCustomTypeTool = defineTool(
    'remove_custom_type',
    'Delete a custom database type. Destructive.',
    removeCustomTypeArgs,
    { destructive: true },
    async (args, ctx) => {
        const customType = resolveCustomType(ctx, args.customTypeId);
        const usage = ctx.chartdb.tables.flatMap((table) =>
            table.fields
                .filter(
                    (field) =>
                        field.type.id === customType.id ||
                        field.type.name === customType.name
                )
                .map((field) => `${table.name}.${field.name}`)
        );
        if (usage.length > 0) {
            fail(
                `Cannot remove custom type "${customType.name}"; it is used by ${usage.join(', ')}.`,
                'Update or remove those fields first.'
            );
        }
        await maybeApproveDestructive(
            ctx,
            'remove_custom_type',
            args,
            `Delete custom type "${customType.name}".`
        );
        await ctx.chartdb.removeCustomType(args.customTypeId);
        ctx.emitProgress?.(`Removed custom type "${customType.name}".`);
        return { ok: true };
    }
);

// ---------------------------------------------------------------------------
// DESTRUCTIVE TOOLS
// ---------------------------------------------------------------------------

const removeTableTool = defineTool(
    'remove_table',
    'Permanently delete a table and its fields. Destructive.',
    removeTableArgs,
    { destructive: true },
    async (args, ctx) => {
        const t = resolveTable(ctx, args.tableId);
        await maybeApproveDestructive(
            ctx,
            'remove_table',
            args,
            `Delete table "${t.name}" (${t.fields.length} fields).`
        );
        await ctx.chartdb.removeTable(args.tableId);
        ctx.emitProgress?.(`Removed table "${t.name}".`);
        return { ok: true };
    }
);

const removeFieldTool = defineTool(
    'remove_field',
    'Permanently delete a column. Destructive.',
    removeFieldArgs,
    { destructive: true },
    async (args, ctx) => {
        const t = resolveTable(ctx, args.tableId);
        const f = t.fields.find((x) => x.id === args.fieldId);
        if (!f) fail(`No field "${args.fieldId}" on "${t.name}".`);
        await maybeApproveDestructive(
            ctx,
            'remove_field',
            args,
            `Delete field "${f.name}" from "${t.name}".`
        );
        await ctx.chartdb.removeField(args.tableId, args.fieldId);
        ctx.emitProgress?.(`Removed field "${f.name}".`);
        return { ok: true };
    }
);

const removeRelationshipTool = defineTool(
    'remove_relationship',
    'Delete a foreign-key relationship. Destructive.',
    removeRelationshipArgs,
    { destructive: true },
    async (args, ctx) => {
        const r = ctx.chartdb.getRelationship(args.relationshipId);
        if (!r) fail(`No relationship "${args.relationshipId}".`);
        await maybeApproveDestructive(
            ctx,
            'remove_relationship',
            args,
            `Delete relationship "${r.name}".`
        );
        await ctx.chartdb.removeRelationship(args.relationshipId);
        ctx.emitProgress?.('Removed relationship.');
        return { ok: true };
    }
);

// ---------------------------------------------------------------------------
// AGGREGATE: apply_schema_patch
// ---------------------------------------------------------------------------

const PATCH_DISPATCH = {
    create_table: { args: createTableArgs, exec: executeCreateTable },
    update_table: { args: updateTableArgs, exec: executeUpdateTable },
    add_field: { args: addFieldArgs, exec: executeAddField },
    update_field: { args: updateFieldArgs, exec: executeUpdateField },
    create_relationship: {
        args: createRelationshipArgs,
        exec: executeCreateRelationship,
    },
    remove_table: { args: removeTableArgs, exec: removeTableTool.execute },
    remove_field: { args: removeFieldArgs, exec: removeFieldTool.execute },
    remove_relationship: {
        args: removeRelationshipArgs,
        exec: removeRelationshipTool.execute,
    },
    add_note: { args: addNoteArgs, exec: executeAddNote },
    add_area: { args: addAreaArgs, exec: executeAddArea },
    create_index: { args: createIndexArgs, exec: executeCreateIndex },
    update_index: { args: updateIndexArgs, exec: executeUpdateIndex },
    remove_index: { args: removeIndexArgs, exec: removeIndexTool.execute },
    create_check_constraint: {
        args: createCheckConstraintArgs,
        exec: executeCreateCheckConstraint,
    },
    update_check_constraint: {
        args: updateCheckConstraintArgs,
        exec: executeUpdateCheckConstraint,
    },
    remove_check_constraint: {
        args: removeCheckConstraintArgs,
        exec: removeCheckConstraintTool.execute,
    },
    create_custom_type: {
        args: createCustomTypeArgs,
        exec: executeCreateCustomType,
    },
    update_custom_type: {
        args: updateCustomTypeArgs,
        exec: updateCustomTypeTool.execute,
    },
    remove_custom_type: {
        args: removeCustomTypeArgs,
        exec: removeCustomTypeTool.execute,
    },
} as const;

const applySchemaPatchTool = defineTool(
    'apply_schema_patch',
    'Apply a batch of related schema operations as a single approvable unit. Use only when all referenced ids already exist. Runs sequentially, stops on failure, and does not roll back earlier operations.',
    applySchemaPatchArgs,
    { destructive: true /* approval gated based on contents */ },
    async (args, ctx) => {
        const ops = args.ops as PatchOp[];
        const destructiveOps = ops.filter((o) => o.op.startsWith('remove_'));
        if (destructiveOps.length > 0) {
            await maybeApproveDestructive(
                ctx,
                'apply_schema_patch',
                args,
                `${args.summary} (${ops.length} ops, ${destructiveOps.length} destructive)`
            );
        }
        const results: unknown[] = [];
        for (let i = 0; i < ops.length; i++) {
            if (ctx.signal.aborted) {
                throw new ToolError(
                    'Patch aborted by user.',
                    'Earlier operations remain applied. Inspect the diagram before continuing.',
                    { applied: results.length, results, failedIndex: i }
                );
            }
            const op = ops[i];
            const dispatch = PATCH_DISPATCH[op.op];
            const parsed = dispatch.args.safeParse(op.args);
            if (!parsed.success) {
                throw new ToolError(
                    `apply_schema_patch op #${i} (${op.op}) has invalid args: ${parsed.error.message}`,
                    'Fix the args and resend the entire patch.'
                );
            }
            try {
                // Disambiguate dispatch — each entry's exec is typed against
                // its own zod schema; the safeParse above guarantees shape.
                const exec = dispatch.exec as (
                    a: unknown,
                    c: AIToolContext
                ) => Promise<unknown>;
                ctx.assertCanWrite?.();
                const res = await exec(parsed.data, ctx);
                results.push({ op: op.op, ok: true, result: res });
            } catch (err) {
                const message =
                    err instanceof Error ? err.message : String(err);
                throw new ToolError(
                    `apply_schema_patch failed at op #${i} (${op.op}): ${message}`,
                    'Earlier ops have already been applied. Use the returned ids and inspect the diagram; retry only unfinished operations.',
                    { applied: results.length, results, failedIndex: i }
                );
            }
        }
        ctx.emitProgress?.(`Applied patch: ${args.summary}`);
        return { applied: ops.length, results };
    }
);

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const AI_TOOLS: AIToolDefinition[] = [
    // read first (model bias)
    getSchemaOverviewTool,
    getTableTool,
    findTablesByNameTool,
    listDataTypesTool,
    // aggregate before individual writes (we want the model to prefer it)
    applySchemaPatchTool,
    // writes
    createTableTool,
    updateTableTool,
    addFieldTool,
    updateFieldTool,
    createRelationshipTool,
    addNoteTool,
    addAreaTool,
    createIndexTool,
    updateIndexTool,
    createCheckConstraintTool,
    updateCheckConstraintTool,
    createCustomTypeTool,
    updateCustomTypeTool,
    // destructive
    removeTableTool,
    removeFieldTool,
    removeRelationshipTool,
    removeIndexTool,
    removeCheckConstraintTool,
    removeCustomTypeTool,
];

export function getTool(name: string): AIToolDefinition | undefined {
    return AI_TOOLS.find((t) => t.name === name);
}

export { ToolError };
