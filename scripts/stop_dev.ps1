# Stop SimplifAI dev servers (API + frontend)
Set-Location $PSScriptRoot

Write-Host "[stop] Stopping SimplifAI dev servers..." -ForegroundColor Yellow

$patterns = @(
    "SimplifAI\backend",
    "SimplifAI\frontend",
    "app.main:app",
    "start_dev.py"
)

$stopped = 0
Get-CimInstance Win32_Process | Where-Object {
    $cmd = $_.CommandLine
    if (-not $cmd) { return $false }
    foreach ($pattern in $patterns) {
        if ($cmd -like "*$pattern*" -and ($cmd -like "*uvicorn*" -or $cmd -like "*vite*" -or $cmd -like "*start_dev*")) {
            return $true
        }
    }
    return $false
} | ForEach-Object {
    Write-Host "[stop] Killing PID $($_.ProcessId) ($($_.Name))"
    taskkill /F /PID $_.ProcessId 2>$null | Out-Null
    $stopped++
}

foreach ($port in 8000, 8001, 5173, 5174, 5175) {
    $connections = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    foreach ($conn in $connections) {
        $procId = $conn.OwningProcess
        if ($procId -gt 0) {
            $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
            if ($proc) {
                Write-Host "[stop] Killing port $port -> PID $procId ($($proc.ProcessName))"
                taskkill /F /PID $procId 2>$null | Out-Null
                $stopped++
            }
        }
    }
}

if ($stopped -eq 0) {
    Write-Host "[stop] No matching processes found."
    Write-Host "[stop] If ports are still busy, close old Cursor/VS Code terminal tabs"
    Write-Host "       running uvicorn or npm run dev, then try again."
} else {
    Write-Host "[stop] Done. Stopped $stopped process(es)." -ForegroundColor Green
}

Start-Sleep -Seconds 1
Write-Host ""
Write-Host "Port status:"
netstat -ano | findstr "LISTENING" | findstr ":8000 :5173 :5174"
