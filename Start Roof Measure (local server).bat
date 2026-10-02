@echo off
title Roof Measure server
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0serve.ps1" -Port 8080 -Open
