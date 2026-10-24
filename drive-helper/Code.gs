// 片語 Clipnote — Drive 刪除小幫手（Google Apps Script，以你的身分執行）
// 片語按「刪除」時會呼叫這裡，把「片語審片」資料夾第一層的影片移到 Google Drive 垃圾桶（30 天內可救回）。
// 只需要改下面兩行，其他不要動。

const TOKEN = '';      // 通關密碼：和 Cloudflare Pages 的 DRIVE_HELPER_TOKEN 一模一樣（30 個字以上的英數字）
const FOLDER_ID = '';  // 「片語審片」資料夾網址 /folders/ 後面那一串

function doGet() {
  return out({ ok: true, app: 'clipnote-drive-helper', ready: TOKEN.length >= 20 && FOLDER_ID.length > 10 });
}

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    if (TOKEN.length < 20 || req.token !== TOKEN) return out({ ok: false, error: '小幫手的密碼不一致（TOKEN 和 DRIVE_HELPER_TOKEN 要一樣）' });
    const folder = DriveApp.getFolderById(FOLDER_ID);
    if (req.action === 'check') return out({ ok: true, folder: folder.getName() });
    if (req.action !== 'trash') return out({ ok: false, error: '不支援的動作' });

    const file = DriveApp.getFileById(String(req.id));
    let inFolder = false;
    for (const ps = file.getParents(); ps.hasNext();) if (ps.next().getId() === FOLDER_ID) inFolder = true;
    if (!inFolder) return out({ ok: false, error: '這個檔案不在「' + folder.getName() + '」資料夾裡，小幫手不會刪' });
    if (!/^video\//.test(file.getMimeType())) return out({ ok: false, error: '只能刪影片檔' });
    file.setTrashed(true);
    return out({ ok: true, name: file.getName() });
  } catch (err) {
    return out({ ok: false, error: String((err && err.message) || err) });
  }
}

function out(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
