# 片語 Clipnote

**暫停，說一句，修改就對齊。**

給自己和客戶用的審片工具：播放影片，看到要改的地方，用說的或打字留言，自動記下時間碼和截圖，AI 把口語整理成剪接師看得懂的修改指示，最後匯出含截圖的修改文件或 Premiere 標記。

## 兩種用法

| | 雲端版（Cloudflare，推薦） | 單機版（GitHub Pages／直接開檔案） |
|---|---|---|
| 網址 | `https://<你的專案>.pages.dev` | https://izzy781028.github.io/video-review-notes/ |
| 登入 | 你用 Email 驗證碼登入，最長 1 個月不用重登 | 不用登入 |
| API Key | 只存在伺服器上，任何人都看不到 | 每台裝置的瀏覽器各自填 |
| 影片 | Google Drive 私人資料夾 | 本機檔案、Dropbox、公開的 Drive 資料夾 |
| 分享給客戶 | ✅ 一個連結只開一支影片 | ✗ |
| 意見同步 | ✅ 雲端儲存，換裝置也看得到 | 只存在這個瀏覽器 |

同一份程式：網頁會自己判斷有沒有雲端後端，沒有就用單機版。

## 功能

- **時間碼意見**：暫停的那一格自動記下時間碼和截圖；**點一下畫面**可以用紅圈標出位置。
- **整體意見**：不針對特定時間碼，針對整支片。
- **語音輸入**：繁體中文夾英文，ElevenLabs Scribe v2 辨識，可加專有名詞；結果自動轉台灣繁體用語。
- **AI 潤飾**：Claude 把口語整理成「改哪裡、改成什麼」，不清楚的地方標【待確認】，原話保留可換回。
- **審核狀態**：每支影片「待審／需要修改／已核准」，客戶按一下就通知你。
- **分享給外部審片**：每次分享產生一組隨機密碼夾在連結裡，對方點開就能看；只看得到指定的那一支影片，也只看得到自己的意見。可設有效期限、另加 6 位數密碼、限第一台裝置，隨時取消；看得到對方何時、用什麼裝置打開。
- **用量上限**：外部人員每人每天語音／AI 共 50 次（可調），用完會暫停並通知你，可一鍵再加。
- **匯出**：Word（每個時間碼配截圖）、HTML／PDF、Excel／CSV、Premiere 標記 XML、SRT、JSON。
- **亮色／暗色**、手機介面、第一次使用的教學（右上「？」可再看）。

快捷鍵：`Space` 播放/暫停、`V` 語音、`Enter` 文字、`G` 整體意見、`←` `→` 逐格、`Shift + ←/→` 一秒、`[` `]` 上/下一則、`Ctrl/⌘ + Enter` 儲存、`Esc` 取消。

## 雲端版設定（一次性，約 30 分鐘）

### 1. Google：建立服務帳戶，讓後端讀你的 Drive 資料夾

1. 打開 https://console.cloud.google.com/ ，建立或選一個專案。
2. 「API 和服務」→「程式庫」→ 搜尋 **Google Drive API** →「啟用」。
3. 「IAM 與管理」→「服務帳戶」→「建立服務帳戶」，名稱例如 `clipnote`，角色不用設，完成。
4. 點進這個服務帳戶 →「金鑰」→「新增金鑰」→「建立新的金鑰」→ **JSON**，會下載一個 `.json` 檔。這個檔案等同密碼，不要傳給別人。
5. 到 Google Drive，對審片資料夾按「共用」，把服務帳戶的 Email（`clipnote@<專案>.iam.gserviceaccount.com`）加為**檢視者**。資料夾的一般存取權可以改回「限制」（私人）。

### 2. Cloudflare Pages：放網站和後端

1. 註冊 https://dash.cloudflare.com/ （免費）。
2. 「Workers & Pages」→「D1 SQL 資料庫」→「建立」，名稱 `clipnote`。
3. 「Workers & Pages」→「建立」→「Pages」→「連結到 Git」→ 選 `izzy781028/video-review-notes`。
   - 架構預設：**None**
   - 建置命令：`npm install`
   - 建置輸出目錄：`public`
4. 部署完成後，進這個 Pages 專案 →「設定」：
   - 「繫結」→ 新增 **D1 資料庫**：變數名稱 `DB`，選 `clipnote`。
   - 「執行階段」→ 相容性旗標加上 `nodejs_compat`。
   - 「變數和祕密」→ 用「祕密（加密）」類型新增下面的值（第 3 步的兩個 Access 值稍後再補）：

| 名稱 | 內容 |
|---|---|
| `OWNER_EMAILS` | 你的 Email（擁有者，多個用逗號分隔） |
| `DRIVE_FOLDER` | Google Drive 資料夾網址 |
| `GOOGLE_SERVICE_ACCOUNT` | 第 1 步下載的 JSON 檔**整份內容**貼上 |
| `ELEVENLABS_API_KEY` | ElevenLabs API Key |
| `ANTHROPIC_API_KEY` | Anthropic API Key |
| `ACCESS_TEAM_DOMAIN` | 第 3 步的團隊網域，例如 `https://izzy.cloudflareaccess.com` |
| `ACCESS_AUD` | 第 3 步的應用程式 AUD 標籤 |
| `GUEST_DAILY_LIMIT` | （選填）外部人員每天語音／AI 次數，預設 50 |
| `RESEND_API_KEY` | （選填）要 Email 通知時才需要，見下方 |

### 3. Cloudflare Access：只有你能登入，分享連結不用登入

1. Cloudflare 左側「Zero Trust」（第一次會請你取一個團隊名稱，選免費方案）。
2. 「設定」→「驗證」→ 登入方式新增 **One-time PIN**（Email 驗證碼）。
3. 「Access」→「應用程式」→「新增應用程式」→「自行託管」：
   - 網域：`<你的專案>.pages.dev`
   - 工作階段持續時間：**1 個月**
   - 政策：動作「允許」，Include →「電子郵件」→ 你的 Email
   - 建好後在應用程式的「概觀」複製 **應用程式受眾 (AUD) 標籤** → 填到 `ACCESS_AUD`
4. 再「新增應用程式」→「自行託管」（給外部人員的分享連結用）：
   - 網域：`<你的專案>.pages.dev`，路徑：`s`
   - 政策：動作「**略過（Bypass）**」，Include →「所有人」
5. 「設定」→「自訂頁面」可以看到團隊網域 → 填到 `ACCESS_TEAM_DOMAIN`。
6. 回 Pages 專案 →「部署」→ 最新一筆按「重試部署」，讓新的設定生效。

完成後打開 `https://<你的專案>.pages.dev`，輸入 Email、收驗證碼，就會看到 Drive 資料夾裡的影片。

### Email 通知（選填）

不設定也可以：客戶核准、要求修改、次數用完時，工具上方都會跳出通知。想同時收 Email：到 https://resend.com 免費註冊（用你的 `OWNER_EMAILS` 第一個 Email），建立 API Key 填到 `RESEND_API_KEY`。

## 安全設計

- API Key 和服務帳戶金鑰只存在 Cloudflare 的加密變數裡，不會送到任何人的瀏覽器。
- 擁有者的每個請求都會再驗證 Cloudflare Access 的簽章，就算有人繞過登入頁也拿不到資料。
- 分享連結的密碼是 32 個隨機字元；伺服器每次都會檢查「這個連結能不能看這支影片」，只能看指定的那一支，也只能改自己的意見。
- 影片只能是 `DRIVE_FOLDER` 那個資料夾裡的檔案，其他 Drive 檔案一律拒絕。
- 擋不了的：對方錄螢幕。任何線上審片工具都一樣。

## 影片要怎麼放

- 資料夾放 **720p H.264 mp4** 審片小檔（約 3～5 Mbps）。Google 不會轉檔，ProRes 等格式瀏覽器播不了。
- 匯出時加 faststart（Premiere 的 H.264 預設就有），才能邊下載邊播、拖時間軸。
- ffmpeg：`ffmpeg -i 原檔.mov -vf scale=-2:720 -c:v libx264 -crf 23 -c:a aac -b:a 128k -movflags +faststart 審片_720p.mp4`

## 單機版

不架雲端也能用：打開 GitHub Pages 網址或直接開 `public/index.html`，在「⚙ 設定」填 API Key。單機版可以：選本機影片、貼 Dropbox 連結、讀「知道連結的任何人都能檢視」的 Drive 資料夾（加 Google API Key）。意見存在瀏覽器裡，換裝置用 JSON 匯出／匯入。

## 檔案結構

```
public/index.html          前端（單機、擁有者、外部審片三種模式）
public/icons/              App icon
functions/api/[[path]].js  擁有者 API（需 Cloudflare Access 登入）
functions/s/[[path]].js    分享連結頁面與 API
lib/                       後端共用：驗證、Google Drive、語音／AI、資料庫
```

## 限制

- 時間碼以非丟格（NDF）計算；29.97／59.94 的丟格制長片後段會差幾格。
- Cloudflare 免費方案：影片經 Cloudflare 轉送，小團隊審片沒問題；若日後大量外部人員同時看長片，可能需要改用付費方案或其他做法。
