param([switch]$Check)
$ErrorActionPreference = 'Stop'

$analyzer = Get-Module -ListAvailable PSScriptAnalyzer | Select-Object -First 1
if (-not $analyzer -and $env:ITER_PSSCRIPTANALYZER) {
    $analyzer = Import-Module -Name $env:ITER_PSSCRIPTANALYZER -PassThru
}
if (-not $analyzer) {
    $extensions = Join-Path $env:USERPROFILE '.vscode/extensions'
    if (Test-Path -LiteralPath $extensions) {
        $manifest = Get-ChildItem -LiteralPath $extensions -Directory -Filter 'ms-vscode.powershell-*' |
            Sort-Object Name -Descending |
            ForEach-Object { Get-ChildItem -LiteralPath (Join-Path $_.FullName 'modules/PSScriptAnalyzer') -Filter PSScriptAnalyzer.psd1 -Recurse -ErrorAction SilentlyContinue } |
            Select-Object -First 1
        if ($manifest) { $analyzer = Import-Module -Name $manifest.FullName -PassThru }
    }
}
if (-not $analyzer) { throw 'PSScriptAnalyzer is required; install the PowerShell editor tools or set ITER_PSSCRIPTANALYZER to its module manifest.' }
Import-Module $analyzer.Path

$settings = @{
    IncludeRules = @('PSUseConsistentIndentation')
    Rules = @{
        PSUseConsistentIndentation = @{
            Enable = $true
            Kind = 'space'
            IndentationSize = 4
            PipelineIndentation = 'IncreaseIndentationForFirstPipeline'
        }
    }
}
$changed = @()
foreach ($file in Get-ChildItem -LiteralPath $PSScriptRoot -File -Filter '*.ps1') {
    $source = [IO.File]::ReadAllText($file.FullName)
    $formatted = (Invoke-Formatter -ScriptDefinition $source -Settings $settings).Replace("`r`n", "`n").TrimEnd() + "`n"
    if ($source -ceq $formatted) { continue }
    $changed += $file.Name
    if (-not $Check) { [IO.File]::WriteAllText($file.FullName, $formatted, [Text.UTF8Encoding]::new($false)) }
}
if ($changed.Count) { Write-Output ($changed -join "`n") }
if ($Check -and $changed.Count) { throw 'PowerShell formatting differs; run npm run format:powershell.' }
