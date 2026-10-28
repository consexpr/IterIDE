param([string]$WorkRoot)
$ErrorActionPreference = 'Stop'
$source = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
if (-not $WorkRoot) { $WorkRoot = Join-Path ([IO.Path]::GetTempPath()) ('iter-verify-' + [guid]::NewGuid().ToString('N')) }
$work = [IO.Path]::GetFullPath($WorkRoot).TrimEnd('\')
if ($work -eq $source -or $work.StartsWith($source + '\', [StringComparison]::OrdinalIgnoreCase) -or $work -eq [IO.Path]::GetPathRoot($work)) { throw 'Verification workspace must be outside the source project' }
if (Test-Path -LiteralPath $work) { throw 'Verification workspace must be new; existing paths are never overwritten' }
$entries = @(Get-ChildItem -LiteralPath $source -Recurse -Force)
if ($entries | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { throw 'Source contains links; inspect their boundaries before copying' }
foreach ($entry in $entries) {
    if ($entry.PSIsContainer) { continue }
    $candidate = $entry.Name -match '^(\.env(?:\..*)?|id_rsa|id_ed25519|credentials|sync-token\.json)$' -or $entry.Extension -in '.pem','.pfx','.p12','.key'
    $relative = $entry.FullName.Substring($source.Length+1).Replace('\','/')
    $fixture = $relative -match '^app/(resources/toolchain|dist/win-unpacked/resources/toolchain)/(lib/python3\.9/test/[^/]+\.pem|share/cmake-3\.31/Templates/Windows/Windows_TemporaryKey\.pfx)$'
    if ($candidate -and -not $fixture) { throw "Credential candidate requires review before copying: $relative" }
}
$control = Join-Path $work 'control'
$results = Join-Path $work 'test-results'
New-Item -ItemType Directory -Force -Path $control,$results,(Join-Path $work 'tmp'),(Join-Path $work 'profile/Roaming'),(Join-Path $work 'profile/Local'),(Join-Path $work 'store') | Out-Null
$project = Join-Path $work 'project'
& robocopy $source $project /E /COPY:DAT /DCOPY:DAT /XJ /SL /R:1 /W:1 /XD .git /XF .git /NFL /NDL /NP /LOG:"$control\copy.log"
if ($LASTEXITCODE -ge 8) { throw "Isolated copy failed ($LASTEXITCODE)" }
[ordered]@{ isolated=$true; root=$project; original=$source } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $control 'run-state.json') -Encoding utf8
$variables = @('TEMP','TMP','APPDATA','LOCALAPPDATA','USERPROFILE','ITER_STORE','ELECTRON_RUN_AS_NODE')
$previous = @{}
foreach ($name in $variables) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$previousLocation = Get-Location
function Invoke-NodeCommand([string[]]$Arguments,[string]$Log) {
    # Windows PowerShell turns native stderr into terminating errors under Stop,
    # even when the child exits successfully with a bundler warning.
    $stderr = $Log + '.stderr'
    $quoted = @($Arguments | ForEach-Object { '"' + $_ + '"' })
    $child = Start-Process -FilePath (Get-Command node -ErrorAction Stop).Source -ArgumentList $quoted -WorkingDirectory (Get-Location).Path -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput $Log -RedirectStandardError $stderr
    if ((Get-Item -LiteralPath $stderr).Length) { [IO.File]::AppendAllText($Log,[IO.File]::ReadAllText($stderr)) }
    return $child.ExitCode
}
try {
    $env:TEMP = Join-Path $work 'tmp'
    $env:TMP = $env:TEMP
    $env:APPDATA = Join-Path $work 'profile/Roaming'
    $env:LOCALAPPDATA = Join-Path $work 'profile/Local'
    $env:USERPROFILE = Join-Path $work 'profile'
    $env:ITER_STORE = Join-Path $work 'store'
    $env:ELECTRON_RUN_AS_NODE = $null
    $application = Join-Path $project 'app'
    Set-Location -LiteralPath $application
    $code = Invoke-NodeCommand @('node_modules/typescript/bin/tsc','-p','tsconfig.json') (Join-Path $results 'typecheck.log')
    if ($code -ne 0) { throw "Typecheck failed; inspect $results\typecheck.log" }
    Write-Output 'Isolated typecheck passed'
    $reportFile = Join-Path $results 'vitest.json'
    $code = Invoke-NodeCommand @('node_modules/vitest/vitest.mjs','run','src','--maxWorkers=2','--reporter=json','--outputFile',$reportFile) (Join-Path $results 'tests.log')
    if ($code -ne 0) { throw "Tests failed; inspect $results\tests.log and vitest.json" }
    Write-Output 'Isolated tests passed'
    $code = Invoke-NodeCommand @('node_modules/electron-vite/bin/electron-vite.js','build') (Join-Path $results 'build.log')
    if ($code -ne 0) { throw "Build failed; inspect $results\build.log" }
    Write-Output 'Isolated build passed'
    $electron = Join-Path $application 'node_modules/electron/dist/electron.exe'
    $smoke = Join-Path $application 'scripts/verify-window-close.cjs'
    foreach ($mode in @('save','cancel','failure','plugin')) {
        $process = Start-Process -FilePath $electron -ArgumentList @(('"' + $smoke + '"'),('"' + $work + '"'),$mode) -WorkingDirectory $application -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $results "ui-$mode.stdout.log") -RedirectStandardError (Join-Path $results "ui-$mode.stderr.log")
        $null = $process.Handle
        if (-not $process.WaitForExit(55000)) { & taskkill /PID $process.Id /T /F | Out-Null; throw "Owned smoke process timed out: $mode" }
        $process.WaitForExit()
        $exitCode = $process.ExitCode
        $resultFile = Join-Path $results "ui-$mode.json"
        if ($exitCode -ne 0 -or -not (Test-Path -LiteralPath $resultFile)) { throw "Window-close verification failed: $mode (exit $exitCode); inspect $results" }
        $result = Get-Content -LiteralPath $resultFile -Raw | ConvertFrom-Json
        if (-not $result.ok) { throw "Window-close verification failed: $mode" }
        Write-Output "Isolated window-close check passed: $mode"
    }
    $tests = Get-Content -LiteralPath $reportFile -Raw | ConvertFrom-Json
    [ordered]@{ passed=$true; project=$project; completedUtc=[DateTime]::UtcNow.ToString('o'); testsPassed=$tests.numPassedTests; testsFailed=$tests.numFailedTests; testsSkipped=$tests.numPendingTests; typecheck=$true; build=$true; windows=@('save','cancel','failure','plugin') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $results 'verification.json') -Encoding utf8
    Write-Output "Verification results: $results"
} finally {
    Set-Location -LiteralPath $previousLocation.Path
    foreach ($name in $variables) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
}
