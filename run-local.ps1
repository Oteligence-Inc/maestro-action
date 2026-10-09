<#
.SYNOPSIS
  Run the Maestro GitHub Action locally against a custom (ngrok/caddy) https endpoint.
  Sets every INPUT_* env var and invokes node dist/index.js in ONE process, so the
  inputs are guaranteed to reach the Action (avoids the "api-key not supplied" trap
  caused by setting env vars in a different shell than the one that runs node).

.EXAMPLE
  .\run-local.ps1 -ApiKey ak_xxx -ApiUrl https://abcd.ngrok-free.app -Service order-service `
                  -Jar fixtures\order-service-1.0.0.jar

.EXAMPLE
  # staleness scenario — point at the changed jar
  .\run-local.ps1 -ApiKey ak_xxx -ApiUrl https://abcd.ngrok-free.app -Service order-service `
                  -Jar <a rebuilt order-service JAR> -FailOnWarnings
#>
param(
  [Parameter(Mandatory=$true)][string]$ApiKey,
  [Parameter(Mandatory=$true)][string]$ApiUrl,
  [Parameter(Mandatory=$true)][string]$Service,   # MUST equal spring.application.name (e.g. order-service)
  [Parameter(Mandatory=$true)][string]$Jar,       # path to exactly one jar
  [string]$Project = "maestro-action-e2e",
  [string]$Environment = "dev",
  [int]$TimeoutSeconds = 300,
  [switch]$FailOnWarnings
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

# Resolve + validate the jar path up front (clearer error than the Action's glob failure).
$jarPath = (Resolve-Path -LiteralPath $Jar).Path
if (-not (Test-Path -LiteralPath $jarPath -PathType Leaf)) {
  throw "Jar not found: $Jar"
}

# Required to allow a non-*.oteligence.com host (ngrok/caddy). Still must be https://.
$env:MAESTRO_ALLOW_CUSTOM_API_URL = "1"
$env:RUNNER_TEMP = (New-Item -ItemType Directory "$env:TEMP\maestro-run" -Force).FullName

# Hyphenated names set via .NET API to dodge all PowerShell parsing ambiguity.
[Environment]::SetEnvironmentVariable('INPUT_API-KEY', $ApiKey, 'Process')
[Environment]::SetEnvironmentVariable('INPUT_API-URL', $ApiUrl, 'Process')
${env:INPUT_PROJECT}        = $Project
${env:INPUT_SERVICE}        = $Service
${env:INPUT_ENVIRONMENT}    = $Environment
${env:INPUT_JARS}           = $jarPath
${env:INPUT_TIMEOUT-SECONDS} = "$TimeoutSeconds"
[Environment]::SetEnvironmentVariable('INPUT_FAIL-ON-WARNINGS', $(if ($FailOnWarnings) { 'true' } else { 'false' }), 'Process')

Write-Host "Maestro action -> $Project/$Service @ $Environment" -ForegroundColor Cyan
Write-Host "  jar:    $jarPath"
Write-Host "  apiUrl: $ApiUrl"
node .\dist\index.js
Write-Host "EXITCODE=$LASTEXITCODE"
