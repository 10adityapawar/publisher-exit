param([int]$Port = 4317)
$ErrorActionPreference = 'Stop'
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$nodeExe = if ($nodeCommand) { $nodeCommand.Source } else { 'C:/Users/kinga/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' }
if (-not (Test-Path -LiteralPath $nodeExe)) { throw 'Install Node.js 24 or newer before starting the app.' }
$dataPath = Join-Path $PSScriptRoot 'data'
New-Item -ItemType Directory -Path $dataPath -Force | Out-Null
$tokenPath = Join-Path $dataPath 'worker-token.txt'
if (-not (Test-Path -LiteralPath $tokenPath)) {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    [System.IO.File]::WriteAllText($tokenPath, ([BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()))
}
$oldPassword = $env:OPERATOR_PASSWORD
$oldToken = $env:WORKER_TOKEN
$oldData = $env:DATA_DIR
$oldPort = $env:PORT
try {
    if (-not (Test-Path -LiteralPath (Join-Path $dataPath 'publisher-exit.sqlite'))) {
        $securePassword = Read-Host 'Choose an operator password (at least 12 characters)' -AsSecureString
        $env:OPERATOR_PASSWORD = [System.Net.NetworkCredential]::new('', $securePassword).Password
        if ($env:OPERATOR_PASSWORD.Length -lt 12) { throw 'Password must contain at least 12 characters.' }
    }
    $env:WORKER_TOKEN = [System.IO.File]::ReadAllText($tokenPath).Trim()
    $env:DATA_DIR = $dataPath
    $env:PORT = [string]$Port
    Write-Output "Open http://127.0.0.1:$Port in your browser. Press Ctrl+C to stop."
    & $nodeExe (Join-Path $PSScriptRoot 'server.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'The application stopped with an error.' }
} finally {
    $env:OPERATOR_PASSWORD = $oldPassword
    $env:WORKER_TOKEN = $oldToken
    $env:DATA_DIR = $oldData
    $env:PORT = $oldPort
}
