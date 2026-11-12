# Overnight watchdog for Turkish Audio Finder (run by Task Scheduler every 10 minutes).
#  - keeps the PC awake (SetThreadExecutionState, like a video player; no power settings are changed)
#  - restarts the PC audio checker (scripts/verify.js) if it is not running
#  - starts a cloud scan on GitHub if the hourly schedule skipped one
#  - after -Until: stops everything and removes its own scheduled task
param(
  [Parameter(Mandatory = $true)][datetime]$Until,
  [int]$Concurrency = 25,
  [string]$TaskName = 'TurkishAudioFinder-Watchdog'
)

$ErrorActionPreference = 'Continue'
$repo = Split-Path (Split-Path $PSScriptRoot)
$logDir = Split-Path $repo
$wlog = Join-Path $logDir 'watchdog.log'
function Log($m) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m" | Out-File -FilePath $wlog -Append -Encoding utf8 }

function Get-Procs($pattern) {
  Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='powershell.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$pattern*" -and $_.ProcessId -ne $PID }
}

$now = Get-Date
if ($now -ge $Until) {
  Log "past end time ($Until): stopping keep-awake and removing task"
  Get-Procs 'taf-keepawake' | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  exit 0
}

# 1) Keep awake until the end time.
if (-not (Get-Procs 'taf-keepawake')) {
  $secs = [int]($Until - $now).TotalSeconds
  $cmd = "# taf-keepawake`n" +
    "Add-Type -Name P -Namespace W -MemberDefinition '[DllImport(""kernel32.dll"")] public static extern uint SetThreadExecutionState(uint f);';" +
    "[W.P]::SetThreadExecutionState([uint32]2147483649) | Out-Null; Start-Sleep -Seconds $secs"
  $enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($cmd))
  Start-Process powershell.exe -ArgumentList '-NoProfile', '-WindowStyle', 'Hidden', '-Command', "`$x='taf-keepawake'; iex ([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('$enc')))" -WindowStyle Hidden | Out-Null
  Log 'started keep-awake'
}

# 2) PC audio checker.
if (-not (Get-Procs 'scripts/verify.js')) {
  $minutes = [int][Math]::Max(5, ($Until - $now).TotalMinutes)
  $log = Join-Path $logDir 'verify-overnight.log'
  if (Test-Path $log) { Get-Content $log -Encoding utf8 | Out-File (Join-Path $logDir 'verify-overnight.prev.log') -Append -Encoding utf8 }
  Start-Process -FilePath 'node.exe' -ArgumentList 'scripts/verify.js', '--loop', '--minutes', "$minutes", '--concurrency', "$Concurrency" `
    -WorkingDirectory $repo -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError "$log.err" | Out-Null
  Log "checker was not running -> restarted ($minutes min left)"
}

# 2b) Stalled torrent engine: if the last 5 passes produced no real result at all (every check timed
#     out), Stremio's streaming server has usually lost its connections -> restart Stremio (max once/hour).
try {
  $vlog = Join-Path $logDir 'verify-overnight.log'
  $marker = Join-Path $logDir 'stremio-restart.txt'
  $recent = (Test-Path $marker) -and ((Get-Date) - (Get-Item $marker).LastWriteTime).TotalMinutes -lt 60
  if ((Test-Path $vlog) -and -not $recent) {
    $passes = @(Get-Content $vlog -Tail 3000 -Encoding utf8 | Where-Object { $_ -match 'pass done: \d+ probed' } | Select-Object -Last 5)
    # Only big passes count: small passes of retried dead torrents are expected to read nothing.
    $dead = @($passes | Where-Object { $_ -match 'pass done: (\d+) probed' -and [int]$Matches[1] -ge 20 -and $_ -match '"yes":0,"no":0,' })
    if ($passes.Count -eq 5 -and $dead.Count -eq 5) {
      Stop-Process -Name stremio-runtime, stremio-shell-ng -Force -ErrorAction SilentlyContinue
      Start-Sleep 3
      Start-Process (Join-Path $env:LOCALAPPDATA 'Programs\Stremio\stremio-shell-ng.exe')
      (Get-Date).ToString('s') | Out-File $marker -Encoding utf8
      Log 'last 5 checker passes were all timeouts -> restarted Stremio streaming server'
    }
  }
} catch { Log "stall check failed: $($_.Exception.Message)" }

# 3) Cloud scan: make sure one runs at least every ~75 minutes.
try {
  $runs = gh run list -R Gokef/turkish-audio-finder --workflow scan-and-publish --limit 5 --json status,createdAt,event 2>$null | ConvertFrom-Json
  $active = $runs | Where-Object { $_.status -ne 'completed' }
  $last = ($runs | Sort-Object createdAt -Descending | Select-Object -First 1)
  if (-not $runs) { Log 'GitHub check returned nothing (offline?) -> skipped'; exit 0 }
  $age = if ($last) { ($now.ToUniversalTime() - ([datetime]$last.createdAt).ToUniversalTime()).TotalMinutes } else { 999 }
  if (-not $active -and $age -gt 75) {
    gh workflow run scan-and-publish -R Gokef/turkish-audio-finder 2>$null | Out-Null
    Log "no cloud scan for $([int]$age) min -> started one"
  }
} catch {
  Log "GitHub check failed: $($_.Exception.Message)"
}

