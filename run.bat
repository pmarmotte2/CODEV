@echo off
setlocal

cd /d "%~dp0"

echo [CODEV] Nettoyage des anciennes instances...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue'; $ids=@(); $ids += (Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'uvicorn\s+app:app' -and $_.Name -match 'python|uvicorn' }).ProcessId; $ids += (Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 8000 -State Listen).OwningProcess; $ids = @($ids | Where-Object { $_ -and $_ -ne $PID } | Sort-Object -Unique); $ids += (Get-CimInstance Win32_Process | Where-Object { $ids -contains $_.ParentProcessId }).ProcessId; $ids | Where-Object { $_ -and $_ -ne $PID } | Sort-Object -Unique | ForEach-Object { Stop-Process -Id $_ -Force }"
echo.

if "%CODEV_CLEAN_ONLY%"=="1" exit /b 0

if not exist ".venv\Scripts\python.exe" (
  echo [ERREUR] Le venv est introuvable.
  echo Lancez install.bat avant run.bat.
  pause
  exit /b 1
)

echo [CODEV] Demarrage de l'application...
echo [CODEV] Ouvrez http://127.0.0.1:8000 dans votre navigateur.
echo.

call ".venv\Scripts\python.exe" -m uvicorn app:app --reload --host 127.0.0.1 --port 8000

pause
