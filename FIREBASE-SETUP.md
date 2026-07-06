# mooMemo – Firebase-Anleitung für das v1.9.0-Sicherheitsupdate

Diese Anleitung beschreibt **alle manuellen Schritte in Firebase / Google Cloud**,
die für das Sicherheitsupdate (Branch `claude/code-review-improvements-0i2gi4`)
nötig sind. Reihenfolge einhalten – Schritt 1–3 **vor** dem Merge!

Projekt: `moomemo-a9012` · Konsole: https://console.firebase.google.com/project/moomemo-a9012

**Voraussetzungen:** Node.js installiert, Projekt-Owner-Rechte, einmalig anmelden:

```bash
npx firebase-tools login
```

---

## Schritt 1 – Neuen Gemini-API-Key erzeugen (alter Key ist kompromittiert)

Der bisherige Key lag für alle angemeldeten Nutzer lesbar in Firestore und muss
als kompromittiert gelten.

1. Öffnen: https://aistudio.google.com/apikey
2. **Neuen API-Key erstellen** (für das gewünschte Google-Cloud-Projekt).
3. Den **alten Key löschen** (oder deaktivieren) – erst nachdem Schritt 2
   erledigt ist, sonst fällt die KI-Funktion zwischenzeitlich aus.
4. Neuen Key zwischenspeichern (wird gleich gebraucht, danach nirgends ablegen).

---

## Schritt 2 – Secret `GEMINI_API_KEY` anlegen (PFLICHT vor dem Merge!)

Die Cloud Function liest den Key jetzt aus dem **Firebase Secret Manager**.
Ohne dieses Secret schlägt das nächste CI-Deployment fehl.

```bash
npx firebase-tools functions:secrets:set GEMINI_API_KEY --project moomemo-a9012
```

→ Bei der Eingabeaufforderung den **neuen** Key aus Schritt 1 einfügen.

Prüfen:

```bash
npx firebase-tools functions:secrets:access GEMINI_API_KEY --project moomemo-a9012
```

Hinweis: Beim ersten Mal aktiviert firebase-tools automatisch die
**Secret Manager API** im Projekt und fragt ggf. nach Bestätigung.

**Key später ändern/rotieren:** einfach denselben `secrets:set`-Befehl erneut
ausführen und danach die Functions neu deployen (CI-Lauf oder
`npx firebase-tools deploy --only functions --project moomemo-a9012`).

---

## Schritt 3 – Rechte des CI-Service-Accounts prüfen

Die GitHub-Action deployt jetzt zusätzlich **Firestore-Rules, Indexes und
Storage-Rules** und bindet ein **Secret** an die Function. Der Service-Account
(hinterlegt als GitHub-Secret `FIREBASE_SERVICE_ACCOUNT`) braucht dafür:

| Rolle | Wofür |
|---|---|
| `Firebase Admin` (roles/firebase.admin) | deckt alles ab – einfachste Variante |

*Oder feingranular statt Firebase Admin:*
`Cloud Functions Admin`, `Firebase Rules Admin`, `Cloud Datastore Index Admin`,
`Secret Manager Secret Accessor` (Lesezugriff auf `GEMINI_API_KEY`),
`Service Account User`.

Prüfen/ändern unter: https://console.cloud.google.com/iam-admin/iam?project=moomemo-a9012
→ Service-Account suchen → Rollen kontrollieren.

Wenn der Account bisher Functions deployen durfte und `Firebase Admin` hat,
ist nichts zu tun.

---

## Schritt 4 – Merge nach `main`

Pull Request für `claude/code-review-improvements-0i2gi4` mergen.
Die GitHub-Action deployt dann automatisch:

- Cloud Functions (`callGemini`, `registerUser`, `syncMyClaims`, `onUserProfileWritten`)
- `firestore.rules` + `firestore.indexes.json`
- `storage.rules`

Deployment beobachten: GitHub → Actions → „Deploy Firebase Functions".
Der Index-Aufbau (2 Composite-Indexes) kann einige Minuten dauern –
Status: https://console.firebase.google.com/project/moomemo-a9012/firestore/indexes

---

## Schritt 5 – Neues Frontend SOFORT ausrollen

⚠️ **Wichtigster Schritt.** Das alte `index.html` liest die komplette
Berichts-Collection – das verbieten die neuen Rules. Nutzer mit dem alten
Frontend sehen sonst eine leere Liste / Sync-Fehler.

Das neue `index.html` so ausrollen, wie das Hosting bisher gepflegt wurde
(die `firebase.json` enthält bewusst keine Hosting-Sektion – falls das Hosting
doch über Firebase läuft, wäre jetzt der richtige Moment, es zu ergänzen und
mit in die CI zu nehmen).

---

## Schritt 6 – Alte Secrets/Daten in Firestore aufräumen

1. Konsole öffnen: https://console.firebase.google.com/project/moomemo-a9012/firestore/data
2. Dokument **`artifacts/moomemo-a9012/public/data/app_config/secrets`
   löschen** (enthält den alten, kompromittierten Key).
   Die neuen Rules sperren es zwar für Clients, aber weg ist weg.
3. Kontrollieren, dass `app_config/auth` (Invite-Code) noch existiert –
   die Registrierung prüft ihn jetzt serverseitig. Ohne gesetzten Invite-Code
   ist keine Registrierung möglich (außer für den S-Admin).

---

## Schritt 7 – Funktionstest (Checkliste)

Nach dem Ausrollen einmal durchklicken:

- [ ] **Login als normaler Nutzer** → App lädt, es erscheinen nur die erlaubten
      Berichte. (Bestandsnutzer werden beim ersten Login automatisch migriert –
      der Client ruft `syncMyClaims` auf; dauert beim ersten Mal 1–2 Sekunden länger.)
- [ ] **Login als Admin** → alle Berichte sichtbar, Löschen-Button vorhanden.
- [ ] **Registrierung mit falschem Einladungscode** → wird abgelehnt.
- [ ] **Registrierung mit korrektem Code** → funktioniert, Nutzer landet in der App.
- [ ] **KI-Zauberstab** (Textverbesserung) → funktioniert (neuer Key im Secret Manager).
- [ ] **Bild-Upload** in einem Punkt → funktioniert (Storage-Rules).
- [ ] **Admin: Rolle eines Nutzers ändern** → wirkt beim Betroffenen nach
      dessen nächstem Login (Claims werden per Trigger aktualisiert, das
      ID-Token erneuert sich beim Re-Login bzw. spätestens nach 1 Stunde).
- [ ] Browser-Konsole auf Fehler prüfen. Meldet Firestore einen fehlenden
      Index, enthält die Fehlermeldung einen Direktlink zum Anlegen –
      anklicken genügt (sollte durch `firestore.indexes.json` aber abgedeckt sein).

**Typische Fehlerbilder:**

| Symptom | Ursache | Lösung |
|---|---|---|
| CI-Deploy bricht ab: „secret GEMINI_API_KEY not found" | Schritt 2 vergessen | Secret setzen, Action erneut ausführen |
| Leere Berichtsliste bei allen Nutzern | Altes Frontend + neue Rules | Schritt 5: neues index.html ausrollen |
| „Konto nicht freigeschaltet" bei Bestandsnutzer | `syncMyClaims` fehlgeschlagen (Function noch nicht deployt?) | Functions-Deploy prüfen, Nutzer erneut anmelden lassen |
| Query-Fehler „requires an index" | Indexes noch im Aufbau | Ein paar Minuten warten (Schritt 4) |
| KI meldet „nicht konfiguriert" | Secret leer/Functions vor Secret deployt | Schritt 2 + Functions redeployen |

---

## Optional (empfohlen, kein Blocker)

### App Check aktivieren (letzter offener Punkt aus S5)

Schützt die Cloud Functions zusätzlich davor, außerhalb der echten App
aufgerufen zu werden:

1. https://console.firebase.google.com/project/moomemo-a9012/appcheck
2. Web-App registrieren mit **reCAPTCHA v3** (Site-Key erzeugen lassen).
3. Im Frontend App Check initialisieren (kleiner Codeblock – bei Bedarf liefere
   ich den Patch) und zunächst im **Monitoring-Modus** laufen lassen.
4. Erst wenn die Metriken sauber sind: Erzwingen aktivieren und in den
   Functions `enforceApp Check: true` setzen.

### Budget-Alarm

https://console.cloud.google.com/billing → Budgets & Benachrichtigungen →
Budget mit E-Mail-Alarm anlegen (fängt Kostenüberraschungen durch KI/Storage ab).

### Backups

Firestore-Export als Sicherheitsnetz vor dem Update:
Konsole → Firestore → „Importieren/Exportieren" (braucht einen Cloud-Storage-Bucket),
alternativ in der App als Admin „Backup speichern" (JSON-Export).
