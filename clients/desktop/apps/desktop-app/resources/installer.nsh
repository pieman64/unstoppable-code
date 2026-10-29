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
