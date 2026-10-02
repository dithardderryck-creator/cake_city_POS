@echo off
rem Starts the Cake POS server. NOT YET TESTED ON WINDOWS.
rem Edit the paths and settings below, then run install-task.ps1 once to start it at boot.

set PORT=8787
set BACKUP_TIME=02:00
rem set DATA_DIR=D:\CakePOS-data
rem set CLOUD_BACKUP_DIR=C:\Users\YOURNAME\OneDrive\CakePOS
rem set STATIC_DIR=C:\cake-pos\apps\web\dist

cd /d C:\cake-pos\packages\server
node dist\cake-pos-server.mjs
