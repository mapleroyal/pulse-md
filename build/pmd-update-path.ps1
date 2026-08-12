param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Add", "Remove")]
  [string]$Action,

  [Parameter(Mandatory = $true)]
  [ValidateSet("Machine", "User")]
  [string]$Scope,

  [Parameter(Mandatory = $true)]
  [string]$Directory
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2

function Normalize-PathEntry([string]$Entry) {
  $normalized = $Entry.Trim()
  if (
    $normalized.Length -ge 2 -and
    $normalized[0] -eq '"' -and
    $normalized[$normalized.Length - 1] -eq '"'
  ) {
    $normalized = $normalized.Substring(1, $normalized.Length - 2)
  }
  return $normalized.TrimEnd('\')
}

$target = Normalize-PathEntry $Directory
if ([string]::IsNullOrWhiteSpace($target) -or $target.Contains(';')) {
  throw "The CLI PATH directory is invalid."
}

if ($Scope -eq "Machine") {
  $baseKey = [Microsoft.Win32.Registry]::LocalMachine
  $subKeyName = "SYSTEM\CurrentControlSet\Control\Session Manager\Environment"
} else {
  $baseKey = [Microsoft.Win32.Registry]::CurrentUser
  $subKeyName = "Environment"
}

$key = $baseKey.OpenSubKey($subKeyName, $true)
if ($null -eq $key) {
  throw "The $Scope environment registry key is unavailable."
}

try {
  $currentValue = $key.GetValue(
    "Path",
    "",
    [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
  )
  $current = if ($null -eq $currentValue) { "" } else { [string]$currentValue }

  $entries = if ($current.Length -eq 0) {
    [string[]]@()
  } else {
    $current.Split(
      [char[]]@(';'),
      [System.StringSplitOptions]::None
    )
  }
  $containsTarget = $false
  foreach ($entry in $entries) {
    if (
      [string]::Equals(
        (Normalize-PathEntry $entry),
        $target,
        [System.StringComparison]::OrdinalIgnoreCase
      )
    ) {
      $containsTarget = $true
      break
    }
  }

  if ($Action -eq "Add") {
    if ($containsTarget) {
      exit 0
    }
    $updated = if ($current.Length -eq 0 -or $current.EndsWith(';')) {
      "$current$target"
    } else {
      "$current;$target"
    }
  } else {
    if (-not $containsTarget) {
      exit 0
    }
    $kept = [System.Collections.Generic.List[string]]::new()
    foreach ($entry in $entries) {
      if (
        -not [string]::Equals(
          (Normalize-PathEntry $entry),
          $target,
          [System.StringComparison]::OrdinalIgnoreCase
        )
      ) {
        $kept.Add($entry)
      }
    }
    $updated = [string]::Join(';', $kept)
  }

  $valueKind = try {
    $key.GetValueKind("Path")
  } catch [System.ArgumentException] {
    [Microsoft.Win32.RegistryValueKind]::ExpandString
  }
  if (
    $valueKind -ne [Microsoft.Win32.RegistryValueKind]::String -and
    $valueKind -ne [Microsoft.Win32.RegistryValueKind]::ExpandString
  ) {
    $valueKind = [Microsoft.Win32.RegistryValueKind]::ExpandString
  }
  $key.SetValue("Path", $updated, $valueKind)
} finally {
  $key.Dispose()
}
