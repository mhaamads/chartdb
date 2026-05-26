import { firebaseAuth } from '@/lib/firebase/firebase-auth';
import type { User } from 'firebase/auth';
import {
    signOut as firebaseSignOut,
    onAuthStateChanged,
    sendPasswordResetEmail,
    signInWithEmailAndPassword,
} from 'firebase/auth';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { authContext } from './auth-context';

export const AuthProvider: React.FC<React.PropsWithChildren> = ({
    children,
}) => {
    const [user, setUser] = useState<User | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const unsubscribe = onAuthStateChanged(
            firebaseAuth,
            (firebaseUser) => {
                setUser(firebaseUser);
                setLoading(false);
            },
            (err) => {
                // onAuthStateChanged can emit errors when the persistence
                // layer fails (e.g. corrupted IndexedDB). Surface them and
                // unblock the UI by ending the loading state.
                console.error('[auth] onAuthStateChanged error:', err);
                setLoading(false);
            }
        );

        return () => unsubscribe();
    }, []);

    const signIn = useCallback(
        async (email: string, password: string): Promise<void> => {
            await signInWithEmailAndPassword(firebaseAuth, email, password);
        },
        []
    );

    const signOut = useCallback(async (): Promise<void> => {
        await firebaseSignOut(firebaseAuth);
    }, []);

    const sendPasswordReset = useCallback(
        async (email: string): Promise<void> => {
            await sendPasswordResetEmail(firebaseAuth, email);
        },
        []
    );

    // Memoize so consumers don't re-render on every AuthProvider render.
    const value = useMemo(
        () => ({
            user,
            loading,
            signIn,
            signOut,
            sendPasswordReset,
        }),
        [user, loading, signIn, signOut, sendPasswordReset]
    );

    return (
        <authContext.Provider value={value}>{children}</authContext.Provider>
    );
};
