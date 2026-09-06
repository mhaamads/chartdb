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
import { INDEX_TYPES } from '@/lib/domain/db-index';
import { DBCustomTypeKind } from '@/lib/domain/db-custom-type';

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

export const listAreasArgs = z
    .object({
        query: z
            .string()
            .optional()
            .describe('Optional case-insensitive area title filter.'),
    })
    .describe('List titled colored areas and the tables assigned to each.');

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

const contextNoteInput = z
    .object({
        areaId: z
            .string()
            .min(1)
            .optional()
            .describe('Existing module area id.'),
        tableId: tableIdField.optional(),
        content: z
            .string()
            .min(1)
            .max(10000)
            .optional()
            .describe(
                'Complete AI-generated Markdown note. Omit only when context is provided.'
            ),
        context: z
            .string()
            .min(1)
            .max(4000)
            .optional()
            .describe(
                'Context to turn into a concise note when content is omitted.'
            ),
        placement: z
            .enum(['inside', 'next_to'])
            .optional()
            .describe('Place inside the target area or next to it.'),
        position: positionField,
        color: hexColorField,
    })
    .describe('One note linked by position to an existing area or table.');

export const addContextNotesArgs = z
    .object({
        notes: z
            .array(contextNoteInput)
            .min(1)
            .max(100)
            .describe('Notes to create, one per table or module target.'),
        context: z
            .string()
            .min(1)
            .max(4000)
            .optional()
            .describe(
                'Shared user-provided context used when an individual note omits content.'
            ),
        placement: z
            .enum(['inside', 'next_to'])
            .optional()
            .default('next_to')
            .describe('Default placement for notes without their own choice.'),
    })
    .describe(
        'Create validated notes for existing modules or tables. The assistant should generate complete note content from the schema and supplied context before calling this tool.'
    );

export const addAreaArgs = z
    .object({
        name: z.string().min(1).describe('Area label.'),
        position: positionField,
        width: z.number().positive().optional(),
        height: z.number().positive().optional(),
        color: hexColorField,
    })
    .describe('Group tables visually by drawing a labelled area.');

const moduleAreaInput = z
    .object({
        name: z.string().min(1).describe('Module title shown on the area.'),
        tableIds: z
            .array(tableIdField)
            .min(1)
            .describe('Existing table ids assigned to this module.'),
        position: positionField,
        width: z.number().positive().optional(),
        height: z.number().positive().optional(),
        color: hexColorField,
    })
    .describe('One titled, colored module area and its tables.');

export const groupTablesByModuleArgs = z
    .object({
        modules: z
            .array(moduleAreaInput)
            .min(1)
            .describe('Modules to create and lay out.'),
        gap: z
            .number()
            .min(0)
            .max(1000)
            .optional()
            .describe('Gap between automatically placed module areas.'),
    })
    .describe(
        'Create titled colored areas, assign existing tables to them, and place each module on a readable grid.'
    );

// ---------------------------------------------------------------------------
// DATABASE FEATURES
// ---------------------------------------------------------------------------

const indexTypeField = z
    .enum(INDEX_TYPES)
    .nullable()
    .optional()
    .describe('Dialect-specific index method. Omit for the database default.');

export const createIndexArgs = z
    .object({
        tableId: tableIdField,
        name: optionalString.describe(
            'Index name. Omit to generate one from the table and fields.'
        ),
        fieldIds: z
            .array(fieldIdField)
            .min(1)
            .describe('One or more existing field ids, in index order.'),
        unique: z.boolean().optional().describe('Default false.'),
        type: indexTypeField,
        isPrimaryKey: z
            .boolean()
            .optional()
            .describe('Mark this as the table primary-key index.'),
        comments: optionalNullableString,
    })
    .describe('Add an index to an existing table.');

export const updateIndexArgs = z
    .object({
        tableId: tableIdField,
        indexId: z.string().min(1).describe('Stable id of the index.'),
        patch: createIndexArgs
            .omit({ tableId: true })
            .partial()
            .describe('Subset of index properties to update.'),
    })
    .describe('Update an existing index.');

export const removeIndexArgs = z
    .object({
        tableId: tableIdField,
        indexId: z.string().min(1).describe('Stable id of the index.'),
    })
    .describe('Delete an index. Destructive.');

export const createCheckConstraintArgs = z
    .object({
        tableId: tableIdField,
        expression: z
            .string()
            .trim()
            .min(1)
            .describe('SQL boolean expression, without the CHECK keyword.'),
    })
    .describe('Add a check constraint to an existing table.');

export const updateCheckConstraintArgs = z
    .object({
        tableId: tableIdField,
        constraintId: z
            .string()
            .min(1)
            .describe('Stable id of the constraint.'),
        patch: createCheckConstraintArgs
            .omit({ tableId: true })
            .partial()
            .describe('Subset of constraint properties to update.'),
    })
    .describe('Update an existing check constraint.');

export const removeCheckConstraintArgs = z
    .object({
        tableId: tableIdField,
        constraintId: z
            .string()
            .min(1)
            .describe('Stable id of the constraint.'),
    })
    .describe('Delete a check constraint. Destructive.');

const customTypeField = z.object({
    field: z.string().min(1).describe('Composite field name.'),
    type: z.string().min(1).describe('Database or custom type id/name.'),
});

export const createCustomTypeArgs = z
    .object({
        name: z.string().min(1).describe('Custom type name.'),
        schema: optionalNullableString.describe('Optional schema/namespace.'),
        kind: z.nativeEnum(DBCustomTypeKind),
        values: z
            .array(z.string().min(1))
            .optional()
            .describe('Enum labels. Use for enum types.'),
        fields: z
            .array(customTypeField)
            .optional()
            .describe('Fields. Use for composite types.'),
        order: z.number().int().nullable().optional(),
    })
    .describe('Create an enum or composite custom database type.');

export const updateCustomTypeArgs = z
    .object({
        customTypeId: z
            .string()
            .min(1)
            .describe('Stable id of the custom type.'),
        patch: createCustomTypeArgs
            .partial()
            .describe('Subset of custom type properties to update.'),
    })
    .describe('Update an existing custom database type.');

export const removeCustomTypeArgs = z
    .object({
        customTypeId: z
            .string()
            .min(1)
            .describe('Stable id of the custom type.'),
    })
    .describe('Delete a custom database type. Destructive.');

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
        op: z.literal('add_context_notes'),
        args: addContextNotesArgs,
    }),
    z.object({
        op: z.literal('add_area'),
        args: addAreaArgs,
    }),
    z.object({
        op: z.literal('group_tables_by_module'),
        args: groupTablesByModuleArgs,
    }),
    z.object({
        op: z.literal('create_index'),
        args: createIndexArgs,
    }),
    z.object({
        op: z.literal('update_index'),
        args: updateIndexArgs,
    }),
    z.object({
        op: z.literal('remove_index'),
        args: removeIndexArgs,
    }),
    z.object({
        op: z.literal('create_check_constraint'),
        args: createCheckConstraintArgs,
    }),
    z.object({
        op: z.literal('update_check_constraint'),
        args: updateCheckConstraintArgs,
    }),
    z.object({
        op: z.literal('remove_check_constraint'),
        args: removeCheckConstraintArgs,
    }),
    z.object({
        op: z.literal('create_custom_type'),
        args: createCustomTypeArgs,
    }),
    z.object({
        op: z.literal('update_custom_type'),
        args: updateCustomTypeArgs,
    }),
    z.object({
        op: z.literal('remove_custom_type'),
        args: removeCustomTypeArgs,
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
                'Ordered list of operations. Executed sequentially; halts on first error without rollback. Reference only ids that already exist before this call.'
            ),
    })
    .describe(
        'Apply a batch of schema operations as a single approvable unit. Prefer this over many tiny tools when making multi-step changes.'
    );
