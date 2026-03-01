@echo off
title CA Comply - Stopping...
color 0E

echo.
echo  Stopping CA Comply...
echo.
docker-compose down

echo.
echo  All services stopped. Data is preserved.
echo  Run START.bat to start again.
echo.
pause
