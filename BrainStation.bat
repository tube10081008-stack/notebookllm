@echo off
title BrainStation Engine
echo ===================================================
echo   BrainStation Agent Workstation is launching...
echo ===================================================
cd /d c:\Users\tube1\Projects\second-brain
start http://localhost:3456
node server.js
pause
