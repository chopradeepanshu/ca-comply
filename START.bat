@echo off
title CA Comply - Starting...
color 0A

echo.
echo  ============================================
echo   CA Comply - Multi-tenant SaaS Platform
echo  ============================================
echo.

:: Check Docker is running
docker info >nul 2>&1
if %errorlevel% neq 0 (
    color 0C
    echo  [ERROR] Docker is not running!
    echo  Please start Docker Desktop and try again.
    echo.
    pause
    exit /b 1
)

echo  [OK] Docker is running
echo.

:: Clean up old failed containers if any
docker-compose down >nul 2>&1

echo  Building and starting services...
echo  (First run takes 2-3 minutes to download images)
echo.

docker-compose up --build -d

if %errorlevel% neq 0 (
    color 0C
    echo.
    echo  [ERROR] Failed to start!
    echo.
    echo  Showing logs:
    docker-compose logs --tail=30
    echo.
    pause
    exit /b 1
)

echo.
echo  Waiting 20 seconds for all services to be ready...
timeout /t 20 /nobreak >nul

color 0A
echo.
echo  ============================================
echo   SUCCESS! CA Comply is running
echo  ============================================
echo.
echo   Open in browser:   http://localhost
echo.
echo   Demo Login:
echo     Email:     ravi@raviranjan-ca.in
echo     Password:  Demo@1234
echo.
echo   API Health:   http://localhost:4000/api/health
echo   API Ready:    http://localhost:4000/api/health/ready
echo.
echo  ============================================
echo.

start http://localhost

echo  Showing live logs (press Ctrl+C to stop watching):
echo.
docker-compose logs -f --tail=20
