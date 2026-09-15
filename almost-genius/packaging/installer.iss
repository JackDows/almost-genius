#ifndef AppVersion
  #define AppVersion "0.4.0"
#endif
[Setup]
AppId={{EF02BFB3-FB9C-4148-95C5-CE72FDD35003}
AppName=Almost Genius
AppVersion={#AppVersion}
AppPublisher=Almost Genius
DefaultDirName={localappdata}\Programs\AlmostGenius
DefaultGroupName=Almost Genius
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.19041
OutputDir=..\dist
OutputBaseFilename=AlmostGenius-{#AppVersion}-Setup-x64
SetupIconFile=..\desktop\bin\AlmostGenius.ico
UninstallDisplayIcon={app}\desktop\bin\AlmostGenius.exe
Compression=lzma2/fast
SolidCompression=yes
WizardStyle=modern
DisableProgramGroupPage=yes
CloseApplications=no
SetupLogging=yes

[Tasks]
Name: desktopicon; Description: "创建桌面快捷方式"; Flags: checkedonce
Name: autostart; Description: "登录 Windows 后自动运行"; Flags: checkedonce

[Files]
Source: "stage\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "Prepare-Install.ps1"; Flags: dontcopy
Source: "vendor\WebView2Setup.exe"; Flags: dontcopy

[InstallDelete]
Type: files; Name: "{autodesktop}\Jira 工作提醒.lnk"
Type: files; Name: "{autoprograms}\Jira 工作提醒.lnk"
Type: files; Name: "{app}\desktop\bin\JiraReminder.exe"
Type: files; Name: "{app}\desktop\bin\JiraReminder.exe.config"

[Icons]
Name: "{autoprograms}\Almost Genius"; Filename: "{app}\desktop\bin\AlmostGenius.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\Almost Genius"; Filename: "{app}\desktop\bin\AlmostGenius.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File ""{app}\Install-Autostart.ps1"""; Flags: runhidden waituntilterminated; Tasks: autostart
Filename: "{app}\desktop\bin\AlmostGenius.exe"; Description: "打开 Almost Genius"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File ""{app}\packaging\Prepare-Install.ps1"" -InstallRoot ""{app}"" -Uninstall"; Flags: runhidden waituntilterminated; RunOnceId: "StopReminder"

[Code]
function HasWebView2: Boolean;
var Version: String;
begin
  Result := (RegQueryStringValue(HKCU, 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version) or
    RegQueryStringValue(HKLM32, 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version)) and (Version <> '') and (Version <> '0.0.0.0');
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var Code: Integer; Shell, Args: String;
begin
  Result := '';
  if not HasWebView2 then begin
    ExtractTemporaryFile('WebView2Setup.exe');
    if not Exec(ExpandConstant('{tmp}\WebView2Setup.exe'), '/silent /install', '', SW_HIDE, ewWaitUntilTerminated, Code) or not HasWebView2 then begin
      Result := '无法安装 WebView2，请连接网络后重新运行安装程序。';
      exit;
    end;
  end;
  if ExpandConstant('{param:ISOLATED|0}') = '1' then exit;
  ExtractTemporaryFile('Prepare-Install.ps1');
  Shell := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
  Args := '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + ExpandConstant('{tmp}\Prepare-Install.ps1') + '" -InstallRoot "' + ExpandConstant('{app}') + '"';
  if not Exec(Shell, Args, '', SW_HIDE, ewWaitUntilTerminated, Code) or (Code <> 0) then Result := '旧版本未能安全停止，安装已取消。请退出旧应用后重试。';
end;
