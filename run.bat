@echo off
setlocal

cd /d "%~dp0"

if not exist ".venv\Scripts\activate.bat" (
  echo [ERREUR] Le venv est introuvable.
  echo Lancez install.bat avant run.bat.
  pause
  exit /b 1
)

call ".venv\Scripts\activate.bat"

echo [CODEV] Demarrage de l'application...
echo [CODEV] Ouvrez http://127.0.0.1:8000 dans votre navigateur.
echo.

python -m uvicorn app:app --reload --host 127.0.0.1 --port 8000

pause
