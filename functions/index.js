// mooMemo Cloud Functions – v2
// Enthält: Gemini-Proxy (Key im Secret Manager), serverseitige Registrierung
// (Invite-Code-Prüfung), Custom-Claims-Verwaltung (approved/admin/department)
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");

initializeApp();

const APP_ID = "moomemo-a9012";
const REGION = "europe-west1";
const SUPER_ADMIN_EMAIL = "david.mazur@gea.com";
const DEPARTMENTS = ["TSS", "T&I", "DV", "R&C"];
const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

// Gemini-Key liegt im Firebase Secret Manager – NICHT mehr in Firestore.
// Setzen/Rotieren: npx firebase-tools functions:secrets:set GEMINI_API_KEY --project moomemo-a9012
const GEMINI_KEY = defineSecret("GEMINI_API_KEY");

// Max. Prompt-Länge – schützt vor versehentlich riesigen (und teuren) Anfragen
const MAX_PROMPT_LENGTH = 20000;
// Timeout für den Gemini-Aufruf; die Function selbst darf etwas länger laufen
const GEMINI_TIMEOUT_MS = 90000;
// Rate-Limit pro Nutzer (Anfragen pro Stunde)
const GEMINI_HOURLY_LIMIT = 60;

const userDocPath = (uid) => `artifacts/${APP_ID}/public/data/users/${uid}`;

// Claims aus dem Firestore-Profil ableiten – einzige Quelle für Berechtigungen
function claimsFromProfile(profile) {
  const email = (profile.email || "").toLowerCase();
  const isSA = email === SUPER_ADMIN_EMAIL;
  return {
    approved: true,
    admin: isSA || profile.role === "admin",
    department: profile.department || "",
  };
}

// ---------------------------------------------------------------------------
// REGISTRIERUNG – serverseitig (Invite-Code und E-Mail-Domain werden hier
// geprüft, nicht mehr im Browser; der Client meldet sich anschließend mit dem
// zurückgegebenen Custom Token an)
// ---------------------------------------------------------------------------
exports.registerUser = onCall({ region: REGION, maxInstances: 5 }, async (request) => {
  const { name, email, password, department, inviteCode, lang } = request.data || {};

  // --- Validierung (spiegelt die Client-Regeln, ist aber maßgeblich) ---
  if (!name || typeof name !== "string" || name.trim().split(/\s+/).length < 2) {
    throw new HttpsError("invalid-argument", "Bitte Vor- und Nachnamen angeben.");
  }
  if (!email || typeof email !== "string" || !email.toLowerCase().endsWith("@gea.com")) {
    throw new HttpsError("invalid-argument", "Nur @gea.com E-Mail-Adressen sind erlaubt.");
  }
  if (
    !password || typeof password !== "string" || password.length < 8 ||
    !/[A-Z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9]/.test(password)
  ) {
    throw new HttpsError(
      "invalid-argument",
      "Passwort: mind. 8 Zeichen, 1 Großbuchstabe, 1 Zahl, 1 Sonderzeichen."
    );
  }
  if (!DEPARTMENTS.includes(department)) {
    throw new HttpsError("invalid-argument", "Ungültige Abteilung.");
  }

  const db = getFirestore();
  const normEmail = email.toLowerCase().trim();
  const isSA = normEmail === SUPER_ADMIN_EMAIL;

  // --- Invite-Code prüfen (Super-Admin darf sich ohne Code registrieren,
  //     damit das System bootstrapfähig bleibt) ---
  if (!isSA) {
    const codeSnap = await db
      .doc(`artifacts/${APP_ID}/public/data/app_config/auth`)
      .get();
    const storedCode = codeSnap.data()?.invite_code;
    if (!storedCode) {
      throw new HttpsError(
        "failed-precondition",
        "Registrierung ist aktuell nicht möglich. Bitte Admin kontaktieren."
      );
    }
    if (!inviteCode || inviteCode !== storedCode) {
      throw new HttpsError("permission-denied", "Einladungscode ist falsch.");
    }
  }

  // --- Auth-Account anlegen ---
  let userRecord;
  try {
    userRecord = await getAuth().createUser({
      email: normEmail,
      password,
      displayName: name.trim(),
    });
  } catch (e) {
    if (e.code === "auth/email-already-exists") {
      throw new HttpsError("already-exists", "Diese E-Mail wird bereits verwendet.");
    }
    if (e.code === "auth/invalid-email") {
      throw new HttpsError("invalid-argument", "Ungültige E-Mail-Adresse.");
    }
    console.error("createUser failed:", e);
    throw new HttpsError("internal", "Registrierung fehlgeschlagen.");
  }

  // --- Profil + Claims anlegen ---
  const appLang = lang === "en" ? "en" : "de";
  const profile = {
    uid: userRecord.uid,
    email: normEmail,
    displayName: name.trim(),
    role: isSA ? "admin" : "user",
    department,
    settings: { lang: appLang, aiLang: appLang },
    created_at: Date.now(),
    lastLogin: Date.now(),
  };
  try {
    await db.doc(userDocPath(userRecord.uid)).set(profile);
    await getAuth().setCustomUserClaims(userRecord.uid, claimsFromProfile(profile));
  } catch (e) {
    // Aufräumen, damit kein Auth-Account ohne Profil zurückbleibt
    console.error("Profile/claims setup failed, rolling back user:", e);
    await getAuth().deleteUser(userRecord.uid).catch(() => {});
    throw new HttpsError("internal", "Registrierung fehlgeschlagen.");
  }

  // Custom Token für den direkten Login im Client
  const token = await getAuth().createCustomToken(userRecord.uid);
  return { token };
});

// ---------------------------------------------------------------------------
// CLAIMS-SYNC – Migration für Bestandsnutzer (vor Einführung der Claims
// registriert) und Reparatur: liest das eigene Firestore-Profil und setzt die
// Claims daraus. Ohne Profil gibt es keine Freischaltung.
// ---------------------------------------------------------------------------
exports.syncMyClaims = onCall({ region: REGION, maxInstances: 5 }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Anmeldung erforderlich.");
  }
  const db = getFirestore();
  const snap = await db.doc(userDocPath(request.auth.uid)).get();
  if (!snap.exists) {
    throw new HttpsError(
      "permission-denied",
      "Kein Benutzerprofil vorhanden. Bitte Admin kontaktieren."
    );
  }
  const claims = claimsFromProfile(snap.data());
  await getAuth().setCustomUserClaims(request.auth.uid, claims);
  return { ok: true, claims };
});

// ---------------------------------------------------------------------------
// CLAIMS-TRIGGER – hält Claims aktuell, wenn ein Admin Rolle/Abteilung im
// Profil ändert oder ein Profil löscht (Löschung entzieht die Freischaltung)
// ---------------------------------------------------------------------------
exports.onUserProfileWritten = onDocumentWritten(
  { document: `artifacts/${APP_ID}/public/data/users/{uid}`, region: REGION },
  async (event) => {
    const uid = event.params.uid;
    try {
      if (!event.data.after.exists) {
        // Profil gelöscht -> Freischaltung entziehen
        await getAuth().setCustomUserClaims(uid, { approved: false });
        return;
      }
      await getAuth().setCustomUserClaims(uid, claimsFromProfile(event.data.after.data()));
    } catch (e) {
      // Auth-Account existiert evtl. nicht (mehr) – nicht fatal
      console.warn(`Claims update for ${uid} failed:`, e.message);
    }
  }
);

// ---------------------------------------------------------------------------
// GEMINI-PROXY
// ---------------------------------------------------------------------------
exports.callGemini = onCall(
  { region: REGION, maxInstances: 10, timeoutSeconds: 120, secrets: [GEMINI_KEY] },
  async (request) => {
  // 1. Require authentication and approval – no unauthenticated calls
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Anmeldung erforderlich.");
  }
  if (request.auth.token.approved !== true) {
    throw new HttpsError("permission-denied", "Konto ist nicht freigeschaltet.");
  }

  const { prompt } = request.data;
  if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
    throw new HttpsError("invalid-argument", "Kein Prompt angegeben.");
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw new HttpsError(
      "invalid-argument",
      `Prompt zu lang (max. ${MAX_PROMPT_LENGTH} Zeichen).`
    );
  }

  const db = getFirestore();

  // 2. Rate-Limit pro Nutzer (Missbrauchs-/Kostenschutz). Der Zähler liegt
  //    außerhalb von artifacts/ und ist damit für Clients nicht erreichbar.
  const usageRef = db.doc(`gemini_usage/${request.auth.uid}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(usageRef);
    const now = Date.now();
    let usage = snap.exists ? snap.data() : { count: 0, windowStart: now };
    if (now - usage.windowStart > 3600 * 1000) {
      usage = { count: 0, windowStart: now };
    }
    if (usage.count >= GEMINI_HOURLY_LIMIT) {
      throw new HttpsError(
        "resource-exhausted",
        "Stundenlimit für KI-Anfragen erreicht. Bitte später erneut versuchen."
      );
    }
    usage.count += 1;
    tx.set(usageRef, usage);
  });

  // 3. API-Key aus dem Secret Manager (nie in Firestore, nie im Browser)
  const apiKey = GEMINI_KEY.value();
  if (!apiKey) {
    throw new HttpsError(
      "not-found",
      "Gemini API-Key nicht konfiguriert. Admin: Secret GEMINI_API_KEY setzen."
    );
  }

  // 4. Call Gemini API (mit Timeout – ein hängender Upstream blockiert sonst
  //    die Function bis zu ihrem eigenen Timeout und der Client sieht nur "internal")
  let response;
  try {
    response = await fetch(GEMINI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1 },
      }),
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
    });
  } catch (err) {
    // Netzwerkfehler / DNS / Timeout → für den Client als "unavailable" (retrybar)
    throw new HttpsError(
      "unavailable",
      "KI-Server nicht erreichbar (Netzwerkfehler/Timeout). Bitte später erneut versuchen."
    );
  }

  if (response.status === 403) {
    throw new HttpsError("permission-denied", "Ungültiger Gemini API-Key.");
  }
  if (response.status === 429) {
    throw new HttpsError(
      "resource-exhausted",
      "Rate-Limit der KI-API erreicht. Bitte kurz warten."
    );
  }
  if (response.status >= 500) {
    throw new HttpsError(
      "unavailable",
      `KI-Server nicht erreichbar (${response.status}). Bitte später erneut versuchen.`
    );
  }
  if (!response.ok) {
    throw new HttpsError("internal", `API-Fehler: ${response.status} ${response.statusText}`);
  }

  let result;
  try {
    result = await response.json();
  } catch (err) {
    throw new HttpsError("internal", "Ungültige Antwort von der KI-API.");
  }
  const text = result.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new HttpsError("internal", "Keine Antwort von der KI erhalten.");
  }

  return { text: text.trim() };
  }
);
