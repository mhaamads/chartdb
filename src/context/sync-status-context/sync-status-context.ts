/**
 * Surface of the hybrid storage sync engine to the rest of the UI.
 *
 * `LocalMirrorLayer` publishes a value here so any component can render
 * sync indicators, show what's still queued, and trigger a manual flush
 * without having to know anything about Dexie or Firestore.
 */

import { createContext, useContext } from 'react';
import type { PendingOpRecord } from '@/lib/storage/local-backup';

export interface SyncStatusContextValue {
    /** Pending operations that haven't been replayed to Firestore yet. */
    pendingOps: PendingOpRecord[];
    /** True while a flush is currently running. */
    isFlushing: boolean;
    /** Mirror of `navigator.onLine`. */
    isOnline: boolean;
    /** ms since epoch of the last successful bootstrap pull. */
    lastBootstrapAt?: number;
    /** Trigger an immediate flush of the pending queue. */
    syncNow: () => Promise<void>;
    /** True when a hybrid storage layer is active in the tree. */
    isAvailable: boolean;
}

/**
 * The default value represents "no hybrid layer in this part of the tree"
 * (e.g. anonymous mode). Consumers should treat `isAvailable === false` as
 * "don't render the sync UI".
 */
export const syncStatusContext = createContext<SyncStatusContextValue>({
    pendingOps: [],
    isFlushing: false,
    isOnline: true,
    lastBootstrapAt: undefined,
    syncNow: async () => {},
    isAvailable: false,
});

export const useSyncStatus = () => useContext(syncStatusContext);
