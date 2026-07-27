@echo off
REM えひめイベントナビ PCサーバー起動用（ダブルクリックでOK）
REM このバッチと同じフォルダで実行される。

cd /d "%~dp0"

echo ============================================
echo   prefecture-events-ai  PC server
echo ============================================

REM 依存が未インストールなら入れる
if not exist "node_modules" (
  echo [setup] installing dependencies...
  call npm install
)

REM フロント(dist)が無ければビルド
if not exist "packages\web\dist\index.html" (
  echo [build] building frontend...
  call npm run web:build
)

echo [start] launching server...
call npm run start

echo.
echo サーバーが終了しました。ウィンドウを閉じるか、再実行してください。
pause
