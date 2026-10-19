#!/usr/bin/env python3
"""片語 Clipnote helper for the local Claude: read review notes, mark them done,
and put review copies into the synced Google Drive folder.

Config: ~/.config/clipnote/config.env (or the same names as environment variables)
  CLIPNOTE_URL             https://<project>.pages.dev
  CF_ACCESS_CLIENT_ID      Cloudflare Access service token: Client ID
  CF_ACCESS_CLIENT_SECRET  Cloudflare Access service token: Client Secret
  CLIPNOTE_DRIVE_DIR       local path of the synced Drive review folder (Google Drive for desktop)

Commands (run with --help for options):
  check | videos | inbox [--all] | ack | notes VIDEO | done VIDEO NOTE [--undo]
  decide VIDEO NOTE accept|adjust|reject [--note TEXT]
  upload FILE [--name NAME] [--proxy] | wait NAME | shot VIDEO NOTE [-o FILE]
"""
import argparse, base64, json, os, re, shutil, subprocess, sys, time, urllib.error, urllib.parse, urllib.request
from pathlib import Path

CONF_DIR = Path(os.environ.get('CLIPNOTE_CONFIG_DIR', Path.home() / '.config' / 'clipnote'))
STATE = CONF_DIR / 'state.json'
STATUS = {'review': '待審', 'changes': '需要修改', 'approved': '已核准'}
DECISION = {'accept': '照改', 'adjust': '改法調整', 'reject': '不改'}
FPS = {'23.976': (24000 / 1001, 24), '24': (24, 24), '25': (25, 25), '29.97': (30000 / 1001, 30),
       '30': (30, 30), '50': (50, 50), '59.94': (60000 / 1001, 60), '60': (60, 60)}
NAME_RULE = re.compile(r'^\d{8}_[^/\\]+_v\d+\.(mp4|mov|m4v)$', re.I)


def die(msg):
    print('✗ ' + msg, file=sys.stderr)
    sys.exit(1)


def config():
    conf = {}
    f = CONF_DIR / 'config.env'
    if f.exists():
        for line in f.read_text(encoding='utf-8').splitlines():
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                conf[k.strip()] = v.strip().strip('"').strip("'")
    for k in ('CLIPNOTE_URL', 'CF_ACCESS_CLIENT_ID', 'CF_ACCESS_CLIENT_SECRET', 'CLIPNOTE_DRIVE_DIR', 'CLIPNOTE_TEST_JWT'):
        if os.environ.get(k):
            conf[k] = os.environ[k]
    return conf


def api(conf, path, method='GET', body=None):
    if not conf.get('CLIPNOTE_URL'):
        die(f'還沒設定 CLIPNOTE_URL，請編輯 {CONF_DIR / "config.env"}')
    headers = {'accept': 'application/json'}
    if conf.get('CLIPNOTE_TEST_JWT'):  # local testing only
        headers['cf-access-jwt-assertion'] = conf['CLIPNOTE_TEST_JWT']
    else:
        if not (conf.get('CF_ACCESS_CLIENT_ID') and conf.get('CF_ACCESS_CLIENT_SECRET')):
            die('還沒設定 CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET（Cloudflare 服務權杖）')
        headers['CF-Access-Client-Id'] = conf['CF_ACCESS_CLIENT_ID']
        headers['CF-Access-Client-Secret'] = conf['CF_ACCESS_CLIENT_SECRET']
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers['content-type'] = 'application/json'
    req = urllib.request.Request(conf['CLIPNOTE_URL'].rstrip('/') + '/api' + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
    except urllib.error.HTTPError as e:
        text = e.read().decode('utf-8', 'replace')
        try:
            msg = json.loads(text).get('error', text)
        except ValueError:
            msg = '登入被 Cloudflare Access 擋下，請檢查服務權杖和 Access 政策' if '<html' in text.lower() else text[:200]
        die(f'{e.code}：{msg}')
    except urllib.error.URLError as e:
        die(f'連不到片語：{e.reason}')
    try:
        return json.loads(raw)
    except ValueError:
        die('片語回傳的不是資料（可能被 Cloudflare Access 導到登入頁），請檢查服務權杖設定')


def load_state():
    try:
        return json.loads(STATE.read_text())
    except (OSError, ValueError):
        return {}


def save_state(s):
    CONF_DIR.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(s))


def timecode(note, fps='29.97', start='00:00:00:00'):
    if note.get('general'):
        return '整體意見'
    rate, tb = FPS.get(fps, FPS['29.97'])
    m = re.match(r'^(\d+):(\d+):(\d+)[:;](\d+)$', start or '')
    offset = ((int(m[1]) * 60 + int(m[2])) * 60 + int(m[3])) * tb + int(m[4]) if m else 0

    def tc(frame, t):
        frame = (int((t or 0) * rate + 1e-4) if frame is None else frame) + offset
        return f'{frame // (tb * 3600):02d}:{frame // (tb * 60) % 60:02d}:{frame // tb % 60:02d}:{frame % tb:02d}'
    out = tc(note.get('frame'), note.get('t'))
    if note.get('frame2') is not None or note.get('t2') is not None:  # a range note
        out += ' → ' + tc(note.get('frame2'), note.get('t2'))
    return out


def find_video(conf, key):
    files = api(conf, '/videos')['files']
    hits = [f for f in files if f['id'] == key] or [f for f in files if key.lower() in f['name'].lower()]
    if not hits:
        die(f'找不到影片「{key}」。用 videos 指令看清單')
    if len(hits) > 1:
        die('有多支影片符合，請寫得更完整：\n' + '\n'.join('  ' + f['name'] for f in hits))
    return hits[0]


# carried-over notes keep their original author in origAuthor
is_client = lambda n: str(n.get('origAuthor') or n.get('author', 'owner')).startswith('share:')
SHAPES = {'arrow': '箭頭', 'box': '方框', 'pen': '手繪線'}


def print_note(n, fps, start, show_new=False):
    mark = '🆕 ' if show_new and n.get('new') else ''
    pt = f"（畫面位置 x{n['pt']['x']:.0%} y{n['pt']['y']:.0%}）" if n.get('pt') else ''
    if n.get('shapes'):
        pt += '（畫面上有' + '、'.join(dict.fromkeys(SHAPES.get(s.get('type'), '標記') for s in n['shapes'])) + '，用 shot 看截圖）'
    who = f"客戶：{n.get('by') or '外部審片'}" if is_client(n) else '你'
    cat = f"[{n['cat']}] " if n.get('cat') else ''  # older notes may still have a category
    print(f"  - {mark}[{timecode(n, fps, start)}] {cat}{who}{pt}  id={n['id']}")
    for line in str(n.get('text', '')).splitlines():
        print(f'      {line}')
    if n.get('raw') and n['raw'] != n.get('text'):
        print(f"      （原始口述：{n['raw'].replace(chr(10), ' ')}）")
    if n.get('carried'):
        print(f"      （從 v{n['carried'].get('v', '?')} 帶入，時間碼可能已隨剪接變動，請對照新版）")
    if n.get('decision'):
        print(f"      → 你的決定：{DECISION.get(n['decision'], n['decision'])}" + (f"：{n['decisionNote']}" if n.get('decisionNote') else ''))
    for r in n.get('replies') or []:
        print(f"      ↳ {r.get('by') or '你'}：{str(r.get('text', '')).replace(chr(10), ' ')}")


# ---------------- commands ----------------
def cmd_check(conf, a):
    print('設定檔：', CONF_DIR / 'config.env', '（存在）' if (CONF_DIR / 'config.env').exists() else '（不存在）')
    d = conf.get('CLIPNOTE_DRIVE_DIR')
    print('雲端資料夾：', d or '（未設定）', '✓' if d and Path(d).is_dir() else '✗ 找不到這個資料夾')
    if not d:
        for c in guess_drive_dirs():
            print('  可能是：', c)
    files = api(conf, '/videos')['files']
    print(f'片語連線 ✓，資料夾裡有 {len(files)} 支影片')


def guess_drive_dirs():
    roots = list((Path.home() / 'Library' / 'CloudStorage').glob('GoogleDrive-*')) + [Path('G:/'), Path('/Volumes/GoogleDrive')]
    out = []
    for r in roots:
        for sub in ('我的雲端硬碟', 'My Drive'):
            p = r / sub / '片語審片'
            if p.is_dir():
                out.append(str(p))
    return out


def cmd_videos(conf, a):
    files = api(conf, '/videos')['files']
    if a.json:
        return print(json.dumps(files, ensure_ascii=False, indent=2))
    for f in files:
        extra = f"，{f['fresh']} 則新的外部意見" if f.get('fresh') else ''
        print(f"- {f['name']}  [{STATUS.get(f.get('status'), '待審')}]  {f.get('notes', 0)} 則意見{extra}  id={f['id']}")


def cmd_inbox(conf, a):
    state = load_state()
    since = state.get('since', 0)
    res = api(conf, '/inbox?since=' + str(since))
    state['pending'] = res['now']
    save_state(state)
    if a.json:
        return print(json.dumps(res, ensure_ascii=False, indent=2))
    videos = res['videos'] if a.all else [v for v in res['videos'] if v['new'] or (v.get('statusAt') or 0) > since]
    when = time.strftime('%m/%d %H:%M', time.localtime(since / 1000)) if since else '第一次檢查'
    if not videos:
        return print(f'沒有新的審片意見（上次確認：{when}）。')
    print(f'所有未完成的意見（🆕 = {when}之後新增或修改）：\n' if a.all else f'上次確認：{when}。有新動態的影片 {len(videos)} 支：\n')
    for v in videos:
        status = STATUS.get(v['status'], '待審') + (f"（{v['statusBy']}）" if v.get('statusBy') else '')
        print(f"■ {v['name']}  [{status}]  未完成 {v['open']} 則，新 {v['new']} 則  id={v['id']}")
        shown = [n for n in v['notes'] if a.all or n.get('new')]  # default: only what changed since the last confirmation
        mine, clients = [n for n in shown if not is_client(n)], [n for n in shown if is_client(n)]
        if mine:
            print('  你的意見（直接照做）：')
            for n in mine:
                print_note(n, v['fps'], v['startTc'], show_new=a.all)
        if clients:
            print('  客戶意見（請使用者逐則決定：照改／改法調整／不改）：')
            for n in clients:
                print_note(n, v['fps'], v['startTc'], show_new=a.all)
        print()
    print('→ 你的意見直接排進待辦；客戶意見逐則請使用者決定，用 `clipnote.py decide` 記下。確認完執行 `clipnote.py ack`；改好的用 `clipnote.py done` 標記。')


def cmd_ack(conf, a):
    state = load_state()
    if not state.get('pending'):
        die('還沒執行過 inbox')
    state['since'] = state.pop('pending')
    save_state(state)
    print('已記下：這次之前的意見都確認過了。')


def cmd_notes(conf, a):
    v = find_video(conf, a.video)
    res = api(conf, f"/videos/{urllib.parse.quote(v['id'])}")
    notes = sorted(res['notes'], key=lambda n: -1 if n.get('general') else n.get('t', 0))
    if a.json:
        for n in notes:
            n.pop('thumb', None)
        return print(json.dumps({'video': v, 'info': res['info'], 'notes': notes}, ensure_ascii=False, indent=2))
    info = res['info']
    print(f"■ {v['name']}  [{STATUS.get(info.get('status'), '待審')}]  共 {len(notes)} 則")
    for n in notes:
        if a.open and n.get('done'):
            continue
        print_note(n, info.get('fps', '29.97'), info.get('startTc', '00:00:00:00'))
        if n.get('done'):
            print('      ✓ 已修改')


def cmd_done(conf, a):
    v = find_video(conf, a.video)
    r = api(conf, f"/videos/{urllib.parse.quote(v['id'])}/notes/{urllib.parse.quote(a.note)}", 'PATCH', {'done': not a.undo})
    print(('✓ 已標記為已修改' if r['done'] else '已改回未完成') + f'：{a.note}')


def cmd_decide(conf, a):
    if a.decision in ('adjust', 'reject') and not a.note_text:
        die('「改法調整」和「不改」請用 --note 寫下使用者說的改法或理由')
    v = find_video(conf, a.video)
    r = api(conf, f"/videos/{urllib.parse.quote(v['id'])}/notes/{urllib.parse.quote(a.note)}", 'PATCH',
            {'decision': a.decision, 'decisionNote': a.note_text or ''})
    print(f"✓ 記下決定：{DECISION[r['decision']]}" + (f"：{a.note_text}" if a.note_text else '') + f'（{a.note}）')


def cmd_shot(conf, a):
    v = find_video(conf, a.video)
    note = next((n for n in api(conf, f"/videos/{urllib.parse.quote(v['id'])}")['notes'] if n['id'] == a.note), None)
    if not note or not str(note.get('thumb', '')).startswith('data:image/'):
        die('這則意見沒有截圖')
    out = Path(a.output or f'{a.note}.jpg')
    out.write_bytes(base64.b64decode(note['thumb'].split(',', 1)[1]))
    print(f'截圖存到 {out}')


def probe(path):
    if not shutil.which('ffprobe'):
        return None
    try:
        r = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height',
                            '-of', 'json', str(path)], capture_output=True, text=True, timeout=60)
        return (json.loads(r.stdout).get('streams') or [None])[0]
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None


def cmd_upload(conf, a):
    src = Path(a.file).expanduser()
    if not src.is_file():
        die(f'找不到檔案 {src}')
    drive = Path(conf.get('CLIPNOTE_DRIVE_DIR', '')).expanduser()
    if not conf.get('CLIPNOTE_DRIVE_DIR') or not drive.is_dir():
        die('CLIPNOTE_DRIVE_DIR 沒設定或找不到。請在 config.env 填 Google Drive 電腦版同步的「片語審片」資料夾路徑')
    name = a.name or src.name
    if a.proxy:
        name = re.sub(r'\.\w+$', '.mp4', name)
    if not NAME_RULE.match(name):
        die(f'檔名「{name}」不符合規則：YYYYMMDD_專案_內容_v版本.mp4，例如 20261018_夏日新品_形象片_v2.mp4。用 --name 指定')
    dest = drive / name
    if dest.exists():
        die(f'雲端資料夾已經有「{name}」。新版本請把版本號加一（v{int(re.search(r"_v(\d+)", name)[1]) + 1}），不要覆蓋舊檔')
    info = probe(src)
    if not a.proxy and info and (info.get('codec_name') != 'h264' or max(info.get('width', 0), info.get('height', 0)) > 1920):
        print(f"⚠ 這個檔案是 {info.get('codec_name')} {info.get('width')}x{info.get('height')}，瀏覽器可能播不順或播不了。建議加 --proxy 轉成 720p 審片檔。")
    if a.proxy:
        if not shutil.which('ffmpeg'):
            die('需要 ffmpeg 才能轉審片檔（macOS：brew install ffmpeg）')
        tmp = dest.with_suffix('.part.mp4')
        vf = "scale='if(gt(iw,ih),-2,720)':'if(gt(iw,ih),720,-2)'"
        cmd = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-stats', '-i', str(src), '-vf', vf, '-c:v', 'libx264', '-preset', 'medium',
               '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-y', str(tmp)]
        print('轉檔中（720p H.264）…')
        if subprocess.run(cmd).returncode != 0:
            tmp.unlink(missing_ok=True)
            die('轉檔失敗')
        tmp.rename(dest)  # rename at the end so Drive never syncs a half-written file
    else:
        shutil.copy2(src, dest)
    print(f'✓ 放進雲端資料夾：{dest}')
    print('  Google Drive 同步完成後就會出現在片語。可以用 `clipnote.py wait "%s"` 等它出現。' % name)


def cmd_wait(conf, a):
    deadline = time.time() + a.minutes * 60
    while time.time() < deadline:
        hit = next((f for f in api(conf, '/videos')['files'] if f['name'] == a.name), None)
        if hit:
            return print(f"✓ 片語已經看得到「{a.name}」（id={hit['id']}）")
        time.sleep(20)
    die(f'{a.minutes} 分鐘內還沒同步上去。檢查 Google Drive 電腦版是否在同步')


def main():
    p = argparse.ArgumentParser(description='片語 Clipnote：讀審片意見、上傳審片檔')
    sub = p.add_subparsers(dest='cmd', required=True)
    sub.add_parser('check', help='檢查設定與連線')
    s = sub.add_parser('videos', help='列出資料夾裡的影片'); s.add_argument('--json', action='store_true')
    s = sub.add_parser('inbox', help='上次確認之後的新意見'); s.add_argument('--all', action='store_true', help='列出所有未完成意見')
    s.add_argument('--json', action='store_true')
    sub.add_parser('ack', help='記下這次的意見都確認過了')
    s = sub.add_parser('notes', help='一支影片的所有意見'); s.add_argument('video'); s.add_argument('--open', action='store_true'); s.add_argument('--json', action='store_true')
    s = sub.add_parser('done', help='標記一則意見已修改'); s.add_argument('video'); s.add_argument('note'); s.add_argument('--undo', action='store_true')
    s = sub.add_parser('decide', help='記下使用者對客戶意見的決定'); s.add_argument('video'); s.add_argument('note')
    s.add_argument('decision', choices=['accept', 'adjust', 'reject']); s.add_argument('--note', dest='note_text', help='改法或不改的理由')
    s = sub.add_parser('shot', help='存下一則意見的截圖'); s.add_argument('video'); s.add_argument('note'); s.add_argument('-o', '--output')
    s = sub.add_parser('upload', help='把審片檔放進雲端資料夾'); s.add_argument('file'); s.add_argument('--name'); s.add_argument('--proxy', action='store_true')
    s = sub.add_parser('wait', help='等檔案同步到片語'); s.add_argument('name'); s.add_argument('--minutes', type=int, default=10)
    a = p.parse_args()
    conf = config()
    globals()['cmd_' + a.cmd](conf, a)


if __name__ == '__main__':
    main()
