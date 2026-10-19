param([Parameter(Mandatory=$true)][string]$JobFile, [switch]$Recover)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
function File-Hash([string]$file) {
  $stream=[IO.File]::OpenRead($file); $hash=[Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-','').ToLowerInvariant() }
  finally { $hash.Dispose(); $stream.Dispose() }
}
$job = Get-Content -Raw -Encoding UTF8 -LiteralPath $JobFile | ConvertFrom-Json
$root = [IO.Path]::GetFullPath($job.root).TrimEnd('\')
$work = Split-Path -Parent ([IO.Path]::GetFullPath($JobFile))
$stage = Join-Path $work 'stage'
$backup = Join-Path $work 'backup'
$journalFile = Join-Path $work 'journal.json'
$resultFile = Join-Path $work 'result.json'
# Only application-owned payloads are accepted. User data can never be an update target.
function Safe-Relative([string]$rel) {
  if (!$rel -or $rel.Contains('\') -or $rel.Contains(':') -or $rel.StartsWith('/') -or $rel -match '(^|/)\.\.?(/|$)' -or $rel -match '[<>"|?*]' -or $rel -match '[. ]($|/)') { throw "Unsafe package path: $rel" }
  $top = ($rel -split '/')[0]
  if ($top -notmatch '^(Pigeon\.exe|chrome_100_percent\.pak|chrome_200_percent\.pak|d3dcompiler_47\.dll|dxcompiler\.dll|dxil\.dll|version|ffmpeg\.dll|icudtl\.dat|libEGL\.dll|libGLESv2\.dll|resources\.pak|snapshot_blob\.bin|v8_context_snapshot\.bin|vk_swiftshader\.dll|vk_swiftshader_icd\.json|vulkan-1\.dll|LICENSE|LICENSES\.chromium\.html|locales|resources|extension)$') { throw "Protected or unknown top-level path: $rel" }
  if ($rel -match '(^|/)(data|userdata|models)(/|$)' -or $rel -match '\.(pigeon|library)(/|$)') { throw "User data in package: $rel" }
  return $rel
}
function Target([string]$base,[string]$rel) {
  $full = [IO.Path]::GetFullPath((Join-Path $base $rel))
  if (!$full.StartsWith($base.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Path escaped root' }
  $check = $full
  while ($check -and $check.Length -ge $base.Length) {
    if (Test-Path -LiteralPath $check) { if ((Get-Item -LiteralPath $check -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse target refused: $check" } }
    $check = Split-Path -Parent $check
  }
  return $full
}
function Write-Json($file,$value) {
  $tmp=$file+'.tmp'
  [IO.File]::WriteAllText($tmp,($value | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
  if (Test-Path -LiteralPath $file) { [IO.File]::Replace($tmp,$file,($file+'.previous')) } else { [IO.File]::Move($tmp,$file) }
}
function Copy-Retry([string]$from,[string]$to) {
  for($attempt=0;$attempt -lt 6;$attempt++) {
    try { Copy-Item -LiteralPath $from -Destination $to -Force; return }
    catch { if($attempt -eq 5) { throw }; Start-Sleep -Milliseconds (100*($attempt+1)) }
  }
}
function Restore($entries) {
  foreach($entry in $entries) {
    $rel=Safe-Relative $entry.path
    $dest=Target $root $rel
    if($entry.existed) { $src=Target $backup $rel; Copy-Retry $src $dest }
    elseif(Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Force }
  }
}
try {
  if($job.pid -and !$Recover) {
    $process=Get-Process -Id $job.pid -ErrorAction SilentlyContinue
    if($process -and !$process.WaitForExit(120000)) { throw 'Application did not exit; update cancelled' }
  }
  if ($Recover) {
    $journal=Get-Content -Raw -Encoding UTF8 -LiteralPath $journalFile | ConvertFrom-Json
    if($journal.status -ne 'applying') { throw 'No interrupted update to restore' }
    Restore $journal.entries
    Write-Json $journalFile @{status='restored';entries=$journal.entries}
    Write-Json $resultFile @{status='restored'}
    exit 0
  }
  if (Test-Path -LiteralPath $journalFile) {
    $previous=Get-Content -Raw -Encoding UTF8 -LiteralPath $journalFile | ConvertFrom-Json
    if($previous.status -eq 'applying') { Restore $previous.entries; Write-Json $journalFile @{status='restored';entries=$previous.entries} }
  }
  if((File-Hash $job.zip) -ne $job.sha256) { throw 'Package hash mismatch' }
  # These two folders are fixed children of the private updater directory.
  foreach($folder in @($stage,$backup)) {
    $resolved=[IO.Path]::GetFullPath($folder)
    if(!(Split-Path -Parent $resolved).Equals($work,[StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid work directory' }
    if(Test-Path -LiteralPath $resolved) { if((Get-Item -LiteralPath $resolved -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse work directory' }; Remove-Item -LiteralPath $resolved -Recurse -Force }
    New-Item -ItemType Directory -Path $resolved | Out-Null
  }
  $zip=[IO.Compression.ZipFile]::OpenRead($job.zip)
  try {
    $manifestEntry=$zip.GetEntry('.pigeon-release.json')
    if(!$manifestEntry -or $manifestEntry.Length -gt 8MB) { throw 'Missing or oversized manifest' }
    $reader=[IO.StreamReader]::new($manifestEntry.Open())
    try { $manifest=$reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
    if($manifest.version -ne $job.version -or $manifest.files.Count -lt 2 -or $manifest.files.Count -gt 50000) { throw 'Manifest mismatch' }
    $listed=@{}; $total=0L
    foreach($file in $manifest.files) {
      $rel=Safe-Relative $file.path
      if($listed.ContainsKey($rel)) { throw 'Duplicate payload path' }
      if($file.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'Invalid file digest' }
      $listed[$rel]=$true
      $entry=$zip.GetEntry($rel)
      if(!$entry -or $entry.Length -ne $file.size) { throw "Missing or incorrect entry: $rel" }
      $total+=$entry.Length; if($total -gt 4GB) { throw 'Expanded package too large' }
      $dest=Target $stage $rel
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,$dest,$false)
      if((File-Hash $dest) -ne $file.sha256) { throw "File hash mismatch: $rel" }
    }
    if(!$listed.ContainsKey('Pigeon.exe') -or !$listed.ContainsKey('resources/app.asar')) { throw 'Not a Pigeon release' }
    foreach($entry in $zip.Entries) { if($entry.FullName -ne '.pigeon-release.json' -and !$listed.ContainsKey($entry.FullName)) { throw 'Unlisted payload' } }
  } finally { $zip.Dispose() }
  $entries=@()
  foreach($file in $manifest.files) {
    $dest=Target $root $file.path
    $existed=Test-Path -LiteralPath $dest -PathType Leaf
    if($existed) {
      $bak=Target $backup $file.path
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $bak) | Out-Null
      Copy-Retry $dest $bak
    }
    $entries+=@{path=$file.path;existed=$existed}
  }
  # Journal exists before touching the installation, including previously absent files.
  Write-Json $journalFile @{status='applying';entries=$entries}
  try {
    foreach($file in $manifest.files) {
      $dest=Target $root $file.path
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
      Copy-Retry (Target $stage $file.path) $dest
    }
    Write-Json $journalFile @{status='installed';entries=$entries}
  } catch { Restore $entries; Write-Json $journalFile @{status='restored';entries=$entries}; throw }
  Write-Json $resultFile @{status='installed';version=$job.version}
  if(!$job.testMode) { Start-Process -FilePath (Join-Path $root 'Pigeon.exe') -WorkingDirectory $root -WindowStyle Hidden }
} catch {
  Write-Json $resultFile @{status='failed';error=$_.Exception.Message}
  exit 1
}
