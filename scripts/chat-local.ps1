param(
    [ValidateRange(1024, 65535)][int]$Port = 8765,
    [switch]$Cpu
)

$ErrorActionPreference = 'Stop'
$manifest = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'local-assets.json') | ConvertFrom-Json
$root = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $root '.local-runtime'
$server = Join-Path $runtimeRoot "$($manifest.runtime.build)\llama-server.exe"
$weights = Join-Path $runtimeRoot "models\$($manifest.model.weights.file)"
$projector = Join-Path $runtimeRoot "models\$($manifest.model.projector.file)"
foreach ($file in @($server, $weights, $projector)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        throw "Missing $(Split-Path -Leaf $file). Run .\scripts\setup-local.ps1 first."
    }
}

$site = Join-Path $root 'local-chat'
$serverArgs = @(
    '--host', '127.0.0.1', '--port', "$Port", '--cors-origins', 'localhost',
    '--path', $site, '--model', $weights, '--mmproj', $projector,
    '--ctx-size', '4096', '--parallel', '1', '--temp', '0'
)
if ($Cpu) {
    $serverArgs += @('--gpu-layers', '0', '--no-mmproj-offload')
} else {
    $serverArgs += @('--gpu-layers', '99')
}

Write-Host "Starting Discobuddy at http://127.0.0.1:$Port (Ctrl+C to stop)."
& $server @serverArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
