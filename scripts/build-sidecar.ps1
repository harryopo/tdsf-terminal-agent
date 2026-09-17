[CmdletBinding()]
param(
    [string]$Python = "python"
)

$ErrorActionPreference = "Stop"
if (-not $IsWindows -and $env:OS -ne "Windows_NT") {
    throw "The bundled sidecar is currently released for Windows only."
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$sidecarRoot = Join-Path $repoRoot "src-tauri/sidecar"
$distRoot = Join-Path $sidecarRoot "tdsf-sidecar"
$workRoot = Join-Path $sidecarRoot "build-sidecar"
$specPath = Join-Path $sidecarRoot "tdsf-sidecar.spec"
$sidecarPrefix = [IO.Path]::GetFullPath($sidecarRoot).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar

foreach ($target in @($distRoot, $workRoot)) {
    $fullTarget = [IO.Path]::GetFullPath($target)
    if (-not $fullTarget.StartsWith($sidecarPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to clean path outside sidecar root: $fullTarget"
    }
    if (Test-Path -LiteralPath $fullTarget) {
        Remove-Item -LiteralPath $fullTarget -Recurse -Force
    }
}

$pythonCommand = Get-Command $Python -ErrorAction Stop
$pythonExe = $pythonCommand.Source
& $pythonExe -c "import PyInstaller"
if ($LASTEXITCODE -ne 0) {
    throw "PyInstaller is missing. Install src-tauri/sidecar/requirements-build.txt first."
}

Push-Location $sidecarRoot
try {
    & $pythonExe -m PyInstaller `
        --noconfirm `
        --clean `
        --distpath $sidecarRoot `
        --workpath $workRoot `
        $specPath
    if ($LASTEXITCODE -ne 0) {
        throw "PyInstaller failed with exit code $LASTEXITCODE"
    }
} finally {
    Pop-Location
}

$exePath = Join-Path $distRoot "tdsf-sidecar.exe"
if (-not (Test-Path -LiteralPath $exePath -PathType Leaf)) {
    throw "Sidecar executable was not produced: $exePath"
}

$exe = Get-Item -LiteralPath $exePath
if ($exe.Length -lt 1MB) {
    throw "Sidecar executable is unexpectedly small: $($exe.Length) bytes"
}

Write-Host "Sidecar built: $exePath ($([math]::Round($exe.Length / 1MB, 1)) MB)"
