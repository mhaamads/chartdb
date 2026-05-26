/**
 * Surface the hybrid storage sync state to the user.
 *
 * Renders a small status pill in the top navbar:
 *   - green dot + "Synced"            → no pending ops
 *   - amber dot + "N unsynced"        → ops queued in local IndexedDB
 *   - red dot + "Offline"             → navigator reports offline
 *   - spinner + "Syncing..."          → flush in progress
 *
 * Clicking the pill opens a dialog with a per-collection breakdown of
 * what's still queued, the last error captured during replay, and a
 * "Sync now" button that drains the queue on demand.
 *
 * The component is a no-op for routes that don't have the hybrid storage
 * layer mounted (anonymous mode), so it's safe to render unconditionally.
 */

import React, { useMemo, useState } from 'react';
import { Loader2, RefreshCw, WifiOff } from 'lucide-react';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/dialog/dialog';
import { Button } from '@/components/button/button';
import { ScrollArea } from '@/components/scroll-area/scroll-area';
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from '@/components/tooltip/tooltip';
import { useSyncStatus } from '@/context/sync-status-context/sync-status-context';
import { cn } from '@/lib/utils';
import type { PendingOp } from '@/lib/storage/local-backup';

/**
 * Map a pending op variant to a human-readable collection label. Keeps the
 * dialog readable without leaking the internal `kind` string.
 */
function collectionLabel(op: PendingOp): string {
    switch (op.kind) {
        case 'updateConfig':
            return 'Config';
        case 'updateDiagramFilter':
        case 'deleteDiagramFilter':
            return 'Diagram filters';
        case 'addDiagram':
        case 'updateDiagram':
        case 'deleteDiagram':
            return 'Diagrams';
        case 'addTable':
        case 'updateTable':
        case 'putTable':
        case 'deleteTable':
        case 'deleteDiagramTables':
            return 'Tables';
        case 'addRelationship':
        case 'updateRelationship':
        case 'deleteRelationship':
        case 'deleteDiagramRelationships':
            return 'Relationships';
        case 'addDependency':
        case 'updateDependency':
        case 'deleteDependency':
        case 'deleteDiagramDependencies':
            return 'Dependencies';
        case 'addArea':
        case 'updateArea':
        case 'deleteArea':
        case 'deleteDiagramAreas':
            return 'Areas';
        case 'addCustomType':
        case 'updateCustomType':
        case 'deleteCustomType':
        case 'deleteDiagramCustomTypes':
            return 'Custom types';
        case 'addNote':
        case 'updateNote':
        case 'deleteNote':
        case 'deleteDiagramNotes':
            return 'Notes';
    }
}

function formatRelative(ts: number): string {
    const diff = Date.now() - ts;
    if (diff < 60_000) return 'just now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return new Date(ts).toLocaleString();
}

export const SyncStatusIndicator: React.FC = () => {
    const {
        pendingOps,
        isFlushing,
        isOnline,
        lastBootstrapAt,
        syncNow,
        isAvailable,
    } = useSyncStatus();
    const [open, setOpen] = useState(false);

    // Group pending ops by user-facing collection for the dialog breakdown.
    const grouped = useMemo(() => {
        const map = new Map<string, number>();
        for (const record of pendingOps) {
            const label = collectionLabel(record.op);
            map.set(label, (map.get(label) ?? 0) + 1);
        }
        return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
    }, [pendingOps]);

    const lastError = useMemo(() => {
        // Surface the most recent error from the queue head (the op that's
        // currently blocking progress) — that's the actionable one.
        const head = pendingOps[0];
        return head?.lastError;
    }, [pendingOps]);

    if (!isAvailable) return null;

    const pendingCount = pendingOps.length;
    const hasPending = pendingCount > 0;

    // Pick the right pill style. We use Tailwind semantic colors that
    // already track the active theme (light/dark) elsewhere in the app.
    let dotClass = 'bg-emerald-500';
    let label = 'Synced';
    let icon: React.ReactNode = null;
    if (!isOnline) {
        dotClass = 'bg-red-500';
        label = 'Offline';
        icon = <WifiOff className="size-3" />;
    } else if (isFlushing) {
        dotClass = 'bg-blue-500';
        label = 'Syncing…';
        icon = <Loader2 className="size-3 animate-spin" />;
    } else if (hasPending) {
        dotClass = 'bg-amber-500 animate-pulse';
        label = `${pendingCount} unsynced`;
    }

    return (
        <>
            <Tooltip>
                <TooltipTrigger asChild>
                    <button
                        type="button"
                        onClick={() => setOpen(true)}
                        aria-label="Open sync status"
                        className={cn(
                            'flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs',
                            'transition-colors hover:bg-accent hover:text-accent-foreground',
                            'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring'
                        )}
                    >
                        {icon ?? (
                            <span
                                className={cn(
                                    'inline-block size-2 rounded-full',
                                    dotClass
                                )}
                            />
                        )}
                        <span className="whitespace-nowrap text-muted-foreground">
                            {label}
                        </span>
                    </button>
                </TooltipTrigger>
                <TooltipContent>
                    {hasPending
                        ? `${pendingCount} change${
                              pendingCount === 1 ? '' : 's'
                          } stored locally, not yet synced to cloud`
                        : 'All local changes are synced to the cloud'}
                </TooltipContent>
            </Tooltip>

            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="flex flex-col" showClose>
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <span
                                className={cn(
                                    'inline-block size-2.5 rounded-full',
                                    dotClass
                                )}
                            />
                            Sync status
                        </DialogTitle>
                        <DialogDescription>
                            {hasPending
                                ? 'These changes are safely saved on this device and will be uploaded to the cloud automatically when possible.'
                                : 'All changes on this device are up to date with the cloud.'}
                        </DialogDescription>
                    </DialogHeader>

                    <div className="flex flex-col gap-3 text-sm">
                        <div className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2">
                            <span className="text-muted-foreground">
                                Network
                            </span>
                            <span
                                className={cn(
                                    'font-medium',
                                    isOnline
                                        ? 'text-emerald-600 dark:text-emerald-400'
                                        : 'text-red-600 dark:text-red-400'
                                )}
                            >
                                {isOnline ? 'Online' : 'Offline'}
                            </span>
                        </div>
                        <div className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2">
                            <span className="text-muted-foreground">
                                Last cloud sync
                            </span>
                            <span className="font-medium">
                                {lastBootstrapAt
                                    ? formatRelative(lastBootstrapAt)
                                    : 'Never'}
                            </span>
                        </div>
                        <div className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2">
                            <span className="text-muted-foreground">
                                Pending changes
                            </span>
                            <span
                                className={cn(
                                    'font-medium',
                                    hasPending
                                        ? 'text-amber-600 dark:text-amber-400'
                                        : 'text-emerald-600 dark:text-emerald-400'
                                )}
                            >
                                {pendingCount}
                            </span>
                        </div>

                        {hasPending && (
                            <div className="rounded-md border">
                                <div className="border-b px-3 py-2 text-xs font-medium uppercase text-muted-foreground">
                                    Stored locally · waiting to upload
                                </div>
                                <ScrollArea className="max-h-48">
                                    <ul className="divide-y">
                                        {grouped.map(([name, count]) => (
                                            <li
                                                key={name}
                                                className="flex items-center justify-between px-3 py-2"
                                            >
                                                <span>{name}</span>
                                                <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">
                                                    {count}
                                                </span>
                                            </li>
                                        ))}
                                    </ul>
                                </ScrollArea>
                            </div>
                        )}

                        {lastError && (
                            <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2">
                                <div className="text-xs font-medium uppercase text-red-600 dark:text-red-400">
                                    Last sync error
                                </div>
                                <div className="mt-1 break-words font-mono text-xs text-red-700 dark:text-red-300">
                                    {lastError}
                                </div>
                            </div>
                        )}

                        <p className="text-xs text-muted-foreground">
                            Local data lives in this browser&apos;s IndexedDB.
                            Switching to another device or browser may show
                            slightly older state until the next sync.
                        </p>
                    </div>

                    <DialogFooter className="flex gap-2 sm:justify-between">
                        <DialogClose asChild>
                            <Button variant="secondary">Close</Button>
                        </DialogClose>
                        <Button
                            onClick={() => void syncNow()}
                            disabled={isFlushing || !hasPending || !isOnline}
                        >
                            {isFlushing ? (
                                <Loader2 className="mr-2 size-4 animate-spin" />
                            ) : (
                                <RefreshCw className="mr-2 size-4" />
                            )}
                            {isFlushing ? 'Syncing…' : 'Sync now'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
};
