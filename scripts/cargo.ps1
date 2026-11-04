# +--------------------------------------------------------------------+
# | asmRT :: cargo.ps1 -- repository-local Cargo entry point             |
# +--------------------------------------------------------------------+
# Prefer the local toolchain when present and forward arguments unchanged.
# Restore the caller's environment/location even on failure; propagate
# Cargo's exit code so build and validation failures cannot look successful.

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$localCargo = Join-Path $root '.tools\cargo\bin\cargo.exe'
# Save caller state so the finally block also restores it when Cargo fails.
$previous = @{
    CARGO_HOME = $env:CARGO_HOME
    RUSTUP_HOME = $env:RUSTUP_HOME
    PATH = $env:PATH
}
Push-Location $root
try {
    if (Test-Path -LiteralPath $localCargo) {
        $env:CARGO_HOME = Join-Path $root '.tools\cargo'
        $env:RUSTUP_HOME = Join-Path $root '.tools\rustup'
        $env:PATH = "$(Join-Path $root '.tools\bin');$(Join-Path $env:CARGO_HOME 'bin');$env:PATH"
        & $localCargo @args
    } else {
        & cargo @args
    }
    $code = $LASTEXITCODE
} finally {
    Pop-Location
    $env:CARGO_HOME = $previous.CARGO_HOME
    $env:RUSTUP_HOME = $previous.RUSTUP_HOME
    $env:PATH = $previous.PATH
}
exit $code
