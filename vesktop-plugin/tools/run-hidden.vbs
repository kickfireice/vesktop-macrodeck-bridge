' run-hidden.vbs - Launch the Vencord watchdog with no console window at all.
' The scheduled task runs THIS file via wscript.exe (windowless by design),
' which starts powershell.exe hidden (window style 0). This avoids the
' split-second CMD flash that a direct powershell.exe task action causes,
' because conhost appears before PowerShell can apply -WindowStyle Hidden.
' Path to the watch script is derived from this file's own folder - nothing
' is hardcoded.
Dim sh, fso, dir, cmd
Set sh = CreateObject("Wscript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
cmd = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & dir & "\watch-vesktop-vencord.ps1"""
sh.Run cmd, 0, False
