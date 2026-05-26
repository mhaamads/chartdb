/**
 * Zod schemas describing tool input arguments.
 *
 * These are the *source of truth* for tool argument validation. We:
 *   1. Run each LLM-supplied args object through the Zod schema before
 *      executing — catches model hallucinations early and feeds back
 *      structured errors so the model can self-correct.
 *   2. Convert each schema to JSON Schema (via `json-schema.ts`) to send
 *      to the provider as the tool's `input_schema`.
 *
 * Naming convention: all schemas describe **input** to a tool. Names match
 * the tool name 1:1 (e.g. `createTableArgs` ↔ tool `create_table`).
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const tableIdField = z
    .string()
    .min(1)
    .describe('Stable id of the target table (from get_schema_overview).');
const fieldIdField = z
    .string()
    .min(1)
    .describe('Stable id of the target field.');
const optionalString = z.string().optional();
const optionalNullableString = z
    .string()
    .nullable()
    .optional()
    .describe('Optional. Use null to clear.');

const hexColorField = z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/u)
    .describe('Hex color like "#3b82f6". Defaults to a palette pick.')
    .optional();

const positionField = z
    .object({
        x: z.number().describe('Canvas X position in pixels.'),
        y: z.number().describe('Canvas Y position in pixels.'),
    })
    .partial()
    .optional()
    .describe('Optional canvas position. Omit to let the editor auto-layout.');

// ---------------------------------------------------------------------------
// Field shape used by create/update operations
// ---------------------------------------------------------------------------

export const fieldInputSchema = z
    .object({
        name: z.string().min(1).describe('Field/column name.'),
        type: z
            .string()
            .min(1)
            .describe(
                'Data type id, e.g. "varchar", "integer", "uuid", "timestamp". Must match the current database dialect.'
            ),
        primaryKey: z.boolean().optional().describe('Default false.'),
        unique: z.boolean().optional().describe('Default false.'),
        nullable: z
            .boolean()
            .optional()
            .describe('Default true unless primaryKey.'),
        increment: z
            .boolean()
            .optional()
            .describe('Auto-increment / serial / identity.'),
        isArray: z.boolean().optional().describe('Array type (Postgres).'),
        characterMaximumLength: optionalNullableString.describe(
            'For varchar(n) / char(n).'
        ),
        precision: z.number().int().nullable().optional(),
        scale: z.number().int().nullable().optional(),
        default: optionalNullableString.describe(
            'SQL default expression as a string.'
        ),
        comments: optionalNullableString,
    })
    .describe('Definition of a single column.');

export type FieldInput = z.infer<typeof fieldInputSchema>;

// ---------------------------------------------------------------------------
// READ TOOLS
// ---------------------------------------------------------------------------

export const getSchemaOverviewArgs = z
    .object({
        includeFields: z
            .boolean()
            .optional()
            .describe(
                'Include field-level detail (default false to save tokens).'
            ),
        includeRelationships: z.boolean().optional().describe('Default true.'),
        includePositions: z
            .boolean()
            .optional()
            .describe('Include x/y on canvas (default false).'),
    })
    .describe(
        'Returns a compact JSON view of the entire diagram. Use this first.'
    );

export const getTableArgs = z
    .object({
        tableId: tableIdField,
    })
    .describe('Returns full details for one table.');

export const findTablesByNameArgs = z
    .object({
        query: z
            .string()
            .min(1)
            .describe('Case-insensitive substring of table name.'),
    })
    .describe('Search tables by name. Returns id/name pairs.');

// ---------------------------------------------------------------------------
// WRITE TOOLS (non-destructive)
// ---------------------------------------------------------------------------

export const createTableArgs = z
    .object({
        name: z.string().min(1).describe('Table name.'),
        schema: optionalString.describe(
            'Schema/namespace name (e.g. "public"). Optional.'
        ),
        comments: optionalString,
        color: hexColorField,
        position: positionField,
        isView: z.boolean().optional().describe('Default false.'),
        fields: z
            .array(fieldInputSchema)
            .optional()
            .describe(
                'Optional initial columns. Each field gets an auto id. Add at least an "id" primary-key field for normal tables.'
            ),
    })
    .describe('Create a new table.');

export const updateTableArgs = z
    .object({
        tableId: tableIdField,
        name: optionalString,
        schema: optionalNullableString,
        comments: optionalNullableString,
        color: hexColorField,
        position: positionField,
    })
    .describe('Update top-level properties of a table. Does not touch fields.');

export const addFieldArgs = z
    .object({
        tableId: tableIdField,
        field: fieldInputSchema,
    })
    .describe('Append a column to an existing table.');

export const updateFieldArgs = z
    .object({
        tableId: tableIdField,
        fieldId: fieldIdField,
        patch: fieldInputSchema
            .partial()
            .describe('Subset of field properties to update.'),
    })
    .describe('Modify properties of an existing column.');

export const createRelationshipArgs = z
    .object({
        sourceTableId: tableIdField,
        sourceFieldId: fieldIdField,
        targetTableId: tableIdField,
        targetFieldId: fieldIdField,
        sourceCardinality: z
            .enum(['one', 'many'])
            .describe('Cardinality on the source side.'),
        targetCardinality: z
            .enum(['one', 'many'])
            .describe('Cardinality on the target side.'),
        name: optionalString.describe(
            'Display name. Auto-generated from columns if omitted.'
        ),
    })
    .describe(
        'Create a foreign-key relationship between two existing columns.'
    );

export const addNoteArgs = z
    .object({
        content: z.string().min(1),
        position: positionField,
        color: hexColorField,
    })
    .describe('Add a sticky note to the canvas.');

export const addAreaArgs = z
    .object({
        name: z.string().min(1).describe('Area label.'),
        position: positionField,
        width: z.number().positive().optional(),
        height: z.number().positive().optional(),
        color: hexColorField,
    })
    .describe('Group tables visually by drawing a labelled area.');

// ---------------------------------------------------------------------------
// DESTRUCTIVE TOOLS
// ---------------------------------------------------------------------------

export const removeTableArgs = z
    .object({
        tableId: tableIdField,
    })
    .describe(
        'Permanently delete a table. Destructive — requires approval depending on safety mode.'
    );

export const removeFieldArgs = z
    .object({
        tableId: tableIdField,
        fieldId: fieldIdField,
    })
    .describe('Permanently delete a column. Destructive.');

export const removeRelationshipArgs = z
    .object({
        relationshipId: z.string().min(1),
    })
    .describe('Delete a foreign-key relationship. Destructive.');

// ---------------------------------------------------------------------------
// AGGREGATE TOOL
// ---------------------------------------------------------------------------

const patchOpSchema = z.discriminatedUnion('op', [
    z.object({
        op: z.literal('create_table'),
        args: createTableArgs,
    }),
    z.object({
        op: z.literal('update_table'),
        args: updateTableArgs,
    }),
    z.object({
        op: z.literal('add_field'),
        args: addFieldArgs,
    }),
    z.object({
        op: z.literal('update_field'),
        args: updateFieldArgs,
    }),
    z.object({
        op: z.literal('create_relationship'),
        args: createRelationshipArgs,
    }),
    z.object({
        op: z.literal('remove_table'),
        args: removeTableArgs,
    }),
    z.object({
        op: z.literal('remove_field'),
        args: removeFieldArgs,
    }),
    z.object({
        op: z.literal('remove_relationship'),
        args: removeRelationshipArgs,
    }),
    z.object({
        op: z.literal('add_note'),
        args: addNoteArgs,
    }),
    z.object({
        op: z.literal('add_area'),
        args: addAreaArgs,
    }),
]);

export type PatchOp = z.infer<typeof patchOpSchema>;

export const applySchemaPatchArgs = z
    .object({
        summary: z
            .string()
            .min(1)
            .describe(
                'One-sentence human summary of the overall change, shown in approval UI.'
            ),
        ops: z
            .array(patchOpSchema)
            .min(1)
            .describe(
                'Ordered list of operations. Executed atomically; halts on first error.'
            ),
    })
    .describe(
        'Apply a batch of schema operations as a single approvable unit. Prefer this over many tiny tools when making multi-step changes.'
    );
