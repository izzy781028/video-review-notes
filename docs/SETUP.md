# 片語 Clipnote 部署教學（含 API 申請）

照順序做，第一次約 1 小時。各家網站的選單名稱偶爾會改，找不到時用頁面上的搜尋，或把畫面截圖給 Claude 看。

> **金鑰保管原則**：下面申請到的每一組 Key、JSON、Secret 都等同密碼。只貼到 Cloudflare 的「祕密」欄位或你電腦上的設定檔，不要貼到對話、Email、LINE。建議先暫存在密碼管理器（例如 1Password、Apple 密碼）。

## 總覽

| # | 要準備的東西 | 用在哪 | 費用 |
|---|---|---|---|
| 1 | Google 服務帳戶 JSON | 讀 Drive 資料夾裡的影片 | 免費 |
| 2 | ElevenLabs API Key | 語音轉文字 | 依用量，少量使用每月幾美元內 |
| 3 | Anthropic API Key | AI 把口語整理成修改指示 | 預付儲值，最低 5 美元 |
| 4 | Cloudflare Pages + D1 | 放網站、後端、資料庫 | 免費方案即可 |
| 5 | Cloudflare Access | 只有你能登入 | 免費（50 人以內） |
| 6 | Resend API Key（選填） | Email 通知 | 免費方案即可 |
| 7 | Cloudflare 服務權杖（選填） | 本機 Claude 連片語 | 免費 |

---

## 0. 準備雲端資料夾

1. 在 Google Drive「我的雲端硬碟」建立資料夾 `片語審片`。
2. 放一支測試影片進去：720p、H.264 的 mp4（Premiere 輸出 H.264、「符合來源 – 中位元速率」再把尺寸改 1280×720 即可）。
3. 打開這個資料夾，複製瀏覽器網址列的網址（`https://drive.google.com/drive/folders/xxxx`），先記著，稍後填 `DRIVE_FOLDER`。

---

## 1. Google 服務帳戶（讓後端讀你的 Drive）

1. 打開 https://console.cloud.google.com/ ，用你的 Google 帳號登入。第一次會要你同意服務條款。
2. 左上角專案選單 →「新增專案」→ 名稱 `clipnote` →「建立」。建立後確認左上角已切換到這個專案。
3. 上方搜尋列輸入 **Google Drive API** → 點進去 →「啟用」。
4. 左側選單「IAM 與管理」→「服務帳戶」→「建立服務帳戶」：
   - 名稱：`clipnote`
   - 「授予這個服務帳戶專案存取權」和「授予使用者存取權」都**跳過**，直接「完成」。
5. 在服務帳戶清單點 `clipnote@clipnote-xxxx.iam.gserviceaccount.com` →「金鑰」分頁 →「新增金鑰」→「建立新的金鑰」→ 選 **JSON** →「建立」。瀏覽器會下載一個 `.json` 檔。
   - 若出現「已停用建立服務帳戶金鑰」（組織政策），代表你用的是公司 Google Workspace 帳號，請改用個人 Gmail 帳號做這一步。
6. 複製服務帳戶的 Email（就是上面那串 `…iam.gserviceaccount.com`）。
7. 回到 Google Drive，在 `片語審片` 資料夾按右鍵 →「共用」→ 貼上服務帳戶 Email → 權限選 **檢視者** → 取消勾選「通知使用者」→「共用」。

完成後你手上有：**JSON 檔**、**資料夾網址**。

### 「片語審片」資料夾權限該怎麼設

| 項目 | 設定 |
|---|---|
| 擁有者 | 你自己的 Google 帳號 |
| 共用對象 | **只加服務帳戶**（`…iam.gserviceaccount.com`），權限 **檢視者** |
| 一般存取權 | **限制**（只有已加入的使用者能開啟），不要用「知道連結的任何人」 |
| 客戶 | **不要**把資料夾或影片共用給客戶，客戶一律用片語的分享連結看片 |
| 剪輯助理（選填） | 要幫你放檔案的人可以加為「編輯者」；他們看得到整個資料夾，只加信任的人 |

- 服務帳戶只需要「檢視者」：片語只讀影片，不會改、不會刪 Drive 上的檔案。
- 客戶打開分享連結時，影片是由片語後端從 Drive 讀出來再傳給他，客戶不會拿到 Drive 網址，也看不到資料夾裡的其他影片。
- 片語只讀 `片語審片` 這一層的影片。`_封存` 等子資料夾會繼承權限，但片語不會列出裡面的檔案。
- 影片移到 `_封存` 或刪除後，這支片的分享連結就打不開了（意見仍保留在資料庫）。客戶還在看的片先不要移。
- 不要把 `專案/` 或整個「我的雲端硬碟」共用給服務帳戶。

---

## 2. ElevenLabs API Key（語音轉文字）

1. 打開 https://elevenlabs.io/ →「Sign up」註冊（可用 Google 登入）。
2. 左下角頭像或左側「Developers」→ **API Keys** →「Create API Key」。
3. 設定：
   - Name：`clipnote`
   - **Restrict Key** 打開，權限只開 **Speech to Text**（其他維持 No Access）。這樣就算外洩也只能用來轉文字。
   - 若有「Credit quota / 使用上限」欄位，可以填一個上限（例如 100000），避免意外大量使用。
4. 「Create」→ 複製出現的 Key（`sk_…` 開頭）。**只會顯示這一次**。
5. 方案：免費方案也能用 Speech to Text，但額度少；常態使用建議升級 Starter 或以上（左側「Subscription」）。

完成後你手上有：**ElevenLabs API Key**。

---

## 3. Anthropic API Key（AI 潤飾）

> Claude.ai 的訂閱（Pro／Max）和 API 是**分開計費**的，要另外儲值。

1. 打開 https://console.anthropic.com/ （也可能會導到 platform.claude.com）→ 註冊並驗證 Email、手機。
2. 第一次進入會請你建立組織（Organization），名稱填你的工作室名稱即可。
3. 左側 **Billing**（帳單）→「Add credits / Buy credits」→ 綁信用卡，先儲值 **5～10 美元**。
   - 建議同時開「Auto reload」關閉，避免自動扣款；之後用量穩定再調整。
4. 左側 **Limits** → 設定每月花費上限（Spend limit），例如 20 美元。超過時 API 會停，不會多扣。
5. 左側 **API Keys** →「Create Key」→ 名稱 `clipnote` → 「Add」→ 複製 Key（`sk-ant-…` 開頭）。**只會顯示這一次**。

用量參考：每次 AI 潤飾只處理一則意見，費用很低；一支片 30 則意見大約幾美分到十幾美分。片語預設用最新的 Claude 模型，之後可在片語「設定」改成較便宜的模型。

完成後你手上有：**Anthropic API Key**。

---

## 4. Cloudflare Pages + D1（網站、後端、資料庫）

1. 打開 https://dash.cloudflare.com/sign-up 註冊（免費）。
2. **建立資料庫**：左側「Storage & Databases」（或「Workers & Pages」）→ **D1 SQL Database** →「Create」→ 名稱 `clipnote` → 建立。資料表片語會自己建，不用手動。
3. **建立網站**：左側「Workers & Pages」→「Create」→ **Pages** 分頁 →「Connect to Git」→ 授權 GitHub → 選 `izzy781028/video-review-notes`：
   - Project name：例如 `clipnote`（網址會是 `clipnote.pages.dev`，記下來）
   - Production branch：`main`
   - Framework preset：**None**
   - Build command：`npm install`
   - Build output directory：`public`
   - 「Save and Deploy」。第一次部署完成後先別打開，還沒設定完。
4. 進 Pages 專案 →「Settings」：
   - **Bindings** →「Add」→ D1 database：Variable name 填 `DB`，選 `clipnote` → Save。
   - **Runtime**（或 Functions）→ Compatibility flags → 加上 `nodejs_compat`。
   - **Variables and Secrets** →「Add」→ Type 一律選 **Secret**（加密），逐一新增：

| 名稱 | 填什麼 |
|---|---|
| `OWNER_EMAILS` | 你登入用的 Email（多個用逗號分隔） |
| `DRIVE_FOLDER` | 第 0 步的資料夾網址 |
| `GOOGLE_SERVICE_ACCOUNT` | 用文字編輯器打開第 1 步的 JSON 檔，**全選整份內容**貼上 |
| `ELEVENLABS_API_KEY` | 第 2 步的 Key |
| `ANTHROPIC_API_KEY` | 第 3 步的 Key |
| `GUEST_DAILY_LIMIT` | （選填）外部人員每天語音／AI 次數，不填就是 50 |

   `ACCESS_TEAM_DOMAIN`、`ACCESS_AUD` 下一步才拿得到。

---

## 5. Cloudflare Access（只有你能登入）

1. Cloudflare 左側 **Zero Trust**。第一次會請你：
   - 取團隊名稱（例如 `izzy`，之後網域就是 `https://izzy.cloudflareaccess.com`）
   - 選 **Free** 方案（可能要綁卡，但不會扣款）
2. **登入方式**：Zero Trust →「Settings」→「Authentication」→ Login methods →「Add new」→ **One-time PIN** → Save。
3. **保護整個網站**：「Access」→「Applications」→「Add an application」→ **Self-hosted**：
   - Application name：`片語`
   - Session duration：**1 month**
   - Domain：`clipnote.pages.dev`（你的網址），路徑留空
   - Policy：名稱 `owner`，Action **Allow**，Include → **Emails** → 你的 Email
   - 儲存後，在這個應用程式的「Overview」複製 **Application Audience (AUD) Tag**。
4. **開放分享連結**：再「Add an application」→ **Self-hosted**：
   - Application name：`片語分享`
   - Domain：`clipnote.pages.dev`，Path：`s`
   - Policy：名稱 `public`，Action **Bypass**，Include → **Everyone**
5. 回 Pages 專案的「Variables and Secrets」新增兩個 Secret：
   - `ACCESS_TEAM_DOMAIN`：`https://<團隊名稱>.cloudflareaccess.com`
   - `ACCESS_AUD`：第 3 點複製的 AUD Tag
6. Pages 專案 →「Deployments」→ 最新一筆右邊「⋯」→ **Retry deployment**，讓所有設定生效。

---

## 6. 測試

1. 打開 `https://clipnote.pages.dev` → 輸入你的 Email → 收信填驗證碼。
2. 應該看到 `片語審片` 裡的影片。看不到時：
   - 「找不到資料夾／403」→ 第 1 步第 7 點的共用沒做，或共用到別的資料夾。
   - 「invalid_grant / 金鑰錯誤」→ `GOOGLE_SERVICE_ACCOUNT` 沒有貼完整 JSON。
3. 打開影片 → 暫停 → 打字留一則意見。
4. 按麥克風講一句話 → 確認轉出繁體中文（測 ElevenLabs）。
5. 按「AI 潤飾」→ 確認有整理結果（測 Anthropic）。錯誤訊息有 `credit balance` 代表還沒儲值。
6. 匯出 Word 和 PDF 看版面。
7. 按「分享給外部審片」→ 複製連結 → 用另一支手機、不要登入打開 → 只看得到這一支影片。
8. 手機打開網站 → 分享 →「加入主畫面」，之後就像 App 一樣開。

---

## 7.（選填）Email 通知：Resend

不設也可以，通知會出現在片語上方。想同時收 Email：

1. https://resend.com/ 註冊，**用 `OWNER_EMAILS` 的第一個 Email**（未驗證網域時只能寄給註冊信箱）。
2. 左側「API Keys」→「Create API Key」→ 名稱 `clipnote`，Permission 選 **Sending access** → 複製 Key（`re_…`）。
3. Pages 新增 Secret `RESEND_API_KEY`，然後 Retry deployment。

---

## 8.（選填）本機 Claude

讓電腦上的 Claude 自動把輸出的影片放進審片資料夾、讀新意見。

1. **服務權杖**：Zero Trust →「Access」→「Service Auth」→「Service Tokens」→「Create Service Token」→ 名稱 `local-claude`，期限選 Non-expiring 或 1 年 → 複製 **Client ID** 和 **Client Secret**（Secret 只顯示一次）。
2. Access →「Applications」→ 打開 `片語`（不是 `片語分享`）→「Policies」→「Add a policy」：名稱 `local-claude`，Action **Service Auth**，Include → **Service Token** → `local-claude` → 儲存。
3. Pages 新增 Secret `ACCESS_SERVICE_TOKEN_ID` = Client ID → Retry deployment。
4. 安裝 **Google Drive 電腦版**（https://www.google.com/drive/download/），登入後確認 `片語審片` 在電腦上看得到。
5. 在終端機（repo 資料夾裡）執行：
   ```bash
   mkdir -p ~/.claude/skills ~/.config/clipnote
   cp -r local-claude/clipnote-review ~/.claude/skills/
   cp local-claude/clipnote-review/config.env.example ~/.config/clipnote/config.env
   chmod 600 ~/.config/clipnote/config.env
   open -e ~/.config/clipnote/config.env   # macOS，用文字編輯開啟
   ```
6. 填入片語網址、Client ID、Client Secret、`片語審片` 在電腦上的路徑，存檔。
7. 測試：`python3 ~/.claude/skills/clipnote-review/clipnote.py check`，看到「片語連線 ✓」「雲端資料夾 ✓」就完成。
8. 要轉 720p 審片檔需要 ffmpeg：macOS 執行 `brew install ffmpeg`。

---

## 之後要換 Key 怎麼做

- Key 外洩或想更換：到原本申請的網站刪掉舊 Key、建新 Key → 到 Pages「Variables and Secrets」編輯對應的值 → Retry deployment。
- 不用改程式，也不用通知客戶，分享連結照常可用。
