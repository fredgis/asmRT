#requires -Version 7.0
param(
    [string]$AsmdbDir = $env:ASMRT_ASMDB_REPO,
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'These PID-scoped fault tests currently require Windows.' }
if (-not $AsmdbDir) { throw 'Set ASMRT_ASMDB_REPO or pass -AsmdbDir.' }
$AsmdbDir = (Resolve-Path -LiteralPath $AsmdbDir).Path
$root = Split-Path -Parent $PSScriptRoot
$binary = Join-Path $root 'target\debug\asmrt.exe'
if (-not $SkipBuild) {
    & (Join-Path $PSScriptRoot 'cargo.ps1') build --locked --quiet
    if ($LASTEXITCODE -ne 0) { throw 'Cargo build failed.' }
}
if (-not (Test-Path -LiteralPath $binary)) { throw 'Build asmRT first.' }
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('asmrt-fault-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temporary | Out-Null
$owned = [Collections.Generic.List[object]]::new()

function Register-OwnedProcess([Diagnostics.Process]$Process) {
    $owned.Add([pscustomobject]@{ Id = $Process.Id; Started = $Process.StartTime.ToUniversalTime().Ticks })
}

function Test-OwnedProcess($Identity) {
    $process = Get-Process -Id $Identity.Id -ErrorAction SilentlyContinue
    if (-not $process) { return $false }
    try { return $process.StartTime.ToUniversalTime().Ticks -eq $Identity.Started }
    catch { return $false }
    finally { $process.Dispose() }
}

function Start-TestProcess([string]$Directory, [string[]]$Arguments) {
    $info = [Diagnostics.ProcessStartInfo]::new($binary)
    $info.WorkingDirectory = $root
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    foreach ($argument in @('--asmdb-dir', $AsmdbDir, '--data-dir', $Directory) + $Arguments) {
        $info.ArgumentList.Add($argument)
    }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $info
    $process.Start() | Out-Null
    Register-OwnedProcess $process
    [pscustomobject]@{ Process = $process; ErrorOutput = $process.StandardError.ReadToEndAsync() }
}

function Receive-Task($Task, [int]$Seconds = 30) {
    if (-not $Task.Wait([TimeSpan]::FromSeconds($Seconds))) { throw 'Timed out waiting for child output.' }
    $Task.GetAwaiter().GetResult()
}

function Wait-Paused($Run, [string]$Stage) {
    for ($index = 0; $index -lt 16; $index++) {
        $line = Receive-Task ($Run.Process.StandardOutput.ReadLineAsync())
        if ($null -eq $line) {
            $errorText = Receive-Task $Run.ErrorOutput 10
            throw "CLI exited before its pause: $errorText"
        }
        $event = $line | ConvertFrom-Json
        if ($event.event -eq 'paused') {
            if ($event.stage -ne $Stage -or $event.task_id -ne '1') { throw 'Unexpected pause boundary.' }
            return
        }
    }
    throw 'No durable pause boundary reported.'
}

function Get-OwnedTree([int]$RootId) {
    $bridges = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $RootId" | Where-Object Name -eq 'node.exe')
    if ($bridges.Count -ne 1) { throw 'Expected exactly one owned Node bridge.' }
    $bridge = Get-Process -Id $bridges[0].ProcessId
    Register-OwnedProcess $bridge
    $engines = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($bridge.Id)" | Where-Object Name -eq 'asmdb.exe')
    if ($engines.Count -ne 1) { throw 'Expected exactly one owned asmDB engine.' }
    $engine = Get-Process -Id $engines[0].ProcessId
    Register-OwnedProcess $engine
    $tree = [pscustomobject]@{ Root = $RootId; Bridge = $bridge.Id; Engine = $engine.Id }
    $bridge.Dispose()
    $engine.Dispose()
    return $tree
}

function Wait-OwnedExit([int[]]$Ids) {
    $deadline = [DateTime]::UtcNow.AddSeconds(12)
    do {
        $live = @($owned | Where-Object { $_.Id -in $Ids -and (Test-OwnedProcess $_) })
        if ($live.Count -eq 0) { return }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Owned processes did not exit: $($live.Id -join ', ')"
}

function Finish-TestProcess($Run) {
    $output = $Run.Process.StandardOutput.ReadToEndAsync()
    if (-not $Run.Process.WaitForExit(30000)) { throw 'CLI did not exit within 30 seconds.' }
    [pscustomobject]@{
        ExitCode = $Run.Process.ExitCode
        Output = Receive-Task $output 10
        ErrorOutput = Receive-Task $Run.ErrorOutput 10
    }
}

function Resume-Demo([string]$Directory) {
    $run = Start-TestProcess $Directory @('demo', '--tasks', '6', '--workers', '3', '--work-ms', '0')
    $result = Finish-TestProcess $run
    $run.Process.Dispose()
    if ($result.ExitCode -ne 0) { throw "Recovery failed: $($result.ErrorOutput)" }
    $summary = ($result.Output.Trim() -split '\r?\n')[-1] | ConvertFrom-Json
    if ($summary.completed -ne 6 -or $summary.running -ne 0 -or $summary.pending -ne 0 -or $summary.retried -ne 1 -or $summary.max_attempt -ne 2) {
        throw "Incorrect recovered task state: $($result.Output)"
    }
}

try {
    $directory = Join-Path $temporary 'rust-loss'
    $run = Start-TestProcess $directory @('demo', '--tasks', '6', '--workers', '1', '--work-ms', '0', '--pause', 'artifact')
    Wait-Paused $run 'artifact'
    $tree = Get-OwnedTree $run.Process.Id
    $artifact = Join-Path $directory 'artifacts\1.json'
    $beforeHash = (Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash
    $beforeWrite = (Get-Item -LiteralPath $artifact).LastWriteTimeUtc
    Stop-Process -Id $tree.Root -Force
    Wait-OwnedExit @($tree.Root, $tree.Bridge, $tree.Engine)
    $run.Process.Dispose()
    Resume-Demo $directory
    if ((Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash -ne $beforeHash -or (Get-Item -LiteralPath $artifact).LastWriteTimeUtc -ne $beforeWrite) {
        throw 'Recovery replaced an already-published artifact.'
    }
    Write-Output 'PASS Rust termination after artifact publication: children exit, work resumes, artifact is reused.'

    foreach ($victim in @('Engine', 'Bridge')) {
        $directory = Join-Path $temporary ($victim.ToLowerInvariant() + '-loss')
        $run = Start-TestProcess $directory @('demo', '--tasks', '6', '--workers', '1', '--work-ms', '0', '--pause', 'claim')
        Wait-Paused $run 'claim'
        $tree = Get-OwnedTree $run.Process.Id
        Stop-Process -Id $tree.$victim -Force
        Wait-OwnedExit @($tree.$victim)
        $run.Process.StandardInput.WriteLine('')
        $run.Process.StandardInput.Flush()
        $run.Process.StandardInput.Close()
        $result = Finish-TestProcess $run
        if ($result.ExitCode -eq 0 -or $result.ErrorOutput -notmatch 'MCP|asmDB') {
            throw "Expected fail-closed behavior after $victim loss: $($result.Output) $($result.ErrorOutput)"
        }
        Wait-OwnedExit @($tree.Root, $tree.Bridge, $tree.Engine)
        $run.Process.Dispose()
        Resume-Demo $directory
        Write-Output "PASS $victim termination: no false success, no lingering writer, all tasks recover."
    }
}
finally {
    # Only terminate recorded, still-identical processes owned by this invocation.
    foreach ($identity in $owned.ToArray()) {
        if (Test-OwnedProcess $identity) {
            try { Get-OwnedTree $identity.Id | Out-Null } catch { }
        }
    }
    for ($index = $owned.Count - 1; $index -ge 0; $index--) {
        if (Test-OwnedProcess $owned[$index]) {
            Stop-Process -Id $owned[$index].Id -Force -ErrorAction SilentlyContinue
        }
    }
    Wait-OwnedExit @($owned.Id)
    Remove-Item -LiteralPath $temporary -Recurse -Force
}
