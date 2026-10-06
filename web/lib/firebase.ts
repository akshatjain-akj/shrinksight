import { getApps, initializeApp } from "firebase/app";
import { GoogleAuthProvider, getAuth, signInAnonymously, signInWithPopup } from "firebase/auth";
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

/** Opens the Google account picker and returns a Firebase ID token for the backend to verify. */
export async function googleIdToken(): Promise<string> {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  const cred = await signInWithPopup(getAuth(firebaseApp()), provider);
  return cred.user.getIdToken();
}

let authReady: Promise<string> | null = null;
let appCheckInstance: Promise<import("firebase/app-check").AppCheck> | null = null;

/** Present only when NEXT_PUBLIC_APPCHECK_SITE_KEY is configured in the Firebase console. */
export function appCheckToken(): Promise<string | null> {
  const siteKey = process.env.NEXT_PUBLIC_APPCHECK_SITE_KEY;
  if (!siteKey) return Promise.resolve(null);
  appCheckInstance ??= import("firebase/app-check").then(({ initializeAppCheck, ReCaptchaV3Provider }) =>
    initializeAppCheck(firebaseApp(), {
      provider: new ReCaptchaV3Provider(siteKey),
      isTokenAutoRefreshEnabled: true,
    }),
  );
  return appCheckInstance
    .then(async (appCheck) => {
      const { getToken } = await import("firebase/app-check");
      return (await getToken(appCheck)).token;
    })
    .catch(() => null);
}

/** Signs in anonymously once per page load; Firestore rules require a signed-in user to read. */
export function ensureAuth(): Promise<string> {
  authReady ??= signInAnon().catch((err) => {
    authReady = null;
    throw err;
  });
  return authReady;
}
