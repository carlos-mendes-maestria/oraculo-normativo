@echo off
rem Abre o Oraculo com um modelo menor (cerca de 6 minutos por resposta sem placa de video dedicada).
cd /d "%~dp0"
py oraculo_local.py --modelo gemma4:e4b
pause
