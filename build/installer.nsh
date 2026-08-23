!include "LogicLib.nsh"
!include "WinMessages.nsh"

!macro updatePmdCliPath action
  Push $0
  Push $1
  Push $R7
  Push $R8
  Push $R9
  Push $OUTDIR
  SetOutPath "$PLUGINSDIR"
  File /oname=pmd-update-path.ps1 "${BUILD_RESOURCES_DIR}\pmd-update-path.ps1"
  Pop $R7
  SetOutPath "$R7"

  ${If} $installMode == "all"
    StrCpy $R8 "Machine"
  ${Else}
    StrCpy $R8 "User"
  ${EndIf}

  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\pmd-update-path.ps1" -Action "${action}" -Scope "$R8" -Directory "$INSTDIR\resources\bin"'
  Pop $R9
  ${If} $R9 != 0
    DetailPrint "Unable to ${action} the pmd CLI directory in the $R8 PATH (exit $R9)."
    SetErrors
  ${EndIf}

  System::Call 'USER32::SendMessageTimeoutW(p ${HWND_BROADCAST}, i ${WM_SETTINGCHANGE}, p 0, t "Environment", i 0x0002, i 5000, *p .r0) p .r1'
  Pop $R9
  Pop $R8
  Pop $R7
  Pop $1
  Pop $0
!macroend

!macro removePmdFileAssociation extension
  ReadRegStr $R6 SHCTX "Software\Classes\.${extension}" ""
  ${If} $R6 == "PulseMD.Markdown"
    DeleteRegValue SHCTX "Software\Classes\.${extension}" ""
  ${EndIf}
  DeleteRegValue SHCTX "Software\Classes\.${extension}\OpenWithProgids" "PulseMD.Markdown"
  DeleteRegKey /ifempty SHCTX "Software\Classes\.${extension}\OpenWithProgids"
  DeleteRegKey /ifempty SHCTX "Software\Classes\.${extension}"
!macroend

!macro removePmdPerUserFileAssociation extension
  ReadRegStr $R6 HKCU "Software\Classes\.${extension}" ""
  ${If} $R6 == "PulseMD.Markdown"
    DeleteRegValue HKCU "Software\Classes\.${extension}" ""
  ${EndIf}
  DeleteRegValue HKCU "Software\Classes\.${extension}\OpenWithProgids" "PulseMD.Markdown"
  DeleteRegKey /ifempty HKCU "Software\Classes\.${extension}\OpenWithProgids"
  DeleteRegKey /ifempty HKCU "Software\Classes\.${extension}"
!macroend

!macro customInstall
  !insertmacro updatePmdCliPath "Add"
  # HKCU classes override the all-users HKLM classes. Remove only Pulse-owned
  # per-user registrations when promoting the canonical install machine-wide.
  ${If} $installMode == "all"
    Push $R6
    !insertmacro removePmdPerUserFileAssociation "md"
    !insertmacro removePmdPerUserFileAssociation "markdown"
    !insertmacro removePmdPerUserFileAssociation "mdown"
    !insertmacro removePmdPerUserFileAssociation "mkd"
    DeleteRegKey HKCU "Software\Classes\PulseMD.Markdown"
    DeleteRegKey HKCU "Software\Classes\pulse-md"
    Pop $R6
  ${EndIf}
  # electron-builder does not quote $appExe in its generated file-association
  # command. Replace it after the generated association macro has run.
  WriteRegStr SHCTX "Software\Classes\PulseMD.Markdown\shell\open\command" "" '$\"$appExe$\" $\"%1$\"'
  WriteRegStr SHCTX "Software\Classes\pulse-md" "" "URL:Pulse MD Scratch Link"
  WriteRegStr SHCTX "Software\Classes\pulse-md" "URL Protocol" ""
  WriteRegStr SHCTX "Software\Classes\pulse-md\DefaultIcon" "" '$\"$appExe$\",0'
  WriteRegStr SHCTX "Software\Classes\pulse-md\shell\open\command" "" '$\"$appExe$\" $\"%1$\"'
  # These final Pulse-owned rewrites run after electron-builder registers its
  # associations, so notify Explorer only once the effective keys are settled.
  !insertmacro UPDATEFILEASSOC
!macroend

!macro customUnInstall
  !insertmacro updatePmdCliPath "Remove"
  Push $R6
  # Clear a default only when it still points at our ProgID. Always remove our
  # OpenWithProgids value, then prune only empty extension keys.
  !insertmacro removePmdFileAssociation "md"
  !insertmacro removePmdFileAssociation "markdown"
  !insertmacro removePmdFileAssociation "mdown"
  !insertmacro removePmdFileAssociation "mkd"
  DeleteRegKey SHCTX "Software\Classes\PulseMD.Markdown"
  DeleteRegKey SHCTX "Software\Classes\pulse-md"
  Pop $R6
!macroend
