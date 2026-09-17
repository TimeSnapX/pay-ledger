$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
Start-Process -FilePath "python" -ArgumentList "-m","http.server","4174" -WindowStyle Hidden
Start-Sleep -Seconds 1
Start-Process "http://localhost:4174"
Write-Host "Pay Ledger is on http://localhost:4174"
