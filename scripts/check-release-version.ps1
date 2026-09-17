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

$versions = [ordered]@{
    package = $packageVersion
    tauri = $tauriVersion
    cargo = $cargoVersion
    sidecar = $sidecarVersion
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
