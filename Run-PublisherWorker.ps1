param([string]$ServerUrl = 'http://127.0.0.1:4317', [string]$TokenFile = '', [int]$TimeoutSeconds = 180)
$ErrorActionPreference = 'Stop'
$serverUri = [Uri]$ServerUrl
if ($serverUri.Scheme -ne 'https' -and -not ($serverUri.Scheme -eq 'http' -and $serverUri.IsLoopback)) { throw 'Use HTTPS for remote servers.' }
if (-not [Type]::GetTypeFromProgID('Publisher.Application')) { throw 'A licensed Microsoft Publisher installation is required on this workstation.' }
if (-not $TokenFile) { $TokenFile = Join-Path $PSScriptRoot 'data/worker-token.txt' }
$workerSecret = [System.IO.File]::ReadAllText($TokenFile).Trim()
$baseHeaders = @{ 'X-Worker-Token' = $workerSecret }
$ServerUrl = $ServerUrl.TrimEnd('/')
$cacheRoot = Join-Path $PSScriptRoot 'work/runner'
New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null
Write-Output 'Supervised export session. Keep Publisher dialogs visible and available. Do not use this workstation for other Publisher work during the run.'
while ($true) {
    $claim = Invoke-RestMethod -Uri "$ServerUrl/api/worker/claim" -Method Post -Headers $baseHeaders -ContentType 'application/json' -Body '{}' -TimeoutSec 30
    if (-not $claim.job) { Write-Output 'Queue empty. Session complete.'; break }
    $job = $claim.job
    if ($job.id -notmatch '^[a-f0-9-]{36}$') { throw 'Server returned an invalid job identifier.' }
    $headers = @{ 'X-Worker-Token' = $workerSecret; 'X-Job-Lease' = $job.lease }
    $jobPath = Join-Path $cacheRoot $job.id
    New-Item -ItemType Directory -Path $jobPath -Force | Out-Null
    $source = Join-Path $jobPath 'source.pub'
    $pdf = Join-Path $jobPath 'export.pdf'
    $resultPath = Join-Path $jobPath 'result.json'
    $child = $null
    try {
        Invoke-WebRequest -UseBasicParsing -Uri "$ServerUrl/api/worker/jobs/$($job.id)/source" -Headers $headers -OutFile $source -TimeoutSec 60 | Out-Null
        if (Test-Path -LiteralPath $resultPath) { Remove-Item -LiteralPath $resultPath }
        $exportScript = Join-Path $PSScriptRoot 'Export-One.ps1'
        $arguments = @('-NoProfile', '-STA', '-File', ('"' + $exportScript + '"'), '-SourcePath', ('"' + $source + '"'), '-PdfPath', ('"' + $pdf + '"'), '-ResultPath', ('"' + $resultPath + '"'))
        $child = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WindowStyle Hidden -PassThru
        $timer = [Diagnostics.Stopwatch]::StartNew()
        while (-not $child.WaitForExit(10000)) {
            if ($timer.Elapsed.TotalSeconds -gt $TimeoutSeconds) { throw 'Export timed out. Inspect and close the isolated Publisher instance before restarting the runner.' }
            Invoke-RestMethod -Uri "$ServerUrl/api/worker/jobs/$($job.id)/heartbeat" -Method Post -Headers $headers -ContentType 'application/json' -Body '{}' -TimeoutSec 20 | Out-Null
        }
        if (-not (Test-Path -LiteralPath $resultPath)) { throw 'Export process ended without a result.' }
        $result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
        if (-not $result.ok) { throw [string]$result.error }
        $headers['X-Page-Count'] = [string]$result.pages
        Invoke-RestMethod -Uri "$ServerUrl/api/worker/jobs/$($job.id)/result" -Method Post -Headers $headers -ContentType 'application/pdf' -InFile $pdf -TimeoutSec 60 | Out-Null
        Write-Output "Exported $($job.name). Operator PDF review required."
        # Delete only the explicitly named temporary files generated in this job.
        foreach ($temporaryFile in @($source, $pdf, $resultPath)) { if (Test-Path -LiteralPath $temporaryFile) { Remove-Item -LiteralPath $temporaryFile } }
        Remove-Item -LiteralPath $jobPath
    } catch {
        $failure = $_.Exception.Message
        if ($child -and -not $child.HasExited) { $child.Kill() }
        try { Invoke-RestMethod -Uri "$ServerUrl/api/worker/jobs/$($job.id)/fail" -Method Post -Headers $headers -ContentType 'application/json' -Body (@{ error = $failure } | ConvertTo-Json) -TimeoutSec 20 | Out-Null } catch { Write-Warning 'Could not report failure; the lease will expire and the queue will recover.' }
        throw "Stopped on $($job.name): $failure Review the workstation before restarting. Source copies remain in $jobPath."
    }
}
