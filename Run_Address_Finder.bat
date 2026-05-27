@echo off
setlocal enabledelayedexpansion
REM ===========================================================================
REM  Address Finder - self-contained launcher (Windows)
REM  -------------------------------------------------------------------------
REM  On first run this creates a private virtual environment (.venv) inside
REM  this folder and installs all required packages into it. Every run after
REM  that just launches the app from that venv - no PATH setup needed.
REM
REM  Keep this .bat in the SAME folder as:
REM      find_addresses.py
REM      find_addresses_gui.py
REM ===========================================================================

cd /d "%~dp0"
title Address Finder

set "VENV=.venv"
set "PYEXE=%VENV%\Scripts\python.exe"
set "MARKER=%VENV%\.deps_installed"

REM ---- sanity: the two source files must be present --------------------------
if not exist "find_addresses_gui.py" (
    echo [ERROR] find_addresses_gui.py was not found in this folder:
    echo         %CD%
    echo Put this .bat in the same folder as the two .py files and try again.
    goto :fail
)
if not exist "find_addresses.py" (
    echo [ERROR] find_addresses.py was not found in this folder:
    echo         %CD%
    echo The GUI needs find_addresses.py beside it. Move both files together.
    goto :fail
)

REM ---- fast path: venv already built and deps installed ----------------------
if exist "%PYEXE%" if exist "%MARKER%" goto :launch

REM ---- find a working Python to BUILD the venv with --------------------------
echo Looking for a Python installation to set up the environment...
set "BOOTPY="

REM Prefer the Windows "py" launcher (works even when PATH is not set).
where py >nul 2>&1
if !errorlevel! == 0 (
    py -3 -c "import sys" >nul 2>&1
    if !errorlevel! == 0 set "BOOTPY=py -3"
)

REM Fall back to "python" on PATH.
if not defined BOOTPY (
    where python >nul 2>&1
    if !errorlevel! == 0 (
        python -c "import sys" >nul 2>&1
        if !errorlevel! == 0 set "BOOTPY=python"
    )
)

if not defined BOOTPY (
    echo.
    echo [ERROR] Could not find Python on this PC.
    echo.
    echo   1. Install Python 3.10 or newer from https://www.python.org/downloads/
    echo   2. On the FIRST installer screen, TICK "Add python.exe to PATH".
    echo   3. Then double-click this file again.
    echo.
    goto :fail
)

echo Found Python via: !BOOTPY!
for /f "delims=" %%v in ('!BOOTPY! -c "import sys;print(sys.version.split()[0])"') do set "PYVER=%%v"
echo Using Python version: !PYVER!

REM ---- make sure that Python has tkinter (needed for the window) -------------
!BOOTPY! -c "import tkinter" >nul 2>&1
if !errorlevel! neq 0 (
    echo.
    echo [ERROR] This Python does not include tkinter, which the window needs.
    echo Install the standard Python from python.org ^(it bundles tkinter^),
    echo then delete the .venv folder here and run this file again.
    echo.
    goto :fail
)

REM ---- create the virtual environment ---------------------------------------
if not exist "%PYEXE%" (
    echo Creating virtual environment in "%VENV%" ... this happens only once.
    !BOOTPY! -m venv "%VENV%"
    if !errorlevel! neq 0 (
        echo [ERROR] Failed to create the virtual environment.
        goto :fail
    )
)

REM ---- install packages into the venv ---------------------------------------
echo Upgrading pip ...
"%PYEXE%" -m pip install --upgrade pip
echo.
echo Installing required packages ^(first run only, please wait^) ...
"%PYEXE%" -m pip install requests beautifulsoup4 openpyxl lxml ddgs anthropic
if !errorlevel! neq 0 (
    echo.
    echo [ERROR] Package installation failed. Check your internet connection
    echo         and try again. You can also delete the .venv folder to reset.
    goto :fail
)

REM ---- mark setup complete so future runs skip straight to launch -----------
echo done> "%MARKER%"
echo.
echo Setup complete.
echo.

:launch
echo Starting Address Finder...
"%PYEXE%" find_addresses_gui.py
set "RC=!errorlevel!"
if !RC! neq 0 (
    echo.
    echo [ERROR] The app exited with an error ^(code !RC!^). The message above
    echo         shows what went wrong.
    echo.
    echo Tip: to fully reset the environment, delete the ".venv" folder in
    echo      this directory, then run this file again.
    goto :fail
)
goto :eof

:fail
echo.
pause
exit /b 1
