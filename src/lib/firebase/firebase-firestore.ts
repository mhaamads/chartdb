import {
    initializeFirestore,
    persistentLocalCache,
    persistentMultipleTabManager,
} from 'firebase/firestore';
import { firebaseApp } from './firebase-config';

/**
 * Initialize Firestore with persistent local cache for offline support.
 * Uses multi-tab synchronization so multiple browser tabs stay consistent.
 *
 * `ignoreUndefinedProperties: true` is critical: ChartDB's domain types
 * (DBField, DBIndex, DBCheckConstraint, etc.) contain many optional
 * properties that are often `undefined`. Without this flag Firestore throws
 * "Unsupported field value: undefined" on writes, which previously caused
 * tables / fields / relationships to silently fail to persist.
 */
export const firestore = initializeFirestore(firebaseApp, {
    localCache: persistentLocalCache({
        tabManager: persistentMultipleTabManager(),
    }),
    ignoreUndefinedProperties: true,
});
