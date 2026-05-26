/**
 * System prompt builder + compact diagram serializer.
 *
 * The serializer trades fidelity for tokens. The model only needs:
 *   - table ids + names + schemas
 *   - field ids + names + types + key/required flags
 *   - relationship endpoints (table id + field id) + cardinality
 *
 * Positions, colors, comments are omitted unless explicitly requested via
 * the `get_table` tool. This keeps a 50-table diagram comfortably under
 * a few thousand tokens.
 */

import type { ChartDBContext } from '@/context/chartdb-context/chartdb-context';
import type { DatabaseType } from '@/lib/domain/database-type';

interface CompactField {
    id: string;
    name: string;
    type: string;
    pk?: true;
    unique?: true;
    nullable?: false;
    fk?: { table: string; field: string };
}

interface CompactTable {
    id: string;
    name: string;
    schema?: string;
    isView?: true;
    fields?: CompactField[];
}

interface CompactRelationship {
    id: string;
    source: { table: string; field: string };
    target: { table: string; field: string };
    cardinality: `${'one' | 'many'}-to-${'one' | 'many'}`;
}

export interface CompactSchema {
    databaseType: DatabaseType;
    diagramName: string;
    counts: {
        tables: number;
        relationships: number;
        areas: number;
        notes: number;
    };
    tables: CompactTable[];
    relationships?: CompactRelationship[];
}

export interface SerializeOptions {
    includeFields?: boolean;
    includeRelationships?: boolean;
}

export function serializeSchemaCompact(
    ctx: Pick<
        ChartDBContext,
        | 'databaseType'
        | 'diagramName'
        | 'tables'
        | 'relationships'
        | 'areas'
        | 'notes'
    >,
    opts: SerializeOptions = {}
): CompactSchema {
    const includeFields = opts.includeFields ?? true;
    const includeRelationships = opts.includeRelationships ?? true;

    // Build a fast lookup for FK annotations.
    const fkByField = new Map<string, { table: string; field: string }>();
    if (includeFields && includeRelationships) {
        for (const r of ctx.relationships) {
            // Convention: the "many" side carries the FK column. If both
            // sides are 'one' we just annotate the source.
            const isSourceFk =
                r.sourceCardinality === 'many' || r.targetCardinality === 'one';
            const fkSide = isSourceFk
                ? { table: r.sourceTableId, field: r.sourceFieldId }
                : { table: r.targetTableId, field: r.targetFieldId };
            const refSide = isSourceFk
                ? { table: r.targetTableId, field: r.targetFieldId }
                : { table: r.sourceTableId, field: r.sourceFieldId };
            fkByField.set(`${fkSide.table}.${fkSide.field}`, refSide);
        }
    }

    const tables: CompactTable[] = ctx.tables.map((t) => {
        const compact: CompactTable = { id: t.id, name: t.name };
        if (t.schema) compact.schema = t.schema;
        if (t.isView) compact.isView = true;
        if (includeFields) {
            compact.fields = t.fields.map((f) => {
                const cf: CompactField = {
                    id: f.id,
                    name: f.name,
                    type: f.type.id,
                };
                if (f.primaryKey) cf.pk = true;
                if (f.unique && !f.primaryKey) cf.unique = true;
                if (f.nullable === false) cf.nullable = false;
                const fk = fkByField.get(`${t.id}.${f.id}`);
                if (fk) cf.fk = fk;
                return cf;
            });
        }
        return compact;
    });

    const result: CompactSchema = {
        databaseType: ctx.databaseType,
        diagramName: ctx.diagramName,
        counts: {
            tables: ctx.tables.length,
            relationships: ctx.relationships.length,
            areas: ctx.areas.length,
            notes: ctx.notes.length,
        },
        tables,
    };

    if (includeRelationships) {
        result.relationships = ctx.relationships.map((r) => ({
            id: r.id,
            source: { table: r.sourceTableId, field: r.sourceFieldId },
            target: { table: r.targetTableId, field: r.targetFieldId },
            cardinality:
                `${r.sourceCardinality}-to-${r.targetCardinality}` as CompactRelationship['cardinality'],
        }));
    }

    return result;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export interface SystemPromptOptions {
    databaseType: DatabaseType;
    diagramName: string;
    /** BCP-47 language tag of the UI (e.g. "en", "fr", "ar"). */
    locale?: string;
    /** Inline schema snapshot. Optional — the model can also use the
     *  `get_schema_overview` tool. Including it once up-front cuts a
     *  round-trip for the common "small diagram" case. */
    schemaSnapshot?: CompactSchema;
    safetyMode: 'auto' | 'ask' | 'dry-run';
}

export function buildSystemPrompt(opts: SystemPromptOptions): string {
    const { databaseType, diagramName, locale, schemaSnapshot, safetyMode } =
        opts;

    const safetyClause =
        safetyMode === 'dry-run'
            ? 'You are in DRY-RUN mode. Do not call mutating tools — only describe what you would change.'
            : safetyMode === 'ask'
              ? 'For destructive operations (remove_table, remove_field, remove_relationship, or any apply_schema_patch that includes them) the user will be asked for approval. Group destructive ops into a single apply_schema_patch with a clear summary.'
              : 'The user has enabled auto-apply. Still avoid surprises: state your plan in plain text before invoking tools.';

    const localeClause = locale
        ? `Reply in the user's language (BCP-47: ${locale}). Identifiers (table/column names, SQL keywords) stay in English.`
        : `Reply in the user's language; identifiers stay in English.`;

    const snapshot = schemaSnapshot
        ? `\n\nCurrent diagram snapshot (compact JSON, ids are stable):\n${JSON.stringify(schemaSnapshot)}`
        : '';

    return [
        `You are ChartDB's database design assistant. You help the user model relational schemas for ${databaseType} via the editor's tools.`,
        ``,
        `Diagram: "${diagramName}". Dialect: ${databaseType}.`,
        ``,
        `Rules:`,
        `1. Always read before you write. Call get_schema_overview (or use the inline snapshot) before suggesting changes that reference existing tables.`,
        `2. Prefer the apply_schema_patch tool to batch related operations (e.g. "add a users table with id, email, created_at + add index on email" → one patch).`,
        `3. Use the database's idiomatic data types (e.g. uuid + timestamptz for Postgres, NVARCHAR for SQL Server).`,
        `4. Reference fields by their stable id (from the snapshot/overview), not by name — names can change.`,
        `5. When asked open questions ("how should I model X?"), explain trade-offs first, then offer to apply a concrete patch.`,
        `6. If a tool call returns an error, read it carefully and self-correct — do not retry the same arguments.`,
        `7. ${safetyClause}`,
        `8. ${localeClause}`,
        `9. Keep prose concise. Use short bullet lists when a list helps. No emojis unless the user uses them.`,
        snapshot,
    ].join('\n');
}
