# Scala dei Turchi

Vetrina Awin pubblicata da questo repository su GitHub Pages:
https://davimarz.github.io/scaladeiturchi/

Per aggiornare le offerte, salva i due file del Passo 2 nella cartella
`C:\Users\admin\awin-playwright\scaladeiturchi\` e incolla in PowerShell
il comando del file `2-Scarica-listini-e-aggiorna-catalogo.txt`.

Scegli la sottocategoria: il programma cerca gli advertiser già attivi
nella categoria selezionata e salva i feed in `LISTINI/<sottocategoria>/`.
Per aggiornare altre categorie, rilancia il comando. Con `0` puoi pubblicare
usando i listini già salvati, senza scaricarne altri.

A ogni pubblicazione il catalogo è ricostruito da `LISTINI` e da tutte le sue
sottocartelle. Su GitHub vanno solo le schede generate, non i listini originali.
Servono Node.js, Playwright e il profilo Awin già configurato sul PC, oltre
all’accesso Git al repository. Un download incompleto blocca la pubblicazione.

Test locale dell’importatore: `node --test tests/awin-general.test.mjs`.
