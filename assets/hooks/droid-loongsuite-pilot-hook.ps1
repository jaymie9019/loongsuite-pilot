# Droid hook entrypoint for Windows. Keep this file ASCII-only for Windows PowerShell 5.1.
param(
    [Parameter(Position = 0)]
    [string]$Subcommand = "unknown"
)

$ErrorActionPreference = "Stop"
$EMPTY_RESULT = '{}'
$MIN_NODE_MAJOR = 18
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Processor = Join-Path $ScriptDir "droid-hook-event-writer.mjs"
$PilotDataDir = Split-Path -Parent $ScriptDir
if (-not $env:LOONGSUITE_PILOT_DATA_DIR) {
    $env:LOONGSUITE_PILOT_DATA_DIR = $PilotDataDir
}

function Write-EmptyResult { Write-Output $EMPTY_RESULT }

function Convert-NodePath {
    param([string]$PathValue)
    if (-not $PathValue) { return $PathValue }
    $candidate = $PathValue.Trim().Trim('"')
    if ($candidate -match '^/([A-Za-z])/(.*)$') {
        $candidate = "$($Matches[1]):\$($Matches[2] -replace '/', '\')"
    }
    if (-not ($candidate -match '\.[^\\/.]+$') -and (Test-Path -LiteralPath "$candidate.exe")) {
        $candidate = "$candidate.exe"
    }
    return $candidate
}

function Test-NodeSuitable {
    param([string]$Bin)
    $resolved = Convert-NodePath $Bin
    if (-not $resolved -or -not (Test-Path -LiteralPath $resolved)) { return $false }
    try {
        $version = & $resolved --version 2>$null
        if (-not $version) { return $false }
        $major = [int](($version -replace '^v', '').Split('.')[0])
        return $major -ge $MIN_NODE_MAJOR
    } catch { return $false }
}

function Resolve-NodeBin {
    $dataDir = if ($env:LOONGSUITE_PILOT_DATA_DIR) {
        $env:LOONGSUITE_PILOT_DATA_DIR
    } else {
        Join-Path $env:USERPROFILE ".loongsuite-pilot"
    }
    $pinFile = Join-Path $dataDir "node-bin"
    if (Test-Path -LiteralPath $pinFile) {
        $pinned = Convert-NodePath ([string](Get-Content -LiteralPath $pinFile -Raw -ErrorAction SilentlyContinue))
        if (Test-NodeSuitable $pinned) { return $pinned }
    }
    $candidates = @(
        (Join-Path $env:USERPROFILE ".volta\bin\node.exe"),
        "C:\Program Files\nodejs\node.exe",
        "C:\Program Files (x86)\nodejs\node.exe"
    )
    $pathNode = Get-Command node -ErrorAction SilentlyContinue
    if ($pathNode) { $candidates += $pathNode.Source }
    foreach ($candidate in $candidates) {
        $resolved = Convert-NodePath $candidate
        if (Test-NodeSuitable $resolved) { return $resolved }
    }
    return $null
}

if (-not (Test-Path -LiteralPath $Processor)) {
    Write-EmptyResult
    exit 0
}

try {
    $nodeBin = Resolve-NodeBin
    if (-not $nodeBin) {
        Write-EmptyResult
        exit 0
    }
    $result = & $nodeBin $Processor $Subcommand 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-EmptyResult
        exit 0
    }
    $result = ($result | Out-String).Trim()
    if ($result) { Write-Output $result } else { Write-EmptyResult }
} catch {
    Write-EmptyResult
}
exit 0
