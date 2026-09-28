$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$env:CNC_DB_PATH = Join-Path (Join-Path $root 'data') 'cli-smoke.db'
Remove-Item "$($env:CNC_DB_PATH)*" -Force -ErrorAction SilentlyContinue
$global:cliPath = Join-Path (Join-Path $root 'src') (Join-Path 'cli' 'index.ts')
function Run-Cli { param([Parameter(ValueFromRemainingArguments = $true)] [string[]] $CliArgs)
  & npx tsx $global:cliPath @CliArgs
}
Run-Cli workorder add WO1 P1 10
Run-Cli feature add WO1 DIA 10 10.1 9.9
Run-Cli machine add MC1 Mill
Run-Cli tool add T1 600000 1 600000
Run-Cli program add PRG 1.0
Run-Cli gauge add G1 DIA 2592000000
Run-Cli mount T1 1 MC1 2026-03-01T00:00:00Z
Run-Cli event ev-s1 MC1 cycle_start 2026-03-01T01:00:00Z PRG 1.0 WO1
Run-Cli event ev-e1 MC1 cycle_end 2026-03-01T01:05:00Z PRG 1.0 WO1
Run-Cli event ev-s1 MC1 cycle_start 2026-03-01T01:00:00Z PRG 1.0 WO1
Run-Cli derive
Run-Cli measure WO1 S1 DIA G1 2026-03-01T01:06:00Z 10.0
Run-Cli measure WO1 S2 DIA G1 2026-03-01T01:07:00Z 10.2
Run-Cli life
Run-Cli life-alerts
Run-Cli traces
Run-Cli report WO1
