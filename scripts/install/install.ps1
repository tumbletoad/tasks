# @@PRODUCT_NAME@@ install script for Windows x64, version @@VERSION@@.
# Rendered from scripts/install/install.ps1 by scripts/install/render.ts (@@BUILD_KIND@@ build).
# Do not edit it: the release keys below are what it trusts. Runs on Windows PowerShell 5.1 and
# PowerShell 7, and uses only what both have: .NET's own classes, never a module cmdlet such as
# Get-FileHash, and never the console's code page for the bytes it verifies.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File install-@@VERSION@@.ps1 -Source <folder>
#          [-Root <folder>] [-Verifier ssh-keygen|node]
#
#   -Source    the release files, in one local folder: @@PRODUCT@@-@@VERSION@@-win-x64.zip, SHA256SUMS,
#              SHA256SUMS.sig and SHA256SUMS.sshsig.
#   -Root      the install root, a full path on a local disk whose parent folder exists. Default:
#              $env:@@HOME_VAR@@. The whole install lives in it (a separate
#              install): versions\, current, bin\@@PRODUCT@@.exe and @@PRODUCT@@w.exe, config\, state\,
#              cache\ and home.marker. This installer makes separate installs only. It writes
#              nothing outside the root: no Path entry, no shortcut, no registry value.
#   -Verifier  the tool that checks the signature: ssh-keygen, the OpenSSH that is part of Windows
#              (System32\OpenSSH), or node, the archive's own runtime\node.exe once Windows has
#              confirmed it is the OpenJS Foundation's signed binary, running a verifier that is
#              part of this script. Default: ssh-keygen when it is there, else node. Each accepts
#              only a signature by a key pinned below.
#
# The order is the point. Nothing from the archive is unpacked or run
# until the Ed25519 signature of SHA256SUMS verifies against a pinned key and the archive's SHA-256
# matches its line in SHA256SUMS. (The node verifier runs runtime\node.exe and nothing else from
# the archive, and only after Authenticode has confirmed its publisher.) Then the zip's entries are
# checked (plain files and folders, relative names without . or .., no device names), it is
# unpacked into a staging folder inside the install root, every file is checked against
# manifest.json, and the folder is renamed into versions\. Only then does the new version run: its
# own version-local launcher reports its package identity, then runs `@@PRODUCT@@ install --finish`,
# which runs the self-test (doctor's integrity, runtime and candidate rows) and, only once that
# passed, switches `current`. A failure at any point leaves the previous install as it was and
# removes what this run created, and nothing else.
param(
  [Parameter(Mandatory = $true)][string]$Source,
  [string]$Root = $env:@@HOME_VAR@@,
  [string]$Verifier = ''
)
Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

$Product = '@@PRODUCT@@'
$ProductName = '@@PRODUCT_NAME@@'
$Version = '@@VERSION@@'
$BuildKind = '@@BUILD_KIND@@'
$Platform = 'win-x64'
$Archive = "$Product-$Version-$Platform.zip"
$Namespace = "$Product-release"
# Path length: the launchers' longest path below the root, versions\<64-character
# version>\runtime\node.exe, must stay under MAX_PATH.
$MaxRoot = 168

# ---- The pinned release keys -------------------------------------------------------------------
# The current key and, during a rotation, the next one. Written by render.ts from
# packages/service/src/version/release-keys.ts; a release build refuses that file's placeholder.
$ReleaseKeys = @('@@RELEASE_KEYS@@')
# -------------------------------------------------------------------------------------------------

function New-VerifyError([string]$Reason) {
  return "Cannot verify this download ($Reason). Stopped before anything from the archive ran."
}

function New-RandomName([string]$Prefix) {
  return $Prefix + [Guid]::NewGuid().ToString('N').Substring(0, 12)
}

# Quotes arguments for a ProcessStartInfo. Arguments that would need escaping are refused: this
# script passes only paths and words it made itself.
function Join-Arguments([string[]]$Arguments) {
  foreach ($a in $Arguments) {
    if ($a.Contains('"') -or $a.EndsWith('\') -or $a.Length -eq 0) { throw "cannot quote argument: $a" }
  }
  return ($Arguments | ForEach-Object { '"' + $_ + '"' }) -join ' '
}

# Runs an executable with a file as its standard input and returns its exit code and output.
# Windows PowerShell 5.1 (.NET Framework) wraps the child's standard input in a StreamWriter with
# [Console]::InputEncoding and writes that encoding's preamble first: on a UTF-8 console (65001) the
# child read a byte order mark before the file (lab row R09). So the console encoding
# is swapped for UTF-8 without a preamble while the process starts, and restored at once.
function Invoke-WithInput([string]$Exe, [string[]]$Arguments, [string]$InputFile, [hashtable]$Environment = @{}, [string[]]$Remove = @()) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Exe
  $psi.Arguments = Join-Arguments $Arguments
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  foreach ($name in @($psi.Environment.Keys)) {
    foreach ($prefix in $Remove) {
      if ($name.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { [void]$psi.Environment.Remove($name); break }
    }
  }
  foreach ($name in $Environment.Keys) { $psi.Environment[$name] = $Environment[$name] }
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
  try {
    $process.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
    $process.StandardInput.Close()
  } catch {
    # The child exited before it read everything: its exit code says why.
  }
  $process.WaitForExit()
  return @{ Code = $process.ExitCode; Output = ($stdout.Result + $stderr.Result).Trim() }
}

# Runs an executable whose output goes straight to this script's own standard output and error,
# without PowerShell re-encoding it. Returns its exit code.
function Invoke-Inherited([string]$Exe, [string[]]$Arguments) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Exe
  $psi.Arguments = Join-Arguments $Arguments
  $psi.UseShellExecute = $false
  $process = [System.Diagnostics.Process]::Start($psi)
  $process.WaitForExit()
  return $process.ExitCode
}

# .NET directly, not Get-FileHash.
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

# Removes a folder and everything in it. Windows keeps a file that was just written or run open
# for a moment after (an antivirus scan, the verifier's node.exe as its process ends), and a delete
# meanwhile fails with a sharing violation or access denied: it is tried again for up to 10 s.
function Remove-Tree([string]$Dir) {
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  while ($true) {
    try {
      if ([System.IO.Directory]::Exists($Dir)) { [System.IO.Directory]::Delete($Dir, $true) }
      return
    } catch [System.IO.IOException], [System.UnauthorizedAccessException] {
      if ($clock.ElapsedMilliseconds -ge 10000) { throw }
      [System.Threading.Thread]::Sleep(100)
    }
  }
}

function Test-IsLink([System.IO.FileSystemInfo]$Item) {
  return [bool]($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
}

# Every entry under $Dir, without following links: a link is listed, never entered.
function Get-Tree([string]$Dir) {
  $out = New-Object System.Collections.Generic.List[System.IO.FileSystemInfo]
  $pending = New-Object System.Collections.Generic.Stack[System.IO.DirectoryInfo]
  $pending.Push((New-Object System.IO.DirectoryInfo $Dir))
  while ($pending.Count -gt 0) {
    foreach ($item in $pending.Pop().GetFileSystemInfos()) {
      $out.Add($item)
      if (($item -is [System.IO.DirectoryInfo]) -and -not (Test-IsLink $item)) { $pending.Push($item) }
    }
  }
  return , $out
}

# Checks $Dir against the manifest at $ManifestPath: its format, product, version and platform, and
# every file in $Dir but its own manifest.json listed with its SHA-256, nothing else in it and
# nothing a link. manifest.json lists one `"<path>": "<hex>"` per line (folder.ts in
# packages/service/src/version owns the format). Returns $null or the first problem.
function Test-VersionFolder([string]$Dir, [string]$ManifestPath) {
  if (-not [System.IO.File]::Exists($ManifestPath)) { return 'manifest.json is missing' }
  $lines = [System.IO.File]::ReadAllLines($ManifestPath)
  foreach ($want in @('  "format": 1,', "  `"name`": `"$Product`",", "  `"version`": `"$Version`",", "  `"platform`": `"$Platform`",")) {
    if (-not ($lines -ccontains $want)) { return 'manifest.json is not this release''s' }
  }
  $listed = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::Ordinal)
  foreach ($line in $lines) {
    if ($line -cmatch '^    "([A-Za-z0-9._/-]+)": "([0-9a-f]{64})",?$') {
      if ($listed.ContainsKey($Matches[1])) { return 'manifest.json lists a file twice' }
      $listed[$Matches[1]] = $Matches[2]
    }
  }
  if ($listed.Count -eq 0) { return 'manifest.json lists no file' }
  $count = 0
  foreach ($item in (Get-Tree $Dir)) {
    $rel = $item.FullName.Substring($Dir.Length + 1).Replace('\', '/')
    if (Test-IsLink $item) { return "$rel is a link" }
    if ($item -is [System.IO.DirectoryInfo]) { continue }
    if ($rel -ceq 'manifest.json') { continue }
    $count++
    if (-not $listed.ContainsKey($rel)) { return "$rel is not in manifest.json" }
    if ((Get-Sha256 $item.FullName) -cne $listed[$rel]) { return "$rel does not match manifest.json" }
  }
  if ($count -ne $listed.Count) { return 'files listed in manifest.json are missing' }
  return $null
}

# An existing folder of this version counts only if it is exactly the signed release:
# a plain folder that no other account can change, all through (checked before its
# files are, so none can change after), its manifest.json byte for byte the staged one, every file
# checked against that. Its own manifest never vouches for it.
function Test-ExistingVersion([string]$Dir, [string]$StagedManifest) {
  $item = Get-Item -LiteralPath $Dir -Force
  if (-not $item.PSIsContainer -or (Test-IsLink $item)) { return 'it is a link or not a folder' }
  $folder = New-Object System.IO.DirectoryInfo $Dir
  foreach ($entry in @(, $folder) + @((Get-Tree $Dir).ToArray())) {
    if (Test-IsLink $entry) { return "$($entry.FullName) is a link" }
    $others = Get-Untrusted $entry $WriteRights
    if ($others.Count -gt 0) { return "another account can change $($entry.FullName) ($($others -join ', '))" }
  }
  $own = Join-Path $Dir 'manifest.json'
  if (-not [System.IO.File]::Exists($own)) { return 'its manifest.json is missing' }
  $ownBytes = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($own))
  $signedBytes = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($StagedManifest))
  if ($ownBytes -cne $signedBytes) { return 'its manifest.json is not the signed one' }
  $problem = Test-VersionFolder $Dir $StagedManifest
  if ($problem) { return "its files do not match the signed manifest: $problem" }
  return $null
}

# ---- Who may change a folder --------------------------------------------------------------------
# Trusted: this user, SYSTEM, Administrators, CREATOR OWNER (whose rights go to whoever creates a
# child, so to this user) and TrustedInstaller (which owns Windows' own folders, C:\ on many
# machines). Any other account allowed to write, delete, change permissions or take ownership could
# replace code that this user then runs. So, before anything from the archive runs:
#   - the root and the folders the install uses in it (versions\, bin\, state\, config\, cache\)
#     are plain folders whose owner and ACL, inherit-only rules included, let no other account
#     change them or what is put in them,
#   - no folder above the root lets another account rename or remove the folder below it (Delete,
#     permissions or ownership on that folder, or DeleteSubdirectoriesAndFiles on its parent): it
#     could put another folder in the root's place after these checks,
#   - a version folder that is already there lets no other account change anything in it.
$Me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$Trusted = @($Me, 'S-1-5-18', 'S-1-5-32-544', 'S-1-3-0', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
# WriteData, AppendData, WriteExtendedAttributes, DeleteSubdirectoriesAndFiles, WriteAttributes,
# Delete, ChangePermissions, TakeOwnership, GENERIC_ALL and GENERIC_WRITE.
$WriteRights = 0x2 -bor 0x4 -bor 0x10 -bor 0x40 -bor 0x100 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x10000000 -bor 0x40000000
# What lets an account rename or remove a folder: Delete, ChangePermissions, TakeOwnership and
# GENERIC_ALL on it, or DeleteSubdirectoriesAndFiles and the same three on its parent.
$ReplaceRights = 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x10000000
$ParentRights = 0x40 -bor 0x40000 -bor 0x80000 -bor 0x10000000

function Get-ItemAcl([System.IO.FileSystemInfo]$Item) {
  if ($PSVersionTable.PSEdition -eq 'Core') {
    if ($Item -is [System.IO.DirectoryInfo]) { return [System.IO.FileSystemAclExtensions]::GetAccessControl([System.IO.DirectoryInfo]$Item) }
    return [System.IO.FileSystemAclExtensions]::GetAccessControl([System.IO.FileInfo]$Item)
  }
  return $Item.GetAccessControl()
}

# The owner, when not trusted, and the other SIDs that the item's ACL lets do any of $Rights: to
# the item itself, or with $Inherited also through inheritance to what is put in it.
function Get-Untrusted([System.IO.FileSystemInfo]$Item, [int64]$Rights, [bool]$Inherited = $true) {
  $acl = Get-ItemAcl $Item
  $found = @()
  $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  if ($Trusted -notcontains $owner) { $found += "owner $owner" }
  foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }
    if (-not $Inherited -and ($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly)) { continue }
    if (([int64][int]$rule.FileSystemRights -band $Rights) -eq 0) { continue }
    $sid = $rule.IdentityReference.Value
    if ($Trusted -notcontains $sid) { $found += $sid }
  }
  return , $found
}

function Assert-SafeRoot([string]$Dir) {
  foreach ($name in @('', 'versions', 'bin', 'state', 'config', 'cache')) {
    $folder = if ($name) { Join-Path $Dir $name } else { $Dir }
    if (-not (Test-Path -LiteralPath $folder)) { continue }
    $item = Get-Item -LiteralPath $folder -Force
    if (-not $item.PSIsContainer -or (Test-IsLink $item)) { throw "$folder is not a plain folder. Nothing was installed." }
    $others = Get-Untrusted $item $WriteRights
    if ($others.Count -gt 0) {
      throw "Another account can change $folder ($($others -join ', ')). Use a folder that only you, SYSTEM and Administrators can change, such as one in your profile folder."
    }
  }
  # What the new version writes while it installs, deeper down: the candidate's checks in
  # state\tmp, its compile cache in cache, the receipt and update.lock. A link or junction there
  # would take those writes out of the root.
  foreach ($name in @('state\tmp', 'cache')) {
    $folder = Join-Path $Dir $name
    if (-not (Test-Path -LiteralPath $folder)) { continue }
    $item = Get-Item -LiteralPath $folder -Force
    if (-not $item.PSIsContainer -or (Test-IsLink $item)) { throw "$folder is not a plain folder. Nothing was installed." }
    foreach ($entry in (Get-Tree $folder)) {
      if (Test-IsLink $entry) { throw "$($entry.FullName) is a link, which would take the install's writes out of the root. Nothing was installed." }
    }
  }
  foreach ($name in @('state\install.json', 'state\update.lock')) {
    $file = Join-Path $Dir $name
    if ((Test-Path -LiteralPath $file) -and (Test-IsLink (Get-Item -LiteralPath $file -Force))) { throw "$file is a link. Nothing was installed." }
  }
  # The folders on the way to the root: no link or junction (the checks below read the folders
  # as written, so the folders they lead to would go unchecked), and none that another account
  # may rename or remove.
  $child = New-Object System.IO.DirectoryInfo $Dir
  while ($null -ne $child.Parent) {
    if ($child.FullName -ne $Dir -and @('Junction', 'SymbolicLink') -contains (Get-Item -LiteralPath $child.FullName -Force).LinkType) {
      throw "$($child.FullName), a folder on the way to the install root, is a link or junction. Use the folder it leads to in the root's path, or a root in your profile folder."
    }
    $others = Get-Untrusted $child.Parent $ParentRights $false
    if ($child.FullName -ne $Dir) { $others = $others + (Get-Untrusted $child $ReplaceRights $false) }
    if ($others.Count -gt 0) {
      throw "Another account can rename or remove $($child.FullName) ($($others -join ', ')), a folder on the way to the install root, and put another in its place. Choose a root inside your own folders, such as your profile folder."
    }
    $child = $child.Parent
  }
}

$work = $null
$staging = $null
$targetNew = $null
$markerNew = $null
$versionsNew = $null
$rootMade = $null
$rootNew = $null
$lock = $null
$lockPath = $null
$code = 0
try {
  if ($BuildKind -eq 'test') {
    [Console]::Error.WriteLine("$Product install: this installer was made by a test and trusts a throwaway key. Never use it for a real install.")
  }
  if (@('', 'ssh-keygen', 'node') -notcontains $Verifier) { throw '-Verifier is ssh-keygen or node.' }

  # ---- The keys this script trusts -------------------------------------------------------------
  if ($ReleaseKeys.Count -lt 1 -or $ReleaseKeys.Count -gt 2) { throw 'This install script pins no release key. Nothing was installed.' }
  foreach ($key in $ReleaseKeys) {
    if ($key -cnotmatch '^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43}$') {
      throw 'This install script pins no valid release key: it is a template or damaged, not a release. Nothing was installed.'
    }
  }

  if (-not [Environment]::Is64BitOperatingSystem) { throw 'This installer is for 64-bit Windows.' }

  # ---- The install root ------------------------------------------------------------------------
  if ([string]::IsNullOrEmpty($Root)) {
    throw "Set `$env:@@HOME_VAR@@ or pass -Root <folder>. This installer makes separate installs only, into a folder you name."
  }
  $Root = $Root.TrimEnd('\')
  if ($Root -cnotmatch '^[A-Za-z]:\\.') { throw 'The install root must be a full path on a local disk, such as C:\Users\you\ttasks-test.' }
  if ([System.IO.Path]::GetFullPath($Root) -cne $Root) {
    throw 'The install root must be written as a full path without . or .. and without trailing dots or spaces.'
  }
  if ($Root.Length -gt $MaxRoot) {
    throw "The install root is $($Root.Length) characters long. At most $MaxRoot are allowed, so every path the launchers use below it stays under MAX_PATH."
  }
  $parent = [System.IO.Path]::GetDirectoryName($Root)
  if (-not (Test-Path -LiteralPath $Root)) {
    if (-not [System.IO.Directory]::Exists($parent)) { throw "The install root's parent folder $parent does not exist. Create it first." }
    [void][System.IO.Directory]::CreateDirectory($Root)
    $rootMade = $Root
  }
  $rootItem = Get-Item -LiteralPath $Root -Force
  if (-not $rootItem.PSIsContainer -or (Test-IsLink $rootItem)) { throw "The install root $Root is not a folder (or is a link). Nothing was installed." }
  Assert-SafeRoot $Root

  # One install into a root at a time, from here to the end of the clean-up (an update holds
  # update.lock for a whole install; a script cannot take a SQLite lock): a lock file in the root,
  # open without sharing, which Windows deletes when its handle closes, however this script ends.
  # Only while it holds the lock may a failure remove the root it made: until then another install
  # may be using it.
  $lockPath = Join-Path $Root '.install.lock'
  try {
    $lock = New-Object System.IO.FileStream($lockPath, [System.IO.FileMode]::OpenOrCreate,
      [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None, 1, [System.IO.FileOptions]::DeleteOnClose)
  } catch {
    $inner = $_.Exception
    while ($null -ne $inner.InnerException) { $inner = $inner.InnerException }
    # Held: a sharing violation; held and closing: access denied while it is being deleted.
    if ($inner -isnot [System.IO.IOException] -and $inner -isnot [System.UnauthorizedAccessException]) { throw }
    $rootMade = $null
    throw "Another install into $Root is running. Run the installer again once it has finished."
  }
  # A root this run made stays its own only while nothing but the lock is in it: between its
  # creation and the lock another install may have taken it, installed and let go.
  if ($rootMade -and @([System.IO.Directory]::GetFileSystemEntries($Root) | Where-Object { $_ -ne $lockPath }).Count -gt 0) {
    $rootMade = $null
  }
  $rootNew = $rootMade
  $rootMade = $null
  $versions = Join-Path $Root 'versions'
  $target = Join-Path $versions $Version

  # ---- 1. A private copy of the release files: what is verified is what gets unpacked ----------
  if (-not [System.IO.Directory]::Exists($Source)) { throw (New-VerifyError "the folder $Source does not exist") }
  if (-not [System.IO.Directory]::Exists($versions)) {
    [void][System.IO.Directory]::CreateDirectory($versions)
    $versionsNew = $versions
  }
  $work = Join-Path $versions (New-RandomName '.download-')
  [void][System.IO.Directory]::CreateDirectory($work)
  foreach ($name in @($Archive, 'SHA256SUMS', 'SHA256SUMS.sig', 'SHA256SUMS.sshsig')) {
    $from = Join-Path $Source $name
    if ([System.IO.File]::Exists($from)) { [System.IO.File]::Copy($from, (Join-Path $work $name)) }
  }
  $zip = Join-Path $work $Archive
  $sums = Join-Path $work 'SHA256SUMS'
  if (-not [System.IO.File]::Exists($sums)) { throw (New-VerifyError 'SHA256SUMS is missing') }
  if (-not [System.IO.File]::Exists($zip)) { throw (New-VerifyError "$Archive is missing") }
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem

  # ---- 2. The signature of SHA256SUMS, by a pinned key -------------------------------------------
  $keygen = Join-Path ([Environment]::GetFolderPath('System')) 'OpenSSH\ssh-keygen.exe'
  if ($Verifier -eq '') { $Verifier = if ([System.IO.File]::Exists($keygen)) { 'ssh-keygen' } else { 'node' } }
  if ($Verifier -eq 'ssh-keygen') {
    if (-not [System.IO.File]::Exists($keygen)) { throw (New-VerifyError 'System32\OpenSSH\ssh-keygen.exe is not installed') }
    $sshsig = Join-Path $work 'SHA256SUMS.sshsig'
    if (-not [System.IO.File]::Exists($sshsig)) { throw (New-VerifyError 'SHA256SUMS.sshsig is missing') }
    $allowed = Join-Path $work 'allowed_signers'
    $lines = foreach ($key in $ReleaseKeys) { "$Namespace namespaces=`"$Namespace`" $key" }
    [System.IO.File]::WriteAllText($allowed, (($lines -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding($false)))
    $verdict = Invoke-WithInput $keygen @('-Y', 'verify', '-f', $allowed, '-I', $Namespace, '-n', $Namespace, '-s', $sshsig) $sums
    if ($verdict.Code -ne 0) {
      if ($verdict.Output) { [Console]::Error.WriteLine($verdict.Output) }
      throw (New-VerifyError 'the signature of SHA256SUMS does not verify (ssh-keygen)')
    }
  } else {
    # Without OpenSSH, the archive's own node.exe verifies, but only once Windows has
    # confirmed that it is the OpenJS Foundation's signed binary. Nothing else from the zip runs,
    # and node.exe runs only the verifier below, from this script's text.
    $rawSig = Join-Path $work 'SHA256SUMS.sig'
    if (-not [System.IO.File]::Exists($rawSig)) { throw (New-VerifyError 'SHA256SUMS.sig is missing') }
    $verifierDir = Join-Path $work 'verifier'
    [void][System.IO.Directory]::CreateDirectory($verifierDir)
    $node = Join-Path $verifierDir 'node.exe'
    $zipArchive = [System.IO.Compression.ZipFile]::OpenRead($zip)
    try {
      $entry = $zipArchive.GetEntry('runtime/node.exe')
      if ($null -eq $entry) { throw (New-VerifyError 'the archive holds no runtime\node.exe to verify with') }
      [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $node, $false)
    } finally {
      $zipArchive.Dispose()
    }
    # The module from this PowerShell's own folder: a module path inherited from the other edition
    # must not decide which Get-AuthenticodeSignature runs.
    Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1')
    $signature = Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $node
    $subject = if ($null -ne $signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { '' }
    if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or $subject -cnotmatch '(^|, )O="?OpenJS Foundation"?(,|$)') {
      throw (New-VerifyError 'the archive''s runtime\node.exe is not the OpenJS Foundation''s signed binary')
    }
    $js = Join-Path $work 'verify.mjs'
    [System.IO.File]::WriteAllText($js, @'
import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
const [sumsFile, sigFile, ...keys] = process.argv.slice(2);
const sums = readFileSync(sumsFile);
const signature = readFileSync(sigFile);
let verified = false;
for (const line of keys) {
  const blob = Buffer.from(line.slice("ssh-ed25519 ".length), "base64");
  const raw = blob.subarray(blob.length - 32);
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") }, format: "jwk" });
  if (signature.length === 64 && verify(null, sums, key, signature)) verified = true;
}
process.stdout.write(verified ? "verified\n" : "not verified\n");
process.exitCode = verified ? 0 : 1;
'@, (New-Object System.Text.UTF8Encoding($false)))
    $nodeArgs = @('--input-type=module', '-', $sums, $rawSig) + $ReleaseKeys
    $verdict = Invoke-WithInput $node $nodeArgs $js @{} @('NODE_', 'OPENSSL_')
    if ($verdict.Code -ne 0 -or $verdict.Output -cne 'verified') {
      throw (New-VerifyError 'the signature of SHA256SUMS does not verify (node)')
    }
  }

  # ---- 3. The zip's SHA-256 against its one line in the signed SHA256SUMS -----------------------
  $expected = @()
  foreach ($line in ([System.IO.File]::ReadAllText($sums) -split "`n")) {
    if ($line -cmatch '^([0-9a-f]{64}) [ *](\S+)$' -and $Matches[2] -ceq $Archive) { $expected += $Matches[1] }
  }
  if ($expected.Count -ne 1) { throw (New-VerifyError "SHA256SUMS does not list $Archive exactly once") }
  if ((Get-Sha256 $zip) -cne $expected[0]) { throw (New-VerifyError "$Archive does not match SHA256SUMS") }

  # ---- 4. The zip's entries, then unpacking into a staging folder in the root ------------------
  # The zip is authentic now; these checks keep even a signed one inside its folder.
  $staging = Join-Path $versions (New-RandomName '.staging-')
  [void][System.IO.Directory]::CreateDirectory($staging)
  $zipArchive = [System.IO.Compression.ZipFile]::OpenRead($zip)
  try {
    $seen = @{}
    foreach ($entry in $zipArchive.Entries) {
      $name = $entry.FullName
      if ($name -cnotmatch '^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*/?$' -or $name -match '(^|/)\.\.?(/|$)' -or
          $name -match '\.(/|$)' -or $name -match '(^|/)(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(\.[^/]*)?(/|$)') {
        throw 'The archive holds a name that could leave its folder. Nothing was unpacked.'
      }
      $type = ($entry.ExternalAttributes -shr 16) -band 0xF000
      if ($type -ne 0 -and $type -ne 0x8000 -and $type -ne 0x4000) {
        throw 'The archive holds an entry that is not a plain file or folder (a link or a device). Nothing was unpacked.'
      }
      $key = $name.TrimEnd('/').ToLowerInvariant()
      if ($seen.ContainsKey($key)) { throw 'The archive holds two entries with one name. Nothing was unpacked.' }
      $seen[$key] = $true
    }
    foreach ($entry in $zipArchive.Entries) {
      $dest = Join-Path $staging $entry.FullName.TrimEnd('/').Replace('/', '\')
      if ($entry.FullName.EndsWith('/')) {
        [void][System.IO.Directory]::CreateDirectory($dest)
      } else {
        [void][System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($dest))
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $dest, $false)
      }
    }
  } finally {
    $zipArchive.Dispose()
  }
  $stagedManifest = Join-Path $staging 'manifest.json'
  $problem = Test-VersionFolder $staging $stagedManifest
  if ($problem) { throw "The unpacked files do not match manifest.json: $problem. Nothing from them ran." }

  # ---- 5. Into versions\<version> ---------------------------------------------------------------
  if (Test-Path -LiteralPath $target) {
    # The same version is already there: it runs only if it is exactly this
    # signed release. Otherwise it is left as it is: a running TTasks may use it.
    $problem = Test-ExistingVersion $target $stagedManifest
    if ($problem) {
      throw ("versions\$Version already exists but is not this signed release: $problem. " +
        "It was left as it is and nothing in it ran. Stop $ProductName if it runs from that folder, " +
        "move the folder out of $versions, and run the installer again.")
    }
    Remove-Tree $staging
  } else {
    [System.IO.Directory]::Move($staging, $target)
    $targetNew = $target
  }
  $staging = $null
  Remove-Tree $work
  $work = $null

  # ---- 6. home.marker: the launchers set @@HOME_VAR@@ to the root ------------------------------
  $marker = Join-Path $Root 'home.marker'
  if (-not [System.IO.File]::Exists($marker)) {
    [System.IO.File]::WriteAllBytes($marker, [byte[]]@())
    $markerNew = $marker
  }

  # ---- 7. The new version's own launcher: package identity, then self-test and current ---------
  $launcher = Join-Path $target "bin\$Product.exe"
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $launcher
  $psi.Arguments = '--package-info'
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.CreateNoWindow = $true
  $info = [System.Diagnostics.Process]::Start($psi)
  $identity = $info.StandardOutput.ReadToEnd().Trim()
  $info.WaitForExit()
  if ($info.ExitCode -ne 0) { throw 'The new version cannot report its package identity.' }
  if ($identity -cne 'none') { throw 'Run this in a normal terminal, not from inside another app.' }
  $finish = @('install', '--finish')
  if ($rootNew) { $finish += @('--created', '.') }
  if ($versionsNew) { $finish += @('--created', 'versions') }
  if ($targetNew) { $finish += @('--created', "versions/$Version") }
  if ($markerNew) { $finish += @('--created', 'home.marker') }
  $finished = Invoke-Inherited $launcher $finish
  if ($finished -ne 0) { throw "The new version did not finish the install (exit $finished): see above." }
  # Done: nothing of this run is removed any more.
  $targetNew = $null
  $markerNew = $null
  $versionsNew = $null
  $rootNew = $null
} catch {
  [Console]::Error.WriteLine("$Product install: " + $_.Exception.Message)
  $code = 1
} finally {
  # Removes what this run created, and nothing else: the download and staging folders, a version
  # folder it moved into place, home.marker and versions\ when it made them, and the root when it
  # made the root and holds the install lock (then everything in it came from this run; before the
  # lock, only while it is still empty).
  # Once the root has a current, it is an install that works, and only the download and staging
  # folders go: current names this version (a crash or a stop after the finish's switch, which
  # puts current back when it fails), the version an earlier install made current, or one an
  # update made current after the finish let go of update.lock. An update may also use, meanwhile,
  # a version folder this run moved into place (it takes an equal folder that is there,
  # and holds update.lock, not this script's lock), so that folder stays too, verified
  # and unused. The lock goes last: a root this run made is emptied first, then the lock file goes
  # with its handle, then the folder, if it is still empty.
  try {
    $currentFile = if ($rootNew -or $targetNew -or $markerNew -or $versionsNew) { Join-Path $Root 'current' } else { $null }
    if ($currentFile -and (Test-Path -LiteralPath $currentFile)) {
      foreach ($dir in @($work, $staging)) {
        if ($dir) { Remove-Tree $dir }
      }
      $rootNew = $null
      if ([System.IO.File]::Exists($currentFile) -and
          [System.IO.File]::ReadAllText($currentFile) -ceq $Version) {
        [Console]::Error.WriteLine("$Product install: current names $Version now, so it stays installed.")
      }
    } elseif ($rootNew) {
      foreach ($entry in [System.IO.Directory]::GetFileSystemEntries($rootNew)) {
        if ($entry -eq $lockPath) { continue }
        if ([System.IO.Directory]::Exists($entry)) { Remove-Tree $entry }
        else { [System.IO.File]::Delete($entry) }
      }
    } elseif ($rootMade) {
      # Not locked: removed only below, and only while empty.
    } else {
      foreach ($dir in @($work, $staging)) {
        if ($dir) { Remove-Tree $dir }
      }
      if ($targetNew) { Remove-Tree $targetNew }
      if ($markerNew -and [System.IO.File]::Exists($markerNew)) { [System.IO.File]::Delete($markerNew) }
      if ($versionsNew -and [System.IO.Directory]::Exists($versionsNew) -and
          @([System.IO.Directory]::GetFileSystemEntries($versionsNew)).Count -eq 0) {
        [System.IO.Directory]::Delete($versionsNew)
      }
    }
  } catch {
    [Console]::Error.WriteLine("$Product install: could not remove everything this run created: " + $_.Exception.Message)
    $code = 1
  }
  if ($null -ne $lock) { $lock.Dispose() }
  foreach ($made in @($rootNew, $rootMade)) {
    if (-not $made) { continue }
    try {
      [System.IO.Directory]::Delete($made, $false)
    } catch {
      [Console]::Error.WriteLine("$Product install: $made was left: something else is in it now.")
    }
  }
}
exit $code
