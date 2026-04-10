import { getAuth } from 'firebase/auth';
import { firebaseApp } from './firebase-config';

export const firebaseAuth = getAuth(firebaseApp);
