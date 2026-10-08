Unicode True
RequestExecutionLevel user
ManifestDPIAware true

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"

!ifndef PRODUCT_VERSION
  !define PRODUCT_VERSION "0.3.2"
!endif
!ifndef INPUT_DIR
  !define INPUT_DIR "native-dist\payload"
!endif
!ifndef OUTPUT_EXE
  !define OUTPUT_EXE "installers\CPEMonitor_${PRODUCT_VERSION}_x64-setup.exe"
!endif

Name "CPE Monitor"
Caption "CPE Monitor ${PRODUCT_VERSION} 安装程序"
OutFile "${OUTPUT_EXE}"
InstallDir "$LOCALAPPDATA\CPE Monitor"
InstallDirRegKey HKCU "Software\CPE Monitor" "InstallDir"
BrandingText "CPE Monitor"
ShowInstDetails show
ShowUnInstDetails show
SetCompressor /SOLID lzma

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\CPEMonitor.exe"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

VIProductVersion "${PRODUCT_VERSION}.0"
VIAddVersionKey /LANG=2052 "ProductName" "CPE Monitor"
VIAddVersionKey /LANG=2052 "FileDescription" "CPE Monitor 原生 Windows 客户端"
VIAddVersionKey /LANG=2052 "ProductVersion" "${PRODUCT_VERSION}"
VIAddVersionKey /LANG=2052 "FileVersion" "${PRODUCT_VERSION}.0"
VIAddVersionKey /LANG=2052 "CompanyName" "CPE Monitor"
VIAddVersionKey /LANG=2052 "LegalCopyright" "CPE Monitor"

!macro EnsureNativeClosed PREFIX
Function ${PREFIX}EnsureNativeClosed
  System::Call 'kernel32::OpenMutexW(i 0x00100000, i 0, w "Local\CPEMonitor.Native") p.r0'
  ${If} $0 != 0
    System::Call 'kernel32::CloseHandle(p r0)'
    MessageBox MB_ICONSTOP "CPE Monitor 正在运行。请从本程序托盘菜单选择退出后重试。安装或卸载不会自动停止程序。" /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
FunctionEnd
!macroend

!insertmacro EnsureNativeClosed ""
!insertmacro EnsureNativeClosed "un."

Function EnsureWebViewRuntime
  SetRegView 32
  ReadRegStr $0 HKLM "Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ReadRegStr $1 HKCU "Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ${If} $0 != ""
  ${AndIf} $0 != "0.0.0.0"
    Return
  ${EndIf}
  ${If} $1 != ""
  ${AndIf} $1 != "0.0.0.0"
    Return
  ${EndIf}
  DetailPrint "正在安装页面运行环境（首次需要联网）…"
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=MicrosoftEdgeWebview2Setup.exe "${INPUT_DIR}\support\MicrosoftEdgeWebview2Setup.exe"
  ExecWait '"$PLUGINSDIR\MicrosoftEdgeWebview2Setup.exe" /silent /install' $2
  ReadRegStr $0 HKLM "Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ReadRegStr $1 HKCU "Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ${If} $0 == ""
  ${AndIf} $1 == ""
    MessageBox MB_ICONSTOP "页面运行环境未能安装。请检查网络后重新运行本安装包。你的原有配置已保留。" /SD IDOK
    SetErrorLevel 3
    Abort
  ${EndIf}
FunctionEnd

Function .onInit
  SetShellVarContext current
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "CPE Monitor 安装包仅支持 64 位 Windows。" /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
  Call EnsureNativeClosed
FunctionEnd

Function un.onInit
  SetShellVarContext current
  Call un.EnsureNativeClosed
FunctionEnd

Section "CPE Monitor" SEC_MAIN
  Call EnsureNativeClosed
  Call EnsureWebViewRuntime
  IfFileExists "$INSTDIR\.cpe-monitor-install" install_directory_ready
  IfFileExists "$INSTDIR\*" 0 install_directory_ready
    MessageBox MB_ICONSTOP "请选择一个空目录，或选择已有 CPE Monitor 的安装目录。为避免误覆盖其他文件，安装已停止。" /SD IDOK
    SetErrorLevel 2
    Abort
  install_directory_ready:
  SetOutPath "$INSTDIR"
  ClearErrors
  File /r "${INPUT_DIR}\*"
  ${If} ${Errors}
    MessageBox MB_ICONSTOP "无法写入程序文件。请确认本 CPE Monitor 已从托盘退出，且安装目录可写，然后重试。" /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
  FileOpen $1 "$INSTDIR\.cpe-monitor-install" w
  FileWrite $1 "CPE Monitor ${PRODUCT_VERSION}"
  FileClose $1
  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKCU "Software\CPE Monitor" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CPE Monitor" "DisplayName" "CPE Monitor"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CPE Monitor" "DisplayVersion" "${PRODUCT_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CPE Monitor" "DisplayIcon" "$INSTDIR\CPEMonitor.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CPE Monitor" "Publisher" "CPE Monitor"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CPE Monitor" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CPE Monitor" "UninstallString" '$\"$INSTDIR\uninstall.exe$\"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CPE Monitor" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CPE Monitor" "NoRepair" 1
  CreateDirectory "$SMPROGRAMS\CPE Monitor"
  CreateShortCut "$SMPROGRAMS\CPE Monitor\CPE Monitor.lnk" "$INSTDIR\CPEMonitor.exe"
  CreateShortCut "$DESKTOP\CPE Monitor.lnk" "$INSTDIR\CPEMonitor.exe"
SectionEnd

Section "Uninstall"
  Call un.EnsureNativeClosed
  IfFileExists "$INSTDIR\.cpe-monitor-install" uninstall_directory_ready
    MessageBox MB_ICONSTOP "安装目录标记缺失。为避免误删其他文件，卸载已停止。" /SD IDOK
    SetErrorLevel 2
    Abort
  uninstall_directory_ready:
  ; 只删除随包安装的目录，绝不递归删除用户选择的整个安装目录。
  Delete "$INSTDIR\CPEMonitor.exe"
  ${If} ${Errors}
    MessageBox MB_ICONSTOP "程序文件被占用，卸载已停止。请关闭本 CPE Monitor 后重试。" /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
  RMDir /r "$INSTDIR\resources"
  RMDir /r "$INSTDIR\runtime"
  RMDir /r "$INSTDIR\support"
  Delete "$SMPROGRAMS\CPE Monitor\CPE Monitor.lnk"
  RMDir "$SMPROGRAMS\CPE Monitor"
  Delete "$DESKTOP\CPE Monitor.lnk"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CPE Monitor"
  DeleteRegKey HKCU "Software\CPE Monitor"
  ; 用户数据在 %APPDATA%\com.cpeye.monitor，卸载时保留。
  Delete "$INSTDIR\uninstall.exe"
  Delete "$INSTDIR\.cpe-monitor-install"
  RMDir "$INSTDIR"
SectionEnd
