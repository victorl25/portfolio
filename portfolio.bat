@echo off
setlocal enabledelayedexpansion

set "CHROME=%~dp0chrome\chrome.exe"

:: Accept optional first argument as DATA_DIR override; default to <appDir>\data
if "%~1" neq "" (
  set "DATA_DIR=%~1"
) else (
  set "DATA_DIR=%~dp0data"
)

:: Create data folder if it doesn't exist
if not exist "!DATA_DIR!" mkdir "!DATA_DIR!"

:: Build file:// URL for index.html (convert backslashes to forward slashes)
set "APP_DIR=%~dp0"
set "APP_DIR=!APP_DIR:\=/!"
set "APP_URL=file:///!APP_DIR!index.html"

:: Build dataDir URL parameter (forward slashes; encode spaces as %20)
set "DATA_DIR_PARAM=!DATA_DIR:\=/!"
set "DATA_DIR_PARAM=!DATA_DIR_PARAM: =%%20!"

:: Find most recent .db file — filenames are timestamped so descending name = descending time
set "LATEST="
for /f "delims=" %%f in ('dir /b /o-n "!DATA_DIR!\*.db" 2^>nul') do (
  if not defined LATEST set "LATEST=%%f"
)

if defined LATEST (
  start "" "%CHROME%" --allow-file-access-from-files --enable-features=FileSystemAccessAPI "!APP_URL!?dataDir=!DATA_DIR_PARAM!&db=!LATEST!"
) else (
  start "" "%CHROME%" --allow-file-access-from-files --enable-features=FileSystemAccessAPI "!APP_URL!?dataDir=!DATA_DIR_PARAM!"
)
