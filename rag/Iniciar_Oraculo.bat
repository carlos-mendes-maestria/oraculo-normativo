@echo off
rem Abre o Oraculo no navegador com o modelo padrao (cerca de 15 minutos por resposta sem placa de video dedicada).
cd /d "%~dp0"
py oraculo_local.py
pause
