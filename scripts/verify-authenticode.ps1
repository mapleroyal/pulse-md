param(
  [Parameter(Mandatory = $true)]
  [string] $ExpectedVersion,

  [Parameter(Mandatory = $true, Position = 0, ValueFromRemainingArguments = $true)]
  [string[]] $Files
)

$ErrorActionPreference = "Stop"

foreach ($File in $Files) {
  $Resolved = Resolve-Path -LiteralPath $File -ErrorAction Stop
  $Signature = Get-AuthenticodeSignature -LiteralPath $Resolved.Path
  if ($Signature.Status -ne "Valid") {
    throw "Authenticode signature is not valid ($($Signature.Status)): $($Resolved.Path)"
  }
  if ($null -eq $Signature.TimeStamperCertificate) {
    throw "Authenticode signature is not timestamped: $($Resolved.Path)"
  }
  $FileName = [IO.Path]::GetFileName($Resolved.Path)
  $VersionedFile = $FileName -eq "Pulse MD.exe" -or $FileName.StartsWith("Pulse MD-$ExpectedVersion-", [StringComparison]::Ordinal)
  if ($VersionedFile) {
    $ProductVersion = (Get-Item -LiteralPath $Resolved.Path -ErrorAction Stop).VersionInfo.ProductVersion
    if ([string]::IsNullOrWhiteSpace($ProductVersion)) {
      throw "Product version is missing: $($Resolved.Path)"
    }
    $VersionMatches = $ProductVersion -eq $ExpectedVersion -or $ProductVersion.StartsWith("$ExpectedVersion.", [StringComparison]::Ordinal)
    if (-not $VersionMatches) {
      throw "Product version '$ProductVersion' does not match '$ExpectedVersion': $($Resolved.Path)"
    }
  }
  Write-Host "Verified signed and timestamped: $($Resolved.Path)"
}
