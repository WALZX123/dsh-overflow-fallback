# Publish this package to the official npm registry.
#
# Two authentication modes:
#   - OTP mode (authenticator app): prompts for a 6-digit code.
#   - Token mode (granular token with "Bypass 2FA"): pass -NoOtp.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\publish.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\publish.ps1 -Otp 123456
#   powershell -ExecutionPolicy Bypass -File scripts\publish.ps1 -NoOtp

param(
  [string]$Otp,
  [switch]$NoOtp
)

$ErrorActionPreference = 'Stop'

# Prefer npm from PATH; fall back to the workspace copy used during development.
$fallback = 'E:\DeepSeek工作区\.tools\npm.cmd'
$npm = $null
$fromPath = Get-Command npm -ErrorAction SilentlyContinue
if ($fromPath) {
  $npm = $fromPath.Source
} elseif (Test-Path -LiteralPath $fallback) {
  $npm = $fallback
} else {
  throw "npm not found: install Node.js, or fix the fallback path. Tried: $fallback"
}

Push-Location (Split-Path $PSScriptRoot -Parent)
try {
  Write-Host "=== npm: $npm ==="
  & $npm whoami
  if ($LASTEXITCODE -ne 0) { throw 'Not logged in. Run: npm login' }

  if ($NoOtp) {
    Write-Host '=== publish (token mode, no OTP) ==='
    & $npm publish --access public
  } else {
    if (-not $Otp) {
      $Otp = Read-Host 'Enter the 6-digit code from your authenticator'
    }
    if ($Otp -notmatch '^\d{6}$') {
      throw "OTP must be exactly 6 digits, got '$Otp'"
    }
    Write-Host '=== publish (OTP mode) ==='
    & $npm publish --access public --otp=$Otp
  }
  if ($LASTEXITCODE -ne 0) { throw 'publish failed' }

  Write-Host ''
  Write-Host 'Published. Next steps:'
  Write-Host '  git tag v0.4.0'
  Write-Host '  git push origin v0.4.0'
}
finally {
  Pop-Location
}