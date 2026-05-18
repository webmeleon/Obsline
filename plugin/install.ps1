param(
  [Parameter(Mandatory, HelpMessage = "Path to your Obsidian vault folder")]
  [string]$Vault
)

$dest = Join-Path $Vault ".obsidian\plugins\obsline"
New-Item -ItemType Directory -Force -Path $dest | Out-Null

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Copy-Item "$here\main.js", "$here\manifest.json", "$here\styles.css" -Destination $dest

Write-Host "✓ Installed to $dest"
Write-Host "  → Restart Obsidian and enable 'Obsline – Outline Sync' under Settings → Community plugins."
