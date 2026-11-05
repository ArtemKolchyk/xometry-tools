# Builds a zip for upload to the Chrome Web Store: dist/xometry-tools-<version>.zip
# Only manifest.json, icons/ and src/ go into the archive (no README, package.json, pack.ps1).
# Compress-Archive in Windows PowerShell 5.1 writes backslashes into entry names, which the
# Web Store rejects, so entries are written by hand with forward slashes.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = $PSScriptRoot
$manifest = Get-Content -Raw -Encoding UTF8 (Join-Path $root 'manifest.json') | ConvertFrom-Json
$version = $manifest.version

$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force $dist | Out-Null
$zipPath = Join-Path $dist "xometry-tools-$version.zip"
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

$files = @(Get-Item (Join-Path $root 'manifest.json'))
$files += Get-ChildItem -Recurse -File (Join-Path $root 'icons')
$files += Get-ChildItem -Recurse -File (Join-Path $root 'src')

$zip = [System.IO.Compression.ZipFile]::Open($zipPath, 'Create')
try {
  foreach ($f in $files) {
    $entry = $f.FullName.Substring($root.Length + 1).Replace('\', '/')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, $entry, 'Optimal') | Out-Null
  }
} finally {
  $zip.Dispose()
}

Write-Host "Packed $($files.Count) files -> $zipPath"
