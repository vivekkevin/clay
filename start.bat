@echo off
setlocal

echo.
echo  ==========================================
echo   CLAY Foundation Model Web Platform
echo  ==========================================
echo.

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  ERROR: Node.js not found. Install from https://nodejs.org
    pause
    exit /b 1
)
echo  Node.js found.

if not exist "server\node_modules" (
    echo  Installing server dependencies...
    cd server
    call npm install --silent
    cd ..
)

if not exist "client\node_modules" (
    echo  Installing client dependencies...
    cd client
    call npm install --silent
    cd ..
)

echo.
echo  Starting API server on http://localhost:3001
echo  Starting web client on http://localhost:5173
echo.
echo  Open your browser at: http://localhost:5173
echo  Press Ctrl+C in this window to stop both servers.
echo.

:: Start API server in a new window
start "CLAY API Server" cmd /k "cd /d %~dp0server && node index.js"

:: Wait a moment for the server to start
timeout /t 2 /nobreak >nul

:: Start Vite dev server in current window
cd client
call npx vite --host 0.0.0.0

endlocal
