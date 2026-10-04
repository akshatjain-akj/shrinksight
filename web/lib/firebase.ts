import { getApps, initializeApp } from "firebase/app";
import { getAuth, signInAnonymously } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

// Firebase web config is public by design (it identifies the project, it doesn't grant access).
// Access is controlled by Firestore rules, App Check and API-key restrictions.
const firebaseConfig = {
  apiKey: "AIzaSyCLVrHxj6KSod48-ZxV9HIsF_-bkZMYzdc",
  authDomain: "shrinksight-app.firebaseapp.com",
  projectId: "shrinksight-app",
  storageBucket: "shrinksight-app.firebasestorage.app",
  messagingSenderId: "820416173552",
  appId: "1:820416173552:web:c40c5e42d0afe8780af935",
};

export function firebaseApp() {
  return getApps()[0] ?? initializeApp(firebaseConfig);
}

export function db() {
  return getFirestore(firebaseApp());
}

export async function signInAnon(): Promise<string> {
  const cred = await signInAnonymously(getAuth(firebaseApp()));
  return cred.user.uid;
}

let authReady: Promise<string> | null = null;

/** Signs in anonymously once per page load; Firestore rules require a signed-in user to read. */
export function ensureAuth(): Promise<string> {
  authReady ??= signInAnon().catch((err) => {
    authReady = null;
    throw err;
  });
  return authReady;
}
