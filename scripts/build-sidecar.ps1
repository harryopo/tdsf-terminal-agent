[CmdletBinding()]
param(
    # 必填。以前默认值是 "python"，等于"PATH 上当时是谁就算谁"——#77 那三份运行时
    # 并存（门禁 1.53 / 桌面 dev 产物 1.50.2 / 安装包 1.56）就是它纵容出来的。
    [Parameter(Mandatory = $true)][string]$Python
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

# --- 先校验解释器，再动任何文件 -------------------------------------------------
# 顺序很重要：校验放在清理之前，用错 python 调用时是"直接停"，而不是先把上一次
# 的可用产物删掉再报错（那等于一次误调用就把能跑的包毁了）。
$pythonCommand = Get-Command $Python -ErrorAction Stop
$pythonExe = $pythonCommand.Source
& $pythonExe -c "import PyInstaller"
if ($LASTEXITCODE -ne 0) {
    throw "PyInstaller is missing. Install src-tauri/sidecar/requirements-build.txt first."
}

# #77：打包前把运行时版本钉死。装的不是 STRANDS_RUNTIME_VERSION 里写的那版就直接停 ——
# 宁可构建失败，也不能产出一个"门禁没跑过的运行时"的包。
$wantStrands = (Get-Content -LiteralPath (Join-Path $sidecarRoot "STRANDS_RUNTIME_VERSION") -Raw).Trim()
$gotStrands = (& $pythonExe -c "import importlib.metadata as m;print(m.version('strands-agents'))").Trim()
if ($LASTEXITCODE -ne 0 -or -not $gotStrands) {
    throw "无法读取 $pythonExe 里的 strands-agents 版本（该 python 不是打包用的 venv？）"
}
if ($gotStrands -ne $wantStrands) {
    throw "strands 版本漂移：$pythonExe 装的是 $gotStrands，STRANDS_RUNTIME_VERSION 要求 $wantStrands。" +
        " 先 `& '$pythonExe' -m pip install -r '$sidecarRoot\requirements-build.txt'` 再打包。"
}
Write-Host "Build python=$pythonExe strands-agents=$gotStrands (== declared)"

# --- 校验通过后才清理 ------------------------------------------------------------
foreach ($target in @($distRoot, $workRoot)) {
    $fullTarget = [IO.Path]::GetFullPath($target)
    if (-not $fullTarget.StartsWith($sidecarPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to clean path outside sidecar root: $fullTarget"
    }
    if (Test-Path -LiteralPath $fullTarget) {
        Remove-Item -LiteralPath $fullTarget -Recurse -Force
    }
}

# #77：陈旧/混装的 sidecar 产物一律先清掉。实测 target/debug/sidecar/tdsf-sidecar/_internal
# 里同时躺着 strands_agents-1.50.2 与 -1.56.0 两份 dist-info —— 混装目录让"产物里到底是
# 哪一版"无法回答。（dev 跑的是 sidecar/main.py + .venv，不依赖这个目录，删了不影响开发。）
foreach ($stale in @((Join-Path $repoRoot "src-tauri/sidecar/dist-sidecar"),
                    (Join-Path $repoRoot "src-tauri/target/debug/sidecar"))) {
    $fullStale = [IO.Path]::GetFullPath($stale)
    if (-not $fullStale.StartsWith([IO.Path]::GetFullPath($repoRoot), [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to clean path outside repo: $fullStale"
    }
    if (Test-Path -LiteralPath $fullStale) {
        Remove-Item -LiteralPath $fullStale -Recurse -Force
        Write-Host "Removed stale sidecar artifact: $fullStale"
    }
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
