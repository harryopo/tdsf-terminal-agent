[CmdletBinding()]
param(
    [string]$ExpectedVersion = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

function Read-TomlVersion {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Section
    )

    $content = Get-Content -LiteralPath $Path -Raw -Encoding utf8
    $pattern = "(?ms)^\[$([regex]::Escape($Section))\]\s*.*?^version\s*=\s*`"([^`"]+)`""
    $match = [regex]::Match($content, $pattern)
    if (-not $match.Success) {
        throw "Version not found in [$Section] of $Path"
    }
    return $match.Groups[1].Value
}

$packageVersion = (Get-Content -LiteralPath (Join-Path $repoRoot "package.json") -Raw -Encoding utf8 | ConvertFrom-Json).version
$tauriVersion = (Get-Content -LiteralPath (Join-Path $repoRoot "src-tauri/tauri.conf.json") -Raw -Encoding utf8 | ConvertFrom-Json).version
$cargoVersion = Read-TomlVersion -Path (Join-Path $repoRoot "src-tauri/Cargo.toml") -Section "package"
$sidecarVersion = Read-TomlVersion -Path (Join-Path $repoRoot "src-tauri/sidecar/pyproject.toml") -Section "project"

# #84: the version the sidecar self-reports (ready notification + sidecar.status).
# Frozen builds cannot rely on package metadata, so it is a standalone constant -
# if it is not compared here it silently drifts into a wrong version number.
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads BOM-less files as
# ANSI, so non-ASCII comments get mis-decoded and can break the parser.
$constantMatch = [regex]::Match(
    (Get-Content -LiteralPath (Join-Path $repoRoot "src-tauri/sidecar/sidecar_version.py") -Raw -Encoding utf8),
    'SIDECAR_VERSION\s*=\s*"([^"]+)"'
)
if (-not $constantMatch.Success) {
    throw "SIDECAR_VERSION not found in src-tauri/sidecar/sidecar_version.py"
}

$versions = [ordered]@{
    package = $packageVersion
    tauri = $tauriVersion
    cargo = $cargoVersion
    sidecar = $sidecarVersion
    sidecarSelfReported = $constantMatch.Groups[1].Value
}

$unique = @($versions.Values | Sort-Object -Unique)
if ($unique.Count -ne 1) {
    throw "Release versions differ: $($versions | ConvertTo-Json -Compress)"
}

$version = [string]$unique[0]
if ($ExpectedVersion -and $version -ne $ExpectedVersion) {
    throw "Manifest version $version does not match expected version $ExpectedVersion"
}

Write-Host "Release version verified: $version"
