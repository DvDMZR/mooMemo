// mooMemo Cloud Functions – v1
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

initializeApp();

const APP_ID = "moomemo-a9012";
const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

// Max. Prompt-Länge – schützt vor versehentlich riesigen (und teuren) Anfragen
const MAX_PROMPT_LENGTH = 20000;
// Timeout für den Gemini-Aufruf; die Function selbst darf etwas länger laufen
const GEMINI_TIMEOUT_MS = 90000;

exports.callGemini = onCall(
  { region: "europe-west1", maxInstances: 10, timeoutSeconds: 120 },
  async (request) => {
  // 1. Require authentication – no unauthenticated calls
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Anmeldung erforderlich.");
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

  // 2. Read API key server-side via Admin SDK (bypasses Firestore security rules,
  //    key is never sent to any browser)
  const db = getFirestore();
  const secretDoc = await db
    .doc(`artifacts/${APP_ID}/public/data/app_config/secrets`)
    .get();

  const apiKey = secretDoc.data()?.gemini_key;
  if (!apiKey) {
    throw new HttpsError(
      "not-found",
      "Gemini API-Key nicht konfiguriert. Bitte im Admin-Panel eintragen."
    );
  }

  // 3. Call Gemini API (mit Timeout – ein hängender Upstream blockiert sonst
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
