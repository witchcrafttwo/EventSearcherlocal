@echo off
REM えひめイベントナビ PCサーバー起動用（ダブルクリックでOK）
REM このバッチと同じフォルダで実行される。
REM 文字コードはCP932(Shift-JIS)で保存すること。UTF-8にすると表示が化ける。

cd /d "%~dp0"

echo ============================================
echo   prefecture-events-ai  PC server
echo ============================================

REM 依存が未インストールなら入れる
if not exist "node_modules" (
  echo [setup] installing dependencies...
  call npm install
  if errorlevel 1 goto installfailed
)

REM フロントは未ビルドか、ソースがdistより新しいときだけビルドする。
REM 判定は scripts\web-build-needed.ps1 が行い、必要なら終了コード1を返す。
REM 変更が無ければビルドを飛ばすので起動が速い。
set NEEDBUILD=0
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\web-build-needed.ps1"
if errorlevel 1 set NEEDBUILD=1

if "%NEEDBUILD%"=="1" (
  echo [build] building frontend...
  call npm run web:build
  if errorlevel 1 goto buildfailed
  for %%F in ("packages\web\dist\index.html") do echo [build] done: %%~tF
)

:launch
echo [start] launching server...
call npm run start

echo.
echo サーバーが終了しました。ウィンドウを閉じるか、再実行してください。
pause
exit /b 0

:buildfailed
echo.
echo [error] ビルドに失敗しました。上のエラーを確認してください。
if exist "packages\web\dist\index.html" (
  echo [warn] 前回のビルド結果のまま起動します。画面は古い内容です。
  echo [warn] 直したら、このバッチを再実行してください。
  echo.
  goto launch
)
echo [error] 配信できるdistがありません。ビルドを直してから再実行してください。
echo.
pause
exit /b 1

:installfailed
echo.
echo [error] npm install に失敗しました。ネットワークとNode.jsの状態を確認してください。
echo.
pause
exit /b 1
