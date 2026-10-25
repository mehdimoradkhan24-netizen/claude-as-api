@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

rem ===== Settings (edit these) =====
set PORT=8787
set PROXY_API_KEY=change-me-to-a-long-random-key
set CLAUDE_MODEL=claude-sonnet-5-5
rem IPs allowed to call with an EMPTY key (VS Code on system B sends none). Comma separated.
set TRUSTED_IPS=10.237.201.222
rem =================================

where node >nul 2>nul || (echo [!] Node.js 18+ is not installed. Get it from https://nodejs.org & pause & exit /b 1)

where claude >nul 2>nul
if errorlevel 1 (
  echo [*] Installing Claude Code...
  call npm install -g @anthropic-ai/claude-code || (echo [!] Install failed & pause & exit /b 1)
)

if not exist node_modules (
  echo [*] Installing project dependencies...
  call npm install || (echo [!] npm install failed & pause & exit /b 1)
)

rem First run only: sign in to Claude Code (skipped if ANTHROPIC_API_KEY is set or already logged in).
if "%ANTHROPIC_API_KEY%"=="" if not exist "%USERPROFILE%\.claude\.credentials.json" (
  echo [*] Opening Claude Code for first-time login. Finish login, then type /exit
  call claude
)

rem Allow system B to reach the port (needs admin; ignore errors otherwise).
netsh advfirewall firewall show rule name="claude-as-api" >nul 2>nul || netsh advfirewall firewall add rule name="claude-as-api" dir=in action=allow protocol=TCP localport=%PORT% >nul 2>nul

echo.
echo ===== Use this on system B =====
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do for /f "tokens=*" %%b in ("%%a") do echo   Base URL: http://%%b:%PORT%/v1/messages
echo   API key : %PROXY_API_KEY%
echo ================================
echo.
node server.js
pause
