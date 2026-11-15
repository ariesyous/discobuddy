$ErrorActionPreference = 'Stop'
$manifest = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'local-assets.json') | ConvertFrom-Json
$runtimeRoot = Join-Path (Split-Path -Parent $PSScriptRoot) '.local-runtime'
$build = $manifest.runtime.build
$binaryDir = Join-Path $runtimeRoot $build
$modelDir = Join-Path $runtimeRoot 'models'

function Get-VerifiedDownload($url, $path, $sha256) {
    if ((Test-Path -LiteralPath $path -PathType Leaf) -and
        ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -eq $sha256)) {
        return
    }

    $partial = "$path.partial"
    Write-Host "Downloading $(Split-Path -Leaf $path) ..."
    & curl.exe --fail --location --retry 2 --no-progress-meter --output $partial $url
    if ($LASTEXITCODE -ne 0) { throw "Download failed for $url" }
    if ((Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash -ne $sha256) {
        throw "SHA-256 mismatch for $path. The downloaded file was not installed."
    }
    Move-Item -LiteralPath $partial -Destination $path -Force
}

New-Item -ItemType Directory -Force -Path $runtimeRoot, $modelDir | Out-Null
$server = Join-Path $binaryDir 'llama-server.exe'
if (-not (Test-Path -LiteralPath $server -PathType Leaf)) {
    $zipName = "llama-$build-bin-win-vulkan-x64.zip"
    $archive = Join-Path $runtimeRoot $zipName
    Get-VerifiedDownload "https://github.com/ggml-org/llama.cpp/releases/download/$build/$zipName" $archive $manifest.runtime.sha256
    Expand-Archive -LiteralPath $archive -DestinationPath $binaryDir -Force
    if (-not (Test-Path -LiteralPath $server -PathType Leaf)) {
        throw "llama-server.exe was not found in $binaryDir after extraction."
    }
    Remove-Item -LiteralPath $archive
}

$baseUrl = "https://huggingface.co/$($manifest.model.repository)/resolve/$($manifest.model.revision)"
foreach ($asset in @($manifest.model.weights, $manifest.model.projector)) {
    Get-VerifiedDownload "$baseUrl/$($asset.file)" (Join-Path $modelDir $asset.file) $asset.sha256
}
Write-Host 'Discobuddy is ready. Run .\scripts\chat-local.ps1 to start the voice lab.'
