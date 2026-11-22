# Restore pinned completion binaries without committing them to Git.
# Archives and extracted binaries have different hashes; the manifest owns both.
$ErrorActionPreference = 'Stop'
$binDir = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\src-tauri\bin'))
$manifest = Get-Content -LiteralPath (Join-Path $binDir 'carapace-manifest.json') -Raw | ConvertFrom-Json
New-Item -ItemType Directory -Force -Path $binDir | Out-Null

foreach ($asset in $manifest.assets) {
    $output = Join-Path $binDir $asset.output
    if ((Test-Path -LiteralPath $output -PathType Leaf) -and
        (Get-Item -LiteralPath $output).Length -eq $asset.size -and
        (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant() -eq $asset.binarySha256) {
        Write-Host "[skip] $($asset.output) verified"
        continue
    }

    $tempDir = Join-Path ([IO.Path]::GetTempPath()) ('tdsf-carapace-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tempDir | Out-Null
    try {
        $archive = Join-Path $tempDir $asset.archive
        $url = "https://github.com/carapace-sh/carapace-bin/releases/download/v$($manifest.version)/$($asset.archive)"
        curl.exe --fail --location --silent --show-error --max-time 300 --output $archive $url
        if ($LASTEXITCODE -ne 0) { throw "Download failed: $($asset.archive)" }
        if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $asset.archiveSha256) {
            throw "Archive SHA-256 mismatch: $($asset.archive)"
        }

        $extract = Join-Path $tempDir 'extract'
        New-Item -ItemType Directory -Path $extract | Out-Null
        if ($asset.archive.EndsWith('.zip')) {
            Expand-Archive -LiteralPath $archive -DestinationPath $extract
        } else {
            tar -xzf $archive -C $extract
            if ($LASTEXITCODE -ne 0) { throw "Extraction failed: $($asset.archive)" }
        }
        $binary = Join-Path $extract $asset.member
        if ((Get-Item -LiteralPath $binary).Length -ne $asset.size -or
            (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant() -ne $asset.binarySha256) {
            throw "Extracted binary size/SHA-256 mismatch: $($asset.output)"
        }
        Copy-Item -LiteralPath $binary -Destination $output -Force
        Write-Host "[ok] $($asset.output) verified"
    } finally {
        # Delete only the exact GUID directory this invocation created under TEMP.
        $resolvedTemp = [IO.Path]::GetFullPath($tempDir)
        $allowedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
        if (-not $resolvedTemp.StartsWith($allowedTemp, [StringComparison]::OrdinalIgnoreCase) -or
            [IO.Path]::GetFileName($resolvedTemp) -notmatch '^tdsf-carapace-[0-9a-f]{32}$') {
            throw 'Refusing to remove an unexpected temporary directory'
        }
        Remove-Item -LiteralPath $resolvedTemp -Recurse -Force
    }
}
Write-Host 'Completion binaries ready (pinned manifest verified).'
