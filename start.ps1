# One-command startup for SimplifAI (Windows PowerShell)
Set-Location $PSScriptRoot

$startScript = Join-Path $PSScriptRoot "scripts\start_dev.py"
$venvPython = Join-Path $PSScriptRoot "backend\.venv\Scripts\python.exe"
if (Test-Path $venvPython) {
    & $venvPython $startScript @args
    exit $LASTEXITCODE
}

if (Get-Command py -ErrorAction SilentlyContinue) {
    & py -3.14 $startScript @args
    exit $LASTEXITCODE
}

if (Get-Command python -ErrorAction SilentlyContinue) {
    & python $startScript @args
    exit $LASTEXITCODE
}

Write-Error "Python not found. Install Python 3.12+ and try again."
exit 1
