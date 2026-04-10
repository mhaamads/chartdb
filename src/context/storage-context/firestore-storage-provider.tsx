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
} from 'firebase/firestore';
import React, { useCallback, useMemo } from 'react';
import type { StorageContext } from './storage-context';
import { storageContext } from './storage-context';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Max operations per Firestore batch. */
const BATCH_LIMIT = 499;

/**
 * Strip `undefined` values so Firestore doesn't throw, while preserving
 * Date objects (unlike JSON.parse(JSON.stringify()) which corrupts them).
 */
function stripUndefined<T extends object>(obj: T): T {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
        if (value === undefined) continue;
        if (
            value !== null &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            !(value instanceof Date) &&
            !(value instanceof Timestamp)
        ) {
            result[key] = stripUndefined(value as Record<string, unknown>);
        } else {
            result[key] = value;
        }
    }
    return result as T;
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
        await batch.commit();
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
            // The interface doesn't pass diagramId. Retrieve it from config's
            // current diagram, falling back to searching all diagrams.
            const configSnap = await getDoc(doc(firestore, configDocPath(uid)));
            const defaultId = configSnap.exists()
                ? (configSnap.data() as ChartDBConfig).defaultDiagramId
                : undefined;

            if (defaultId) {
                const tableRef = doc(
                    firestore,
                    subCol(uid, defaultId, 'db_tables'),
                    id
                );
                const tableSnap = await getDoc(tableRef);
                if (tableSnap.exists()) {
                    await updateDoc(tableRef, stripUndefined(attributes));
                    return;
                }
            }

            // Fallback: search all diagrams
            const snap = await getDocs(collection(firestore, diagramsCol(uid)));
            for (const diagramSnap of snap.docs) {
                if (diagramSnap.id === defaultId) continue; // already checked
                const tableRef = doc(
                    firestore,
                    subCol(uid, diagramSnap.id, 'db_tables'),
                    id
                );
                const tableSnap = await getDoc(tableRef);
                if (tableSnap.exists()) {
                    await updateDoc(tableRef, stripUndefined(attributes));
                    return;
                }
            }
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
                const configSnap = await getDoc(
                    doc(firestore, configDocPath(uid))
                );
                const defaultId = configSnap.exists()
                    ? (configSnap.data() as ChartDBConfig).defaultDiagramId
                    : undefined;

                if (defaultId) {
                    const relRef = doc(
                        firestore,
                        subCol(uid, defaultId, 'db_relationships'),
                        id
                    );
                    const relSnap = await getDoc(relRef);
                    if (relSnap.exists()) {
                        await updateDoc(relRef, stripUndefined(attributes));
                        return;
                    }
                }

                const snap = await getDocs(
                    collection(firestore, diagramsCol(uid))
                );
                for (const diagramSnap of snap.docs) {
                    if (diagramSnap.id === defaultId) continue;
                    const relRef = doc(
                        firestore,
                        subCol(uid, diagramSnap.id, 'db_relationships'),
                        id
                    );
                    const relSnap = await getDoc(relRef);
                    if (relSnap.exists()) {
                        await updateDoc(relRef, stripUndefined(attributes));
                        return;
                    }
                }
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
            const configSnap = await getDoc(doc(firestore, configDocPath(uid)));
            const defaultId = configSnap.exists()
                ? (configSnap.data() as ChartDBConfig).defaultDiagramId
                : undefined;

            if (defaultId) {
                const depRef = doc(
                    firestore,
                    subCol(uid, defaultId, 'db_dependencies'),
                    id
                );
                const depSnap = await getDoc(depRef);
                if (depSnap.exists()) {
                    await updateDoc(depRef, stripUndefined(attributes));
                    return;
                }
            }

            const snap = await getDocs(collection(firestore, diagramsCol(uid)));
            for (const diagramSnap of snap.docs) {
                if (diagramSnap.id === defaultId) continue;
                const depRef = doc(
                    firestore,
                    subCol(uid, diagramSnap.id, 'db_dependencies'),
                    id
                );
                const depSnap = await getDoc(depRef);
                if (depSnap.exists()) {
                    await updateDoc(depRef, stripUndefined(attributes));
                    return;
                }
            }
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
            const configSnap = await getDoc(doc(firestore, configDocPath(uid)));
            const defaultId = configSnap.exists()
                ? (configSnap.data() as ChartDBConfig).defaultDiagramId
                : undefined;

            if (defaultId) {
                const areaRef = doc(
                    firestore,
                    subCol(uid, defaultId, 'areas'),
                    id
                );
                const areaSnap = await getDoc(areaRef);
                if (areaSnap.exists()) {
                    await updateDoc(areaRef, stripUndefined(attributes));
                    return;
                }
            }

            const snap = await getDocs(collection(firestore, diagramsCol(uid)));
            for (const diagramSnap of snap.docs) {
                if (diagramSnap.id === defaultId) continue;
                const areaRef = doc(
                    firestore,
                    subCol(uid, diagramSnap.id, 'areas'),
                    id
                );
                const areaSnap = await getDoc(areaRef);
                if (areaSnap.exists()) {
                    await updateDoc(areaRef, stripUndefined(attributes));
                    return;
                }
            }
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
            const configSnap = await getDoc(doc(firestore, configDocPath(uid)));
            const defaultId = configSnap.exists()
                ? (configSnap.data() as ChartDBConfig).defaultDiagramId
                : undefined;

            if (defaultId) {
                const ctRef = doc(
                    firestore,
                    subCol(uid, defaultId, 'db_custom_types'),
                    id
                );
                const ctSnap = await getDoc(ctRef);
                if (ctSnap.exists()) {
                    await updateDoc(ctRef, stripUndefined(attributes));
                    return;
                }
            }

            const snap = await getDocs(collection(firestore, diagramsCol(uid)));
            for (const diagramSnap of snap.docs) {
                if (diagramSnap.id === defaultId) continue;
                const ctRef = doc(
                    firestore,
                    subCol(uid, diagramSnap.id, 'db_custom_types'),
                    id
                );
                const ctSnap = await getDoc(ctRef);
                if (ctSnap.exists()) {
                    await updateDoc(ctRef, stripUndefined(attributes));
                    return;
                }
            }
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
            const configSnap = await getDoc(doc(firestore, configDocPath(uid)));
            const defaultId = configSnap.exists()
                ? (configSnap.data() as ChartDBConfig).defaultDiagramId
                : undefined;

            if (defaultId) {
                const noteRef = doc(
                    firestore,
                    subCol(uid, defaultId, 'notes'),
                    id
                );
                const noteSnap = await getDoc(noteRef);
                if (noteSnap.exists()) {
                    await updateDoc(noteRef, stripUndefined(attributes));
                    return;
                }
            }

            const snap = await getDocs(collection(firestore, diagramsCol(uid)));
            for (const diagramSnap of snap.docs) {
                if (diagramSnap.id === defaultId) continue;
                const noteRef = doc(
                    firestore,
                    subCol(uid, diagramSnap.id, 'notes'),
                    id
                );
                const noteSnap = await getDoc(noteRef);
                if (noteSnap.exists()) {
                    await updateDoc(noteRef, stripUndefined(attributes));
                    return;
                }
            }
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
     * Chunks into batches of 499 to respect Firestore's 500-op limit.
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

            // Collect all ops: [path, data]
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

            // First batch: diagram metadata + first chunk of sub-entities
            for (let i = 0; i < ops.length; i += BATCH_LIMIT) {
                const batch = writeBatch(firestore);
                if (i === 0) {
                    // Include the diagram doc itself in the first batch
                    batch.set(
                        doc(firestore, diagramDocPath(uid, diagram.id)),
                        stripUndefined(meta)
                    );
                }
                ops.slice(i, i + BATCH_LIMIT).forEach((op) => {
                    batch.set(doc(firestore, op.path, op.id), op.data);
                });
                await batch.commit();
            }

            // If no sub-entities, still write the diagram doc
            if (ops.length === 0) {
                await setDoc(
                    doc(firestore, diagramDocPath(uid, diagram.id)),
                    stripUndefined(meta)
                );
            }
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
                // Rename: copy diagram + all sub-collections to new ID
                const oldRef = doc(firestore, diagramDocPath(uid, id));
                const oldSnap = await getDoc(oldRef);
                if (!oldSnap.exists()) return;

                const newId = attributes.id;
                const newRef = doc(firestore, diagramDocPath(uid, newId));

                await setDoc(
                    newRef,
                    stripUndefined({ ...oldSnap.data(), ...attributes })
                );

                // Copy + delete all sub-collections in parallel
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
                                batch.delete(d.ref);
                            });
                            await batch.commit();
                        }
                    })
                );

                await deleteDoc(oldRef);
            } else {
                // Normal update — strip the `id` field to avoid overwriting it
                const { id: _id, ...rest } = attributes as Partial<Diagram> & {
                    id?: string;
                };
                void _id;
                if (Object.keys(rest).length > 0) {
                    await updateDoc(
                        doc(firestore, diagramDocPath(uid, id)),
                        stripUndefined(rest)
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
