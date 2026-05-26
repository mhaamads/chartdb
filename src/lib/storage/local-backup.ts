/**
 * Per-user local IndexedDB mirror for the authenticated storage.
 *
 * Goal: make the app bulletproof against Firestore outages, permission
 * issues, quota errors, or network failures. Every write goes to the local
 * mirror first (instant, synchronous-ish, always succeeds) before being
 * propagated to Firestore. If the Firestore write fails, the operation is
 * enqueued in `pending_ops` so it can be retried later (on reconnect, on
 * page reload, or via the periodic drain interval).
 *
 * Reads can fall back to the mirror when Firestore errors out, so the user
 * can keep working with their data on this device even if the remote side
 * is unreachable. Acknowledged tradeoff: state can be inconsistent across
 * devices/browsers until the mirror flushes; we treat the mirror as the
 * device-local source of truth and Firestore as the cross-device sync
 * target. Conflicts are resolved last-write-wins on `updatedAt`.
 */

import Dexie, { type EntityTable } from 'dexie';
import type { Diagram } from '@/lib/domain/diagram';
import type { DBTable } from '@/lib/domain/db-table';
import type { DBRelationship } from '@/lib/domain/db-relationship';
import type { DBDependency } from '@/lib/domain/db-dependency';
import type { Area } from '@/lib/domain/area';
import type { DBCustomType } from '@/lib/domain/db-custom-type';
import type { Note } from '@/lib/domain/note';
import type { DiagramFilter } from '@/lib/domain/diagram-filter/diagram-filter';
import type { ChartDBConfig } from '@/lib/domain/config';

// ---------------------------------------------------------------------------
// Pending operation log
// ---------------------------------------------------------------------------

/**
 * Discriminated union of every write operation the StorageContext exposes.
 * Each variant carries enough information for the sync engine to re-run the
 * remote write idempotently against Firestore.
 */
export type PendingOp =
    | { kind: 'updateConfig'; config: Partial<ChartDBConfig> }
    | { kind: 'updateDiagramFilter'; diagramId: string; filter: DiagramFilter }
    | { kind: 'deleteDiagramFilter'; diagramId: string }
    | { kind: 'addDiagram'; diagram: Diagram }
    | {
          kind: 'updateDiagram';
          id: string;
          attributes: Partial<Diagram>;
      }
    | { kind: 'deleteDiagram'; id: string }
    | { kind: 'addTable'; diagramId: string; table: DBTable }
    | { kind: 'updateTable'; id: string; attributes: Partial<DBTable> }
    | { kind: 'putTable'; diagramId: string; table: DBTable }
    | { kind: 'deleteTable'; diagramId: string; id: string }
    | { kind: 'deleteDiagramTables'; diagramId: string }
    | {
          kind: 'addRelationship';
          diagramId: string;
          relationship: DBRelationship;
      }
    | {
          kind: 'updateRelationship';
          id: string;
          attributes: Partial<DBRelationship>;
      }
    | { kind: 'deleteRelationship'; diagramId: string; id: string }
    | { kind: 'deleteDiagramRelationships'; diagramId: string }
    | {
          kind: 'addDependency';
          diagramId: string;
          dependency: DBDependency;
      }
    | {
          kind: 'updateDependency';
          id: string;
          attributes: Partial<DBDependency>;
      }
    | { kind: 'deleteDependency'; diagramId: string; id: string }
    | { kind: 'deleteDiagramDependencies'; diagramId: string }
    | { kind: 'addArea'; diagramId: string; area: Area }
    | { kind: 'updateArea'; id: string; attributes: Partial<Area> }
    | { kind: 'deleteArea'; diagramId: string; id: string }
    | { kind: 'deleteDiagramAreas'; diagramId: string }
    | {
          kind: 'addCustomType';
          diagramId: string;
          customType: DBCustomType;
      }
    | {
          kind: 'updateCustomType';
          id: string;
          attributes: Partial<DBCustomType>;
      }
    | { kind: 'deleteCustomType'; diagramId: string; id: string }
    | { kind: 'deleteDiagramCustomTypes'; diagramId: string }
    | { kind: 'addNote'; diagramId: string; note: Note }
    | { kind: 'updateNote'; id: string; attributes: Partial<Note> }
    | { kind: 'deleteNote'; diagramId: string; id: string }
    | { kind: 'deleteDiagramNotes'; diagramId: string };

export interface PendingOpRecord {
    /** Auto-incrementing primary key (insertion order). */
    seq?: number;
    /** Wall-clock timestamp captured when the op was enqueued. */
    enqueuedAt: number;
    /** Number of remote-replay attempts made so far. */
    attempts: number;
    /** Most recent error message captured during a failed replay, if any. */
    lastError?: string;
    /** The operation payload. */
    op: PendingOp;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

type TableRow<T> = T & { diagramId: string };

interface SyncMetaRow {
    /** Singleton: always 'main'. */
    id: 'main';
    /** Wall-clock timestamp of the last successful bootstrap from Firestore. */
    lastBootstrapAt?: number;
}

export type LocalMirrorDB = Dexie & {
    diagrams: EntityTable<Diagram, 'id'>;
    db_tables: EntityTable<TableRow<DBTable>, 'id'>;
    db_relationships: EntityTable<TableRow<DBRelationship>, 'id'>;
    db_dependencies: EntityTable<TableRow<DBDependency>, 'id'>;
    areas: EntityTable<TableRow<Area>, 'id'>;
    db_custom_types: EntityTable<TableRow<DBCustomType>, 'id'>;
    notes: EntityTable<TableRow<Note>, 'id'>;
    diagram_filters: EntityTable<
        TableRow<DiagramFilter> & { diagramId: string },
        'diagramId'
    >;
    config: EntityTable<ChartDBConfig & { id: 'main' }, 'id'>;
    pending_ops: EntityTable<PendingOpRecord, 'seq'>;
    sync_meta: EntityTable<SyncMetaRow, 'id'>;
};

// ---------------------------------------------------------------------------
// Cache of open databases (one per uid).
// ---------------------------------------------------------------------------

const dbCache = new Map<string, LocalMirrorDB>();

/**
 * Sanitize a uid for use in an IndexedDB database name. Firebase UIDs are
 * URL-safe already, but this is defensive.
 */
function safeUid(uid: string): string {
    return uid.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * Open (or reuse) the per-user mirror database. Databases are cached by uid
 * so the schema is only declared once per session even if React re-renders
 * the provider.
 */
export function getMirrorDB(uid: string): LocalMirrorDB {
    const cached = dbCache.get(uid);
    if (cached) return cached;

    const db = new Dexie(`ChartDB_user_${safeUid(uid)}`) as LocalMirrorDB;

    db.version(1).stores({
        // Same indexes as the anonymous StorageProvider so cross-mode data
        // shape stays compatible. We intentionally do NOT chain through all
        // historical migrations — this is a fresh per-user DB.
        diagrams:
            'id, name, databaseType, databaseEdition, createdAt, updatedAt',
        db_tables:
            'id, diagramId, name, schema, x, y, fields, indexes, color, createdAt, width, comment, isView, isMaterializedView, order',
        db_relationships:
            'id, diagramId, name, sourceSchema, sourceTableId, targetSchema, targetTableId, sourceFieldId, targetFieldId, createdAt',
        db_dependencies:
            'id, diagramId, schema, tableId, dependentSchema, dependentTableId, createdAt',
        areas: 'id, diagramId, name, x, y, width, height, color',
        db_custom_types: 'id, diagramId, schema, type, kind, values, fields',
        notes: 'id, diagramId, content, x, y, width, height, color',
        diagram_filters: 'diagramId, tableIds, schemasIds',
        config: 'id, defaultDiagramId',
        pending_ops: '++seq, enqueuedAt',
        sync_meta: 'id',
    });

    dbCache.set(uid, db);
    return db;
}

/**
 * Close and forget all cached mirror databases. Useful on sign-out to make
 * sure another user signing in on the same browser doesn't read prior
 * cached state. Each database itself is preserved on disk (so the user
 * can sign back in and recover their work) — this only clears the in-memory
 * Dexie handle cache.
 */
export function closeAllMirrorDBs(): void {
    for (const db of dbCache.values()) {
        try {
            db.close();
        } catch {
            // best effort
        }
    }
    dbCache.clear();
}

// ---------------------------------------------------------------------------
// Queue helpers
// ---------------------------------------------------------------------------

export async function enqueuePendingOp(
    db: LocalMirrorDB,
    op: PendingOp,
    lastError?: unknown
): Promise<void> {
    await db.pending_ops.add({
        op,
        enqueuedAt: Date.now(),
        attempts: 0,
        lastError: lastError ? String(lastError) : undefined,
    });
}

export async function listPendingOps(
    db: LocalMirrorDB
): Promise<PendingOpRecord[]> {
    return db.pending_ops.orderBy('seq').toArray();
}

export async function deletePendingOp(
    db: LocalMirrorDB,
    seq: number
): Promise<void> {
    await db.pending_ops.delete(seq);
}

export async function markPendingOpFailed(
    db: LocalMirrorDB,
    seq: number,
    error: unknown
): Promise<void> {
    const row = await db.pending_ops.get(seq);
    if (!row) return;
    await db.pending_ops.update(seq, {
        attempts: row.attempts + 1,
        lastError: String(error),
    });
}
