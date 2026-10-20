@echo off
REM ===================================================================
REM  QC BookLog - Windows one-click build
REM  Double-click this file to build the installer.
REM  CLI flags are forwarded, e.g.:
REM      build-win.bat -InstallDeps -OpenOutput
REM ===================================================================
setlocal

cd /d "%~dp0.."

echo.
echo  QC BookLog - Windows build starting...
echo  Working dir: %CD%
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-win.ps1" %*
set "RC=%ERRORLEVEL%"

if not "%RC%"=="0" (
    echo.
    echo  Build failed with exit code %RC%.
    echo  Check build-win.log for details.
    echo.
    pause
)

endlocal & exit /b %RC%
