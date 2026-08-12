!include "LogicLib.nsh"
!include "WinMessages.nsh"

!macro updatePmdLocalCliPath action
  Push $0
  Push $1
  Push $R7
  Push $R8
  Push $R9
  Push $OUTDIR
  SetOutPath "$PLUGINSDIR"
  File /oname=pmd-local-update-path.ps1 "${BUILD_RESOURCES_DIR}\pmd-update-path.ps1"
  Pop $R7
  SetOutPath "$R7"

  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\pmd-local-update-path.ps1" -Action "${action}" -Scope "User" -Directory "$INSTDIR\resources\bin"'
  Pop $R9
  ${If} $R9 != 0
    DetailPrint "Unable to ${action} the pmd-local CLI directory in the user PATH (exit $R9)."
    SetErrors
  ${EndIf}

  System::Call 'USER32::SendMessageTimeoutW(p ${HWND_BROADCAST}, i ${WM_SETTINGCHANGE}, p 0, t "Environment", i 0x0002, i 5000, *p .r0) p .r1'
  Pop $R9
  Pop $R8
  Pop $R7
  Pop $1
  Pop $0
!macroend

!macro customInstall
  !insertmacro updatePmdLocalCliPath "Add"
!macroend

!macro customUnInstall
  !insertmacro updatePmdLocalCliPath "Remove"
!macroend
