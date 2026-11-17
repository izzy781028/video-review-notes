# 把片語接成 Claude Code 的 MCP 連接器（Windows）。讀 ~/.config/clipnote/config.env，不會印出密碼。
# 用法：powershell -ExecutionPolicy Bypass -File local-claude\connect-mcp.ps1
$dir = if ($env:CLIPNOTE_CONFIG_DIR) { $env:CLIPNOTE_CONFIG_DIR } else { Join-Path $HOME '.config\clipnote' }
$conf = Join-Path $dir 'config.env'
if (-not (Test-Path $conf)) { Write-Host "找不到 $conf，請先完成 clipnote-review 的第一次設定"; exit 1 }
function Get-Conf($k) { $l = Get-Content $conf -Encoding UTF8 | Where-Object { $_ -match "^$k=" } | Select-Object -Last 1
  if ($l) { ($l -replace "^$k=", '').Trim().Trim('"', "'") } else { '' } }
$url = Get-Conf 'CLIPNOTE_URL'; $id = Get-Conf 'CF_ACCESS_CLIENT_ID'; $secret = Get-Conf 'CF_ACCESS_CLIENT_SECRET'
if (-not $url -or -not $id -or -not $secret) { Write-Host 'config.env 缺 CLIPNOTE_URL、CF_ACCESS_CLIENT_ID 或 CF_ACCESS_CLIENT_SECRET'; exit 1 }
claude mcp remove --scope user clipnote *> $null
claude mcp add --transport http --scope user clipnote ($url.TrimEnd('/') + '/mcp') --header "CF-Access-Client-Id: $id" --header "CF-Access-Client-Secret: $secret" *> $null
Write-Host '已加入片語連接器（clipnote）。連線狀態：'
claude mcp list 2>$null | Select-String clipnote
