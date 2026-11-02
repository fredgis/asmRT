# Launch the local visualizer against an existing asmDB checkout and dedicated demo state.

[CmdletBinding()]
param(
    [string]$AsmdbDir = $env:ASMRT_ASMDB_REPO,
    [string]$DataRoot = (Join-Path $PSScriptRoot '..\.asmrt\visual'),
    [ValidateRange(1, 65535)][int]$Port = 8787,
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
if ([string]::IsNullOrWhiteSpace($AsmdbDir)) {
    $AsmdbDir = Join-Path (Split-Path $root -Parent) 'repo-asmdb'
}
$AsmdbDir = (Resolve-Path -LiteralPath $AsmdbDir).Path
$DataRoot = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($DataRoot)
Get-Command node -ErrorAction Stop | Out-Null
# A failed build must stop here rather than launch the server with a stale binary.
if (-not $SkipBuild) {
    & (Join-Path $PSScriptRoot 'cargo.ps1') build --locked --quiet
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
& node (Join-Path $root 'visualizer\server.mjs') --asmdb-dir $AsmdbDir --data-root $DataRoot --port $Port
exit $LASTEXITCODE
