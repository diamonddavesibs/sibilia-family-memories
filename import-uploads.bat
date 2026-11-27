@echo off
rem Brings approved family uploads onto the site. Double-click to run.
cd /d "%~dp0"
where py >nul 2>nul && (set PY=py -3) || (set PY=python)
%PY% -m pip install --user --quiet --disable-pip-version-check pillow pillow-heif boto3
%PY% import_uploads.py %*
echo.
pause
