param([Parameter(Mandatory=$true)][string]$SourceDir,[Parameter(Mandatory=$true)][string]$OutputDir,[Parameter(Mandatory=$true)][string]$Version)
$ErrorActionPreference='Stop'
if($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Use stable version x.y.z' }
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
function File-Hash([string]$file) {
  $stream=[IO.File]::OpenRead($file); $hash=[Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-','').ToLowerInvariant() }
  finally { $hash.Dispose(); $stream.Dispose() }
}
$src=[IO.Path]::GetFullPath($SourceDir).TrimEnd('\')
$out=[IO.Path]::GetFullPath($OutputDir).TrimEnd('\')
if($out.StartsWith($src+'\',[StringComparison]::OrdinalIgnoreCase) -or $out -eq $src) { throw 'Output must be outside source' }
if(!(Test-Path -LiteralPath (Join-Path $src 'Pigeon.exe')) -or !(Test-Path -LiteralPath (Join-Path $src 'resources/app.asar'))) { throw 'Supply a built portable Pigeon distribution' }
$allowed='^(Pigeon\.exe|chrome_100_percent\.pak|chrome_200_percent\.pak|d3dcompiler_47\.dll|dxcompiler\.dll|dxil\.dll|version|ffmpeg\.dll|icudtl\.dat|libEGL\.dll|libGLESv2\.dll|resources\.pak|snapshot_blob\.bin|v8_context_snapshot\.bin|vk_swiftshader\.dll|vk_swiftshader_icd\.json|vulkan-1\.dll|LICENSE|LICENSES\.chromium\.html|locales|resources|extension)$'
$files=@()
foreach($top in Get-ChildItem -LiteralPath $src -Force) {
  if($top.Name -notmatch $allowed) { continue }
  if($top.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse payload refused' }
  $all=if($top.PSIsContainer) { @(Get-ChildItem -LiteralPath $top.FullName -Recurse -Force) } else { @($top) }
  foreach($file in $all) {
    if($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse payload refused' }
    if($file.PSIsContainer) { continue }
    $relative=$file.FullName.Substring($src.Length+1).Replace('\','/')
    if($relative -match '(^|/)(data|userdata|models)(/|$)' -or $relative -match '\.(pigeon|library)(/|$)') { throw "User data refused: $relative" }
    $files+=@{path=$relative;size=$file.Length;sha256=(File-Hash $file.FullName)}
  }
}
New-Item -ItemType Directory -Force -Path $out | Out-Null
$target=Join-Path $out "Pigeon-$Version-win-x64.zip"
if(Test-Path -LiteralPath $target) { throw 'Output exists; choose a new output directory' }
$zip=[IO.Compression.ZipFile]::Open($target,[IO.Compression.ZipArchiveMode]::Create)
try {
  foreach($file in $files) { [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip,(Join-Path $src $file.path),$file.path,[IO.Compression.CompressionLevel]::Optimal) | Out-Null }
  $entry=$zip.CreateEntry('.pigeon-release.json')
  $writer=[IO.StreamWriter]::new($entry.Open(),[Text.UTF8Encoding]::new($false))
  try { $writer.Write((@{version=$Version;files=$files} | ConvertTo-Json -Depth 6)) } finally { $writer.Dispose() }
} finally { $zip.Dispose() }
Write-Output (File-Hash $target)
