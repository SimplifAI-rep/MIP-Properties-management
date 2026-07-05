# One-command startup for SimplifAI (Windows PowerShell)
Set-Location $PSScriptRoot

$venvPython = Join-Path $PSScriptRoot "backend\.venv\Scripts\python.exe"
if (Test-Path $venvPython) {
    & $venvPython scripts/start_dev.py @args
    exit $LASTEXITCODE
}

if (Get-Command py -ErrorAction SilentlyContinue) {
    & py -3.14 scripts/start_dev.py @args
    exit $LASTEXITCODE
}

if (Get-Command python -ErrorAction SilentlyContinue) {
    & python scripts/start_dev.py @args
    exit $LASTEXITCODE
}

Write-Error "Python not found. Install Python 3.12+ and try again."
exit 1
