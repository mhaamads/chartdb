import type { Area } from '@/lib/domain/area';
import type { ChartDBConfig } from '@/lib/domain/config';
import type { DBCustomType } from '@/lib/domain/db-custom-type';
import type { DBDependency } from '@/lib/domain/db-dependency';
import type { DBRelationship } from '@/lib/domain/db-relationship';
import type { DBTable } from '@/lib/domain/db-table';
import type { Diagram } from '@/lib/domain/diagram';
import type { DiagramFilter } from '@/lib/domain/diagram-filter/diagram-filter';
import type { Note } from '@/lib/domain/note';
import { firestore } from '@/lib/firebase/firebase-firestore';
import {
    collection,
    deleteDoc,
    doc,
    getDoc,
    getDocs,
    setDoc,
    Timestamp,
    updateDoc,
    writeBatch,
    type WriteBatch,
} from 'firebase/firestore';
import { FirebaseError } from 'firebase/app';
import React, { useCallback, useMemo } from 'react';
import type { StorageContext } from './storage-context';
import { storageContext } from './storage-context';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Firestore's hard limit is 500 writes per batch.
 */
const BATCH_LIMIT = 500;

/** Maximum number of retry attempts for transient Firestore errors. */
const MAX_RETRIES = 4;

/** Firestore error codes that are safe to retry. */
const RETRYABLE_CODES = new Set([
    'unavailable',
    'deadline-exceeded',
    'internal',
    'aborted',
    'cancelled',
    'resource-exhausted',
    'unknown',
]);

function isRetryableFirestoreError(err: unknown): boolean {
    if (err instanceof FirebaseError) {
        // FirebaseError codes can be prefixed (`firestore/unavailable`) or
        // bare (`unavailable`). Normalize before checking.
        const code = err.code.includes('/') ? err.code.split('/')[1] : err.code;
        return RETRYABLE_CODES.has(code);
    }
    return false;
}

/**
 * Run a Firestore write operation with exponential backoff on transient
 * errors. Non-retryable errors (permission-denied, invalid-argument,
 * failed-precondition, …) propagate immediately so callers can react.
 */
async function withRetry<T>(
    operation: () => Promise<T>,
    label: string
): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            return await operation();
        } catch (err) {
            lastError = err;
            if (!isRetryableFirestoreError(err) || attempt === MAX_RETRIES) {
                break;
            }
            // Exponential backoff with jitter: 100, 250, 600, 1300ms (±25%)
            const base = 100 * Math.pow(2.2, attempt);
            const delay = base * (0.75 + Math.random() * 0.5);
            console.warn(
                `[firestore] ${label} failed (attempt ${attempt + 1}/${
                    MAX_RETRIES + 1
                }), retrying in ${Math.round(delay)}ms`,
                err
            );
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }
    throw lastError;
}

/** Commit a batch with retry-on-transient-error semantics. */
function commitBatch(batch: WriteBatch, label: string): Promise<void> {
    return withRetry(() => batch.commit(), label);
}

/**
 * Recursively strip `undefined` values from objects and any nested objects
 * inside arrays. Preserves `Date` and `Timestamp` instances (unlike
 * `JSON.parse(JSON.stringify(...))`, which corrupts dates).
 *
 * Even though Firestore is configured with `ignoreUndefinedProperties: true`
 * (see `firebase-firestore.ts`), `undefined` ARRAY ELEMENTS still throw at
 * the SDK layer (the option only ignores undefined object properties).
 * This helper handles that case and keeps persisted docs minimal.
 */
function stripUndefined<T>(value: T): T {
    if (value === undefined || value === null) return value;
    if (value instanceof Date || value instanceof Timestamp) return value;
    if (Array.isArray(value)) {
        return value
            .filter((v) => v !== undefined)
            .map((v) => stripUndefined(v)) as unknown as T;
    }
    if (typeof value === 'object') {
        const result: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            if (v === undefined) continue;
            result[k] = stripUndefined(v);
        }
        return result as T;
    }
    return value;
}

/** Convert any Firestore Timestamp fields to JS Date recursively. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function timestampsToDate(data: any): any {
    if (data instanceof Timestamp) return data.toDate();
    if (Array.isArray(data)) return data.map(timestampsToDate);
    if (data && typeof data === 'object') {
        return Object.fromEntries(
            Object.entries(data).map(([k, v]) => [k, timestampsToDate(v)])
        );
    }
    return data;
}

/**
 * Delete all documents in a collection, respecting Firestore's 500-op batch
 * limit by chunking.
 */
async function deleteCollection(collectionPath: string): Promise<void> {
    const col = collection(firestore, collectionPath);
    const snap = await getDocs(col);
    if (snap.empty) return;

    const docs = snap.docs;
    for (let i = 0; i < docs.length; i += BATCH_LIMIT) {
        const batch = writeBatch(firestore);
        docs.slice(i, i + BATCH_LIMIT).forEach((d) => batch.delete(d.ref));
        await commitBatch(batch, `deleteCollection(${collectionPath})`);
    }
}

// ---------------------------------------------------------------------------
// Path helpers (all data lives under users/{userId}/...)
// ---------------------------------------------------------------------------

const configDocPath = (uid: string) => `users/${uid}/config/main`;

const diagramsCol = (uid: string) => `users/${uid}/diagrams`;
const diagramDocPath = (uid: string, diagramId: string) =>
    `${diagramsCol(uid)}/${diagramId}`;

const subCol = (uid: string, diagramId: string, name: string) =>
    `${diagramDocPath(uid, diagramId)}/${name}`;

const SUB_COLLECTIONS = [
    'db_tables',
    'db_relationships',
    'db_dependencies',
    'areas',
    'db_custom_types',
    'notes',
    'diagram_filters',
] as const;

/**
 * Update an entity (table/relationship/dependency/area/customType/note) by
 * id without knowing its parent diagram up-front.
 *
 * Strategy: check the user's default diagram first (the overwhelmingly
 * common case), then fall back to scanning all diagrams. This is a
 * compatibility shim for `StorageContext.updateXxx` signatures that don't
 * accept a `diagramId`. The diagrams collection is small in practice
 * (typically <100 docs per user), so the worst-case fan-out is bounded.
 *
 * Logs a warning if the entity isn't found anywhere \u2014 silent no-ops are
 * notoriously hard to debug.
 */
async function updateEntityById(
    uid: string,
    collectionName: (typeof SUB_COLLECTIONS)[number],
    entityId: string,
    attributes: object,
    label: string
): Promise<void> {
    const configSnap = await getDoc(doc(firestore, configDocPath(uid)));
    const defaultId = configSnap.exists()
        ? (configSnap.data() as ChartDBConfig).defaultDiagramId
        : undefined;

    const tryUpdate = async (diagramId: string): Promise<boolean> => {
        const ref = doc(
            firestore,
            subCol(uid, diagramId, collectionName),
            entityId
        );
        const snap = await getDoc(ref);
        if (!snap.exists()) return false;
        await withRetry(
            () => updateDoc(ref, stripUndefined(attributes)),
            `${label}(${entityId}) in ${diagramId}`
        );
        return true;
    };

    if (defaultId && (await tryUpdate(defaultId))) return;

    const snap = await getDocs(collection(firestore, diagramsCol(uid)));
    for (const diagramSnap of snap.docs) {
        if (diagramSnap.id === defaultId) continue;
        if (await tryUpdate(diagramSnap.id)) return;
    }

    console.warn(
        `[firestore] ${label}: entity "${entityId}" not found in any diagram; ` +
            `update was a no-op.`
    );
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const FirestoreStorageProvider: React.FC<
    React.PropsWithChildren<{ uid: string }>
> = ({ children, uid }) => {
    // -----------------------------------------------------------------------
    // Config
    // -----------------------------------------------------------------------

    const getConfig: StorageContext['getConfig'] =
        useCallback(async (): Promise<ChartDBConfig | undefined> => {
            const snap = await getDoc(doc(firestore, configDocPath(uid)));
            if (!snap.exists()) return undefined;
            return timestampsToDate(snap.data()) as ChartDBConfig;
        }, [uid]);

    const updateConfig: StorageContext['updateConfig'] = useCallback(
        async (config) => {
            await setDoc(
                doc(firestore, configDocPath(uid)),
                stripUndefined(config),
                {
                    merge: true,
                }
            );
        },
        [uid]
    );

    // -----------------------------------------------------------------------
    // Diagram filter
    // -----------------------------------------------------------------------

    const getDiagramFilter: StorageContext['getDiagramFilter'] = useCallback(
        async (diagramId): Promise<DiagramFilter | undefined> => {
            const ref = doc(
                firestore,
                subCol(uid, diagramId, 'diagram_filters'),
                diagramId
            );
            const snap = await getDoc(ref);
            if (!snap.exists()) return undefined;
            return snap.data() as DiagramFilter;
        },
        [uid]
    );

    const updateDiagramFilter: StorageContext['updateDiagramFilter'] =
        useCallback(
            async (diagramId, filter): Promise<void> => {
                const ref = doc(
                    firestore,
                    subCol(uid, diagramId, 'diagram_filters'),
                    diagramId
                );
                await setDoc(ref, stripUndefined(filter));
            },
            [uid]
        );

    const deleteDiagramFilter: StorageContext['deleteDiagramFilter'] =
        useCallback(
            async (diagramId): Promise<void> => {
                const ref = doc(
                    firestore,
                    subCol(uid, diagramId, 'diagram_filters'),
                    diagramId
                );
                await deleteDoc(ref);
            },
            [uid]
        );

    // -----------------------------------------------------------------------
    // Tables
    // -----------------------------------------------------------------------

    const addTable: StorageContext['addTable'] = useCallback(
        async ({ diagramId, table }) => {
            const ref = doc(
                firestore,
                subCol(uid, diagramId, 'db_tables'),
                table.id
            );
            await setDoc(ref, stripUndefined(table));
        },
        [uid]
    );

    const getTable: StorageContext['getTable'] = useCallback(
        async ({ diagramId, id }): Promise<DBTable | undefined> => {
            const ref = doc(firestore, subCol(uid, diagramId, 'db_tables'), id);
            const snap = await getDoc(ref);
            if (!snap.exists()) return undefined;
            return timestampsToDate(snap.data()) as DBTable;
        },
        [uid]
    );

    const updateTable: StorageContext['updateTable'] = useCallback(
        async ({ id, attributes }) => {
            await updateEntityById(
                uid,
                'db_tables',
                id,
                attributes,
                'updateTable'
            );
        },
        [uid]
    );

    const putTable: StorageContext['putTable'] = useCallback(
        async ({ diagramId, table }) => {
            const ref = doc(
                firestore,
                subCol(uid, diagramId, 'db_tables'),
                table.id
            );
            await setDoc(ref, stripUndefined(table), { merge: true });
        },
        [uid]
    );

    const deleteTable: StorageContext['deleteTable'] = useCallback(
        async ({ diagramId, id }) => {
            await deleteDoc(
                doc(firestore, subCol(uid, diagramId, 'db_tables'), id)
            );
        },
        [uid]
    );

    const listTables: StorageContext['listTables'] = useCallback(
        async (diagramId): Promise<DBTable[]> => {
            const snap = await getDocs(
                collection(firestore, subCol(uid, diagramId, 'db_tables'))
            );
            return snap.docs.map((d) => timestampsToDate(d.data()) as DBTable);
        },
        [uid]
    );

    const deleteDiagramTables: StorageContext['deleteDiagramTables'] =
        useCallback(
            async (diagramId) => {
                await deleteCollection(subCol(uid, diagramId, 'db_tables'));
            },
            [uid]
        );

    // -----------------------------------------------------------------------
    // Relationships
    // -----------------------------------------------------------------------

    const addRelationship: StorageContext['addRelationship'] = useCallback(
        async ({ diagramId, relationship }) => {
            const ref = doc(
                firestore,
                subCol(uid, diagramId, 'db_relationships'),
                relationship.id
            );
            await setDoc(ref, stripUndefined(relationship));
        },
        [uid]
    );

    const getRelationship: StorageContext['getRelationship'] = useCallback(
        async ({ diagramId, id }): Promise<DBRelationship | undefined> => {
            const ref = doc(
                firestore,
                subCol(uid, diagramId, 'db_relationships'),
                id
            );
            const snap = await getDoc(ref);
            if (!snap.exists()) return undefined;
            return timestampsToDate(snap.data()) as DBRelationship;
        },
        [uid]
    );

    const updateRelationship: StorageContext['updateRelationship'] =
        useCallback(
            async ({ id, attributes }) => {
                await updateEntityById(
                    uid,
                    'db_relationships',
                    id,
                    attributes,
                    'updateRelationship'
                );
            },
            [uid]
        );

    const deleteRelationship: StorageContext['deleteRelationship'] =
        useCallback(
            async ({ diagramId, id }) => {
                await deleteDoc(
                    doc(
                        firestore,
                        subCol(uid, diagramId, 'db_relationships'),
                        id
                    )
                );
            },
            [uid]
        );

    const listRelationships: StorageContext['listRelationships'] = useCallback(
        async (diagramId): Promise<DBRelationship[]> => {
            const snap = await getDocs(
                collection(
                    firestore,
                    subCol(uid, diagramId, 'db_relationships')
                )
            );
            return snap.docs
                .map((d) => timestampsToDate(d.data()) as DBRelationship)
                .sort((a, b) => a.name.localeCompare(b.name));
        },
        [uid]
    );

    const deleteDiagramRelationships: StorageContext['deleteDiagramRelationships'] =
        useCallback(
            async (diagramId) => {
                await deleteCollection(
                    subCol(uid, diagramId, 'db_relationships')
                );
            },
            [uid]
        );

    // -----------------------------------------------------------------------
    // Dependencies
    // -----------------------------------------------------------------------

    const addDependency: StorageContext['addDependency'] = useCallback(
        async ({ diagramId, dependency }) => {
            const ref = doc(
                firestore,
                subCol(uid, diagramId, 'db_dependencies'),
                dependency.id
            );
            await setDoc(ref, stripUndefined(dependency));
        },
        [uid]
    );

    const getDependency: StorageContext['getDependency'] = useCallback(
        async ({ diagramId, id }): Promise<DBDependency | undefined> => {
            const ref = doc(
                firestore,
                subCol(uid, diagramId, 'db_dependencies'),
                id
            );
            const snap = await getDoc(ref);
            if (!snap.exists()) return undefined;
            return timestampsToDate(snap.data()) as DBDependency;
        },
        [uid]
    );

    const updateDependency: StorageContext['updateDependency'] = useCallback(
        async ({ id, attributes }) => {
            await updateEntityById(
                uid,
                'db_dependencies',
                id,
                attributes,
                'updateDependency'
            );
        },
        [uid]
    );

    const deleteDependency: StorageContext['deleteDependency'] = useCallback(
        async ({ diagramId, id }) => {
            await deleteDoc(
                doc(firestore, subCol(uid, diagramId, 'db_dependencies'), id)
            );
        },
        [uid]
    );

    const listDependencies: StorageContext['listDependencies'] = useCallback(
        async (diagramId): Promise<DBDependency[]> => {
            const snap = await getDocs(
                collection(firestore, subCol(uid, diagramId, 'db_dependencies'))
            );
            return snap.docs.map(
                (d) => timestampsToDate(d.data()) as DBDependency
            );
        },
        [uid]
    );

    const deleteDiagramDependencies: StorageContext['deleteDiagramDependencies'] =
        useCallback(
            async (diagramId) => {
                await deleteCollection(
                    subCol(uid, diagramId, 'db_dependencies')
                );
            },
            [uid]
        );

    // -----------------------------------------------------------------------
    // Areas
    // -----------------------------------------------------------------------

    const addArea: StorageContext['addArea'] = useCallback(
        async ({ diagramId, area }) => {
            const ref = doc(
                firestore,
                subCol(uid, diagramId, 'areas'),
                area.id
            );
            await setDoc(ref, stripUndefined(area));
        },
        [uid]
    );

    const getArea: StorageContext['getArea'] = useCallback(
        async ({ diagramId, id }): Promise<Area | undefined> => {
            const ref = doc(firestore, subCol(uid, diagramId, 'areas'), id);
            const snap = await getDoc(ref);
            if (!snap.exists()) return undefined;
            return timestampsToDate(snap.data()) as Area;
        },
        [uid]
    );

    const updateArea: StorageContext['updateArea'] = useCallback(
        async ({ id, attributes }) => {
            await updateEntityById(uid, 'areas', id, attributes, 'updateArea');
        },
        [uid]
    );

    const deleteArea: StorageContext['deleteArea'] = useCallback(
        async ({ diagramId, id }) => {
            await deleteDoc(
                doc(firestore, subCol(uid, diagramId, 'areas'), id)
            );
        },
        [uid]
    );

    const listAreas: StorageContext['listAreas'] = useCallback(
        async (diagramId): Promise<Area[]> => {
            const snap = await getDocs(
                collection(firestore, subCol(uid, diagramId, 'areas'))
            );
            return snap.docs.map((d) => timestampsToDate(d.data()) as Area);
        },
        [uid]
    );

    const deleteDiagramAreas: StorageContext['deleteDiagramAreas'] =
        useCallback(
            async (diagramId) => {
                await deleteCollection(subCol(uid, diagramId, 'areas'));
            },
            [uid]
        );

    // -----------------------------------------------------------------------
    // Custom types
    // -----------------------------------------------------------------------

    const addCustomType: StorageContext['addCustomType'] = useCallback(
        async ({ diagramId, customType }) => {
            const ref = doc(
                firestore,
                subCol(uid, diagramId, 'db_custom_types'),
                customType.id
            );
            await setDoc(ref, stripUndefined(customType));
        },
        [uid]
    );

    const getCustomType: StorageContext['getCustomType'] = useCallback(
        async ({ diagramId, id }): Promise<DBCustomType | undefined> => {
            const ref = doc(
                firestore,
                subCol(uid, diagramId, 'db_custom_types'),
                id
            );
            const snap = await getDoc(ref);
            if (!snap.exists()) return undefined;
            return timestampsToDate(snap.data()) as DBCustomType;
        },
        [uid]
    );

    const updateCustomType: StorageContext['updateCustomType'] = useCallback(
        async ({ id, attributes }) => {
            await updateEntityById(
                uid,
                'db_custom_types',
                id,
                attributes,
                'updateCustomType'
            );
        },
        [uid]
    );

    const deleteCustomType: StorageContext['deleteCustomType'] = useCallback(
        async ({ diagramId, id }) => {
            await deleteDoc(
                doc(firestore, subCol(uid, diagramId, 'db_custom_types'), id)
            );
        },
        [uid]
    );

    const listCustomTypes: StorageContext['listCustomTypes'] = useCallback(
        async (diagramId): Promise<DBCustomType[]> => {
            const snap = await getDocs(
                collection(firestore, subCol(uid, diagramId, 'db_custom_types'))
            );
            return snap.docs
                .map((d) => timestampsToDate(d.data()) as DBCustomType)
                .sort((a, b) => a.name.localeCompare(b.name));
        },
        [uid]
    );

    const deleteDiagramCustomTypes: StorageContext['deleteDiagramCustomTypes'] =
        useCallback(
            async (diagramId) => {
                await deleteCollection(
                    subCol(uid, diagramId, 'db_custom_types')
                );
            },
            [uid]
        );

    // -----------------------------------------------------------------------
    // Notes
    // -----------------------------------------------------------------------

    const addNote: StorageContext['addNote'] = useCallback(
        async ({ diagramId, note }) => {
            const ref = doc(
                firestore,
                subCol(uid, diagramId, 'notes'),
                note.id
            );
            await setDoc(ref, stripUndefined(note));
        },
        [uid]
    );

    const getNote: StorageContext['getNote'] = useCallback(
        async ({ diagramId, id }): Promise<Note | undefined> => {
            const ref = doc(firestore, subCol(uid, diagramId, 'notes'), id);
            const snap = await getDoc(ref);
            if (!snap.exists()) return undefined;
            return timestampsToDate(snap.data()) as Note;
        },
        [uid]
    );

    const updateNote: StorageContext['updateNote'] = useCallback(
        async ({ id, attributes }) => {
            await updateEntityById(uid, 'notes', id, attributes, 'updateNote');
        },
        [uid]
    );

    const deleteNote: StorageContext['deleteNote'] = useCallback(
        async ({ diagramId, id }) => {
            await deleteDoc(
                doc(firestore, subCol(uid, diagramId, 'notes'), id)
            );
        },
        [uid]
    );

    const listNotes: StorageContext['listNotes'] = useCallback(
        async (diagramId): Promise<Note[]> => {
            const snap = await getDocs(
                collection(firestore, subCol(uid, diagramId, 'notes'))
            );
            return snap.docs.map((d) => timestampsToDate(d.data()) as Note);
        },
        [uid]
    );

    const deleteDiagramNotes: StorageContext['deleteDiagramNotes'] =
        useCallback(
            async (diagramId) => {
                await deleteCollection(subCol(uid, diagramId, 'notes'));
            },
            [uid]
        );

    // -----------------------------------------------------------------------
    // Diagrams
    // -----------------------------------------------------------------------

    /**
     * Add a full diagram with all sub-entities using batched writes.
     *
     * Write ordering is critical for crash-consistency: we write all
     * sub-entity batches FIRST and the parent diagram doc LAST. This way,
     * if a sub-entity batch fails partway, the diagram document never
     * becomes visible in `listDiagrams`, so the caller can safely retry
     * without leaving an orphaned half-populated diagram in the UI.
     *
     * Sub-entity writes use the diagram id + entity id as the doc key, so
     * retries are idempotent (setDoc overwrites with the same data).
     */
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

            type WriteOp = { path: string; id: string; data: object };
            const ops: WriteOp[] = [];

            (tables ?? []).forEach((t) =>
                ops.push({
                    path: subCol(uid, diagram.id, 'db_tables'),
                    id: t.id,
                    data: stripUndefined(t),
                })
            );
            (relationships ?? []).forEach((r) =>
                ops.push({
                    path: subCol(uid, diagram.id, 'db_relationships'),
                    id: r.id,
                    data: stripUndefined(r),
                })
            );
            (dependencies ?? []).forEach((d) =>
                ops.push({
                    path: subCol(uid, diagram.id, 'db_dependencies'),
                    id: d.id,
                    data: stripUndefined(d),
                })
            );
            (areas ?? []).forEach((a) =>
                ops.push({
                    path: subCol(uid, diagram.id, 'areas'),
                    id: a.id,
                    data: stripUndefined(a),
                })
            );
            (customTypes ?? []).forEach((ct) =>
                ops.push({
                    path: subCol(uid, diagram.id, 'db_custom_types'),
                    id: ct.id,
                    data: stripUndefined(ct),
                })
            );
            (notes ?? []).forEach((n) =>
                ops.push({
                    path: subCol(uid, diagram.id, 'notes'),
                    id: n.id,
                    data: stripUndefined(n),
                })
            );

            // 1. Write sub-entities first (in 500-op chunks, idempotent).
            for (let i = 0; i < ops.length; i += BATCH_LIMIT) {
                const batch = writeBatch(firestore);
                ops.slice(i, i + BATCH_LIMIT).forEach((op) => {
                    batch.set(doc(firestore, op.path, op.id), op.data);
                });
                await commitBatch(
                    batch,
                    `addDiagram(${diagram.id}) batch ${
                        Math.floor(i / BATCH_LIMIT) + 1
                    }`
                );
            }

            // 2. Then write the diagram parent doc last. Until this succeeds
            //    the diagram is invisible to listDiagrams, making the whole
            //    operation atomic from the caller's point of view.
            await withRetry(
                () =>
                    setDoc(
                        doc(firestore, diagramDocPath(uid, diagram.id)),
                        stripUndefined(meta)
                    ),
                `addDiagram(${diagram.id}) meta`
            );
        },
        [uid]
    );

    /**
     * List diagrams. Fetches all sub-entities in parallel per diagram rather
     * than sequentially per option.
     */
    const listDiagrams: StorageContext['listDiagrams'] = useCallback(
        async (options = {}): Promise<Diagram[]> => {
            const snap = await getDocs(collection(firestore, diagramsCol(uid)));

            const diagrams: Diagram[] = await Promise.all(
                snap.docs.map(async (d) => {
                    let diagram = timestampsToDate(d.data()) as Diagram;

                    // Fetch all requested sub-entities in parallel
                    const [
                        tables,
                        relationships,
                        dependencies,
                        areasResult,
                        customTypesResult,
                        notesResult,
                    ] = await Promise.all([
                        options.includeTables
                            ? listTables(diagram.id)
                            : undefined,
                        options.includeRelationships
                            ? listRelationships(diagram.id)
                            : undefined,
                        options.includeDependencies
                            ? listDependencies(diagram.id)
                            : undefined,
                        options.includeAreas
                            ? listAreas(diagram.id)
                            : undefined,
                        options.includeCustomTypes
                            ? listCustomTypes(diagram.id)
                            : undefined,
                        options.includeNotes
                            ? listNotes(diagram.id)
                            : undefined,
                    ]);

                    if (tables) diagram = { ...diagram, tables };
                    if (relationships) diagram = { ...diagram, relationships };
                    if (dependencies) diagram = { ...diagram, dependencies };
                    if (areasResult)
                        diagram = { ...diagram, areas: areasResult };
                    if (customTypesResult)
                        diagram = {
                            ...diagram,
                            customTypes: customTypesResult,
                        };
                    if (notesResult)
                        diagram = { ...diagram, notes: notesResult };

                    return diagram;
                })
            );

            return diagrams;
        },
        [
            uid,
            listTables,
            listRelationships,
            listDependencies,
            listAreas,
            listCustomTypes,
            listNotes,
        ]
    );

    /**
     * Get a single diagram with optional sub-entities loaded in parallel.
     */
    const getDiagram: StorageContext['getDiagram'] = useCallback(
        async (id, options = {}): Promise<Diagram | undefined> => {
            const ref = doc(firestore, diagramDocPath(uid, id));
            const snap = await getDoc(ref);
            if (!snap.exists()) return undefined;

            let diagram = timestampsToDate(snap.data()) as Diagram;

            const [
                tables,
                relationships,
                dependencies,
                areasResult,
                customTypesResult,
                notesResult,
            ] = await Promise.all([
                options.includeTables ? listTables(id) : undefined,
                options.includeRelationships
                    ? listRelationships(id)
                    : undefined,
                options.includeDependencies ? listDependencies(id) : undefined,
                options.includeAreas ? listAreas(id) : undefined,
                options.includeCustomTypes ? listCustomTypes(id) : undefined,
                options.includeNotes ? listNotes(id) : undefined,
            ]);

            if (tables) diagram = { ...diagram, tables };
            if (relationships) diagram = { ...diagram, relationships };
            if (dependencies) diagram = { ...diagram, dependencies };
            if (areasResult) diagram = { ...diagram, areas: areasResult };
            if (customTypesResult)
                diagram = { ...diagram, customTypes: customTypesResult };
            if (notesResult) diagram = { ...diagram, notes: notesResult };

            return diagram;
        },
        [
            uid,
            listTables,
            listRelationships,
            listDependencies,
            listAreas,
            listCustomTypes,
            listNotes,
        ]
    );

    const updateDiagram: StorageContext['updateDiagram'] = useCallback(
        async ({ id, attributes }) => {
            if (attributes.id && attributes.id !== id) {
                // Rename: copy diagram + all sub-collections to new ID.
                //
                // Crash-consistency: we copy sub-collections FIRST, then
                // write the new parent doc, then clean up the old data.
                // This means at any failure point the user either sees the
                // old diagram intact (failure before new meta write) or the
                // new diagram intact (failure during cleanup) — never two
                // diagrams in an inconsistent state visible together.
                const oldRef = doc(firestore, diagramDocPath(uid, id));
                const oldSnap = await getDoc(oldRef);
                if (!oldSnap.exists()) return;

                const newId = attributes.id;
                const newRef = doc(firestore, diagramDocPath(uid, newId));

                // Refuse to overwrite an unrelated existing diagram.
                const newExisting = await getDoc(newRef);
                if (newExisting.exists()) {
                    throw new Error(
                        `Cannot rename diagram "${id}" to "${newId}": ` +
                            `target id already exists.`
                    );
                }

                // 1. Copy sub-collections to new path (without deleting old
                //    yet) so the operation stays re-runnable on failure.
                //    Each doc consumes ONE write here (set on new path).
                await Promise.all(
                    SUB_COLLECTIONS.map(async (colName) => {
                        const oldCol = collection(
                            firestore,
                            subCol(uid, id, colName)
                        );
                        const snap = await getDocs(oldCol);
                        if (snap.empty) return;

                        const docs = snap.docs;
                        for (let i = 0; i < docs.length; i += BATCH_LIMIT) {
                            const batch = writeBatch(firestore);
                            docs.slice(i, i + BATCH_LIMIT).forEach((d) => {
                                batch.set(
                                    doc(
                                        firestore,
                                        subCol(uid, newId, colName),
                                        d.id
                                    ),
                                    d.data()
                                );
                            });
                            await commitBatch(
                                batch,
                                `rename(${id}→${newId}) copy ${colName}`
                            );
                        }
                    })
                );

                // 2. Write the new parent doc. Once this succeeds the new
                //    diagram is visible to listDiagrams.
                await withRetry(
                    () =>
                        setDoc(
                            newRef,
                            stripUndefined({
                                ...oldSnap.data(),
                                ...attributes,
                            })
                        ),
                    `rename(${id}→${newId}) meta`
                );

                // 3. Clean up old data. If this fails the new diagram is
                //    still intact — leftover old docs can be retried later.
                await Promise.all(
                    SUB_COLLECTIONS.map((colName) =>
                        deleteCollection(subCol(uid, id, colName))
                    )
                );
                await withRetry(
                    () => deleteDoc(oldRef),
                    `rename(${id}→${newId}) delete old`
                );
            } else {
                // Normal update — strip the `id` field to avoid overwriting it
                const { id: _id, ...rest } = attributes as Partial<Diagram> & {
                    id?: string;
                };
                void _id;
                if (Object.keys(rest).length > 0) {
                    await withRetry(
                        () =>
                            updateDoc(
                                doc(firestore, diagramDocPath(uid, id)),
                                stripUndefined(rest)
                            ),
                        `updateDiagram(${id})`
                    );
                }
            }
        },
        [uid]
    );

    /**
     * Delete diagram and all sub-collections in parallel, respecting batch limits.
     */
    const deleteDiagram: StorageContext['deleteDiagram'] = useCallback(
        async (id) => {
            await Promise.all(
                SUB_COLLECTIONS.map((colName) =>
                    deleteCollection(subCol(uid, id, colName))
                )
            );
            await deleteDoc(doc(firestore, diagramDocPath(uid, id)));
        },
        [uid]
    );

    // -----------------------------------------------------------------------
    // Context value — memoized to avoid unnecessary re-renders
    // -----------------------------------------------------------------------

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

    return (
        <storageContext.Provider value={value}>
            {children}
        </storageContext.Provider>
    );
};
