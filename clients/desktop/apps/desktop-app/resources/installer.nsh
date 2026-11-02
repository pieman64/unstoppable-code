; Register the installed desktop app as a Windows Default Apps browser choice.
; `config.protocols` covers macOS/Linux, while Windows requires an advertised
; RegisteredApplications capability before Settings will offer HTTP/HTTPS.

!macro customInstall
  WriteRegStr SHELL_CONTEXT "Software\Classes\${APP_ID}.URL" "" "${PRODUCT_NAME} URL"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${APP_ID}.URL" "URL Protocol" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\${APP_ID}.URL\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${APP_ID}.URL\shell\open\command" "" '$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" $\"%1$\"'

  WriteRegStr SHELL_CONTEXT "Software\Clients\StartMenuInternet\${APP_ID}" "" "${PRODUCT_NAME}"
  WriteRegStr SHELL_CONTEXT "Software\Clients\StartMenuInternet\${APP_ID}\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHELL_CONTEXT "Software\Clients\StartMenuInternet\${APP_ID}\shell\open\command" "" '$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\"'
  WriteRegStr SHELL_CONTEXT "Software\Clients\StartMenuInternet\${APP_ID}\Capabilities" "ApplicationDescription" "${APP_DESCRIPTION}"
  WriteRegStr SHELL_CONTEXT "Software\Clients\StartMenuInternet\${APP_ID}\Capabilities" "ApplicationIcon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHELL_CONTEXT "Software\Clients\StartMenuInternet\${APP_ID}\Capabilities" "ApplicationName" "${PRODUCT_NAME}"
  WriteRegStr SHELL_CONTEXT "Software\Clients\StartMenuInternet\${APP_ID}\Capabilities\URLAssociations" "http" "${APP_ID}.URL"
  WriteRegStr SHELL_CONTEXT "Software\Clients\StartMenuInternet\${APP_ID}\Capabilities\URLAssociations" "https" "${APP_ID}.URL"
  WriteRegStr SHELL_CONTEXT "Software\RegisteredApplications" "${APP_ID}" "Software\Clients\StartMenuInternet\${APP_ID}\Capabilities"
!macroend

!macro customUnInstall
  DeleteRegValue SHELL_CONTEXT "Software\RegisteredApplications" "${APP_ID}"
  DeleteRegKey SHELL_CONTEXT "Software\Clients\StartMenuInternet\${APP_ID}"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\${APP_ID}.URL"
!macroend

; Bundled processes (CAN-4965). The core daemon in resources\bin outlives the
; app by design; left running, it would serve the next version from the old
; install. Every install, in-app update and uninstall reaches this hook, once
; per build: the installer through installSection.nsh, the uninstaller through
; un.checkAppRunning. Defining it drops the template's getProcessInfo.nsh
; include and $pid, which _CHECK_APP_RUNNING still uses. Use macros only: an
; unreferenced Function fails the -WX build. Without usable PowerShell only the
; template's name-based check runs, and a running daemon is left alone.
!include "getProcessInfo.nsh"
Var pid

!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro canopyStopIdleDaemon
  !insertmacro _CHECK_APP_RUNNING
  !insertmacro canopyStopBundled
!macroend

; PowerShell reads the install directory from the environment, so no path
; character can break its quoting.
!macro canopyExportInstallDir
  System::Call 'Kernel32::SetEnvironmentVariable(t "CANOPY_INSTALL_DIR", t "$INSTDIR")'
!macroend

; When idle daemons (the executables shipped with an .identity.json) are the
; only processes left under the install, stop them, so an app that has quit
; does not prompt "is running". Anything else running keeps the template's
; prompt, and keeps the daemon it may be using, until the user confirms.
!macro canopyStopIdleDaemon
  ${if} $IsPowerShellAvailable == 0
    !insertmacro canopyExportInstallDir
    nsExec::Exec `"$PowerShellPath" -NoProfile -NonInteractive -C "$$r = $$env:CANOPY_INSTALL_DIR.TrimEnd('\') + '\'; $$p = @(Get-CimInstance -ClassName Win32_Process | ? { $$_.Path -and $$_.Path.StartsWith($$r, 'OrdinalIgnoreCase') }); $$d = @($$p | ? { $$_.Path.StartsWith($$r + 'resources\bin\', 'OrdinalIgnoreCase') -and (Test-Path -LiteralPath ($$_.Path + '.identity.json')) }); if ($$p.Count -gt 0 -and $$d.Count -eq $$p.Count) { $$d | % { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue; Wait-Process -Id $$_.ProcessId -Timeout 5 -ErrorAction SilentlyContinue } }"`
    Pop $R0
  ${endIf}
!macroend

; After the template's check, nothing under resources\bin or resources\cli may
; still run. Stop what remains for up to 5 s (exit 2 if it survives, for
; example when started elevated), then abort and keep the installed version
; rather than replace files beneath it. Other failures fall through, as the
; template's own checks do.
!macro canopyStopBundled
  ${if} $IsPowerShellAvailable == 0
    canopy_stop_bundled:
    !insertmacro canopyExportInstallDir
    nsExec::Exec `"$PowerShellPath" -NoProfile -NonInteractive -C "$$r = $$env:CANOPY_INSTALL_DIR.TrimEnd('\') + '\resources\'; for ($$i = 0; ; $$i++) { $$p = @(Get-CimInstance -ClassName Win32_Process | ? { $$_.Path -and ($$_.Path.StartsWith($$r + 'bin\', 'OrdinalIgnoreCase') -or $$_.Path.StartsWith($$r + 'cli\', 'OrdinalIgnoreCase')) }); if ($$p.Count -eq 0) { exit 0 }; if ($$i -ge 10) { exit 2 }; $$p | % { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 500 }"`
    Pop $R0
    ${if} $R0 == 2
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY canopy_stop_bundled
      Quit
    ${endIf}
  ${endIf}
!macroend
