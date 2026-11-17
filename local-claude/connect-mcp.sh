#!/usr/bin/env bash
# 把片語接成 Claude Code 的 MCP 連接器。讀 ~/.config/clipnote/config.env 裡的網址和服務權杖，不會印出密碼。
# 用法：bash local-claude/connect-mcp.sh
set -euo pipefail
CONF="${CLIPNOTE_CONFIG_DIR:-$HOME/.config/clipnote}/config.env"
[ -f "$CONF" ] || { echo "找不到 $CONF，請先完成 clipnote-review 的第一次設定"; exit 1; }
get() { grep -E "^$1=" "$CONF" | tail -1 | cut -d= -f2- | sed -e "s/^[\"']//" -e "s/[\"'][[:space:]]*$//" -e 's/[[:space:]]*$//'; }
URL=$(get CLIPNOTE_URL); ID=$(get CF_ACCESS_CLIENT_ID); SECRET=$(get CF_ACCESS_CLIENT_SECRET)
if [ -z "$URL" ] || [ -z "$ID" ] || [ -z "$SECRET" ]; then echo "config.env 缺 CLIPNOTE_URL、CF_ACCESS_CLIENT_ID 或 CF_ACCESS_CLIENT_SECRET"; exit 1; fi
command -v claude >/dev/null || { echo "找不到 claude 指令，請先安裝 Claude Code"; exit 1; }
claude mcp remove --scope user clipnote >/dev/null 2>&1 || true
claude mcp add --transport http --scope user clipnote "${URL%/}/mcp" \
  --header "CF-Access-Client-Id: $ID" --header "CF-Access-Client-Secret: $SECRET" >/dev/null
echo "已加入片語連接器（clipnote）。連線狀態："
claude mcp list 2>/dev/null | grep -i clipnote || echo "（看不到狀態，開 Claude Code 輸入 /mcp 確認）"
