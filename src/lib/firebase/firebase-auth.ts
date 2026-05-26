import {
    browserLocalPersistence,
    getAuth,
    setPersistence,
} from 'firebase/auth';
import { firebaseApp } from './firebase-config';

export const firebaseAuth = getAuth(firebaseApp);

/**
 * Explicitly use `browserLocalPersistence` so the user stays signed in across
 * page reloads and browser restarts. This is the SDK default in browsers, but
 * we set it explicitly to be deterministic and to surface failures early (e.g.
 * Safari private mode where IndexedDB is restricted).
 */
void setPersistence(firebaseAuth, browserLocalPersistence).catch((err) => {
    // Non-fatal: the user can still sign in but the session won't survive a
    // reload. Log so we notice when running in restricted environments.
    console.warn('[firebase-auth] Failed to set local persistence:', err);
});
