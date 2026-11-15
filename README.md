# Scala dei Turchi

Vetrina Awin pubblicata da questo repository su GitHub Pages:
https://davimarz.github.io/scaladeiturchi/

Per aggiornare le offerte da PowerShell, avvia lo script con il tuo Publisher ID
Awin e la cartella contenente il lotto completo di listini:

```powershell
node tools/awin/aggiorna-scala-dei-turchi.cjs ID_PUBLISHER --da-listini "C:\Awin\Listini-Scala"
```

Sostituisci ID_PUBLISHER con il numero del tuo account. Per riutilizzare il
download automatico di Archivio Scarpe, esegui una copia dello script nella
stessa cartella locale dello scaricatore già configurato e ometti
`--da-listini`. I feed originali restano in locale. Ogni pubblicazione rigenera
il catalogo a partire dall'intero lotto fornito e invia solo il catalogo
generato a questo repository. È necessario che Git sia autenticato sul computer.

Test locale dell’importatore: `node --test tests/awin-general.test.mjs`.
