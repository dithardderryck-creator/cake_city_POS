# Makes Windows start the Cake POS server at boot, and start it again if it stops.
# NOT YET TESTED ON WINDOWS. Run once, in PowerShell, as Administrator.
#   Set-ExecutionPolicy -Scope Process Bypass; .\install-task.ps1

$script = Join-Path $PSScriptRoot 'start-server.cmd'
if (-not (Test-Path $script)) { throw "Cannot find $script" }

$action   = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$script`""
$trigger  = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

Register-ScheduledTask -TaskName 'CakePOS Server' -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Force | Out-Null

Write-Host "Done. 'CakePOS Server' will start at boot. Start it now with:  Start-ScheduledTask -TaskName 'CakePOS Server'"
Write-Host "Note: running as SYSTEM stores data under C:\Windows\System32\config\systemprofile\AppData\Roaming\CakePOS unless you set DATA_DIR in start-server.cmd. Setting DATA_DIR is recommended."
