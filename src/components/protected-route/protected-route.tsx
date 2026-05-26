import { Spinner } from '@/components/spinner/spinner';
import { FirestoreStorageProvider } from '@/context/storage-context/firestore-storage-provider';
import { LocalMirrorLayer } from '@/context/storage-context/local-mirror-layer';
import { useAuth } from '@/hooks/use-auth';
import React from 'react';
import { Navigate, Outlet } from 'react-router-dom';

/**
 * Layout route that requires authentication.
 *
 * - While Firebase resolves the persisted session it shows a loading spinner.
 * - If there is no authenticated user it redirects to /auth.
 * - If the user is authenticated it renders child routes via `<Outlet />` inside
 *   a `FirestoreStorageProvider` scoped to their UID, wrapped in a
 *   `LocalMirrorLayer` that adds a per-user IndexedDB mirror + pending-op
 *   queue. Writes go to the mirror first (instant, always succeed) before
 *   being propagated to Firestore; reads fall back to the mirror if the
 *   network or Firestore is unavailable. This makes the app resilient to
 *   Firebase outages, permission errors, quota issues, etc.
 */
export const ProtectedRoute: React.FC = () => {
    const { user, loading } = useAuth();

    if (loading) {
        return (
            <div className="flex h-screen w-screen items-center justify-center bg-background">
                <Spinner size="large" />
            </div>
        );
    }

    if (!user) {
        return <Navigate to="/auth" replace />;
    }

    return (
        <FirestoreStorageProvider uid={user.uid}>
            <LocalMirrorLayer uid={user.uid}>
                <Outlet />
            </LocalMirrorLayer>
        </FirestoreStorageProvider>
    );
};
