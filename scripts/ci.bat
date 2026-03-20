@echo off
setlocal enabledelayedexpansion
REM Windows CI script — runs MCP tests, extension tests, and extension build.
REM Firmware steps are skipped (PlatformIO targets Linux/macOS).
REM Usage: scripts\ci.bat

set "ROOT=%~dp0.."

echo.
echo === MCP tests ===
pushd "%ROOT%\mcp"
call node --test
if !errorlevel! neq 0 ( popd & echo MCP tests failed & exit /b 1 )
popd

echo.
echo === Extension tests ===
pushd "%ROOT%\extension"
call node --test
if !errorlevel! neq 0 ( popd & echo Extension tests failed & exit /b 1 )
popd

echo.
echo === Extension build ===
pushd "%ROOT%\extension"
call npm run build
if !errorlevel! neq 0 ( popd & echo Extension build failed & exit /b 1 )
popd

echo.
echo === All checks passed ===
