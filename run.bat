@echo off
REM =====================================================================
REM  RiskFiveRuler launcher
REM
REM  KEEP THIS FILE PURE ASCII. cmd.exe mis-parses multi-byte text in a
REM  .bat file, and it processes redirection before REM runs.
REM =====================================================================
setlocal
cd /d "%~dp0"

if exist "RiskFiveRuler.exe" (
    if not exist "WebView2Loader.dll" (
        echo  WARNING: WebView2Loader.dll is missing next to RiskFiveRuler.exe.
        echo  Copy it from the repository root before running on another machine.
        echo.
    )
    start "" "RiskFiveRuler.exe"
    exit /b 0
)

echo.
echo  RiskFiveRuler.exe not found.
echo.
echo  Build the portable desktop exe (no dev server needed):
echo     npm install
echo     npm run package:exe
echo.
echo  The script runs "tauri build" so the UI is embedded in the binary.
echo  A plain "cargo build" produces an exe that tries http://127.0.0.1:1420
echo  and shows a blank window - do not ship that.
echo.
pause
