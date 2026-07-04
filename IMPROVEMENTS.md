# mooMemo – Optimierungspotential

Stand: 2026-07-04 · Basis: v1.8.6 (Branch `claude/code-review-improvements-0i2gi4`)

Ergebnis der sorgfältigen Code-Prüfung – gegliedert nach: bereits umgesetzt,
kaputter/toter Code, Benutzerfreundlichkeit, fehlende Features, Performance &
Architektur. Sicherheitsthemen stehen separat in **SECURITY.md**.

---

## 1. In diesem Branch bereits umgesetzt (v1.8.6)

| Bereich | Fix |
|---|---|
| Frontend | **Drag & Drop repariert**: `draggedItemIndex` war nie deklariert → `ReferenceError` im Strict Mode; Punkte-Sortierung per Maus war komplett funktionslos. |
| Frontend | `savePoint()` verliert keine Eingaben mehr, wenn der Bericht während der Bearbeitung von einem anderen Nutzer gelöscht wurde (Modal bleibt offen + Hinweis). |
| Frontend | `openReport()` validiert die ID, bevor Zustand/`localStorage` gesetzt werden (kein „Geister-Bericht" nach Reload). |
| Frontend | Doppelklick-Schutz für „Neuer Bericht" (vorher zwei Berichte möglich). |
| Frontend | KI-Buttons sind während laufender Anfrage `disabled` (keine parallelen Anfragen/Kosten). |
| Frontend | Bild-Upload: Spinner wird per `try/finally` garantiert ausgeblendet. |
| Frontend | `toggleStatus()` mit Guard gegen per Sync entfernte Punkte. |
| Frontend | Export/Sidebar: konsequentes `escapeHtml` – behebt Stored-XSS (SECURITY.md S4) **und** kaputte Darstellung bei `<`, `>`, `&` in Kundennamen/Texten. |
| Frontend | Versionschaos behoben: `APP_VERSION`, Header und Info-Bereich zeigten 1.8.4/1.8.5/1.8.5 – jetzt eine Quelle (`APP_VERSION`), Anzeige dynamisch. |
| Frontend | Leerzustände im Dashboard: „Noch keine Berichte" statt fälschlich „Keine Punkte."; erfolglose Suche zeigt jetzt einen Hinweis statt leerer Fläche. |
| Frontend | Punkt-Modal: Titel „Punkt bearbeiten" beim Editieren; Löschen-Button nur bei bestehenden Punkten; Punkteliste zeigt „…" nur bei tatsächlich gekürztem Text. |
| Frontend | Filter-Pills ohne deprecated globales `event` (robust über `data`-Attribute). |
| Backend | `callGemini`: Prompt-Limit (20 000 Zeichen), 90-s-Timeout mit sauberem `unavailable`-Fehler statt Hänger, JSON-Parse abgesichert, `maxInstances: 10` als Kostenbremse. |
| CI | `package-lock.json` ergänzt + `npm ci` (reproduzierbare Deployments); `cache-dependency-path` zeigte auf `package.json` → Cache war wirkungslos/fehleranfällig. Service-Account-Secret ohne Shell-Interpolation geschrieben. |

---

## 2. Kaputter / toter Code (Aufräum-Kandidaten)

| Fundstelle | Befund | Empfehlung |
|---|---|---|
| `#readonly-banner` | Wird nie eingeblendet – der Shared-Modus nutzt stattdessen `shared-mode`-CSS. | Entfernen oder im Shared-Modus tatsächlich anzeigen. |
| `updateShareLink()` | Leere Funktion, wird bei jedem Export-Tab-Wechsel aufgerufen. | Entfernen. |
| `copyShareLink(tab)` | Parameter `tab` wird nie genutzt. | Signatur bereinigen. |
| `translateReport()` | Deaktiviert („Funktion aktuell deaktiviert"), kein UI-Zugang. | Entfernen oder als Feature reaktivieren (siehe 4.6). |
| `duplicateReport()` | Voll funktionsfähig, aber der Button wurde entfernt. | Günstigstes „neues" Feature überhaupt: Button wieder einbauen (siehe 4.1). |
| `exportSingleReport()` | Keine Aufrufstelle mehr im Markup. | Entfernen oder als „Bericht als JSON exportieren" in die Berichtsaktionen. |
| `prepareLogo()` / `LOGO_PNG` / `LOGO_SRC` | PNG-Konvertierung läuft bei jedem Start, aber der PDF-Export nutzt längst das CDN-SVG (`logoSrc`). | Kompletten Block entfernen (spart Startup-Arbeit). |
| Sichtbarkeits-Migration `published→all`, `draft→authors_only` | Identische 2-Zeilen-Logik an **vier** Stellen dupliziert (`renderReportList`, `renderRelatedReports`, `openReport`, Dashboard-Badges). | Helper `normalizeVisibility(header)` – eine Quelle, weniger Drift-Risiko. |
| `formatDate()` | Dreimal identisch als lokale Arrow-Function definiert. | Einmal als Helper. |
| `.skeleton`-CSS | Komplettes Skeleton-Loading-CSS vorhanden, wird aber nirgends verwendet. | Nutzen (siehe 3.1) oder löschen. |
| `renderPointsList()` | `rDate`-Fallback ist ein `Date`-Objekt, sonst ein String – funktioniert, ist aber typ-inkonsistent. | Vereinheitlichen. |
| Hilfe-Button (v1.8-Hinweis) | Pulsiert dauerhaft; der Hinweis („Ab v1.8 …") ist inzwischen veraltet. | Nach Lesen ausblenden (localStorage-Flag) oder entfernen. |
| `beforeunload`-Warnung | Warnt vor „ungespeicherten Daten", obwohl alles automatisch gespeichert wird → verwirrt Nutzer beim Schließen. | Entfernen oder nur bei tatsächlich laufendem Save anzeigen. |
| `popstate`-Exit-Dialog | `history.back()` im Handler + erneutes `pushState` ist fragil (doppelte Einträge, Endlos-Dialoge auf manchen Browsern). | Vereinfachen: Zurück-Geste navigiert in der App (Bericht → Dashboard) statt Exit-Confirm. |

---

## 3. Benutzerfreundlichkeit (UX)

1. **Skeleton-Loading nutzen:** Beim ersten Laden erscheint nur ein Spinner-Text.
   Die CSS-Klassen für Skeleton-Cards existieren bereits – 3 Platzhalter-Karten
   rendern, bis der erste Snapshot da ist.
2. **Suchfeld debouncen:** `oninput` rendert bei jedem Tastendruck die komplette
   Liste inkl. aller Filterläufe. Ein Debounce von ~200 ms macht die Suche bei
   wachsender Berichtszahl spürbar flüssiger.
3. **Einheitliche Dialoge:** Punkt-Löschen hat ein schönes Bestätigungs-Modal,
   Bericht-Löschen/Benutzer-Löschen/Import nutzen natives `confirm()`/`alert()`
   (blockierend, nicht übersetzt gestylt). Auf das vorhandene Modal-Pattern
   vereinheitlichen.
4. **Fehlermeldungen in Klartext:** „Fehler S04 – Admin kontaktieren" ist für
   Endnutzer kryptisch. Kurzer Klartext + Fehlercode klein darunter, plus
   „Erneut versuchen"-Aktion, wo sinnvoll.
5. **Share-Button-Verhalten:** „Link kopieren" kopiert **und** öffnet den Link
   sofort in einem neuen Tab – das überrascht und erzeugt unnötige Tabs. Nur
   kopieren; optional kleiner „Vorschau öffnen"-Sekundärbutton.
6. **Passwort vergessen:** Aktuell nur ein Alert („bitte Admin anschreiben").
   `sendPasswordResetEmail` ist bereits importiert – ein echter Self-Service-Reset
   ist eine Zeile Code und entlastet den Admin.
7. **Modals per ESC/Außenklick schließen + Fokus-Management:** Aktuell schließt
   nur das X. ESC-Handler und `focus()` auf das erste Feld beim Öffnen (bes. für
   Desktop-Vielnutzer).
8. **Barrierefreiheit:** Navigations-Tabs und Punkt-Karten sind `div`s mit
   `onclick` (nicht per Tastatur erreichbar), Icon-Buttons ohne `aria-label`,
   Modals ohne `role="dialog"`. Mit überschaubarem Aufwand deutlich verbesserbar.
9. **Upload-Feedback:** Bei mehreren/großen Bildern gibt es nur einen globalen
   Spinner. Fortschritt pro Bild (Thumbnail-Platzhalter mit Prozent) verhindert
   den „eingefroren"-Eindruck; `uploadBytesResumable` liefert Progress-Events.
10. **Kamera-Direktaufnahme:** `<input type="file" accept="image/*" capture="environment">`
    als zweiter Button („Foto aufnehmen") – für den Stallbesuch per Smartphone der
    schnellste Weg.
11. **Undo statt endgültig:** Nach „Punkt gelöscht" ein Toast mit „Rückgängig"
    (5 s), statt sofort unwiderruflich zu löschen.
12. **Punkte-Sortierung auf Touch:** HTML5-Drag&Drop funktioniert auf Mobilgeräten
    nicht; dort gibt es nur die Pfeil-Buttons. Kleine Touch-Sortier-Lib (z. B.
    SortableJS, ~4 kB) deckt beides ab.
13. **Suchtreffer-Kontext:** Die Suche findet auch Punkt-Inhalte, zeigt aber nicht,
    *warum* ein Bericht matcht. Treffer-Snippet („…Melkroboter **Fehler 42**…")
    unter dem Berichtstitel einblenden.
14. **Statusansicht filtern:** Bei langen Berichten wären Filter (Verantwortlicher,
    Alter) und eine Sortierung in der Status-Übersicht hilfreich.
15. **Export-Filter im Share-Link:** „Nur Offene" geht beim Teilen verloren –
    `?report=…&filter=open` mitgeben und in `applySharedLinkMode` auswerten.

---

## 4. Fehlende Features (Vorschläge, nach Aufwand/Nutzen sortiert)

1. **Bericht duplizieren** – Funktion existiert bereits (`duplicateReport`), nur
   der Button fehlt. Ideal für wiederkehrende Besuche beim selben Kunden. *(Aufwand: Minuten)*
2. **Offline-Fähigkeit** – Für den Einsatzort (Stall, Funkloch) der größte Hebel:
   `persistentLocalCache` des Firestore-SDK aktivieren → Lesen & Schreiben offline,
   Sync bei Netz. Dazu PWA-Manifest + Service Worker (App-Icon, „installierbar",
   Start ohne Netz). Die Meta-Tags (`mobile-web-app-capable`) sind schon da, es
   fehlen `manifest.json` und Icons. *(Aufwand: 1–2 Tage)*
3. **Erinnerung an überfällige Punkte** – Die Alters-Badges (3/6 Monate) existieren;
   eine wöchentliche Scheduled Cloud Function könnte Verantwortlichen eine E-Mail
   mit ihren offenen Punkten schicken. *(Aufwand: ~1 Tag, braucht E-Mail-Dienst)*
4. **CSV/Excel-Export offener Punkte** – Für Nachverfolgung im Team; clientseitig
   trivial erzeugbar (Punkte → CSV-Download). *(Aufwand: Stunden)*
5. **Papierkorb / Soft-Delete** – Berichte werden aktuell hart gelöscht (inkl.
   Bilder). `deleted_at`-Flag + Admin-Ansicht „Gelöschte Berichte (30 Tage)".
   *(Aufwand: ~1 Tag)*
6. **Berichts-Übersetzung reaktivieren** – `translateReport` war mal da; über die
   bestehende `callGemini`-Function sauber umsetzbar (kompletter Bericht → EN für
   internationale Empfänger, passend zum englischen PDF-Dateinamen). *(Aufwand: ~1 Tag)*
7. **Änderungshistorie pro Punkt** – „Wer hat wann Status/Lösung geändert" (Array
   `history` am Punkt oder Subcollection); wichtig, sobald mehrere Teams auf
   denselben Berichten arbeiten. *(Aufwand: 1–2 Tage)*
8. **Login mit Microsoft (Entra ID/SSO)** – Firmenkontext mit @gea.com-Konten;
   ersetzt Passwort-/Invite-Handling weitgehend und löst mehrere Punkte aus
   SECURITY.md gleich mit. *(Aufwand: abhängig von IT-Freigabe)*

---

## 5. Performance & Architektur

1. **Monolith aufteilen:** ~4 800 Zeilen in einer `index.html` (CSS ≈ 1 500,
   JS ≈ 2 800). Erster Schritt ohne Build-Tool: `styles.css` + `app.js` auslagern.
   Das verbessert Diffs/Reviews massiv – die Git-Historie (#8–#12 für einen
   einzigen Bugfix) zeigt den Schmerz.
2. **Daten-Lademodell:** `onSnapshot` auf die **gesamte** Reports-Collection hält
   alle Berichte inkl. aller Punkte dauerhaft im Speicher; jeder Fremd-Edit
   triggert ein komplettes Re-Render. Mittelfristig: Dashboard lädt nur
   Header-Felder (eigene Query je Sichtbarkeit), Punkte erst beim Öffnen des
   Berichts (Subcollection).
3. **Ganzes-Dokument-Schreiben:** Jede Kleinigkeit (Status-Toggle, Header-Tipp)
   schreibt den kompletten Bericht per `setDoc` → Last-write-wins-Konflikte bei
   paralleler Bearbeitung. `updateDoc` mit Feldpfaden bzw. Punkte als
   Subcollection beheben das strukturell (gleiche Baustelle wie Rules in
   SECURITY.md S1).
4. **Verwaiste Storage-Dateien:** Bilder werden beim Auswählen sofort hochgeladen;
   Abbruch des Modals oder `removeTempImage` löscht sie nicht, `images/temp_uploads/`
   wird nie geleert. Aufräum-Job (Scheduled Function, löscht Unreferenziertes
   > 7 Tage) oder Upload erst beim Speichern des Punkts.
5. **`readable_id`-Kollisionen:** 5-stellige Zufallszahl ohne Eindeutigkeitsprüfung
   – bei ein paar hundert Berichten wird eine Doppelvergabe wahrscheinlich
   (Geburtstagsparadoxon: ~50 % bei ~350 Berichten). Fortlaufende Nummer per
   Firestore-Transaction auf einem Zähler-Dokument.
6. **Hosting nicht in der CI:** `firebase.json` enthält nur `functions` – die
   `index.html` wird offenbar manuell deployt. `hosting`-Sektion ergänzen und im
   Workflow `--only functions,hosting` deployen → Frontend und Backend bleiben
   automatisch synchron (wichtig, weil Client und Function sich Region/Fehlercodes
   teilen).
7. **Keine Tests:** Nichts ist abgesichert. Sinnvoller Einstieg: (a) Unit-Tests für
   die Cloud Function (Input-Validierung, Fehler-Mapping) mit
   `firebase-functions-test`, (b) ein Playwright-Smoke-Test gegen den
   Firebase-Emulator (Login → Bericht anlegen → Punkt anlegen → Export rendert).
8. **Fehler-Monitoring:** Fehler landen nur in der Browser-Konsole der Nutzer.
   Sentry (oder Firebase Crashlytics for Web via `window.onerror`-Reporter) macht
   Produktionsfehler überhaupt erst sichtbar.
9. **CDN-Abhängigkeiten:** Font Awesome & heic2any von Dritt-CDNs (Ausfall-/
   Manipulationsrisiko, siehe SECURITY.md S9.1) – selbst hosten, dann funktioniert
   die App auch in restriktiven Firmennetzen zuverlässig.
10. **Firestore-Rules ins Repo** (Deckungsgleich mit SECURITY.md S1/S6/S7 – hier
    nur als Erinnerung, dass es auch ein *Deployment*-Thema ist: Rules gehören in
    die CI wie der Function-Code.)

---

## 6. Vorschlag für die nächsten Iterationen

| Iteration | Inhalt |
|---|---|
| **v1.8.7** | Toter Code raus (Abschnitt 2), Duplizieren-Button, CSV-Export, Debounce, ESC/Fokus in Modals, Passwort-Reset per E-Mail |
| **v1.9** | Sicherheits-Baustelle laut SECURITY.md (Rules, Secret Manager, Registrierung) – dabei gleich Punkte als Subcollection (5.3) |
| **v2.0** | Offline/PWA (4.2), Datenmodell-Umbau (5.2), Datei-Aufteilung (5.1), Tests (5.7) |
