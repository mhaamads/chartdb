/**
 * Bulletproof storage layer for authenticated users.
 *
 * This provider is meant to wrap `FirestoreStorageProvider` and overrides
 * its context with a version that:
 *
 *   1. Writes go to the local per-user IndexedDB mirror FIRST. They return
 *      to the caller instantly. The Firestore write is then kicked off in
 *      the background — on success it just settles; on failure (after
 *      retries) the operation is appended to a persistent `pending_ops`
 *      table in the mirror so the sync engine can replay it later.
 *
 *   2. Reads first attempt Firestore (so the user sees data from other
 *      devices). If Firestore throws (offline, quota, permission, etc.)
 *      they transparently fall back to the local mirror. Successful
 *      remote reads are written through to the mirror for future fallback.
 *
 *   3. On mount, online events, and a periodic interval, the pending-op
 *      queue is drained against Firestore. Successful ops are removed;
 *      failed ops bump their attempt count and stay in the queue.
 *
 * Conflict resolution is last-write-wins by `updatedAt`. We acknowledge
 * that switching browsers / devices may briefly show stale state until
 * the next bootstrap; the local mirror is authoritative for the current
 * device and Firestore is the cross-device sync target.
 */

import React, {
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import { liveQuery } from 'dexie';
import type { StorageContext } from './storage-context';
import { storageContext } from './storage-context';
import {
    getMirrorDB,
    enqueuePendingOp,
    listPendingOps,
    deletePendingOp,
    markPendingOpFailed,
    type PendingOp,
    type PendingOpRecord,
    type LocalMirrorDB,
} from '@/lib/storage/local-backup';
import {
    syncStatusContext,
    type SyncStatusContextValue,
} from '@/context/sync-status-context/sync-status-context';
import type { Diagram } from '@/lib/domain/diagram';
import type { DBTable } from '@/lib/domain/db-table';
import type { DBRelationship } from '@/lib/domain/db-relationship';
import type { DBDependency } from '@/lib/domain/db-dependency';
import type { Area } from '@/lib/domain/area';
import type { DBCustomType } from '@/lib/domain/db-custom-type';
import type { Note } from '@/lib/domain/note';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PERIODIC_FLUSH_MS = 30_000;

/**
 * Try a remote read. On error, swallow and return `undefined` so the caller
 * can fall back to the mirror. Errors are logged so they don't disappear
 * silently — the user can still keep working but a developer can see why.
 */
async function tryRemote<T>(
    fn: () => Promise<T>,
    label: string
): Promise<T | undefined> {
    try {
        return await fn();
    } catch (err) {
        console.warn(
            `[hybrid-storage] ${label} failed remotely, falling back to local mirror`,
            err
        );
        return undefined;
    }
}

/**
 * Dispatch a single pending-op record back through the outer Firestore
 * provider. Returns a promise that resolves on success or rejects on
 * failure — caller decides what to do with the queue entry.
 */
function dispatchPendingOp(
    remote: StorageContext,
    op: PendingOp
): Promise<void> {
    switch (op.kind) {
        case 'updateConfig':
            return remote.updateConfig(op.config);
        case 'updateDiagramFilter':
            return remote.updateDiagramFilter(op.diagramId, op.filter);
        case 'deleteDiagramFilter':
            return remote.deleteDiagramFilter(op.diagramId);
        case 'addDiagram':
            return remote.addDiagram({ diagram: op.diagram });
        case 'updateDiagram':
            return remote.updateDiagram({
                id: op.id,
                attributes: op.attributes,
            });
        case 'deleteDiagram':
            return remote.deleteDiagram(op.id);
        case 'addTable':
            return remote.addTable({
                diagramId: op.diagramId,
                table: op.table,
            });
        case 'updateTable':
            return remote.updateTable({
                id: op.id,
                attributes: op.attributes,
            });
        case 'putTable':
            return remote.putTable({
                diagramId: op.diagramId,
                table: op.table,
            });
        case 'deleteTable':
            return remote.deleteTable({
                diagramId: op.diagramId,
                id: op.id,
            });
        case 'deleteDiagramTables':
            return remote.deleteDiagramTables(op.diagramId);
        case 'addRelationship':
            return remote.addRelationship({
                diagramId: op.diagramId,
                relationship: op.relationship,
            });
        case 'updateRelationship':
            return remote.updateRelationship({
                id: op.id,
                attributes: op.attributes,
            });
        case 'deleteRelationship':
            return remote.deleteRelationship({
                diagramId: op.diagramId,
                id: op.id,
            });
        case 'deleteDiagramRelationships':
            return remote.deleteDiagramRelationships(op.diagramId);
        case 'addDependency':
            return remote.addDependency({
                diagramId: op.diagramId,
                dependency: op.dependency,
            });
        case 'updateDependency':
            return remote.updateDependency({
                id: op.id,
                attributes: op.attributes,
            });
        case 'deleteDependency':
            return remote.deleteDependency({
                diagramId: op.diagramId,
                id: op.id,
            });
        case 'deleteDiagramDependencies':
            return remote.deleteDiagramDependencies(op.diagramId);
        case 'addArea':
            return remote.addArea({
                diagramId: op.diagramId,
                area: op.area,
            });
        case 'updateArea':
            return remote.updateArea({
                id: op.id,
                attributes: op.attributes,
            });
        case 'deleteArea':
            return remote.deleteArea({
                diagramId: op.diagramId,
                id: op.id,
            });
        case 'deleteDiagramAreas':
            return remote.deleteDiagramAreas(op.diagramId);
        case 'addCustomType':
            return remote.addCustomType({
                diagramId: op.diagramId,
                customType: op.customType,
            });
        case 'updateCustomType':
            return remote.updateCustomType({
                id: op.id,
                attributes: op.attributes,
            });
        case 'deleteCustomType':
            return remote.deleteCustomType({
                diagramId: op.diagramId,
                id: op.id,
            });
        case 'deleteDiagramCustomTypes':
            return remote.deleteDiagramCustomTypes(op.diagramId);
        case 'addNote':
            return remote.addNote({
                diagramId: op.diagramId,
                note: op.note,
            });
        case 'updateNote':
            return remote.updateNote({
                id: op.id,
                attributes: op.attributes,
            });
        case 'deleteNote':
            return remote.deleteNote({
                diagramId: op.diagramId,
                id: op.id,
            });
        case 'deleteDiagramNotes':
            return remote.deleteDiagramNotes(op.diagramId);
    }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const LocalMirrorLayer: React.FC<
    React.PropsWithChildren<{ uid: string }>
> = ({ children, uid }) => {
    // The outer FirestoreStorageProvider's context value. All remote work
    // ultimately goes through this object so retry/backoff/etc. lives in
    // exactly one place.
    const remote = useContext(storageContext);

    const db = useMemo<LocalMirrorDB>(() => getMirrorDB(uid), [uid]);

    // Guard against overlapping flushes (multiple online events firing,
    // interval racing with a write, etc.). Only one flush runs at a time.
    const flushingRef = useRef(false);

    // -----------------------------------------------------------------------
    // Observable sync state (consumed by `useSyncStatus`)
    // -----------------------------------------------------------------------

    const [pendingOps, setPendingOps] = useState<PendingOpRecord[]>([]);
    const [isFlushing, setIsFlushing] = useState(false);
    const [isOnline, setIsOnline] = useState<boolean>(() =>
        typeof navigator === 'undefined' ? true : navigator.onLine !== false
    );
    const [lastBootstrapAt, setLastBootstrapAt] = useState<number | undefined>(
        undefined
    );

    // Live subscription on the pending-ops table. Updates whenever any code
    // path (enqueue, flush success, manual delete) mutates the queue.
    useEffect(() => {
        const sub = liveQuery(() =>
            db.pending_ops.orderBy('seq').toArray()
        ).subscribe({
            next: setPendingOps,
            error: (err) =>
                console.warn(
                    '[hybrid-storage] pending_ops liveQuery error',
                    err
                ),
        });
        const metaSub = liveQuery(() => db.sync_meta.get('main')).subscribe({
            next: (row) => setLastBootstrapAt(row?.lastBootstrapAt),
            error: (err) =>
                console.warn('[hybrid-storage] sync_meta liveQuery error', err),
        });
        return () => {
            sub.unsubscribe();
            metaSub.unsubscribe();
        };
    }, [db]);

    // Mirror online/offline events for the indicator UI.
    useEffect(() => {
        const onOnline = () => setIsOnline(true);
        const onOffline = () => setIsOnline(false);
        window.addEventListener('online', onOnline);
        window.addEventListener('offline', onOffline);
        return () => {
            window.removeEventListener('online', onOnline);
            window.removeEventListener('offline', onOffline);
        };
    }, []);

    // -----------------------------------------------------------------------
    // Sync queue flush
    // -----------------------------------------------------------------------

    const flushPending = useCallback(async (): Promise<void> => {
        if (flushingRef.current) return;
        flushingRef.current = true;
        setIsFlushing(true);
        try {
            const queue = await listPendingOps(db);
            for (const record of queue) {
                if (record.seq === undefined) continue;
                try {
                    await dispatchPendingOp(remote, record.op);
                    await deletePendingOp(db, record.seq);
                } catch (err) {
                    console.warn(
                        `[hybrid-storage] replay of pending op #${record.seq} ` +
                            `(${record.op.kind}) failed; will retry later`,
                        err
                    );
                    await markPendingOpFailed(db, record.seq, err);
                    // Stop draining on first failure — the next attempt
                    // will pick up where we left off. This preserves order.
                    break;
                }
            }
        } finally {
            flushingRef.current = false;
            setIsFlushing(false);
        }
    }, [db, remote]);

    /**
     * Run a remote write and on failure enqueue it for later replay. The
     * caller's Promise resolves either way — the mirror already has the
     * data so the UI can move on.
     */
    const remoteOrEnqueue = useCallback(
        async (op: PendingOp, exec: () => Promise<void>): Promise<void> => {
            try {
                await exec();
            } catch (err) {
                console.warn(
                    `[hybrid-storage] ${op.kind} failed remotely; enqueued ` +
                        `for retry`,
                    err
                );
                await enqueuePendingOp(db, op, err);
            }
        },
        [db]
    );

    // -----------------------------------------------------------------------
    // Periodic / online flushes + initial bootstrap
    // -----------------------------------------------------------------------

    useEffect(() => {
        // 1. Initial bootstrap: best-effort pull of remote diagrams into
        //    the mirror. We don't block UI on this — reads will still serve
        //    from whatever is in the mirror until it completes.
        let cancelled = false;
        void (async () => {
            // Drain pending ops FIRST so any writes the user queued in a
            // prior session get pushed up before we pull (otherwise the
            // pull could overwrite local edits the remote hasn't seen).
            await flushPending();

            const remoteConfig = await tryRemote(
                () => remote.getConfig(),
                'bootstrap getConfig'
            );
            if (cancelled) return;
            if (remoteConfig) {
                await db.config.put({ ...remoteConfig, id: 'main' });
            }

            const remoteDiagrams = await tryRemote(
                () =>
                    remote.listDiagrams({
                        includeTables: true,
                        includeRelationships: true,
                        includeDependencies: true,
                        includeAreas: true,
                        includeCustomTypes: true,
                        includeNotes: true,
                    }),
                'bootstrap listDiagrams'
            );
            if (cancelled || !remoteDiagrams) return;

            await db.transaction(
                'rw',
                [
                    db.diagrams,
                    db.db_tables,
                    db.db_relationships,
                    db.db_dependencies,
                    db.areas,
                    db.db_custom_types,
                    db.notes,
                    db.sync_meta,
                ],
                async () => {
                    for (const diagram of remoteDiagrams) {
                        const {
                            tables,
                            relationships,
                            dependencies,
                            areas,
                            customTypes,
                            notes,
                            ...meta
                        } = diagram;
                        // LWW: only overwrite local if remote is newer or
                        // local is missing the diagram entirely.
                        const localMeta = await db.diagrams.get(diagram.id);
                        if (
                            !localMeta ||
                            (meta.updatedAt &&
                                (!localMeta.updatedAt ||
                                    meta.updatedAt > localMeta.updatedAt))
                        ) {
                            await db.diagrams.put(meta as Diagram);
                        }
                        if (tables) {
                            await db.db_tables
                                .where('diagramId')
                                .equals(diagram.id)
                                .delete();
                            await db.db_tables.bulkPut(
                                tables.map((t) => ({
                                    ...t,
                                    diagramId: diagram.id,
                                }))
                            );
                        }
                        if (relationships) {
                            await db.db_relationships
                                .where('diagramId')
                                .equals(diagram.id)
                                .delete();
                            await db.db_relationships.bulkPut(
                                relationships.map((r) => ({
                                    ...r,
                                    diagramId: diagram.id,
                                }))
                            );
                        }
                        if (dependencies) {
                            await db.db_dependencies
                                .where('diagramId')
                                .equals(diagram.id)
                                .delete();
                            await db.db_dependencies.bulkPut(
                                dependencies.map((d) => ({
                                    ...d,
                                    diagramId: diagram.id,
                                }))
                            );
                        }
                        if (areas) {
                            await db.areas
                                .where('diagramId')
                                .equals(diagram.id)
                                .delete();
                            await db.areas.bulkPut(
                                areas.map((a) => ({
                                    ...a,
                                    diagramId: diagram.id,
                                }))
                            );
                        }
                        if (customTypes) {
                            await db.db_custom_types
                                .where('diagramId')
                                .equals(diagram.id)
                                .delete();
                            await db.db_custom_types.bulkPut(
                                customTypes.map((c) => ({
                                    ...c,
                                    diagramId: diagram.id,
                                }))
                            );
                        }
                        if (notes) {
                            await db.notes
                                .where('diagramId')
                                .equals(diagram.id)
                                .delete();
                            await db.notes.bulkPut(
                                notes.map((n) => ({
                                    ...n,
                                    diagramId: diagram.id,
                                }))
                            );
                        }
                    }
                    await db.sync_meta.put({
                        id: 'main',
                        lastBootstrapAt: Date.now(),
                    });
                }
            );
        })();

        // 2. Online listener — drain queue as soon as the network comes back.
        const onOnline = () => {
            void flushPending();
        };
        window.addEventListener('online', onOnline);

        // 3. Periodic flush — safety net for transient errors that aren't
        //    associated with a network state change (rate limits, etc.).
        const interval = window.setInterval(() => {
            if (navigator.onLine !== false) void flushPending();
        }, PERIODIC_FLUSH_MS);

        return () => {
            cancelled = true;
            window.removeEventListener('online', onOnline);
            window.clearInterval(interval);
        };
    }, [db, remote, flushPending]);

    // -----------------------------------------------------------------------
    // StorageContext implementation — writes hit the mirror first, reads
    // try remote and fall back to mirror.
    // -----------------------------------------------------------------------

    // Config
    const getConfig: StorageContext['getConfig'] = useCallback(async () => {
        const fromRemote = await tryRemote(
            () => remote.getConfig(),
            'getConfig'
        );
        if (fromRemote) {
            await db.config.put({ ...fromRemote, id: 'main' });
            return fromRemote;
        }
        const local = await db.config.get('main');
        if (!local) return undefined;
        const { id: _id, ...rest } = local;
        void _id;
        return rest;
    }, [db, remote]);

    const updateConfig: StorageContext['updateConfig'] = useCallback(
        async (config) => {
            const existing = await db.config.get('main');
            await db.config.put({
                ...(existing ?? { defaultDiagramId: '' }),
                ...config,
                id: 'main',
            });
            void remoteOrEnqueue({ kind: 'updateConfig', config }, () =>
                remote.updateConfig(config)
            );
        },
        [db, remote, remoteOrEnqueue]
    );

    // Diagram filter
    const getDiagramFilter: StorageContext['getDiagramFilter'] = useCallback(
        async (diagramId) => {
            const fromRemote = await tryRemote(
                () => remote.getDiagramFilter(diagramId),
                'getDiagramFilter'
            );
            if (fromRemote) {
                await db.diagram_filters.put({ ...fromRemote, diagramId });
                return fromRemote;
            }
            const local = await db.diagram_filters.get(diagramId);
            if (!local) return undefined;
            const { diagramId: _d, ...rest } = local;
            void _d;
            return rest;
        },
        [db, remote]
    );

    const updateDiagramFilter: StorageContext['updateDiagramFilter'] =
        useCallback(
            async (diagramId, filter) => {
                await db.diagram_filters.put({ ...filter, diagramId });
                void remoteOrEnqueue(
                    { kind: 'updateDiagramFilter', diagramId, filter },
                    () => remote.updateDiagramFilter(diagramId, filter)
                );
            },
            [db, remote, remoteOrEnqueue]
        );

    const deleteDiagramFilter: StorageContext['deleteDiagramFilter'] =
        useCallback(
            async (diagramId) => {
                await db.diagram_filters.delete(diagramId);
                void remoteOrEnqueue(
                    { kind: 'deleteDiagramFilter', diagramId },
                    () => remote.deleteDiagramFilter(diagramId)
                );
            },
            [db, remote, remoteOrEnqueue]
        );

    // Tables
    const addTable: StorageContext['addTable'] = useCallback(
        async ({ diagramId, table }) => {
            await db.db_tables.put({ ...table, diagramId });
            void remoteOrEnqueue({ kind: 'addTable', diagramId, table }, () =>
                remote.addTable({ diagramId, table })
            );
        },
        [db, remote, remoteOrEnqueue]
    );

    const getTable: StorageContext['getTable'] = useCallback(
        async ({ diagramId, id }) => {
            const fromRemote = await tryRemote(
                () => remote.getTable({ diagramId, id }),
                'getTable'
            );
            if (fromRemote) {
                await db.db_tables.put({ ...fromRemote, diagramId });
                return fromRemote;
            }
            const local = await db.db_tables.get(id);
            if (!local || local.diagramId !== diagramId) return undefined;
            const { diagramId: _d, ...rest } = local;
            void _d;
            return rest as DBTable;
        },
        [db, remote]
    );

    const updateTable: StorageContext['updateTable'] = useCallback(
        async ({ id, attributes }) => {
            await db.db_tables.update(id, attributes);
            void remoteOrEnqueue({ kind: 'updateTable', id, attributes }, () =>
                remote.updateTable({ id, attributes })
            );
        },
        [db, remote, remoteOrEnqueue]
    );

    const putTable: StorageContext['putTable'] = useCallback(
        async ({ diagramId, table }) => {
            await db.db_tables.put({ ...table, diagramId });
            void remoteOrEnqueue({ kind: 'putTable', diagramId, table }, () =>
                remote.putTable({ diagramId, table })
            );
        },
        [db, remote, remoteOrEnqueue]
    );

    const deleteTable: StorageContext['deleteTable'] = useCallback(
        async ({ diagramId, id }) => {
            await db.db_tables.delete(id);
            void remoteOrEnqueue({ kind: 'deleteTable', diagramId, id }, () =>
                remote.deleteTable({ diagramId, id })
            );
        },
        [db, remote, remoteOrEnqueue]
    );

    const listTables: StorageContext['listTables'] = useCallback(
        async (diagramId) => {
            const fromRemote = await tryRemote(
                () => remote.listTables(diagramId),
                'listTables'
            );
            if (fromRemote) {
                await db.transaction('rw', db.db_tables, async () => {
                    await db.db_tables
                        .where('diagramId')
                        .equals(diagramId)
                        .delete();
                    await db.db_tables.bulkPut(
                        fromRemote.map((t) => ({ ...t, diagramId }))
                    );
                });
                return fromRemote;
            }
            const rows = await db.db_tables
                .where('diagramId')
                .equals(diagramId)
                .toArray();
            return rows.map(({ diagramId: _d, ...rest }) => {
                void _d;
                return rest as DBTable;
            });
        },
        [db, remote]
    );

    const deleteDiagramTables: StorageContext['deleteDiagramTables'] =
        useCallback(
            async (diagramId) => {
                await db.db_tables
                    .where('diagramId')
                    .equals(diagramId)
                    .delete();
                void remoteOrEnqueue(
                    { kind: 'deleteDiagramTables', diagramId },
                    () => remote.deleteDiagramTables(diagramId)
                );
            },
            [db, remote, remoteOrEnqueue]
        );

    // Relationships
    const addRelationship: StorageContext['addRelationship'] = useCallback(
        async ({ diagramId, relationship }) => {
            await db.db_relationships.put({ ...relationship, diagramId });
            void remoteOrEnqueue(
                { kind: 'addRelationship', diagramId, relationship },
                () => remote.addRelationship({ diagramId, relationship })
            );
        },
        [db, remote, remoteOrEnqueue]
    );

    const getRelationship: StorageContext['getRelationship'] = useCallback(
        async ({ diagramId, id }) => {
            const fromRemote = await tryRemote(
                () => remote.getRelationship({ diagramId, id }),
                'getRelationship'
            );
            if (fromRemote) {
                await db.db_relationships.put({ ...fromRemote, diagramId });
                return fromRemote;
            }
            const local = await db.db_relationships.get(id);
            if (!local || local.diagramId !== diagramId) return undefined;
            const { diagramId: _d, ...rest } = local;
            void _d;
            return rest as DBRelationship;
        },
        [db, remote]
    );

    const updateRelationship: StorageContext['updateRelationship'] =
        useCallback(
            async ({ id, attributes }) => {
                await db.db_relationships.update(id, attributes);
                void remoteOrEnqueue(
                    { kind: 'updateRelationship', id, attributes },
                    () => remote.updateRelationship({ id, attributes })
                );
            },
            [db, remote, remoteOrEnqueue]
        );

    const deleteRelationship: StorageContext['deleteRelationship'] =
        useCallback(
            async ({ diagramId, id }) => {
                await db.db_relationships.delete(id);
                void remoteOrEnqueue(
                    { kind: 'deleteRelationship', diagramId, id },
                    () => remote.deleteRelationship({ diagramId, id })
                );
            },
            [db, remote, remoteOrEnqueue]
        );

    const listRelationships: StorageContext['listRelationships'] = useCallback(
        async (diagramId) => {
            const fromRemote = await tryRemote(
                () => remote.listRelationships(diagramId),
                'listRelationships'
            );
            if (fromRemote) {
                await db.transaction('rw', db.db_relationships, async () => {
                    await db.db_relationships
                        .where('diagramId')
                        .equals(diagramId)
                        .delete();
                    await db.db_relationships.bulkPut(
                        fromRemote.map((r) => ({ ...r, diagramId }))
                    );
                });
                return fromRemote;
            }
            const rows = await db.db_relationships
                .where('diagramId')
                .equals(diagramId)
                .toArray();
            return rows.map(({ diagramId: _d, ...rest }) => {
                void _d;
                return rest as DBRelationship;
            });
        },
        [db, remote]
    );

    const deleteDiagramRelationships: StorageContext['deleteDiagramRelationships'] =
        useCallback(
            async (diagramId) => {
                await db.db_relationships
                    .where('diagramId')
                    .equals(diagramId)
                    .delete();
                void remoteOrEnqueue(
                    { kind: 'deleteDiagramRelationships', diagramId },
                    () => remote.deleteDiagramRelationships(diagramId)
                );
            },
            [db, remote, remoteOrEnqueue]
        );

    // Dependencies
    const addDependency: StorageContext['addDependency'] = useCallback(
        async ({ diagramId, dependency }) => {
            await db.db_dependencies.put({ ...dependency, diagramId });
            void remoteOrEnqueue(
                { kind: 'addDependency', diagramId, dependency },
                () => remote.addDependency({ diagramId, dependency })
            );
        },
        [db, remote, remoteOrEnqueue]
    );

    const getDependency: StorageContext['getDependency'] = useCallback(
        async ({ diagramId, id }) => {
            const fromRemote = await tryRemote(
                () => remote.getDependency({ diagramId, id }),
                'getDependency'
            );
            if (fromRemote) {
                await db.db_dependencies.put({ ...fromRemote, diagramId });
                return fromRemote;
            }
            const local = await db.db_dependencies.get(id);
            if (!local || local.diagramId !== diagramId) return undefined;
            const { diagramId: _d, ...rest } = local;
            void _d;
            return rest as DBDependency;
        },
        [db, remote]
    );

    const updateDependency: StorageContext['updateDependency'] = useCallback(
        async ({ id, attributes }) => {
            await db.db_dependencies.update(id, attributes);
            void remoteOrEnqueue(
                { kind: 'updateDependency', id, attributes },
                () => remote.updateDependency({ id, attributes })
            );
        },
        [db, remote, remoteOrEnqueue]
    );

    const deleteDependency: StorageContext['deleteDependency'] = useCallback(
        async ({ diagramId, id }) => {
            await db.db_dependencies.delete(id);
            void remoteOrEnqueue(
                { kind: 'deleteDependency', diagramId, id },
                () => remote.deleteDependency({ diagramId, id })
            );
        },
        [db, remote, remoteOrEnqueue]
    );

    const listDependencies: StorageContext['listDependencies'] = useCallback(
        async (diagramId) => {
            const fromRemote = await tryRemote(
                () => remote.listDependencies(diagramId),
                'listDependencies'
            );
            if (fromRemote) {
                await db.transaction('rw', db.db_dependencies, async () => {
                    await db.db_dependencies
                        .where('diagramId')
                        .equals(diagramId)
                        .delete();
                    await db.db_dependencies.bulkPut(
                        fromRemote.map((d) => ({ ...d, diagramId }))
                    );
                });
                return fromRemote;
            }
            const rows = await db.db_dependencies
                .where('diagramId')
                .equals(diagramId)
                .toArray();
            return rows.map(({ diagramId: _d, ...rest }) => {
                void _d;
                return rest as DBDependency;
            });
        },
        [db, remote]
    );

    const deleteDiagramDependencies: StorageContext['deleteDiagramDependencies'] =
        useCallback(
            async (diagramId) => {
                await db.db_dependencies
                    .where('diagramId')
                    .equals(diagramId)
                    .delete();
                void remoteOrEnqueue(
                    { kind: 'deleteDiagramDependencies', diagramId },
                    () => remote.deleteDiagramDependencies(diagramId)
                );
            },
            [db, remote, remoteOrEnqueue]
        );

    // Areas
    const addArea: StorageContext['addArea'] = useCallback(
        async ({ diagramId, area }) => {
            await db.areas.put({ ...area, diagramId });
            void remoteOrEnqueue({ kind: 'addArea', diagramId, area }, () =>
                remote.addArea({ diagramId, area })
            );
        },
        [db, remote, remoteOrEnqueue]
    );

    const getArea: StorageContext['getArea'] = useCallback(
        async ({ diagramId, id }) => {
            const fromRemote = await tryRemote(
                () => remote.getArea({ diagramId, id }),
                'getArea'
            );
            if (fromRemote) {
                await db.areas.put({ ...fromRemote, diagramId });
                return fromRemote;
            }
            const local = await db.areas.get(id);
            if (!local || local.diagramId !== diagramId) return undefined;
            const { diagramId: _d, ...rest } = local;
            void _d;
            return rest as Area;
        },
        [db, remote]
    );

    const updateArea: StorageContext['updateArea'] = useCallback(
        async ({ id, attributes }) => {
            await db.areas.update(id, attributes);
            void remoteOrEnqueue({ kind: 'updateArea', id, attributes }, () =>
                remote.updateArea({ id, attributes })
            );
        },
        [db, remote, remoteOrEnqueue]
    );

    const deleteArea: StorageContext['deleteArea'] = useCallback(
        async ({ diagramId, id }) => {
            await db.areas.delete(id);
            void remoteOrEnqueue({ kind: 'deleteArea', diagramId, id }, () =>
                remote.deleteArea({ diagramId, id })
            );
        },
        [db, remote, remoteOrEnqueue]
    );

    const listAreas: StorageContext['listAreas'] = useCallback(
        async (diagramId) => {
            const fromRemote = await tryRemote(
                () => remote.listAreas(diagramId),
                'listAreas'
            );
            if (fromRemote) {
                await db.transaction('rw', db.areas, async () => {
                    await db.areas
                        .where('diagramId')
                        .equals(diagramId)
                        .delete();
                    await db.areas.bulkPut(
                        fromRemote.map((a) => ({ ...a, diagramId }))
                    );
                });
                return fromRemote;
            }
            const rows = await db.areas
                .where('diagramId')
                .equals(diagramId)
                .toArray();
            return rows.map(({ diagramId: _d, ...rest }) => {
                void _d;
                return rest as Area;
            });
        },
        [db, remote]
    );

    const deleteDiagramAreas: StorageContext['deleteDiagramAreas'] =
        useCallback(
            async (diagramId) => {
                await db.areas.where('diagramId').equals(diagramId).delete();
                void remoteOrEnqueue(
                    { kind: 'deleteDiagramAreas', diagramId },
                    () => remote.deleteDiagramAreas(diagramId)
                );
            },
            [db, remote, remoteOrEnqueue]
        );

    // Custom types
    const addCustomType: StorageContext['addCustomType'] = useCallback(
        async ({ diagramId, customType }) => {
            await db.db_custom_types.put({ ...customType, diagramId });
            void remoteOrEnqueue(
                { kind: 'addCustomType', diagramId, customType },
                () => remote.addCustomType({ diagramId, customType })
            );
        },
        [db, remote, remoteOrEnqueue]
    );

    const getCustomType: StorageContext['getCustomType'] = useCallback(
        async ({ diagramId, id }) => {
            const fromRemote = await tryRemote(
                () => remote.getCustomType({ diagramId, id }),
                'getCustomType'
            );
            if (fromRemote) {
                await db.db_custom_types.put({ ...fromRemote, diagramId });
                return fromRemote;
            }
            const local = await db.db_custom_types.get(id);
            if (!local || local.diagramId !== diagramId) return undefined;
            const { diagramId: _d, ...rest } = local;
            void _d;
            return rest as DBCustomType;
        },
        [db, remote]
    );

    const updateCustomType: StorageContext['updateCustomType'] = useCallback(
        async ({ id, attributes }) => {
            await db.db_custom_types.update(id, attributes);
            void remoteOrEnqueue(
                { kind: 'updateCustomType', id, attributes },
                () => remote.updateCustomType({ id, attributes })
            );
        },
        [db, remote, remoteOrEnqueue]
    );

    const deleteCustomType: StorageContext['deleteCustomType'] = useCallback(
        async ({ diagramId, id }) => {
            await db.db_custom_types.delete(id);
            void remoteOrEnqueue(
                { kind: 'deleteCustomType', diagramId, id },
                () => remote.deleteCustomType({ diagramId, id })
            );
        },
        [db, remote, remoteOrEnqueue]
    );

    const listCustomTypes: StorageContext['listCustomTypes'] = useCallback(
        async (diagramId) => {
            const fromRemote = await tryRemote(
                () => remote.listCustomTypes(diagramId),
                'listCustomTypes'
            );
            if (fromRemote) {
                await db.transaction('rw', db.db_custom_types, async () => {
                    await db.db_custom_types
                        .where('diagramId')
                        .equals(diagramId)
                        .delete();
                    await db.db_custom_types.bulkPut(
                        fromRemote.map((c) => ({ ...c, diagramId }))
                    );
                });
                return fromRemote;
            }
            const rows = await db.db_custom_types
                .where('diagramId')
                .equals(diagramId)
                .toArray();
            return rows.map(({ diagramId: _d, ...rest }) => {
                void _d;
                return rest as DBCustomType;
            });
        },
        [db, remote]
    );

    const deleteDiagramCustomTypes: StorageContext['deleteDiagramCustomTypes'] =
        useCallback(
            async (diagramId) => {
                await db.db_custom_types
                    .where('diagramId')
                    .equals(diagramId)
                    .delete();
                void remoteOrEnqueue(
                    { kind: 'deleteDiagramCustomTypes', diagramId },
                    () => remote.deleteDiagramCustomTypes(diagramId)
                );
            },
            [db, remote, remoteOrEnqueue]
        );

    // Notes
    const addNote: StorageContext['addNote'] = useCallback(
        async ({ diagramId, note }) => {
            await db.notes.put({ ...note, diagramId });
            void remoteOrEnqueue({ kind: 'addNote', diagramId, note }, () =>
                remote.addNote({ diagramId, note })
            );
        },
        [db, remote, remoteOrEnqueue]
    );

    const getNote: StorageContext['getNote'] = useCallback(
        async ({ diagramId, id }) => {
            const fromRemote = await tryRemote(
                () => remote.getNote({ diagramId, id }),
                'getNote'
            );
            if (fromRemote) {
                await db.notes.put({ ...fromRemote, diagramId });
                return fromRemote;
            }
            const local = await db.notes.get(id);
            if (!local || local.diagramId !== diagramId) return undefined;
            const { diagramId: _d, ...rest } = local;
            void _d;
            return rest as Note;
        },
        [db, remote]
    );

    const updateNote: StorageContext['updateNote'] = useCallback(
        async ({ id, attributes }) => {
            await db.notes.update(id, attributes);
            void remoteOrEnqueue({ kind: 'updateNote', id, attributes }, () =>
                remote.updateNote({ id, attributes })
            );
        },
        [db, remote, remoteOrEnqueue]
    );

    const deleteNote: StorageContext['deleteNote'] = useCallback(
        async ({ diagramId, id }) => {
            await db.notes.delete(id);
            void remoteOrEnqueue({ kind: 'deleteNote', diagramId, id }, () =>
                remote.deleteNote({ diagramId, id })
            );
        },
        [db, remote, remoteOrEnqueue]
    );

    const listNotes: StorageContext['listNotes'] = useCallback(
        async (diagramId) => {
            const fromRemote = await tryRemote(
                () => remote.listNotes(diagramId),
                'listNotes'
            );
            if (fromRemote) {
                await db.transaction('rw', db.notes, async () => {
                    await db.notes
                        .where('diagramId')
                        .equals(diagramId)
                        .delete();
                    await db.notes.bulkPut(
                        fromRemote.map((n) => ({ ...n, diagramId }))
                    );
                });
                return fromRemote;
            }
            const rows = await db.notes
                .where('diagramId')
                .equals(diagramId)
                .toArray();
            return rows.map(({ diagramId: _d, ...rest }) => {
                void _d;
                return rest as Note;
            });
        },
        [db, remote]
    );

    const deleteDiagramNotes: StorageContext['deleteDiagramNotes'] =
        useCallback(
            async (diagramId) => {
                await db.notes.where('diagramId').equals(diagramId).delete();
                void remoteOrEnqueue(
                    { kind: 'deleteDiagramNotes', diagramId },
                    () => remote.deleteDiagramNotes(diagramId)
                );
            },
            [db, remote, remoteOrEnqueue]
        );

    // Diagrams (composite)
    const addDiagram: StorageContext['addDiagram'] = useCallback(
        async ({ diagram }) => {
            const {
                tables,
                relationships,
                dependencies,
                areas,
                customTypes,
                notes,
                ...meta
            } = diagram;
            await db.transaction(
                'rw',
                [
                    db.diagrams,
                    db.db_tables,
                    db.db_relationships,
                    db.db_dependencies,
                    db.areas,
                    db.db_custom_types,
                    db.notes,
                ],
                async () => {
                    await db.diagrams.put(meta as Diagram);
                    if (tables?.length)
                        await db.db_tables.bulkPut(
                            tables.map((t) => ({ ...t, diagramId: diagram.id }))
                        );
                    if (relationships?.length)
                        await db.db_relationships.bulkPut(
                            relationships.map((r) => ({
                                ...r,
                                diagramId: diagram.id,
                            }))
                        );
                    if (dependencies?.length)
                        await db.db_dependencies.bulkPut(
                            dependencies.map((d) => ({
                                ...d,
                                diagramId: diagram.id,
                            }))
                        );
                    if (areas?.length)
                        await db.areas.bulkPut(
                            areas.map((a) => ({ ...a, diagramId: diagram.id }))
                        );
                    if (customTypes?.length)
                        await db.db_custom_types.bulkPut(
                            customTypes.map((c) => ({
                                ...c,
                                diagramId: diagram.id,
                            }))
                        );
                    if (notes?.length)
                        await db.notes.bulkPut(
                            notes.map((n) => ({ ...n, diagramId: diagram.id }))
                        );
                }
            );
            void remoteOrEnqueue({ kind: 'addDiagram', diagram }, () =>
                remote.addDiagram({ diagram })
            );
        },
        [db, remote, remoteOrEnqueue]
    );

    const hydrateDiagram = useCallback(
        async (
            id: string,
            options: Parameters<StorageContext['getDiagram']>[1] = {}
        ): Promise<Diagram | undefined> => {
            const meta = await db.diagrams.get(id);
            if (!meta) return undefined;
            let diagram: Diagram = { ...meta };
            const [
                tables,
                relationships,
                dependencies,
                areas,
                customTypes,
                notes,
            ] = await Promise.all([
                options.includeTables
                    ? db.db_tables
                          .where('diagramId')
                          .equals(id)
                          .toArray()
                          .then((rows) =>
                              rows.map(({ diagramId: _d, ...rest }) => {
                                  void _d;
                                  return rest as DBTable;
                              })
                          )
                    : undefined,
                options.includeRelationships
                    ? db.db_relationships
                          .where('diagramId')
                          .equals(id)
                          .toArray()
                          .then((rows) =>
                              rows.map(({ diagramId: _d, ...rest }) => {
                                  void _d;
                                  return rest as DBRelationship;
                              })
                          )
                    : undefined,
                options.includeDependencies
                    ? db.db_dependencies
                          .where('diagramId')
                          .equals(id)
                          .toArray()
                          .then((rows) =>
                              rows.map(({ diagramId: _d, ...rest }) => {
                                  void _d;
                                  return rest as DBDependency;
                              })
                          )
                    : undefined,
                options.includeAreas
                    ? db.areas
                          .where('diagramId')
                          .equals(id)
                          .toArray()
                          .then((rows) =>
                              rows.map(({ diagramId: _d, ...rest }) => {
                                  void _d;
                                  return rest as Area;
                              })
                          )
                    : undefined,
                options.includeCustomTypes
                    ? db.db_custom_types
                          .where('diagramId')
                          .equals(id)
                          .toArray()
                          .then((rows) =>
                              rows.map(({ diagramId: _d, ...rest }) => {
                                  void _d;
                                  return rest as DBCustomType;
                              })
                          )
                    : undefined,
                options.includeNotes
                    ? db.notes
                          .where('diagramId')
                          .equals(id)
                          .toArray()
                          .then((rows) =>
                              rows.map(({ diagramId: _d, ...rest }) => {
                                  void _d;
                                  return rest as Note;
                              })
                          )
                    : undefined,
            ]);
            if (tables) diagram = { ...diagram, tables };
            if (relationships) diagram = { ...diagram, relationships };
            if (dependencies) diagram = { ...diagram, dependencies };
            if (areas) diagram = { ...diagram, areas };
            if (customTypes) diagram = { ...diagram, customTypes };
            if (notes) diagram = { ...diagram, notes };
            return diagram;
        },
        [db]
    );

    const listDiagrams: StorageContext['listDiagrams'] = useCallback(
        async (options = {}) => {
            const fromRemote = await tryRemote(
                () => remote.listDiagrams(options),
                'listDiagrams'
            );
            if (fromRemote) {
                // Mirror in the background — don't block the caller.
                void (async () => {
                    try {
                        await db.transaction('rw', db.diagrams, async () => {
                            for (const d of fromRemote) {
                                const {
                                    tables: _t,
                                    relationships: _r,
                                    dependencies: _dp,
                                    areas: _a,
                                    customTypes: _c,
                                    notes: _n,
                                    ...meta
                                } = d;
                                void _t;
                                void _r;
                                void _dp;
                                void _a;
                                void _c;
                                void _n;
                                await db.diagrams.put(meta as Diagram);
                            }
                        });
                    } catch {
                        // Mirror update is best-effort.
                    }
                })();
                return fromRemote;
            }
            const metas = await db.diagrams.toArray();
            return Promise.all(
                metas.map(async (m) => {
                    const full = await hydrateDiagram(m.id, options);
                    return full ?? m;
                })
            );
        },
        [db, remote, hydrateDiagram]
    );

    const getDiagram: StorageContext['getDiagram'] = useCallback(
        async (id, options = {}) => {
            const fromRemote = await tryRemote(
                () => remote.getDiagram(id, options),
                'getDiagram'
            );
            if (fromRemote) {
                const {
                    tables: _t,
                    relationships: _r,
                    dependencies: _dp,
                    areas: _a,
                    customTypes: _c,
                    notes: _n,
                    ...meta
                } = fromRemote;
                void _t;
                void _r;
                void _dp;
                void _a;
                void _c;
                void _n;
                await db.diagrams.put(meta as Diagram);
                return fromRemote;
            }
            return hydrateDiagram(id, options);
        },
        [db, remote, hydrateDiagram]
    );

    const updateDiagram: StorageContext['updateDiagram'] = useCallback(
        async ({ id, attributes }) => {
            if (attributes.id && attributes.id !== id) {
                // Local rename: copy meta + all sub-rows to new id, delete old.
                await db.transaction(
                    'rw',
                    [
                        db.diagrams,
                        db.db_tables,
                        db.db_relationships,
                        db.db_dependencies,
                        db.areas,
                        db.db_custom_types,
                        db.notes,
                        db.diagram_filters,
                    ],
                    async () => {
                        const old = await db.diagrams.get(id);
                        if (!old) return;
                        const merged = { ...old, ...attributes } as Diagram;
                        const newId = attributes.id as string;
                        await db.diagrams.put(merged);
                        if (newId !== id) await db.diagrams.delete(id);

                        const reKey = async <T extends { diagramId: string }>(
                            table: EntityLike<T>
                        ) => {
                            const rows = await table
                                .where('diagramId')
                                .equals(id)
                                .toArray();
                            if (!rows.length) return;
                            await table.where('diagramId').equals(id).delete();
                            await table.bulkPut(
                                rows.map((r) => ({ ...r, diagramId: newId }))
                            );
                        };
                        await reKey(db.db_tables);
                        await reKey(db.db_relationships);
                        await reKey(db.db_dependencies);
                        await reKey(db.areas);
                        await reKey(db.db_custom_types);
                        await reKey(db.notes);

                        const filter = await db.diagram_filters.get(id);
                        if (filter) {
                            await db.diagram_filters.delete(id);
                            await db.diagram_filters.put({
                                ...filter,
                                diagramId: newId,
                            });
                        }
                    }
                );
            } else {
                await db.diagrams.update(id, attributes);
            }
            void remoteOrEnqueue(
                { kind: 'updateDiagram', id, attributes },
                () => remote.updateDiagram({ id, attributes })
            );
        },
        [db, remote, remoteOrEnqueue]
    );

    const deleteDiagram: StorageContext['deleteDiagram'] = useCallback(
        async (id) => {
            await db.transaction(
                'rw',
                [
                    db.diagrams,
                    db.db_tables,
                    db.db_relationships,
                    db.db_dependencies,
                    db.areas,
                    db.db_custom_types,
                    db.notes,
                    db.diagram_filters,
                ],
                async () => {
                    await db.diagrams.delete(id);
                    await db.db_tables.where('diagramId').equals(id).delete();
                    await db.db_relationships
                        .where('diagramId')
                        .equals(id)
                        .delete();
                    await db.db_dependencies
                        .where('diagramId')
                        .equals(id)
                        .delete();
                    await db.areas.where('diagramId').equals(id).delete();
                    await db.db_custom_types
                        .where('diagramId')
                        .equals(id)
                        .delete();
                    await db.notes.where('diagramId').equals(id).delete();
                    await db.diagram_filters.delete(id);
                }
            );
            void remoteOrEnqueue({ kind: 'deleteDiagram', id }, () =>
                remote.deleteDiagram(id)
            );
        },
        [db, remote, remoteOrEnqueue]
    );

    const value: StorageContext = useMemo(
        () => ({
            getConfig,
            updateConfig,
            getDiagramFilter,
            updateDiagramFilter,
            deleteDiagramFilter,
            addDiagram,
            listDiagrams,
            getDiagram,
            updateDiagram,
            deleteDiagram,
            addTable,
            getTable,
            updateTable,
            putTable,
            deleteTable,
            listTables,
            deleteDiagramTables,
            addRelationship,
            getRelationship,
            updateRelationship,
            deleteRelationship,
            listRelationships,
            deleteDiagramRelationships,
            addDependency,
            getDependency,
            updateDependency,
            deleteDependency,
            listDependencies,
            deleteDiagramDependencies,
            addArea,
            getArea,
            updateArea,
            deleteArea,
            listAreas,
            deleteDiagramAreas,
            addCustomType,
            getCustomType,
            updateCustomType,
            deleteCustomType,
            listCustomTypes,
            deleteDiagramCustomTypes,
            addNote,
            getNote,
            updateNote,
            deleteNote,
            listNotes,
            deleteDiagramNotes,
        }),
        [
            getConfig,
            updateConfig,
            getDiagramFilter,
            updateDiagramFilter,
            deleteDiagramFilter,
            addDiagram,
            listDiagrams,
            getDiagram,
            updateDiagram,
            deleteDiagram,
            addTable,
            getTable,
            updateTable,
            putTable,
            deleteTable,
            listTables,
            deleteDiagramTables,
            addRelationship,
            getRelationship,
            updateRelationship,
            deleteRelationship,
            listRelationships,
            deleteDiagramRelationships,
            addDependency,
            getDependency,
            updateDependency,
            deleteDependency,
            listDependencies,
            deleteDiagramDependencies,
            addArea,
            getArea,
            updateArea,
            deleteArea,
            listAreas,
            deleteDiagramAreas,
            addCustomType,
            getCustomType,
            updateCustomType,
            deleteCustomType,
            listCustomTypes,
            deleteDiagramCustomTypes,
            addNote,
            getNote,
            updateNote,
            deleteNote,
            listNotes,
            deleteDiagramNotes,
        ]
    );

    const syncStatusValue = useMemo<SyncStatusContextValue>(
        () => ({
            pendingOps,
            isFlushing,
            isOnline,
            lastBootstrapAt,
            syncNow: flushPending,
            isAvailable: true,
        }),
        [pendingOps, isFlushing, isOnline, lastBootstrapAt, flushPending]
    );

    return (
        <storageContext.Provider value={value}>
            <syncStatusContext.Provider value={syncStatusValue}>
                {children}
            </syncStatusContext.Provider>
        </storageContext.Provider>
    );
};

/**
 * Minimal Dexie EntityTable surface used by the generic `reKey` helper.
 * Avoids the need to import Dexie's type machinery for a one-off helper.
 */
interface EntityLike<T extends { diagramId: string }> {
    where(index: string): {
        equals(value: string): {
            toArray(): Promise<T[]>;
            delete(): Promise<number>;
        };
    };
    bulkPut(rows: T[]): Promise<unknown>;
}
