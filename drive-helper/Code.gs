// 片語 Clipnote — Drive 刪除小幫手（Google Apps Script，以你的身分執行）
// 片語按「刪除」時會呼叫這裡，把「片語審片」資料夾第一層的影片移到 Google Drive 垃圾桶（30 天內可救回）。
// 片語「上傳影片」時，這裡用你的身分開一個 Drive 上傳通道，影片再由片語分段傳進「片語審片」資料夾。
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
    if (req.action === 'upload') return out(startUpload(req, folder));
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

// a resumable upload session in the review folder (or replacing one video there, keeping its file id)
function startUpload(req, folder) {
  const name = String(req.name || '').trim(), size = Number(req.size), mime = /^video\/[\w.+-]+$/.test(req.mime || '') ? req.mime : 'video/mp4';
  if (!/\.(mp4|mov|m4v)$/i.test(name) || /[\/\\]/.test(name) || name.length > 200) return { ok: false, error: '檔名要是 .mp4、.mov 或 .m4v' };
  if (!(size > 0)) return { ok: false, error: '檔案大小不對' };
  let url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,name';
  let method = 'post', meta = { name: name, parents: [FOLDER_ID], mimeType: mime };
  if (req.replaceId) {
    const file = DriveApp.getFileById(String(req.replaceId));
    let inFolder = false;
    for (const ps = file.getParents(); ps.hasNext();) if (ps.next().getId() === FOLDER_ID) inFolder = true;
    if (!inFolder) return { ok: false, error: '要覆蓋的檔案不在「' + folder.getName() + '」資料夾裡' };
    url = 'https://www.googleapis.com/upload/drive/v3/files/' + file.getId() + '?uploadType=resumable&supportsAllDrives=true&fields=id,name';
    method = 'patch'; meta = {};
  }
  const r = UrlFetchApp.fetch(url, { method: method, contentType: 'application/json; charset=UTF-8', payload: JSON.stringify(meta), muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), 'X-Upload-Content-Type': mime, 'X-Upload-Content-Length': String(size) } });
  if (r.getResponseCode() !== 200) return { ok: false, error: 'Drive 拒絕上傳：' + r.getContentText().slice(0, 200) };
  const h = r.getHeaders();
  return { ok: true, session: h.Location || h.location };
}

// 第一次部署或更新後，若片語說「需要授權」，在編輯器上方選這個函式按「執行」，允許存取即可。
function authorize() {
  DriveApp.getFolderById(FOLDER_ID).getName();
  UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/about?fields=user', { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
}

function out(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
