@echo off
setlocal

cd /d "%~dp0"

echo [CODEV] Installation de l'environnement local...

where python >nul 2>nul
if errorlevel 1 (
  echo [ERREUR] Python est introuvable dans le PATH.
  echo Installez Python 3.11+ puis relancez ce script.
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo [CODEV] Creation du venv .venv...
  python -m venv .venv
  if errorlevel 1 (
    echo [ERREUR] Impossible de creer le venv.
    pause
    exit /b 1
  )
) else (
  echo [CODEV] Venv existant detecte.
)

echo [CODEV] Mise a jour de pip...
call ".venv\Scripts\python.exe" -m pip install --upgrade pip
if errorlevel 1 (
  echo [ERREUR] Impossible de mettre a jour pip.
  pause
  exit /b 1
)

echo [CODEV] Installation des dependances...
call ".venv\Scripts\pip.exe" install -r requirements.txt
if errorlevel 1 (
  echo [ERREUR] Installation des dependances echouee.
  pause
  exit /b 1
)

echo.
echo [CODEV] Installation terminee.
echo Lancez run.bat pour demarrer l'application.
pause
