# Lab session 3 (M0.07), rows B01, B06 and B07 cold after a reboot, on the Windows lab machine.
#
# A supervisor that is not Node: it times the installed launcher directly, so nothing warms the
# Node runtime before the timed start. Run it right after sign-in, before anything else starts the
# lab install's Node:
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File cold-start.ps1 -Root <lab install root> `
#     -Out <results .jsonl> -Label <text> [-Metric offline|online|shim|all] [-State <folder>]
#
# offline  bin\tasks.exe mcp with the service not running: spawn to the first byte of the reply to
#          an MCP initialize (the offline first launch after a reboot). Refuses if the service runs.
# online   the same with the service running (the runtime is then already warm from the service).
# shim     mints a ticket through bin\tasks.exe ticket (Node), then times bin\tasks.exe shim from
#          spawn to its claim (the service's claim event). Needs the service.
# all      offline, then starts the service through bin\tasksw.exe if it is not running, then online
#          and shim, each labelled. It stops the service again if it started it.
#
# The clock stops at the first byte of the reply. After that the script reads the whole reply,
# parses it with ConvertFrom-Json and checks its structure: a JSON-RPC 2.0 response with the
# number 0 as its id, a result object with protocolVersion 2025-11-25 and a serverInfo object with
# a name, and no error. Then it asks the same bridge for `status` and checks that reply the same
# way: a response with the number 1 as its id and a text content item. It is the service's answer
# when the text is a JSON object naming the instance in service.json, and the bridge's own offline
# answer when the result is an error whose text says "not running". A measurement counts (ok true)
# only when both replies are valid and the answer is of the kind its metric needs: an offline
# answer to `online` is recorded as "offline answer, not counted", an online answer to `offline`
# likewise. No check runs Node.
#
# "The service runs" means more than a live PID: service.json names a node.exe under this
# install's versions\<v>\runtime\ whose arguments, after the runtime's own options, are
# versions\<v>\lib\tasks.mjs and then `service`, and which started no later than service.json was
# written. After a reboot a stale service.json may name any process. These checks use CIM.
#
# Every wait is bounded (-Limit, default 20 s). Every process the script starts is owned from the
# moment it exists and is stopped, with bounded waits, when the script ends, also after an error
# or Ctrl+C. If something does not stop, the script writes cold-start-leftovers.txt next to the
# results and says what is left. -FailAt service-started is a test hook: it fails on purpose right
# after starting the service.
#
# Each measurement appends one JSON line to -Out: metric, label, ms, ok, uptime_s, whether the
# service ran before the measurement, which kind of answer came, and a note. Runs on Windows
# PowerShell 5.1 and PowerShell 7.
param(
  [Parameter(Mandatory = $true)][string]$Root,
  [Parameter(Mandatory = $true)][string]$Out,
  [Parameter(Mandatory = $true)][string]$Label,
  [ValidateSet('offline', 'online', 'shim', 'all')][string]$Metric = 'all',
  [string]$State = '',
  [int]$Limit = 20,
  [string]$FailAt = ''
)
Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

$Root = [IO.Path]::GetFullPath($Root).TrimEnd('\')
if (-not $State) { $State = Join-Path $Root 'state\service' }
$tasks = Join-Path $Root 'bin\tasks.exe'
$tasksw = Join-Path $Root 'bin\tasksw.exe'
$init = '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"tasks-cold-start","version":"1"}}}' + "`n"
$statusCall = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"status","arguments":{}}}' + "`n"

# Every process this script started and has not seen end.
$script:owned = New-Object System.Collections.Generic.List[System.Diagnostics.Process]
$script:service = $null
$script:started = $false

function Get-UptimeSeconds { return [int]([uint32][Environment]::TickCount / 1000) }

function Get-EpochMs { return ([DateTime]::UtcNow.Ticks - 621355968000000000) / 10000.0 }

# The PID and instance service.json names, or $null.
function Get-ServiceFile {
  $file = Join-Path $State 'service.json'
  if (-not (Test-Path -LiteralPath $file)) { return $null }
  try { $info = [IO.File]::ReadAllText($file) | ConvertFrom-Json } catch { return $null }
  if (-not ($info.PSObject.Properties.Name -contains 'pid') -or -not ($info.PSObject.Properties.Name -contains 'instance')) { return $null }
  return [pscustomobject]@{ Pid = [int]$info.pid; Instance = [string]$info.instance; Written = (Get-Item -LiteralPath $file).LastWriteTimeUtc }
}

# Splits a Windows command line as the C runtime does: blanks separate words, double quotes group,
# 2n backslashes before a quote give n backslashes and 2n+1 give n and a literal quote.
function Split-CommandLine([string]$Line) {
  $words = New-Object System.Collections.Generic.List[string]
  $word = New-Object System.Text.StringBuilder
  $inWord = $false
  $quoted = $false
  $i = 0
  while ($i -lt $Line.Length) {
    $c = $Line[$i]
    if ($c -eq [char]'\') {
      $n = 0
      while ($i -lt $Line.Length -and $Line[$i] -eq [char]'\') { $n++; $i++ }
      if ($i -lt $Line.Length -and $Line[$i] -eq [char]'"') {
        [void]$word.Append([char]'\', [int][math]::Floor($n / 2))
        if ($n % 2 -eq 1) { [void]$word.Append([char]'"'); $i++ }
      } else {
        [void]$word.Append([char]'\', $n)
      }
      $inWord = $true
      continue
    }
    if ($c -eq [char]'"') { $quoted = -not $quoted; $inWord = $true; $i++; continue }
    if (-not $quoted -and ($c -eq [char]' ' -or $c -eq [char]"`t")) {
      if ($inWord) { $words.Add($word.ToString()); [void]$word.Clear(); $inWord = $false }
      $i++
      continue
    }
    [void]$word.Append($c)
    $inWord = $true
    $i++
  }
  if ($inWord) { $words.Add($word.ToString()) }
  return , $words.ToArray()
}

# service.json names this install's live service, not just a live PID.
function Test-ServiceRunning {
  $id = Get-ServiceFile
  if ($null -eq $id) { return $false }
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($id.Pid)" -ErrorAction SilentlyContinue
  if ($null -eq $p -or -not $p.ExecutablePath -or -not $p.CommandLine) { return $false }
  $versions = (Join-Path $Root 'versions') + '\'
  if (-not $p.ExecutablePath.StartsWith($versions, [StringComparison]::OrdinalIgnoreCase)) { return $false }
  if (-not $p.ExecutablePath.EndsWith('\runtime\node.exe', [StringComparison]::OrdinalIgnoreCase)) { return $false }
  # The arguments after the runtime and its options (--...) are this version's lib\tasks.mjs,
  # then `service`.
  $version = Split-Path -Parent (Split-Path -Parent $p.ExecutablePath)
  if ((Split-Path -Parent $version) + '\' -ne $versions) { return $false }
  $entry = Join-Path $version 'lib\tasks.mjs'
  [string[]]$words = Split-CommandLine $p.CommandLine
  $i = 1
  while ($i -lt $words.Count -and $words[$i].StartsWith('--')) { $i++ }
  if ($i + 1 -ge $words.Count) { return $false }
  if (-not [string]::Equals($words[$i], $entry, [StringComparison]::OrdinalIgnoreCase)) { return $false }
  if (-not [string]::Equals($words[$i + 1], 'service', [StringComparison]::Ordinal)) { return $false }
  # A reused PID started after service.json was written.
  if ($p.CreationDate.ToUniversalTime() -gt $id.Written.AddSeconds(1)) { return $false }
  return $true
}

function Write-Record([string]$Name, $Ms, [bool]$Ok, [bool]$Running, [string]$Answer, [string]$Note) {
  $record = [ordered]@{
    metric = $Name; label = $Label; ms = $Ms; ok = $Ok; uptime_s = (Get-UptimeSeconds)
    service_running_before = $Running; answer = $Answer; note = $Note; t = [int64](Get-EpochMs)
  }
  $line = ($record | ConvertTo-Json -Compress) + "`n"
  [IO.File]::AppendAllText($Out, $line, (New-Object Text.UTF8Encoding($false)))
  Write-Output $line.Trim()
}

function New-StartInfo([string]$File, [string]$Arguments) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $File
  $psi.Arguments = $Arguments
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  return $psi
}

# Starts a process and owns it at once.
function Start-Owned($Psi) {
  $p = [Diagnostics.Process]::Start($Psi)
  $script:owned.Add($p)
  return $p
}

# Ends an owned process: waits up to $Seconds for it to end by itself, then kills it. tasks.exe
# holds its Node in a kill-on-close job object, so killing tasks.exe ends its Node too.
function Stop-Owned($P, [int]$Seconds = 0) {
  try {
    if (-not $P.HasExited -and -not $P.WaitForExit($Seconds * 1000)) {
      $P.Kill()
      [void]$P.WaitForExit(5000)
    }
  } catch { }
  $gone = $true
  try { $gone = $P.HasExited } catch { }
  if ($gone) { [void]$script:owned.Remove($P) }
  return $gone
}

# Windows PowerShell 5.1 writes the console input encoding's preamble into a redirected stdin on a
# UTF-8 console (lab row R09). The encoding is swapped while the process starts, as install.ps1 does.
function Start-Redirected($Psi) {
  $saved = [Console]::InputEncoding
  $swapped = $false
  try {
    if ($saved.GetPreamble().Length -gt 0) {
      [Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
      $swapped = $true
    }
  } catch { $swapped = $false }
  try { return Start-Owned $Psi } finally { if ($swapped) { [Console]::InputEncoding = $saved } }
}

# Reads up to the end of a line, one byte at a time so nothing past it is consumed. $null when the
# deadline passes or the stream ends first.
function Read-Line($Stream, [System.Collections.Generic.List[byte]]$Bytes, [DateTime]$Deadline) {
  $one = New-Object byte[] 1
  while ($Bytes.Count -eq 0 -or $Bytes[$Bytes.Count - 1] -ne 10) {
    $left = [int]($Deadline - [DateTime]::UtcNow).TotalMilliseconds
    if ($left -le 0) { return $null }
    $task = $Stream.ReadAsync($one, 0, 1)
    if (-not $task.Wait($left)) { return $null }
    if ($task.Result -ne 1) { return $null }
    $Bytes.Add($one[0])
  }
  return [Text.Encoding]::UTF8.GetString($Bytes.ToArray()).TrimEnd("`r", "`n")
}

# JSON parsed into objects, and checks of its structure. A JSON object becomes a PSCustomObject;
# a number with no fraction an Int32 or Int64.
function ConvertFrom-JsonLine([string]$Line) {
  if ([string]::IsNullOrEmpty($Line)) { return $null }
  try { return , ($Line | ConvertFrom-Json) } catch { return $null }
}
function Test-JsonObject($Value) { return $Value -is [System.Management.Automation.PSCustomObject] }
function Test-Member($Object, [string]$Name) { return @($Object.PSObject.Properties.Name) -ccontains $Name }

# A JSON-RPC 2.0 response with the number $Id as its id, a result object and no error.
function Test-Response($Msg, [int]$Id) {
  if (-not (Test-JsonObject $Msg)) { return $false }
  if (-not (Test-Member $Msg 'jsonrpc') -or -not (Test-Member $Msg 'id') -or -not (Test-Member $Msg 'result')) { return $false }
  if (Test-Member $Msg 'error') { return $false }
  if (-not ($Msg.jsonrpc -is [string]) -or $Msg.jsonrpc -cne '2.0') { return $false }
  if (-not ($Msg.id -is [int] -or $Msg.id -is [long]) -or $Msg.id -ne $Id) { return $false }
  return Test-JsonObject $Msg.result
}

function Test-InitializeReply([string]$Line) {
  try {
    $msg = ConvertFrom-JsonLine $Line
    if (-not (Test-Response $msg 0)) { return $false }
    $result = $msg.result
    if (-not (Test-Member $result 'protocolVersion') -or -not (Test-Member $result 'serverInfo')) { return $false }
    if (-not ($result.protocolVersion -is [string]) -or $result.protocolVersion -cne '2025-11-25') { return $false }
    if (-not (Test-JsonObject $result.serverInfo) -or -not (Test-Member $result.serverInfo 'name')) { return $false }
    return ($result.serverInfo.name -is [string]) -and $result.serverInfo.name -ne ''
  } catch { return $false }
}

# Which kind of answer `status` gave: service (a result whose text is a JSON object naming the
# expected instance), offline (an error result whose text says "not running") or unknown.
function Get-AnswerKind([string]$Line, [string]$Instance) {
  try {
    $msg = ConvertFrom-JsonLine $Line
    if (-not (Test-Response $msg 1)) { return 'unknown' }
    if (-not (Test-Member $msg.result 'content')) { return 'unknown' }
    $content = @($msg.result.content)
    if (-not ($msg.result.content -is [array]) -or $content.Count -lt 1) { return 'unknown' }
    $item = $content[0]
    if (-not (Test-JsonObject $item) -or -not (Test-Member $item 'type') -or -not (Test-Member $item 'text')) { return 'unknown' }
    if ($item.type -cne 'text' -or -not ($item.text -is [string])) { return 'unknown' }
    $isError = (Test-Member $msg.result 'isError') -and ($msg.result.isError -is [bool]) -and $msg.result.isError
    if ($Instance -and -not $isError) {
      $said = ConvertFrom-JsonLine $item.text
      if ((Test-JsonObject $said) -and (Test-Member $said 'instance') -and ($said.instance -is [string]) -and $said.instance -ceq $Instance) { return 'service' }
    }
    if ($isError -and $item.text.Contains('not running')) { return 'offline' }
    return 'unknown'
  } catch { return 'unknown' }
}

function Measure-Bridge([string]$Name) {
  $running = Test-ServiceRunning
  if ($Name -eq 'offline' -and $running) { throw 'offline needs the service stopped' }
  if ($Name -eq 'online' -and -not $running) {
    Write-Warning 'No running service of this install found. Measuring anyway: the answer decides the label.'
  }
  $id = Get-ServiceFile
  $instance = if ($null -ne $id) { $id.Instance } else { '' }
  $psi = New-StartInfo $tasks ('mcp --state "' + $State + '"')
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $bytes = [Text.Encoding]::UTF8.GetBytes($init)
  $buffer = New-Object byte[] 1
  $watch = [Diagnostics.Stopwatch]::StartNew()
  $p = Start-Redirected $psi
  $deadline = [DateTime]::UtcNow.AddSeconds($Limit)
  try {
    $p.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
    $p.StandardInput.BaseStream.Flush()
    $read = $p.StandardOutput.BaseStream.ReadAsync($buffer, 0, 1)
    $done = $read.Wait($Limit * 1000)
    $ms = [math]::Round($watch.Elapsed.TotalMilliseconds, 1)
    $errors = $p.StandardError.ReadToEndAsync()
    # After the clock: the whole reply, then which service answered.
    $valid = $false
    $answer = 'none'
    if ($done -and $read.Result -eq 1) {
      $first = New-Object 'System.Collections.Generic.List[byte]'
      $first.Add($buffer[0])
      $line = Read-Line $p.StandardOutput.BaseStream $first $deadline
      $valid = ($null -ne $line) -and (Test-InitializeReply $line)
      if ($valid) {
        $call = [Text.Encoding]::UTF8.GetBytes($statusCall)
        $p.StandardInput.BaseStream.Write($call, 0, $call.Length)
        $p.StandardInput.BaseStream.Flush()
        $said = Read-Line $p.StandardOutput.BaseStream (New-Object 'System.Collections.Generic.List[byte]') $deadline
        $answer = Get-AnswerKind $said $instance
      }
    }
    # A bridge that answered ends by itself when its stdin closes. One that did not is killed now.
    $p.StandardInput.Close()
    if (-not (Stop-Owned $p $(if ($valid) { 10 } else { 0 }))) { throw 'the bridge did not end' }
    if (-not $valid) {
      $diag = Join-Path (Split-Path -Parent $Out) 'cold-start-bridge-stderr.txt'
      if ($errors.Wait(2000)) { [IO.File]::WriteAllText($diag, $errors.Result) }
    }
  } finally {
    [void](Stop-Owned $p 0)
  }
  $ok = $false
  if (-not $valid) { $note = "no valid initialize reply within $Limit s, not counted" }
  elseif ($Name -eq 'offline' -and $answer -eq 'offline') { $ok = $true; $note = 'offline first launch' }
  elseif ($Name -eq 'online' -and $answer -eq 'service') { $ok = $true; $note = 'runtime already warmed by the service' }
  elseif ($answer -eq 'offline') { $note = 'offline answer, not counted' }
  elseif ($answer -eq 'service') { $note = 'online answer, not counted' }
  else { $note = 'the answer named no expected service, not counted' }
  Write-Record "forwarder_$Name" $ms $ok $running $answer $note
}

# Runs bin\tasks.exe with a fixed argument string and returns its standard output, bounded.
# PowerShell would drop the "--" before a native command's arguments, so the arguments are passed
# as written.
function Invoke-Tasks([string]$Arguments) {
  $psi = New-StartInfo $tasks $Arguments
  $psi.RedirectStandardOutput = $true
  $p = Start-Owned $psi
  try {
    $text = $p.StandardOutput.ReadToEndAsync()
    if (-not $p.WaitForExit($Limit * 1000)) { throw "tasks $(($Arguments -split ' ')[0]) did not finish within $Limit s" }
    if (-not $text.Wait(5000)) { throw "tasks $(($Arguments -split ' ')[0]) left its output open" }
    return $text.Result
  } finally {
    [void](Stop-Owned $p 0)
  }
}

function Measure-Shim {
  if (-not (Test-ServiceRunning)) { throw 'shim needs the service running' }
  $folder = Join-Path $Root 'state\cold-folder'
  [void][IO.Directory]::CreateDirectory($folder)
  $version = [IO.File]::ReadAllText((Join-Path $Root 'current')).Trim()
  $node = Join-Path $Root "versions\$version\runtime\node.exe"
  $minted = (Invoke-Tasks ('ticket --state "' + $State + '" --cwd "' + $folder + '" -- "' + $node + '" -e 0')) | ConvertFrom-Json
  $ticket = [string]$minted.ticket
  $sha = [Security.Cryptography.SHA256]::Create()
  $tag = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($ticket))) -replace '-', '').ToLowerInvariant().Substring(0, 12)
  $psi = New-StartInfo $tasks ('shim --state "' + $State + '" ' + $ticket)
  $t0 = Get-EpochMs
  $p = Start-Owned $psi
  $finished = $p.WaitForExit($Limit * 1000)
  [void](Stop-Owned $p 0)
  if (-not $finished) { Write-Record 'shim_claim' $null $false $true 'none' "the shim did not finish within $Limit s, not counted"; return }
  $claim = $null
  foreach ($line in [IO.File]::ReadAllLines((Join-Path $State 'events.jsonl'))) {
    if ($line.Contains('"kind":"claim"') -and $line.Contains('"ticket":"' + $tag + '"')) { $claim = $line | ConvertFrom-Json }
  }
  if ($null -eq $claim) { Write-Record 'shim_claim' $null $false $true 'none' 'no claim event, not counted'; return }
  Write-Record 'shim_claim' ([math]::Round($claim.t - $t0, 1)) $true $true 'service' 'runtime already warmed by the service and the ticket call'
}

function Start-LabService {
  $script:service = Start-Owned (New-StartInfo $tasksw ('service --state "' + $State + '"'))
  $script:started = $true
  if ($FailAt -eq 'service-started') { throw 'failing on purpose after starting the service (test hook)' }
  $end = (Get-Date).AddSeconds($Limit)
  while (-not (Test-ServiceRunning)) {
    if ($script:service.HasExited) { throw 'the service ended before it was ready' }
    if ((Get-Date) -gt $end) { throw "the service did not start within $Limit s" }
    Start-Sleep -Milliseconds 100
  }
}

# The processes of this install whose parent is $ParentId. CIM keeps the parent's PID after the
# parent ended, so this finds tasksw.exe's Node also once tasksw.exe is gone.
function Get-ChildrenOf([int]$ParentId) {
  $prefix = $Root + '\'
  return @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$ParentId" -ErrorAction SilentlyContinue |
      Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) })
}

# Stops the service this script started: a shutdown call when it is ready, then tasksw.exe (it
# ends by itself after its Node's clean exit, else it is killed), then any Node of it still alive.
# tasksw.exe has no job object, so its Node is ended by its own PID. Returns the PIDs left.
function Stop-LabService {
  $left = @()
  $taskswId = $script:service.Id
  $wait = 0
  if (Test-Path -LiteralPath (Join-Path $State 'service.json')) {
    try { [void](Invoke-Tasks ('call --state "' + $State + '" service/shutdown')); $wait = 15 } catch { Write-Warning "shutdown call: $($_.Exception.Message)" }
  }
  if (-not (Stop-Owned $script:service $wait)) { $left += $taskswId }
  foreach ($c in @(Get-ChildrenOf $taskswId)) {
    $p = Get-Process -Id $c.ProcessId -ErrorAction SilentlyContinue
    if ($null -ne $p) {
      try { $p.Kill(); [void]$p.WaitForExit(5000) } catch { }
      if (-not $p.HasExited) { $left += $c.ProcessId }
    }
  }
  return $left
}

$left = @()
try {
  switch ($Metric) {
    'offline' { Measure-Bridge 'offline' }
    'online' { Measure-Bridge 'online' }
    'shim' { Measure-Shim }
    'all' {
      if (Test-ServiceRunning) {
        Write-Warning 'The service runs already, so there is no offline measurement.'
      } else {
        Measure-Bridge 'offline'
        Start-LabService
      }
      Measure-Bridge 'online'
      Measure-Shim
    }
  }
} finally {
  if ($script:started) {
    try { $left += @(Stop-LabService) } catch { Write-Warning "stopping the service: $($_.Exception.Message)"; $left += $script:service.Id }
  }
  foreach ($p in @($script:owned)) { if (-not (Stop-Owned $p 0)) { $left += $p.Id } }
  if ($left.Count -gt 0) {
    $diag = Join-Path (Split-Path -Parent $Out) 'cold-start-leftovers.txt'
    [IO.File]::WriteAllText($diag, "Processes this script started and could not stop: $($left -join ', ')`r`n")
    Write-Warning "Not stopped: $($left -join ', '). See $diag."
  }
}
if ($left.Count -gt 0) { exit 1 }
