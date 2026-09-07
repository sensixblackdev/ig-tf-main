@echo off
title IG System Launcher
echo ========================================================
echo        INICIANDO SISTEMA IG MONITOR (WARM WORKER + NODE)
echo ========================================================
echo.
echo [1/2] Iniciando Warm Worker Playwright (:3006)...
start "IG-Warm-Worker" /min python bot_service.py
timeout /t 4 /nobreak >nul

echo [2/2] Iniciando Servidor Web Node.js (:5501)...
start "IG-Web-Server" /min node server.js
timeout /t 2 /nobreak >nul

echo.
echo ========================================================
echo  SISTEMA PRONTO:
echo  - Painel do Operador: http://localhost:5501/painel
echo  - Tela de Login:     http://localhost:5501/
echo  - Tela de 2FA:       http://localhost:5501/codigo/
echo  - Worker Persistente: http://127.0.0.1:3006/health
echo ========================================================
echo Abrindo o painel no navegador padrao...
start http://localhost:5501/painel
pause
