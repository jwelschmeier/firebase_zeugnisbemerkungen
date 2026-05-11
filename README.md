# Zeugnisbemerkungen FSR - Firebase Migration

Firebase-Projekt:

- Projektname: `Zeugnisbemerkungen FSR`
- Projekt-ID: `zeugnisbemerkungen-fsr`
- Projektnummer: `92918209203`

## Struktur

- `public/`: statische Web-App fuer Firebase Hosting
- `public/firebase-api-shim.js`: ersetzt `google.script.run` durch HTTP-Aufrufe an Firebase Functions
- `functions/`: Express-API auf Firebase Functions mit Firestore als Datenbank
- `firestore.rules`: sperrt direkte Client-Zugriffe; Schreib-/Lesezugriffe laufen ueber Functions

## Lokal starten

```bash
cd /home/jwelschmeier/LOCAL_Projekte/LOCAL_Zeugnisbemerkungen
npm --prefix functions install
firebase emulators:start --project zeugnisbemerkungen-fsr --only hosting,functions,firestore
```

## Deploy

```bash
cd /home/jwelschmeier/LOCAL_Projekte/LOCAL_Zeugnisbemerkungen
firebase deploy --project zeugnisbemerkungen-fsr --only hosting,functions,firestore:rules,firestore:indexes
```

## GitHub Actions Deploy

Ein Push auf `main` deployt automatisch nach Firebase. Dafuer muss im GitHub-Repository
`jwelschmeier/firebase_zeugnisbemerkungen` dieses Secret gesetzt sein:

- `FIREBASE_SERVICE_ACCOUNT_ZEUGNISBEMERKUNGEN_FSR`

Der Wert ist der komplette JSON-Inhalt eines Google-Service-Accounts mit Berechtigungen fuer
Firebase Hosting, Cloud Functions und Firestore.

## Hinweise

- Das Admin-Passwort ist standardmaessig `schule123`, wie im bisherigen Apps-Script-Projekt.
- Fuer Produktion sollte `ADMIN_PASSWORD` als Secret/Environment-Wert gesetzt werden.
- Daten werden nach Firestore importiert, sobald im Admin-Bereich die CSV/TXT-Dateien importiert werden.
- Foto-Sync aus Google Drive ist als Platzhalter angebunden und muss bei Bedarf separat auf Firebase Storage oder signierte Drive-URLs migriert werden.
