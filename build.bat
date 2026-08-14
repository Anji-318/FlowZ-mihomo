@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul
title FlowZ (mihomo) 构建菜单

cd /d "%~dp0"

:menu
cls
echo ==================================================
echo   FlowZ (mihomo 核心) - 构建菜单
echo ==================================================
echo.
echo   [1] 构建 Windows (x64)
echo   [2] 构建 macOS (arm64 + x64)
echo   [3] 构建 Linux (x64)
echo   [4] 构建所有平台 (Win + Mac + Linux)
echo.
echo   [5] 安装依赖 (npm install)
echo   [6] 仅获取 mihomo 核心 (fetch:core)
echo.
echo   [0] 退出
echo.
set /p choice=请选择 [0-6]:

if "%choice%"=="1" goto build_win
if "%choice%"=="2" goto build_mac
if "%choice%"=="3" goto build_linux
if "%choice%"=="4" goto build_all
if "%choice%"=="5" goto install_deps
if "%choice%"=="6" goto fetch_core
if "%choice%"=="0" goto end
echo 无效选项，请重新选择。
pause
goto menu

:check_deps
if not exist node_modules (
  echo 未找到 node_modules，正在先安装依赖...
  call npm install --no-audit --no-fund
  if errorlevel 1 goto fail
)
exit /b 0

:build_win
call :check_deps || goto fail
echo.
echo === 正在构建 Windows 安装包 ===
call npm run dist:win
if errorlevel 1 goto fail
goto done

:build_mac
call :check_deps || goto fail
echo.
echo === 正在构建 macOS 安装包 (arm64 + x64) ===
call npm run dist:mac
if errorlevel 1 goto fail
goto done

:build_linux
call :check_deps || goto fail
echo.
echo === 正在构建 Linux 安装包 (x64) ===
call npm run dist:linux
if errorlevel 1 goto fail
goto done

:build_all
call :check_deps || goto fail
echo.
echo === 正在构建所有平台 ===
echo.
echo --- [1/3] Windows ---
call npm run dist:win
if errorlevel 1 goto fail
echo.
echo --- [2/3] macOS ---
call npm run dist:mac
if errorlevel 1 goto fail
echo.
echo --- [3/3] Linux ---
call npm run dist:linux
if errorlevel 1 goto fail
goto done

:install_deps
call npm install --no-audit --no-fund
if errorlevel 1 goto fail
goto done

:fetch_core
call npm run fetch:core
if errorlevel 1 goto fail
goto done

:done
echo.
echo ==================================================
echo   完成。构建产物位于 dist/ 目录中。
echo ==================================================
pause
goto menu

:fail
echo.
echo ==================================================
echo   构建失败 - 请查看上方输出了解详情。
echo ==================================================
pause
goto menu

:end
endlocal