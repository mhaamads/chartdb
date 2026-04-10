import {
    initializeFirestore,
    persistentLocalCache,
    persistentMultipleTabManager,
} from 'firebase/firestore';
import { firebaseApp } from './firebase-config';

/**
 * Initialize Firestore with persistent local cache for offline support.
 * Uses multi-tab synchronization so multiple browser tabs stay consistent.
 */
export const firestore = initializeFirestore(firebaseApp, {
    localCache: persistentLocalCache({
        tabManager: persistentMultipleTabManager(),
    }),
});
