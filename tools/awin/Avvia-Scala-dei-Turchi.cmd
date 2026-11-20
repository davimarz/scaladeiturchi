@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js non trovato. Installalo o aggiungilo al PATH.
  pause
  exit /b 1
)
echo Scala dei Turchi - Awin
echo.
echo 1. Candidature
echo 2. Scarica tutti i listini e pubblica il catalogo
echo 3. Scegli i listini da scaricare
echo 0. Esci
choice /c 1230 /n /m "Scelta: "
if errorlevel 4 exit /b 0
if errorlevel 3 goto selection
if errorlevel 2 goto full
if not errorlevel 1 exit /b 1
if not exist "candidature-awin-per-categoria.cjs" goto missing
node "candidature-awin-per-categoria.cjs"
goto done
:full
if not exist "aggiorna-scala-dei-turchi.cjs" goto missing
node "aggiorna-scala-dei-turchi.cjs" --tutti-iscritti
goto done
:selection
if not exist "aggiorna-scala-dei-turchi.cjs" goto missing
node "aggiorna-scala-dei-turchi.cjs" --tutti-iscritti --scegli-listini
goto done
:missing
echo Manca lo script CJS richiesto nella cartella del menu.
pause
exit /b 1
:done
set "result=%errorlevel%"
echo.
pause
exit /b %result%
