@echo off
setlocal
node "%~dp0aggiorna-scala-dei-turchi.cjs" --tutti-iscritti %*
set "RISULTATO=%ERRORLEVEL%"
pause
exit /b %RISULTATO%
