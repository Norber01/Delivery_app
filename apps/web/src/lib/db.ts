import { connectFirestoreEmulator, getFirestore, type Firestore } from 'firebase/firestore';
import { config } from './config';
import { getFirebase } from './firebase';

let db: Firestore | null = null;

/** Firestore client, loaded only by pages that read it directly (account, saved addresses). */
export function getDb(): Firestore {
  if (db) return db;
  db = getFirestore(getFirebase().app);
  if (config.useEmulators) connectFirestoreEmulator(db, '127.0.0.1', 8080);
  return db;
}
