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
    createRelationshipArgs,
    createTableArgs,
    findTablesByNameArgs,
    getSchemaOverviewArgs,
    getTableArgs,
    removeFieldArgs,
    removeRelationshipArgs,
    removeTableArgs,
    updateFieldArgs,
    updateTableArgs,
    type FieldInput,
    type PatchOp,
} from './schemas';
import { serializeSchemaCompact } from './system-prompt';
import type { ZodTypeAny } from 'zod';
import { generateId } from '@/lib/utils/utils';
import type { DBField } from '@/lib/domain/db-field';
import type { DBTable } from '@/lib/domain/db-table';
import { dataTypeMap } from '@/lib/data/data-types/data-types';
import type { DataType } from '@/lib/data/data-types/data-types';
import type { Cardinality } from '@/lib/domain/db-relationship';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class ToolError extends Error {
    constructor(
        message: string,
        public hint?: string
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
    const lookup = dataTypeMap[ctx.chartdb.databaseType];
    const match = lookup.find(
        (t) => t.id === typeId || t.name.toLowerCase() === typeId.toLowerCase()
    );
    if (!match) {
        const sample = lookup
            .slice(0, 8)
            .map((t) => t.id)
            .join(', ');
        fail(
            `Unknown data type "${typeId}" for ${ctx.chartdb.databaseType}.`,
            `Examples valid for this dialect: ${sample}. Use one of those ids.`
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
        nullable: input.nullable ?? !isPk,
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
    options: { destructive?: boolean },
    execute: (
        args: ReturnType<S['parse']>,
        ctx: AIToolContext
    ) => Promise<unknown>
): AIToolDefinition {
    let cachedSchema: AIToolJSONSchema | null = null;
    return {
        name,
        description,
        destructive: options.destructive,
        get inputSchema() {
            cachedSchema ??= zodToToolSchema(schema);
            return cachedSchema;
        },
        execute: async (rawArgs, ctx) => {
            const parsed = schema.safeParse(rawArgs);
            if (!parsed.success) {
                throw new ToolError(
                    `Invalid arguments for ${name}: ${parsed.error.message}`,
                    'Check the tool input_schema and resend with corrected args.'
                );
            }
            return execute(parsed.data as ReturnType<S['parse']>, ctx);
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
    {},
    async (args, ctx) => {
        return serializeSchemaCompact(ctx.chartdb, {
            includeFields: args.includeFields ?? true,
            includeRelationships: args.includeRelationships ?? true,
        });
    }
);

const getTableTool = defineTool(
    'get_table',
    'Returns full details for one table including all field properties.',
    getTableArgs,
    {},
    async (args, ctx) => {
        const t = resolveTable(ctx, args.tableId);
        return {
            id: t.id,
            name: t.name,
            schema: t.schema ?? null,
            comments: t.comments ?? null,
            isView: t.isView,
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
    {},
    async (args, ctx) => {
        const q = args.query.toLowerCase();
        return ctx.chartdb.tables
            .filter((t) => t.name.toLowerCase().includes(q))
            .map((t) => ({ id: t.id, name: t.name, schema: t.schema ?? null }));
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
        color: args.color,
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
    const created = await ctx.chartdb.createRelationship({
        sourceTableId: args.sourceTableId,
        sourceFieldId: args.sourceFieldId,
        targetTableId: args.targetTableId,
        targetFieldId: args.targetFieldId,
    });
    // Override cardinality + name after creation (chartdb defaults to one-to-many).
    const patch: Partial<typeof created> = {
        sourceCardinality: args.sourceCardinality as Cardinality,
        targetCardinality: args.targetCardinality as Cardinality,
    };
    if (args.name) patch.name = args.name;
    await ctx.chartdb.updateRelationship(created.id, patch);
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
    remove_table: {
        args: removeTableArgs,
        exec: async (
            args: ReturnType<typeof removeTableArgs.parse>,
            ctx: AIToolContext
        ) => {
            await ctx.chartdb.removeTable(args.tableId);
            return { ok: true };
        },
    },
    remove_field: {
        args: removeFieldArgs,
        exec: async (
            args: ReturnType<typeof removeFieldArgs.parse>,
            ctx: AIToolContext
        ) => {
            await ctx.chartdb.removeField(args.tableId, args.fieldId);
            return { ok: true };
        },
    },
    remove_relationship: {
        args: removeRelationshipArgs,
        exec: async (
            args: ReturnType<typeof removeRelationshipArgs.parse>,
            ctx: AIToolContext
        ) => {
            await ctx.chartdb.removeRelationship(args.relationshipId);
            return { ok: true };
        },
    },
    add_note: { args: addNoteArgs, exec: executeAddNote },
    add_area: { args: addAreaArgs, exec: executeAddArea },
} as const;

const applySchemaPatchTool = defineTool(
    'apply_schema_patch',
    'Apply a batch of related schema operations as a single approvable unit. Strongly preferred over many individual tool calls for multi-step changes.',
    applySchemaPatchArgs,
    { destructive: true /* approval gated based on contents */ },
    async (args, ctx) => {
        const ops = args.ops as PatchOp[];
        const destructiveOps = ops.filter(
            (o) =>
                o.op === 'remove_table' ||
                o.op === 'remove_field' ||
                o.op === 'remove_relationship'
        );
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
                    'Stop the run and ask before continuing.'
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
                const res = await exec(parsed.data, ctx);
                results.push({ op: op.op, ok: true, result: res });
            } catch (err) {
                const message =
                    err instanceof Error ? err.message : String(err);
                throw new ToolError(
                    `apply_schema_patch failed at op #${i} (${op.op}): ${message}`,
                    'Earlier ops in the patch have already been applied. Inspect the diagram before continuing.'
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
    // destructive
    removeTableTool,
    removeFieldTool,
    removeRelationshipTool,
];

export function getTool(name: string): AIToolDefinition | undefined {
    return AI_TOOLS.find((t) => t.name === name);
}

export { ToolError };
