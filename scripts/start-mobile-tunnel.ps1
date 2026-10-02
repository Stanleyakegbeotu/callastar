param([ValidateRange(1, 65535)][int]$Port = 8443)

$cloudflaredExe = Join-Path $env:LOCALAPPDATA "Programs\cloudflared\cloudflared.exe"
if (-not (Test-Path -LiteralPath $cloudflaredExe)) {
  $installedCloudflared = Get-Command cloudflared.exe -ErrorAction SilentlyContinue
  if ($installedCloudflared) { $cloudflaredExe = $installedCloudflared.Source }
}
$statePath = Join-Path $env:TEMP "callastar-mobile-tunnel.json"

if (-not (Test-Path -LiteralPath $cloudflaredExe)) {
  throw "Cloudflare's official cloudflared executable is missing at $cloudflaredExe"
}

if (Test-Path -LiteralPath $statePath) {
  $previous = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
  $running = Get-Process -Id $previous.pid -ErrorAction SilentlyContinue
  if ($running -and $running.ProcessName -eq "cloudflared") {
    Write-Output "Existing CallaStar tunnel PID: $($previous.pid)"
    Write-Output "Log: $($previous.log)"
    if ($previous.url) { Write-Output "URL: $($previous.url)" }
    exit 0
  }
}

$localUrl = "http://127.0.0.1:$Port/"
try {
  $response = Invoke-WebRequest -Uri $localUrl -Method Head -TimeoutSec 8 -UseBasicParsing
  if ($response.StatusCode -ne 200) { throw "Unexpected status $($response.StatusCode)" }
} catch {
  throw "CallaStar did not respond at $localUrl. Start the existing Vite dev server first."
}

$logPath = Join-Path $env:TEMP ("callastar-mobile-tunnel-" + [guid]::NewGuid().ToString("N") + ".log")
$process = Start-Process -FilePath $cloudflaredExe -ArgumentList @(
  "tunnel", "--url", "http://127.0.0.1:$Port", "--http-host-header", "localhost:$Port", "--logfile", $logPath
) -WindowStyle Hidden -PassThru

$state = @{ pid = $process.Id; log = $logPath; url = $null }
$state | ConvertTo-Json | Set-Content -LiteralPath $statePath

for ($attempt = 0; $attempt -lt 60; $attempt++) {
  Start-Sleep -Seconds 1
  if (Test-Path -LiteralPath $logPath) {
    $log = Get-Content -LiteralPath $logPath -Raw
    if ($log -match 'https://[a-z0-9-]+\.trycloudflare\.com') {
      $state.url = $Matches[0]
      $state | ConvertTo-Json | Set-Content -LiteralPath $statePath
      Write-Output "CallaStar tunnel PID: $($process.Id)"
      Write-Output "URL: $($state.url)"
      Write-Output "Log: $logPath"
      exit 0
    }
  }
  if ($process.HasExited) { throw "cloudflared exited. Read $logPath" }
}

throw "cloudflared did not produce a URL within 60 seconds. Read $logPath"
