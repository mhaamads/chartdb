import type { User } from 'firebase/auth';
import { createContext } from 'react';

export interface AuthContext {
    user: User | null;
    /** true while Firebase resolves the persisted session on first load */
    loading: boolean;
    signIn: (email: string, password: string) => Promise<void>;
    signOut: () => Promise<void>;
    sendPasswordReset: (email: string) => Promise<void>;
}

export const authContextInitialValue: AuthContext = {
    user: null,
    loading: true,
    signIn: async () => {},
    signOut: async () => {},
    sendPasswordReset: async () => {},
};

export const authContext = createContext<AuthContext>(authContextInitialValue);
