# fetch-carapace.ps1 — 下载 carapace 参数补全引擎二进制 (参数预测功能的前置)
# -----------------------------------------------------------------------------
# 用途: src-tauri/bin/ 下的 carapace 二进制不入 git (~155MB), 换机/克隆后运行
#       本脚本一键恢复。版本与 SHA256 记录在 src-tauri/bin/CHECKSUMS.txt。
# 用法: powershell -ExecutionPolicy Bypass -File scripts/fetch-carapace.ps1
#       已存在且哈希匹配时跳过下载 (幂等)。
# 注意: GitHub 不可达时自动走镜像 gh-proxy.com。

$ErrorActionPreference = 'Stop'
$version = '1.7.3'
$binDir = Join-Path $PSScriptRoot '..\src-tauri\bin'
New-Item -ItemType Directory -Force -Path $binDir | Out-Null

$assets = @(
    @{
        Url    = "https://github.com/carapace-sh/carapace-bin/releases/download/v$version/carapace-bin_${version}_windows_amd64.zip"
        Mirror = "https://gh-proxy.com/https://github.com/carapace-sh/carapace-bin/releases/download/v$version/carapace-bin_${version}_windows_amd64.zip"
        Hash   = 'c25e6f88bcb13ab44cb977db07f2b878bf140c397a3fd5582ce5bfb4d2143303'
        Output = Join-Path $binDir 'carapace.exe'
        Zip    = $true
    },
    @{
        Url    = "https://github.com/carapace-sh/carapace-bin/releases/download/v$version/carapace-bin_${version}_linux_amd64.tar.gz"
        Mirror = "https://gh-proxy.com/https://github.com/carapace-sh/carapace-bin/releases/download/v$version/carapace-bin_${version}_linux_amd64.tar.gz"
        Hash   = '35ab52bfe7bdd8296d90c3687660bde80497599badde840ab615d2f421f5f053'
        Output = Join-Path $binDir 'carapace-linux-amd64'
        Zip    = $false
    }
)

foreach ($a in $assets) {
    # 幂等: 已存在且哈希匹配 → 跳过
    if ((Test-Path $a.Output) -and ((Get-FileHash $a.Output -Algorithm SHA256).Hash.ToLower() -eq $a.Hash)) {
        Write-Host "[skip] $($a.Output) 已存在且校验通过"
        continue
    }
    $tmp = Join-Path $env:TEMP ("carapace-fetch-" + [IO.Path]::GetFileName($a.Output))
    $url = $a.Url
    try {
        curl.exe -sL --max-time 300 -o $tmp $url
        if ((Get-FileHash $tmp -Algorithm SHA256).Hash.ToLower() -ne $a.Hash) { throw 'sha256 mismatch' }
    } catch {
        Write-Host "[warn] GitHub 下载/校验失败, 改走镜像: $($_.Exception.Message)"
        curl.exe -sL --max-time 300 -o $tmp $a.Mirror
        if ((Get-FileHash $tmp -Algorithm SHA256).Hash.ToLower() -ne $a.Hash) { throw '镜像下载 sha256 也不匹配, 请检查网络' }
    }
    # 解包
    if ($a.Zip) {
        $extract = Join-Path $env:TEMP 'carapace-fetch-zip'
        Expand-Archive -Path $tmp -DestinationPath $extract -Force
        Copy-Item (Join-Path $extract 'carapace.exe') $a.Output -Force
    } else {
        $extract = Join-Path $env:TEMP 'carapace-fetch-tgz'
        New-Item -ItemType Directory -Force -Path $extract | Out-Null
        tar -xzf $tmp -C $extract
        Copy-Item (Join-Path $extract 'carapace') $a.Output -Force
    }
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    Write-Host "[ok] $($a.Output)"
}
Write-Host 'carapace 二进制就绪 (版本/协议见 src-tauri/bin/CHECKSUMS.txt)'
