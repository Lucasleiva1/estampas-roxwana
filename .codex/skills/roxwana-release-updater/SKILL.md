---
name: roxwana-release-updater
description: Publish ROXWANA Biblioteca Visual as a signed Tauri desktop release on GitHub. Use when updating this project, creating GitHub releases, uploading updater assets, generating latest.json, signing NSIS installers, or troubleshooting auto-update for C:/Users/jaell/Desktop/PAGINAS WEB Y APP/estampas-roxwana.
---

# ROXWANA Release Updater

Use this skill for this project only: `C:\Users\jaell\Desktop\PAGINAS WEB Y APP\estampas-roxwana`.

## Project Facts

- GitHub repo: `Lucasleiva1/estampas-roxwana`
- Release tag prefix: `app-v`
- Product name: `ROXWANA Biblioteca Visual`
- Tauri identifier: `com.roxwana.biblioteca-visual`
- Updater endpoint in `src-tauri/tauri.conf.json`:
  `https://github.com/Lucasleiva1/estampas-roxwana/releases/latest/download/latest.json`
- Local updater private key path:
  `C:\Users\jaell\AppData\Roaming\ROXWANA Biblioteca Visual\updater\tauri-updater.key`
- Local updater password path:
  `C:\Users\jaell\AppData\Roaming\ROXWANA Biblioteca Visual\updater\tauri-updater-password.txt`
- Never print, commit, upload, or paste the private key or password.

## Important State

Version `0.1.5` introduced the current updater public key. An app older than `0.1.5` may need one manual install because it trusted an older public key whose private key was not available. Future releases signed with the local key above can update automatically from `0.1.5+`.

## Fast Release Path

1. Bump the version consistently in:
   - `package.json`
   - `package-lock.json`
   - `src-tauri/Cargo.toml`
   - `src-tauri/Cargo.lock`
   - `src-tauri/tauri.conf.json`

2. Validate:

```powershell
npm.cmd test
cargo test --manifest-path src-tauri\Cargo.toml
npm.cmd run build
```

3. Build the signed NSIS installer locally. Use `TAURI_SIGNING_PRIVATE_KEY` with the key content, not `TAURI_SIGNING_PRIVATE_KEY_PATH`; the path variable failed here.

```powershell
$privateKey = (Get-Content -LiteralPath "$env:APPDATA\ROXWANA Biblioteca Visual\updater\tauri-updater.key" -Raw).Trim()
$password = (Get-Content -LiteralPath "$env:APPDATA\ROXWANA Biblioteca Visual\updater\tauri-updater-password.txt" -Raw).Trim([char]0xFEFF).Trim()
$env:TAURI_SIGNING_PRIVATE_KEY = $privateKey
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $password
npm.cmd run tauri build -- --ci --bundles nsis
Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
```

4. Prepare release assets. The local build output contains spaces; upload a clean GitHub asset name.

```powershell
$version = "0.1.6"
$assetDir = Join-Path $PWD.Path "src-tauri\target\release\bundle\release-assets-$version"
New-Item -ItemType Directory -Force -Path $assetDir | Out-Null
$sourceExe = Join-Path $PWD.Path "src-tauri\target\release\bundle\nsis\ROXWANA Biblioteca Visual_${version}_x64-setup.exe"
$sourceSig = "$sourceExe.sig"
$assetExeName = "ROXWANA.Biblioteca.Visual_${version}_x64-setup.exe"
$assetExe = Join-Path $assetDir $assetExeName
$assetSig = Join-Path $assetDir "$assetExeName.sig"
Copy-Item -LiteralPath $sourceExe -Destination $assetExe -Force
Copy-Item -LiteralPath $sourceSig -Destination $assetSig -Force
```

5. Generate `latest.json` in Tauri static format. Include both `windows-x86_64-nsis` and `windows-x86_64`. Write UTF-8 without BOM.

```powershell
$signature = (Get-Content -LiteralPath $assetSig -Raw).Trim()
$url = "https://github.com/Lucasleiva1/estampas-roxwana/releases/download/app-v$version/$assetExeName"
$manifest = [ordered]@{
  version = $version
  notes = "Version pre-final con categorias editables, copia de seguridad, random sin repetir y mejoras de visor."
  pub_date = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  platforms = [ordered]@{
    "windows-x86_64-nsis" = [ordered]@{ signature = $signature; url = $url }
    "windows-x86_64" = [ordered]@{ signature = $signature; url = $url }
  }
}
$latestPath = Join-Path $assetDir "latest.json"
$json = $manifest | ConvertTo-Json -Depth 10
[System.IO.File]::WriteAllText((Resolve-Path $latestPath), $json, (New-Object System.Text.UTF8Encoding($false)))
```

6. Commit, tag, and push:

```powershell
git add .github\workflows\release.yml package.json package-lock.json src-tauri\Cargo.toml src-tauri\Cargo.lock src-tauri\tauri.conf.json
git commit -m "Preparar updater firmado $version"
git tag -a "app-v$version" -m "ROXWANA Biblioteca Visual $version pre-final firmado"
git push origin main
git push origin "app-v$version"
```

7. Upload the signed assets. If `gh` is not logged in but `git push` works, use the Git credential token only in `GH_TOKEN`; do not echo it.

```powershell
$inputText = "protocol=https`nhost=github.com`n`n"
$cred = $inputText | git credential fill
$env:GH_TOKEN = ($cred | Where-Object { $_ -match "^password=" }) -replace "^password=", ""
$notes = "Version pre-final con categorias editables, copia de seguridad, random sin repetir y mejoras de visor. Incluye instalador NSIS y latest.json firmado localmente para el updater."
gh release create "app-v$version" -R Lucasleiva1/estampas-roxwana $assetExe $assetSig $latestPath --title "ROXWANA Biblioteca Visual v$version pre-final" --notes $notes --latest
Remove-Item Env:GH_TOKEN -ErrorAction SilentlyContinue
```

If the release already exists, use:

```powershell
gh release upload "app-v$version" -R Lucasleiva1/estampas-roxwana $assetExe $assetSig $latestPath --clobber
```

## Verification

Always verify all of these before saying it is done:

```powershell
$r = Invoke-WebRequest -Uri "https://github.com/Lucasleiva1/estampas-roxwana/releases/latest/download/latest.json" -Headers @{ "User-Agent" = "Codex" } -UseBasicParsing
$bytes = if ($r.Content -is [byte[]]) { $r.Content } else { [Text.Encoding]::UTF8.GetBytes([string]$r.Content) }
$content = [Text.Encoding]::UTF8.GetString($bytes)
$json = $content | ConvertFrom-Json
"LATEST_STATUS=$($r.StatusCode)"
"first_bytes=$(([byte[]]($bytes | Select-Object -First 3) | ForEach-Object { $_.ToString("X2") }) -join " ")"
"version=$($json.version)"
"platforms=$(([string[]]$json.platforms.PSObject.Properties.Name) -join ",")"
"signature_length=$($json.platforms."windows-x86_64-nsis".signature.Length)"
```

Expected:

- `LATEST_STATUS=200`
- `first_bytes=7B ...` (no UTF-8 BOM)
- `version` equals the release version
- platforms include `windows-x86_64-nsis`
- signature length is nonzero, usually `440`

