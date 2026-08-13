param(
    [int]$ZenPort = 8643,
    [int]$CheckInterval = 10,
    [int]$CooldownSeconds = 30
)

$ErrorActionPreference = "Continue"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$logPath = Join-Path $scriptDir "watchdog.log"
$zenLog = Join-Path $scriptDir "zen_proxy.log"
$zenErrLog = Join-Path $scriptDir "zen_proxy.log.err"
$pythonExe = "D:\Python312\python.exe"
if (-not (Test-Path -LiteralPath $pythonExe)) { $pythonExe = "python" }

function Write-Log([string]$msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
    Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
    Write-Host $line
}

function Test-PortListening([int]$port) {
    return [bool](Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
}

$relayRoot = Get-ChildItem -Path "D:\" -Filter "restart_relay.ps1" -Recurse -Depth 3 -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty FullName |
    ForEach-Object { Split-Path (Split-Path $_) }

Write-Log "watchdog started zen=$ZenPort relay=18787 check=${CheckInterval}s cooldown=${CooldownSeconds}s relayRoot=$relayRoot"
Write-Host "OpenCode Service Watchdog - Ctrl+C to stop"
Write-Host "  zen clean proxy : port $ZenPort"
if ($relayRoot) {
    Write-Host "  codex relay     : port 18787 (root=$relayRoot)"
} else {
    Write-Host "  codex relay     : NOT FOUND, relay monitor disabled"
}
Write-Host "  log             : $logPath"

$zenLast = 0
$relayLast = 0

while ($true) {
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()

    if (-not (Test-PortListening $ZenPort)) {
        if (($now - $zenLast) -ge $CooldownSeconds) {
            Write-Log "zen proxy DOWN on port $ZenPort, starting..."
            $args = @("`"$scriptDir\zen_proxy.py`"", "--port", "$ZenPort")
            Start-Process -FilePath $pythonExe -ArgumentList $args -WorkingDirectory $scriptDir -WindowStyle Hidden `
                -RedirectStandardOutput $zenLog -RedirectStandardError $zenErrLog
            $zenLast = $now
            Write-Log "zen proxy start issued on port $ZenPort"
        }
    }

    if ($relayRoot) {
        if (-not (Test-PortListening 18787)) {
            if (($now - $relayLast) -ge $CooldownSeconds) {
                Write-Log "codex relay DOWN on port 18787, launching supervisor..."
                Start-Process -FilePath (Join-Path $relayRoot "start.bat") -WorkingDirectory $relayRoot
                $relayLast = $now
                Write-Log "codex relay supervisor launched"
            }
        }
    }

    Start-Sleep -Seconds $CheckInterval
}
