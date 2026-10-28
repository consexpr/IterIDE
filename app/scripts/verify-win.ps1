param(
    [string]$AppDirectory = (Join-Path $PSScriptRoot '../dist/win-unpacked'),
    [switch]$RestrictedEnvironment
)
$ErrorActionPreference = 'Stop'
$appDirectory = (Resolve-Path -LiteralPath $AppDirectory).Path
$verification = Join-Path $PSScriptRoot '../dist/verification'
New-Item -ItemType Directory -Path $verification -Force | Out-Null
$verification = (Resolve-Path -LiteralPath $verification).Path
$bin = Join-Path $appDirectory 'resources/toolchain/bin'
$node = (Get-Command node -ErrorAction Stop).Source
$savedEnvironment = @{}
$isolatedVariables = @('PATH', 'CPATH', 'CPLUS_INCLUDE_PATH', 'C_INCLUDE_PATH', 'LIBRARY_PATH', 'COMPILER_PATH', 'GCC_EXEC_PREFIX', 'PYTHONHOME', 'PYTHONPATH', 'ITER_DATA_DIR', 'ITER_STORE', 'ITER_CAPTURE', 'ITER_EVAL', 'ITER_CAPTURE_DELAY', 'ITER_CAPTURE_KEEP', 'ELECTRON_RENDERER_URL', 'ELECTRON_RUN_AS_NODE')
foreach ($name in $isolatedVariables) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    [Environment]::SetEnvironmentVariable($name, $null, 'Process')
}
function Invoke-Checked([string]$Executable, [string[]]$Arguments) {
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Executable failed with exit code $LASTEXITCODE" }
}
try {
    $env:PATH = "$env:SystemRoot\System32;$bin"
    # Both launch modes use a fresh application profile and problem store.
    $profile = Join-Path $verification ('profile-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $profile -Force | Out-Null
    $env:ITER_DATA_DIR = Join-Path $profile 'runtime'
    $env:ITER_STORE = Join-Path $profile 'store'
    Start-Transcript -Path (Join-Path $verification 'toolchain.log') -Force | Out-Null
    Write-Output "Isolated PATH=$env:PATH"
    foreach ($tool in @('g++', 'clangd', 'clang-format', 'gdb')) {
        Invoke-Checked (Join-Path $bin "$tool.exe") @('--version')
    }
    $source = Join-Path $verification 'cxx23.cpp'
    @'
#include <expected>
#include <iostream>
#include <numeric>
#include <ranges>
#include <vector>
int main() {
    auto values = std::views::iota(1, 6) | std::ranges::to<std::vector<int>>();
    std::expected<int, const char*> sum = std::accumulate(values.begin(), values.end(), 0);
    if (!sum || *sum != 15) return 1;
    std::cout << "C++23 ranges::to + expected OK: " << *sum << '\n';
}
'@ | Set-Content -LiteralPath $source -Encoding ASCII
    $program = Join-Path $verification 'cxx23.exe'
    Invoke-Checked (Join-Path $bin 'g++.exe') @('-std=c++23', '-O0', '-g', $source, '-o', $program)
    Invoke-Checked $program @()
    Invoke-Checked (Join-Path $bin 'gdb.exe') @('--batch', '-ex', 'show data-directory', '-ex', 'start', '-ex', 'info pretty-printer', '-ex', 'continue', $program)
    Invoke-Checked (Join-Path $bin 'g++.exe') @('-std=c++17', '-O2', (Join-Path $appDirectory 'resources/runner/runner.cpp'), '-lpsapi', '-o', (Join-Path $verification 'runner.exe'))
    Invoke-Checked (Join-Path $verification 'runner.exe') @((Join-Path $verification 'runner-result.json'), '5000', '256', $program)
    $runnerResult = Get-Content -LiteralPath (Join-Path $verification 'runner-result.json') -Raw | ConvertFrom-Json
    if ($runnerResult.exitCode -ne 0 -or $runnerResult.status -ne 'OK') { throw "Runner failed: $($runnerResult | ConvertTo-Json -Compress)" }
    Write-Output "Runner OK: $($runnerResult | ConvertTo-Json -Compress)"
    '#include "testlib.h"', 'int main(int argc, char** argv) { registerGen(argc, argv, 1); return 0; }' | Set-Content -LiteralPath (Join-Path $verification 'testlib.cpp') -Encoding ASCII
    Invoke-Checked (Join-Path $bin 'g++.exe') @('-std=c++17', (Join-Path $verification 'testlib.cpp'), '-I', (Join-Path $appDirectory 'resources/testlib'), '-o', (Join-Path $verification 'testlib.exe'))
    Invoke-Checked (Join-Path $verification 'testlib.exe') @()
    $env:ITER_CAPTURE = Join-Path $verification 'iter.png'
    foreach ($file in @($env:ITER_CAPTURE, "$env:ITER_CAPTURE.log")) {
        if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force }
    }
    $env:ITER_CAPTURE_DELAY = '5000'
    $env:ITER_EVAL = 'console.log("PACKAGING_TOOLCHAIN", JSON.stringify(await iter.toolchain.status())); console.log("PACKAGING_PLUGINS", JSON.stringify(await iter.plugins.list()));'
    $launch = @{
        FilePath = Join-Path $appDirectory 'ITER.exe'
        WorkingDirectory = $verification
        WindowStyle = 'Hidden'
        PassThru = $true
        RedirectStandardOutput = Join-Path $verification 'iter-stdout.log'
        RedirectStandardError = Join-Path $verification 'iter-stderr.log'
    }
    if ($RestrictedEnvironment) {
        $expectedDirectory = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../dist/win-unpacked')).Path
        if ($appDirectory -ne $expectedDirectory) { throw 'RestrictedEnvironment may only adjust the workspace dist/win-unpacked artifact' }
        # Only this generated artifact receives read permission; no system ACLs change.
        Invoke-Checked 'icacls.exe' @($appDirectory, '/grant', '*S-1-1-0:(OI)(CI)(RX)', '*S-1-15-2-1:(OI)(CI)(RX)')
        $port = Get-Random -Minimum 19000 -Maximum 29000
        $launch.ArgumentList = @('--disable-gpu', '--in-process-gpu', "--inspect-brk=127.0.0.1:$port", ('--user-data-dir="' + $profile + '\ITER"'))
    }
    $process = Start-Process @launch
    if ($RestrictedEnvironment) {
        try { Invoke-Checked $node @((Join-Path $PSScriptRoot 'prepare-capture.mjs'), "$port", $profile) }
        catch { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue; throw }
    }
    if (-not $process.WaitForExit(45000)) {
        Stop-Process -Id $process.Id -Force
        throw 'Packaged app did not exit within 45 seconds; check the capture log (another ITER instance may own the single-instance lock).'
    }
    $process.Refresh()
    if (($null -ne $process.ExitCode -and $process.ExitCode -ne 0) -or -not (Test-Path -LiteralPath $env:ITER_CAPTURE)) { throw 'Packaged app failed to capture; check dist/verification/iter*.log' }
    $captureLog = Get-Content -LiteralPath "$env:ITER_CAPTURE.log" -Raw
    Write-Output $captureLog
    if ($captureLog -notmatch '(?m)^captured\s*$') { throw 'Packaged app did not finish capture' }
    if ($captureLog -match '(?m)^error |renderer gone|"error":') { throw 'Packaged app reported an error; inspect capture log' }
    foreach ($tool in @('compiler', 'gdb', 'clangd', 'clangFormat')) {
        if ($captureLog -notmatch ('"' + $tool + '":\{"command":.*?"source":"bundled"')) { throw "App did not resolve bundled $tool" }
    }
    Write-Output "Packaged app startup and screenshot OK: $env:ITER_CAPTURE"
} finally {
    Stop-Transcript -ErrorAction SilentlyContinue | Out-Null
    foreach ($name in $isolatedVariables) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process') }
}
