# Tasks installer for Windows x64, version @@VERSION@@. M0.03 packaging spike (A2 3.12.4).
# Generated from spikes/m0/packaging/install/install.template.ps1. Do not edit: the release keys
# below are what this script trusts. Runs on Windows PowerShell 5.1 and PowerShell 7.
#
# Usage: powershell -NoProfile -File install-@@VERSION@@.ps1 -Source <folder> [-Root <folder>]
#   -Source  folder with tasks-@@VERSION@@-win-x64.zip, SHA256SUMS and SHA256SUMS.sshsig
#   -Root    install root. Defaults to $env:TTASKS_HOME. The spike installs only into a folder that
#            is named this way, never into %USERPROFILE%\.ttasks, and never changes the user Path.
#
# Order of trust: the Ed25519 signature of SHA256SUMS must verify with the ssh-keygen.exe that is
# part of Windows (System32\OpenSSH) against a key pinned below, and the zip's SHA-256 must match
# SHA256SUMS, before the zip is unpacked. So nothing from the archive runs unless both hold. Only
# then is every unpacked file checked against manifest.json, and only then does the new version's
# own launcher run. An existing folder of the same version runs only if it is exactly this signed
# release: its manifest.json equal to the unpacked one and every file matching it.
param(
  [Parameter(Mandatory = $true)][string]$Source,
  [string]$Root = $env:TTASKS_HOME
)
Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

$Version = '@@VERSION@@'
$Archive = "ttasks-$Version-win-x64.zip"
$Namespace = 'ttasks-release'
# Pinned release keys: the current key and, during a rotation, the next one.
$ReleaseKeys = @(
@@RELEASE_KEYS@@
)

function New-VerifyError([string]$Reason) {
  return "Cannot verify this download ($Reason). Stopped before anything from the archive ran."
}

function New-RandomName([string]$Prefix) {
  return $Prefix + [Guid]::NewGuid().ToString('N').Substring(0, 12)
}

# Runs an executable with a file as its standard input. Windows PowerShell cannot redirect a
# native command's input from a file, and piping text would change the bytes.
# Windows PowerShell 5.1 (.NET Framework) wraps the child's standard input in a StreamWriter with
# [Console]::InputEncoding and writes that encoding's preamble first. On a console whose input code
# page is UTF-8 (65001) the child then reads a byte order mark before the file (lab row R09,
# M0.05). So the console encoding is swapped for UTF-8 without a preamble while the process
# starts, and restored at once. The code page stays the same, so the console does not change.
function Invoke-WithInput([string]$Exe, [string[]]$Arguments, [string]$InputFile) {
  foreach ($a in $Arguments) {
    if ($a.Contains('"') -or $a.EndsWith('\')) { throw "cannot quote argument: $a" }
  }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Exe
  $psi.Arguments = ($Arguments | ForEach-Object { '"' + $_ + '"' }) -join ' '
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $saved = [Console]::InputEncoding
  $swapped = $false
  if ($saved.GetPreamble().Length -gt 0) {
    if ($saved.CodePage -ne 65001) { throw 'the console input encoding writes a preamble' }
    [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
    $swapped = $true
  }
  try {
    $process = [System.Diagnostics.Process]::Start($psi)
  } finally {
    if ($swapped) { [Console]::InputEncoding = $saved }
  }
  $stdout = $process.StandardOutput.ReadToEndAsync()
  $stderr = $process.StandardError.ReadToEndAsync()
  $bytes = [System.IO.File]::ReadAllBytes($InputFile)
  $process.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
  $process.StandardInput.Close()
  $process.WaitForExit()
  return @{ Code = $process.ExitCode; Output = ($stdout.Result + $stderr.Result).Trim() }
}

# .NET directly, not Get-FileHash: Windows PowerShell 5.1 started from PowerShell 7 inherits its
# PSModulePath, loads PowerShell 7's Microsoft.PowerShell.Utility and then has no Get-FileHash
# (lab row R09, M0.05).
function Get-Sha256([string]$Path) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    return ([BitConverter]::ToString($sha.ComputeHash($stream)) -replace '-', '').ToLowerInvariant()
  } finally {
    $stream.Dispose()
    $sha.Dispose()
  }
}

# Checks $Dir against the manifest at $ManifestPath: every file in $Dir except its own
# manifest.json must be listed with its SHA-256, nothing else may exist, and nothing may be a link.
function Test-VersionFolder([string]$Dir, [string]$ManifestPath) {
  if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) { return 'manifest.json is missing' }
  $manifest = [System.IO.File]::ReadAllText($ManifestPath) | ConvertFrom-Json
  if ($manifest.version -cne $Version) { return 'manifest.json names another version' }
  if ($manifest.platform -cne 'win-x64') { return 'manifest.json names another platform' }
  $listed = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($p in $manifest.files.PSObject.Properties) { $listed[$p.Name] = [string]$p.Value }
  $items = @(Get-ChildItem -LiteralPath $Dir -Recurse -Force)
  foreach ($item in $items) {
    if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { return "$($item.Name) is a link" }
  }
  $files = @($items | Where-Object { -not $_.PSIsContainer })
  $count = 0
  foreach ($file in $files) {
    $rel = $file.FullName.Substring($Dir.Length + 1).Replace('\', '/')
    if ($rel -ceq 'manifest.json') { continue }
    $count++
    if (-not $listed.ContainsKey($rel)) { return "$rel is not in manifest.json" }
    if ((Get-Sha256 $file.FullName) -cne $listed[$rel]) { return "$rel does not match manifest.json" }
  }
  if ($count -ne $listed.Count) { return 'files listed in manifest.json are missing' }
  return $null
}

# An existing folder of this version counts only if it is exactly the signed release: a plain
# folder, its manifest.json byte for byte the staged one (which the signature covers), and every
# file checked against the staged manifest. Its own manifest never vouches for it.
function Test-ExistingVersion([string]$Dir, [string]$StagedManifest) {
  $item = Get-Item -LiteralPath $Dir -Force
  if (-not $item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
    return 'it is a link or not a folder'
  }
  $own = Join-Path $Dir 'manifest.json'
  if (-not (Test-Path -LiteralPath $own -PathType Leaf)) { return 'its manifest.json is missing' }
  $ownBytes = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($own))
  $signedBytes = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($StagedManifest))
  if ($ownBytes -cne $signedBytes) { return 'its manifest.json is not the signed one' }
  $problem = Test-VersionFolder $Dir $StagedManifest
  if ($problem) { return "its files do not match the signed manifest: $problem" }
  return $null
}

$work = $null
$staging = $null
$code = 0
try {
  if ([string]::IsNullOrEmpty($Root)) {
    throw 'Set TTASKS_HOME or pass -Root: the spike installs only into a folder you name.'
  }
  if (-not [Environment]::Is64BitOperatingSystem) { throw 'This installer is for 64-bit Windows.' }
  $Root = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
  $versions = Join-Path $Root 'versions'
  [void][System.IO.Directory]::CreateDirectory($versions)

  # 1. Copy the three inputs into a private folder, so what is verified is what gets unpacked.
  $work = Join-Path $versions (New-RandomName '.download-')
  [void][System.IO.Directory]::CreateDirectory($work)
  foreach ($name in @($Archive, 'SHA256SUMS', 'SHA256SUMS.sshsig')) {
    $from = Join-Path $Source $name
    if (-not (Test-Path -LiteralPath $from -PathType Leaf)) { throw (New-VerifyError "$name is missing") }
    Copy-Item -LiteralPath $from -Destination (Join-Path $work $name)
  }
  $zip = Join-Path $work $Archive
  $sums = Join-Path $work 'SHA256SUMS'

  # 2. The signature of SHA256SUMS, with the ssh-keygen.exe of Windows and only the pinned keys.
  $keygen = Join-Path ([Environment]::GetFolderPath('System')) 'OpenSSH\ssh-keygen.exe'
  if (-not (Test-Path -LiteralPath $keygen -PathType Leaf)) {
    throw (New-VerifyError 'System32\OpenSSH\ssh-keygen.exe is not installed')
  }
  $allowed = Join-Path $work 'allowed_signers'
  $lines = foreach ($key in $ReleaseKeys) { "$Namespace namespaces=`"$Namespace`" $key" }
  [System.IO.File]::WriteAllText($allowed, (($lines -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding($false)))
  $verdict = Invoke-WithInput $keygen @('-Y', 'verify', '-f', $allowed, '-I', $Namespace, '-n', $Namespace, '-s', (Join-Path $work 'SHA256SUMS.sshsig')) $sums
  if ($verdict.Code -ne 0) {
    if ($verdict.Output) { [Console]::Error.WriteLine($verdict.Output) }
    throw (New-VerifyError 'the signature of SHA256SUMS does not verify')
  }

  # 3. The zip's SHA-256 against its single line in the signed SHA256SUMS.
  $expected = @()
  foreach ($line in ([System.IO.File]::ReadAllText($sums) -split "`n")) {
    if ($line -cmatch '^([0-9a-f]{64}) [ *](\S+)$' -and $Matches[2] -ceq $Archive) { $expected += $Matches[1] }
  }
  if ($expected.Count -ne 1) { throw (New-VerifyError "SHA256SUMS does not list $Archive exactly once") }
  if ((Get-Sha256 $zip) -cne $expected[0]) { throw (New-VerifyError "$Archive does not match SHA256SUMS") }

  # 4. Only now unpack, into a staging folder next to the version folders.
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $staging = Join-Path $versions (New-RandomName '.staging-')
  [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $staging)
  $stagedManifest = Join-Path $staging 'manifest.json'
  $problem = Test-VersionFolder $staging $stagedManifest
  if ($problem) { throw "The unpacked files do not match manifest.json: $problem" }
  $target = Join-Path $versions $Version
  if (Test-Path -LiteralPath $target) {
    # The same version is already there. It runs only if it is exactly this signed release.
    # Otherwise stop and leave it as it is: it may be the version a running TTasks uses.
    $problem = Test-ExistingVersion $target $stagedManifest
    if ($problem) {
      throw ("versions\$Version already exists but is not this signed release: $problem. " +
        'It was left as it is and nothing in it ran. Stop TTasks if it runs from that folder, ' +
        "move the folder out of $versions, and run the installer again.")
    }
    Remove-Item -LiteralPath $staging -Recurse -Force
  } else {
    [System.IO.Directory]::Move($staging, $target)
  }
  $staging = $null
  Remove-Item -LiteralPath $work -Recurse -Force
  $work = $null

  # 5. A separate install (TTASKS_HOME) is marked, so the launcher sets TTASKS_HOME (A2 3.12.3).
  [System.IO.File]::WriteAllBytes((Join-Path $Root 'home.marker'), [byte[]]@())

  # 6. The verified version's own launcher: package identity first, then the hand-over.
  $launcher = Join-Path $target 'bin\ttasks.exe'
  $identity = @(& $launcher --package-info)
  if ($LASTEXITCODE -ne 0) { throw 'The new version cannot report its package identity.' }
  if ($identity.Count -ne 1 -or $identity[0] -cne 'none') {
    throw 'Run this in a normal terminal, not from inside another app.'
  }
  & $launcher install --finish
  if ($LASTEXITCODE -ne 0) { throw 'The new version failed its self-test.' }
  Write-Output "The stable command is $Root\bin\ttasks.exe"
} catch {
  [Console]::Error.WriteLine('ttasks install: ' + $_.Exception.Message)
  $code = 1
} finally {
  if ($work -and (Test-Path -LiteralPath $work)) { Remove-Item -LiteralPath $work -Recurse -Force }
  if ($staging -and (Test-Path -LiteralPath $staging)) { Remove-Item -LiteralPath $staging -Recurse -Force }
}
exit $code
