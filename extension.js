const vscode = require('vscode');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const PROVIDERS = {
  groq: {
    label: 'Groq',
    url: 'https://api.groq.com/openai/v1/audio/transcriptions',
    model: 'whisper-large-v3',
    keyHint: 'gsk_…',
    minBilledSec: 10, // Groq は1リクエスト最低10秒として数える
  },
  openai: {
    label: 'OpenAI',
    url: 'https://api.openai.com/v1/audio/transcriptions',
    model: 'gpt-4o-transcribe',
    keyHint: 'sk-…',
    minBilledSec: 0,
  },
};

function provider() {
  const id = PROVIDERS[cfg('provider')] ? cfg('provider') : 'groq';
  return { id, ...PROVIDERS[id], secret: `jpVoice.key.${id}` };
}

let helper = null;
let status = null;
let log = null;
let state = 'idle'; // idle | recording | transcribing
let pressedAt = 0;
let lastText = '';
let ctx = null;
let pendingStop = null;
let pendingSnapshot = null;
let session = 0;
let previewTimer = null;
let previewBusy = false;
let preview = null; // { progress, resolve }
let previewText = ''; // この録音で最後に出た途中表示の文字
let lastRateHeaders = {};
let requestTimes = []; // 直近の送信時刻（1分あたりの上限対策）

function recentRequests() {
  const cut = Date.now() - 60000;
  requestTimes = requestTimes.filter((t) => t > cut);
  return requestTimes.length;
}

const HOTKEY_LABEL = { fn: 'fn', rightOption: '右Option', rightCommand: '右command' };

function cfg(key) {
  return vscode.workspace.getConfiguration('jpVoice').get(key);
}

function setState(s, detail) {
  state = s;
  vscode.commands.executeCommand('setContext', 'jpVoice.recording', s === 'recording');
  if (s === 'recording') {
    status.text = '$(record) 録音中…';
    status.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  } else if (s === 'transcribing') {
    status.text = '$(sync~spin) 文字起こし中…';
    status.backgroundColor = undefined;
  } else {
    status.text = '$(mic) 音声入力';
    status.backgroundColor = undefined;
  }
  status.tooltip = detail || (lastText ? `最後: ${lastText}` : `${HOTKEY_LABEL[cfg('hotkey')] || 'fn'}を押している間だけ録音 / クリックで開始・停止`);
}

function send(line) {
  if (helper) helper.stdin.write(line + '\n');
}

let helperRestarts = [];

function startHelper() {
  const bin = path.join(ctx.extensionPath, 'helper', 'voicehelper');
  const h = cp.spawn(bin, [cfg('hotkey') || 'fn'], { stdio: ['pipe', 'pipe', 'pipe'] });
  helper = h;
  const rl = readline.createInterface({ input: h.stdout });
  rl.on('line', onHelperLine);
  h.stderr.on('data', (d) => log.appendLine('[helper] ' + String(d).trim()));
  h.stdin.on('error', () => {});
  // 起動できない（実行が止められた等）ときに拡張ごと落ちないよう受け止める
  h.on('error', (e) => {
    log.appendLine(`[helper] 起動できません: ${e.message}`);
    vscode.window.showErrorMessage(
      `音声入力: 録音プログラムを起動できません（${e.code || e.message}）。ターミナルで xattr -dr com.apple.quarantine ~/.vscode/extensions/yuukibk.jp-voice-input-* を実行して VSCode を再読み込みしてください。`
    );
  });
  h.on('exit', (code, signal) => {
    if (helper !== h) return; // 意図して止めたもの
    helper = null;
    if (state !== 'idle') {
      endSession();
      setState('idle');
    }
    if (code === 0) return;
    log.appendLine(`[helper] 終了しました code=${code} signal=${signal}`);
    // 落ちたら自動で立ち上げ直す（1分に3回まで）
    const now = Date.now();
    helperRestarts = helperRestarts.filter((t) => t > now - 60000);
    if (helperRestarts.length < 3) {
      helperRestarts.push(now);
      setTimeout(() => { if (!helper) startHelper(); }, 1000);
    } else {
      vscode.window.showErrorMessage('音声入力: 録音プログラムが繰り返し止まりました。出力パネルの「日本語音声入力」の内容を教えてください。');
    }
  });
  send('perm');
}

function onHelperLine(line) {
  const [ev, ...rest] = line.split(' ');
  switch (ev) {
    case 'unstale':
      log.appendLine(`${now()} [key] 矢印キーの印が残っていましたが、fn が押されたので録音します`);
      break;
    case 'stale':
      log.appendLine(`${now()} [key] 矢印キーなどの直後のため、fn の印が消えるまで録音を始めません`);
      break;
    case 'down':
      if (cfg('hotkey') === 'off') return;
      if (!vscode.window.state.focused) {
        log.appendLine(`${now()} [key] fn を検知しましたが、VSCode が前面にないため無視しました`);
        return;
      }
      if (state !== 'idle') {
        log.appendLine(`${now()} [key] fn を検知しましたが、前の処理（${state}）の途中なので無視しました`);
        return;
      }
      log.appendLine(`${now()} [key] fn 押下 → 録音開始`);
      pressedAt = Date.now();
      startRecording();
      break;
    case 'up':
      if (state !== 'recording' || !pressedAt) return;
      log.appendLine(`${now()} [key] fn を離した（${((Date.now() - pressedAt) / 1000).toFixed(1)}秒）`);
      pressedAt = 0;
      stopRecording();
      break;
    case 'abort':
      if (state === 'recording' && pressedAt) {
        log.appendLine(`${now()} [key] fn と一緒にほかのキーが押されたので取り消しました`);
        pressedAt = 0;
        cancelRecording();
      }
      break;
    case 'stopped':
    case 'snapshot': {
      const result = { seconds: parseFloat(rest[0]), file: rest.slice(1).join(' ') };
      const pending = ev === 'stopped' ? pendingStop : pendingSnapshot;
      if (ev === 'stopped') pendingStop = null;
      else pendingSnapshot = null;
      if (pending) pending(result);
      break;
    }
    case 'perm':
      if (rest[0] === 'denied') {
        vscode.window.showErrorMessage(
          '音声入力: マイクが許可されていません。システム設定 → プライバシーとセキュリティ → マイク で「Visual Studio Code」をオンにしてください。'
        );
      }
      break;
    case 'error':
      vscode.window.showErrorMessage('音声入力: ' + rest.join(' '));
      endSession();
      setState('idle');
      break;
  }
}

// helper にコマンドを送り、対応する応答（stopped / snapshot）を待つ
function request(cmd, setPending) {
  return new Promise((resolve) => {
    setPending(resolve);
    send(cmd);
    setTimeout(() => resolve(null), 3000);
  });
}

function tmpWav(kind) {
  return path.join(os.tmpdir(), `jpvoice-${kind}-${Date.now()}.wav`);
}

// MARK: - 途中表示

const STYLES = [
  { id: 'notification', label: '通知', detail: '右下の VSCode 通知に末尾をひっそり表示（初期設定）' },
  { id: 'hud', label: '浮かぶ窓', detail: '画面の上（または下）中央に半透明の窓。全文が折り返して見える' },
  { id: 'panel', label: '専用パネル', detail: '下のパネルの「音声入力」タブに全文を大きく表示' },
];

function style() {
  return STYLES.some((x) => x.id === cfg('previewStyle')) ? cfg('previewStyle') : 'notification';
}

function tail(text, max) {
  return text.length > max ? '…' + text.slice(-max) : text;
}

function hud(mode, text) {
  send(`hud ${mode} ${cfg('hudPosition') === 'bottom' ? 'bottom' : 'top'} ${Buffer.from(text, 'utf8').toString('base64')}`);
}

function openPreview() {
  const st = style();
  if (st === 'hud') {
    hud('rec', '');
  } else if (st === 'notification') {
    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: '🎙' },
      (progress) =>
        new Promise((resolve) => {
          preview = { progress, resolve };
          progress.report({ message: '聞き取り中…' });
        })
    );
  } else if (st === 'panel') {
    panelProvider.post({ type: 'start' });
    panelProvider.reveal();
  }
}

function updatePreview(text) {
  status.tooltip = text;
  const st = style();
  if (st === 'hud') {
    hud('rec', text);
  } else if (st === 'notification' && preview) {
    // 通知は1行に収まらない部分を後ろから切るので、新しく話した末尾だけを短く見せる
    preview.progress.report({ message: tail(text, Math.max(10, cfg('previewChars') || 36)) });
  } else if (st === 'panel') {
    panelProvider.post({ type: 'text', text });
  }
}

function finalizingPreview(text) {
  const st = style();
  if (st === 'hud') hud('final', text || '');
  else if (st === 'notification' && preview) preview.progress.report({ message: '仕上げ中…' });
  else if (st === 'panel') panelProvider.post({ type: 'final' });
}

function closePreview(finalText) {
  const st = style();
  if (st === 'hud') send('hudhide');
  if (preview) preview.resolve();
  preview = null;
  if (st === 'panel') {
    panelProvider.post({ type: 'done', text: finalText || '' });
    // 結果を一瞬見せてからパネルを閉じる（ずっと出しておかない）
    {
      setTimeout(() => {
        if (state === 'idle' && panelProvider.view && panelProvider.view.visible) {
          vscode.commands.executeCommand('workbench.action.closePanel');
        }
      }, 1200);
    }
  }
}

// 下のパネルの「音声入力」タブ
const panelProvider = {
  view: null,
  last: { type: 'idle' },
  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = PANEL_HTML;
    view.onDidDispose(() => (this.view = null));
    setTimeout(() => this.post(this.last), 100);
  },
  post(msg) {
    if (msg.type !== 'start') this.last = msg;
    if (this.view) this.view.webview.postMessage(msg);
  },
  reveal() {
    if (this.view) {
      if (!this.view.visible) this.view.show(true);
    } else {
      vscode.commands.executeCommand('jpVoice.previewView.focus').then(() => vscode.commands.executeCommand('claude-vscode.focus'));
    }
  },
};

const PANEL_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; padding: 14px 18px; font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
  #head { display: flex; align-items: center; gap: 8px; font-size: 11px; font-weight: 600; letter-spacing: .02em;
          color: var(--vscode-descriptionForeground); margin-bottom: 8px; }
  #dot { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-descriptionForeground); opacity: .5; }
  body.rec #dot { background: var(--vscode-errorForeground, #f14c4c); opacity: 1; animation: pulse 1.4s ease-in-out infinite; }
  body.final #dot { background: var(--vscode-progressBar-background, #0e70c0); opacity: 1; }
  @keyframes pulse { 50% { opacity: .25; } }
  #text { font-size: 17px; line-height: 1.7; white-space: pre-wrap; word-break: break-all; }
  body.done #text { color: var(--vscode-descriptionForeground); }
  .hint { color: var(--vscode-descriptionForeground); font-size: 13px; }
</style></head><body>
<div id="head"><span id="dot"></span><span id="label">待機中</span></div>
<div id="text"><span class="hint">fn を押している間に話すと、ここに途中経過が出ます。</span></div>
<script>
  const body = document.body, label = document.getElementById('label'), text = document.getElementById('text');
  function set(cls, l) { body.className = cls; label.textContent = l; }
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'start') { set('rec', '聞き取り中'); text.textContent = '…'; }
    else if (m.type === 'text') { set('rec', '聞き取り中'); text.textContent = m.text; }
    else if (m.type === 'final') { set('final', '仕上げ中…'); }
    else if (m.type === 'done') { set('done', '入力しました'); if (m.text) text.textContent = m.text; }
    window.scrollTo(0, document.body.scrollHeight);
  });
</script></body></html>`;

async function previewTick(sid) {
  if (previewBusy || state !== 'recording' || sid !== session) return;
  // 1分あたりの回数上限（Groq 無料枠は20回）に当たらないよう、最終結果のぶんを残して途中表示を間引く
  if (recentRequests() >= (cfg('previewMaxPerMinute') || 15)) return;
  previewBusy = true;
  try {
    const snap = await request('snapshot ' + tmpWav('preview'), (r) => (pendingSnapshot = r));
    if (!snap || !snap.file) return;
    try {
      if (snap.seconds < 1 || sid !== session || isSilent(snap.file)) return;
      const text = await transcribe(snap.file, 'preview', snap.seconds);
      if (text && sid === session && state === 'recording') {
        previewText = text;
        updatePreview(text);
      }
    } finally {
      fs.unlink(snap.file, () => {});
    }
  } catch (e) {
    log.appendLine(`[preview] ${e.message}`);
    // 上限に当たったらこの録音中は途中表示をやめる（最終結果は試みる）
    if (/\b429\b/.test(e.message)) stopPreviewLoop();
  } finally {
    previewBusy = false;
  }
}

function stopPreviewLoop() {
  if (previewTimer) clearInterval(previewTimer);
  previewTimer = null;
}

function endSession(finalText) {
  session++;
  stopPreviewLoop();
  closePreview(finalText);
}

// MARK: - 録音

function startRecording() {
  session++;
  const sid = session;
  send('start ' + tmpWav('final'));
  previewText = '';
  setState('recording');
  if (cfg('preview')) {
    openPreview();
    const ms = Math.max(1, cfg('previewInterval') || 2) * 1000;
    previewTimer = setInterval(() => previewTick(sid), ms);
  }
}

function cancelRecording() {
  send('cancel');
  endSession();
  setState('idle');
}

async function stopRecording() {
  stopPreviewLoop();
  const result = await request('stop', (r) => (pendingStop = r));
  if (!result || !result.file) {
    log.appendLine(`${now()} [rec] 録音プログラムから結果が返ってきませんでした`);
    notice('録音を受け取れませんでした。もう一度話してください');
    endSession();
    setState('idle');
    return;
  }
  log.appendLine(`${now()} [rec] 録音終了 ${result.seconds.toFixed(1)}秒 最大音量 ${Math.round(peakLevel(result.file))}`);
  if (result.seconds < cfg('minSeconds') || isSilent(result.file)) {
    if (result.seconds >= cfg('minSeconds')) notice('聞き取れませんでした（無音）');
    fs.unlink(result.file, () => {});
    endSession();
    setState('idle');
    return;
  }
  setState('transcribing');
  finalizingPreview(previewText);
  let text = '';
  try {
    text = await transcribeWithRetry(result.file, result.seconds);
    if (text) {
      lastText = text;
      await insertText(text);
    } else {
      notice('聞き取れませんでした。もう一度話してください');
    }
  } catch (e) {
    vscode.window.showErrorMessage('音声入力: ' + e.message);
  } finally {
    fs.unlink(result.file, () => {});
    endSession(text);
    setState('idle');
  }
}

// MARK: - 文字起こし・使用量

// 最終結果は 429（回数上限）なら指定秒数だけ待ってやり直す
async function transcribeWithRetry(file, seconds) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await transcribe(file, 'final', seconds);
    } catch (e) {
      const m = /\b429\b/.test(e.message) && e.message.match(/try again in ([\d.]+)(ms|s)/);
      if (!m || attempt >= 3) throw e;
      const wait = (m[2] === 'ms' ? parseFloat(m[1]) : parseFloat(m[1]) * 1000) + 500;
      log.appendLine(`[final] 429 のため ${(wait / 1000).toFixed(1)}秒待ってやり直し（${attempt + 1}回目）`);
      if (style() === 'hud') hud('final', `混み合っているので ${Math.ceil(wait / 1000)} 秒待って再送します…`);
      else if (preview) preview.progress.report({ message: `混み合っているので ${Math.ceil(wait / 1000)} 秒待って再送します…` });
      await sleep(wait);
    }
  }
}

async function transcribe(file, kind, seconds) {
  const p = provider();
  const key = await ctx.secrets.get(p.secret);
  if (!key) {
    if (kind === 'preview') return '';
    const pick = await vscode.window.showWarningMessage(`${p.label} の APIキーが未設定です。`, 'APIキーを設定');
    if (pick) await setApiKey();
    throw new Error('APIキーを設定してからもう一度話してください');
  }
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(file)], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', cfg('model') || p.model);
  form.append('language', 'ja');
  // prompt は「直前に話された文章」として扱われるので、指示文は書かず用語の列挙だけにする
  // （指示文を書くと、無音のときにそれがそのまま文字起こしとして返ってくる）
  const prompt = buildPrompt();
  if (prompt) form.append('prompt', prompt);

  const t0 = Date.now();
  requestTimes.push(t0);
  const res = await fetch(p.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  const body = await res.text();
  recordUsage(p, kind, seconds, res, Date.now() - t0);
  if (!res.ok) {
    let msg = body;
    try { msg = JSON.parse(body).error.message; } catch {}
    throw new Error(`${p.label} ${res.status}: ${msg}`);
  }
  const text = (JSON.parse(body).text || '').trim();
  if (isHallucination(text, prompt)) {
    log.appendLine(`[${kind}] 無音時の出力とみなして捨てました: ${text}`);
    return '';
  }
  return text;
}

function buildPrompt() {
  const terms = (cfg('vocabulary') || '').split(/[,、，]/).map((t) => t.trim()).filter(Boolean);
  return terms.length ? terms.join('、') + '。' : '';
}

const norm = (t) => t.replace(/[\s、。，．,.!！?？・:：「」『』()（）\-]/g, '').toLowerCase();

// 無音や短い録音のときに Whisper が返しがちな「聞こえていない内容」を見分ける
function isHallucination(text, prompt) {
  if (!text) return true;
  // 定型文
  if (/^(ご視聴ありがとうございました|ありがとうございました|お疲れ様でした)[。.!！]?$/.test(text)) return true;
  // 以前の版の指示文
  if (/句読点を付けた自然な文章/.test(text)) return true;
  // prompt（用語の列挙）をなぞっただけ。用語1語だけなら本当に話した可能性があるので残す
  const t = norm(text);
  const p = norm(prompt || '');
  if (p && t.includes(p)) return true;
  const terms = (cfg('vocabulary') || '').split(/[,、，]/).map((x) => norm(x)).filter(Boolean);
  const hits = terms.filter((x) => t.includes(x)).length;
  if (p && t.length >= 2 && p.includes(t) && hits >= 2) return true;
  return false;
}

// WAV（16bit モノラル）を 50ms ごとに区切り、いちばん大きい区間の音量を返す
function peakLevel(file) {
  try {
    const buf = fs.readFileSync(file);
    const data = buf.subarray(44);
    const win = 800; // 16kHz で 50ms
    let peak = 0;
    for (let off = 0; off + win * 2 <= data.length; off += win * 2) {
      let sum = 0;
      for (let i = 0; i < win; i++) {
        const v = data.readInt16LE(off + i * 2);
        sum += v * v;
      }
      peak = Math.max(peak, Math.sqrt(sum / win));
    }
    return peak;
  } catch (e) {
    return Infinity; // 読めなければ判定しない
  }
}

function isSilent(file) {
  const th = cfg('silenceThreshold');
  if (!th) return false;
  const level = peakLevel(file);
  if (level < th) {
    log.appendLine(`無音とみなして送りませんでした（最大音量 ${Math.round(level)} < ${th}）`);
    return true;
  }
  return false;
}

function now() {
  return new Date().toLocaleTimeString('ja-JP', { hour12: false });
}

// 右下のステータスバーに数秒だけ知らせる
function notice(msg) {
  vscode.window.setStatusBarMessage(`$(info) 音声入力: ${msg}`, 4000);
  log.appendLine(`${now()} [notice] ${msg}`);
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function recordUsage(p, kind, seconds, res, ms) {
  const billed = Math.max(p.minBilledSec, seconds || 0);
  const all = ctx.globalState.get('jpVoice.usage', {});
  const k = `${today()}|${p.id}`;
  const u = all[k] || { requests: 0, preview: 0, final: 0, audioSec: 0, billedSec: 0 };
  u.requests++;
  u[kind]++;
  if (kind === 'final') u.audioSec += seconds || 0;
  u.billedSec += billed;
  all[k] = u;
  // 古い日付は30日分だけ残す
  const keys = Object.keys(all).sort();
  while (keys.length > 60) delete all[keys.shift()];
  ctx.globalState.update('jpVoice.usage', all);

  const rate = {};
  res.headers.forEach((v, h) => { if (h.startsWith('x-ratelimit')) rate[h] = v; });
  if (Object.keys(rate).length) lastRateHeaders = rate;
  log.appendLine(
    `${new Date().toLocaleTimeString()} ${p.label} ${kind} ${res.status} 音声${(seconds || 0).toFixed(1)}秒 → 計上${billed.toFixed(1)}秒 (${ms}ms) ${JSON.stringify(rate)}`
  );
}

function showUsage() {
  const all = ctx.globalState.get('jpVoice.usage', {});
  log.appendLine('');
  log.appendLine('==== 使用量（日別） ====');
  for (const k of Object.keys(all).sort().reverse()) {
    const [date, id] = k.split('|');
    const u = all[k];
    log.appendLine(
      `${date} ${PROVIDERS[id] ? PROVIDERS[id].label : id}: 話した長さ ${fmtSec(u.audioSec)} / 計上 ${fmtSec(u.billedSec)}（${(u.billedSec / Math.max(u.audioSec, 1)).toFixed(1)}倍） / 送信 ${u.requests}回（途中 ${u.preview}・確定 ${u.final}）`
    );
  }
  if (Object.keys(lastRateHeaders).length) {
    log.appendLine('---- 直近の上限ヘッダー ----');
    for (const [h, v] of Object.entries(lastRateHeaders)) log.appendLine(`${h}: ${v}`);
  }
  log.show(true);
}

function fmtSec(s) {
  return s >= 60 ? `${Math.floor(s / 60)}分${Math.round(s % 60)}秒` : `${Math.round(s)}秒`;
}

// MARK: - 入力

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function insertText(text) {
  if (cfg('target') === 'editor') {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      await editor.edit((b) => editor.selections.forEach((s) => b.replace(s, text)));
      return;
    }
  }
  // Claude Code の入力欄（Webview）には直接書き込めないので、クリップボード経由で貼り付ける
  const prev = await vscode.env.clipboard.readText();
  await vscode.env.clipboard.writeText(text);
  await vscode.commands.executeCommand('claude-vscode.focus');
  await sleep(250);
  await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
  await sleep(400);
  await vscode.env.clipboard.writeText(prev);
}

async function chooseStyle() {
  const cur = style();
  const items = STYLES.map((x) => ({ ...x, description: x.id === cur ? '使用中' : '' }));
  const pick = await vscode.window.showQuickPick(items, { placeHolder: '途中表示の見せ方を選んでください' });
  if (!pick) return;
  await vscode.workspace.getConfiguration('jpVoice').update('previewStyle', pick.id, vscode.ConfigurationTarget.Global);
  if (pick.id === 'panel') panelProvider.reveal();
  if (pick.id === 'hud') {
    // どこに出るか見本を一瞬出す
    hud('rec', 'ここに途中経過が出ます（見本）');
    setTimeout(() => send('hudhide'), 2500);
  }
  vscode.window.showInformationMessage(`途中表示: 「${pick.label}」にしました。fn を押して試してください`);
}

async function setApiKey() {
  const p = provider();
  const key = await vscode.window.showInputBox({
    prompt: `${p.label} の APIキー（${p.keyHint}）を貼り付けてください。VSCode の安全な保管庫に保存されます`,
    password: true,
    ignoreFocusOut: true,
  });
  if (key) {
    await ctx.secrets.store(p.secret, key.trim());
    vscode.window.showInformationMessage(`音声入力: ${p.label} の APIキーを保存しました`);
  }
}

// MARK: - 自動更新（GitHub Releases）

const REPO = 'yuukiBK/jp-voice-input';

function newer(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

async function checkUpdate(manual) {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(`GitHub ${res.status}`);
    const rel = await res.json();
    const latest = String(rel.tag_name || '').replace(/^v/, '');
    const current = ctx.extension.packageJSON.version;
    const asset = (rel.assets || []).find((a) => a.name.endsWith('.vsix'));
    if (!asset || !newer(latest, current)) {
      if (manual) vscode.window.showInformationMessage(`日本語音声入力は最新です（${current}）`);
      return;
    }
    const pick = await vscode.window.showInformationMessage(
      `日本語音声入力の新しい版があります（${current} → ${latest}）`,
      '更新する',
      '変更内容'
    );
    if (pick === '変更内容') {
      vscode.env.openExternal(vscode.Uri.parse(rel.html_url));
      return;
    }
    if (pick !== '更新する') return;
    const dl = await fetch(asset.browser_download_url);
    if (!dl.ok) throw new Error(`ダウンロード失敗 ${dl.status}`);
    const file = path.join(os.tmpdir(), asset.name);
    fs.writeFileSync(file, Buffer.from(await dl.arrayBuffer()));
    await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(file));
    const r = await vscode.window.showInformationMessage(`${latest} に更新しました。再読み込みすると反映されます`, '再読み込み');
    if (r) vscode.commands.executeCommand('workbench.action.reloadWindow');
  } catch (e) {
    log.appendLine(`[update] ${e.message}`);
    if (manual) vscode.window.showErrorMessage('更新の確認に失敗しました: ' + e.message);
  }
}

// MARK: - アップデート情報

const CHANGELOG = require('./changelog');

function esc(t) {
  return String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function maybeShowWhatsNew() {
  const current = ctx.extension.packageJSON.version;
  const seen = ctx.globalState.get('jpVoice.lastSeenVersion');
  if (seen === current) return;
  ctx.globalState.update('jpVoice.lastSeenVersion', current);
  // 初めて入れたときは最新の1件、更新したときは見ていない版をまとめて
  const entries = seen ? CHANGELOG.filter((e) => newer(e.version, seen)) : CHANGELOG.slice(0, 1);
  if (entries.length) showWhatsNew(entries);
}

function showWhatsNew(entries) {
  const panel = vscode.window.createWebviewPanel(
    'jpVoice.whatsNew',
    'アップデート情報',
    { viewColumn: vscode.ViewColumn.Active, preserveFocus: true },
    { enableScripts: true }
  );
  panel.iconPath = vscode.Uri.file(path.join(ctx.extensionPath, 'media', 'mic.svg'));
  panel.webview.onDidReceiveMessage((m) => {
    if (m === 'close') panel.dispose();
    if (m === 'history') {
      panel.dispose();
      showWhatsNew(CHANGELOG);
    }
  });
  panel.webview.html = whatsNewHtml(entries);
}

function whatsNewHtml(entries) {
  const tagClass = { NEW: 'new', '改善': 'imp', '修正': 'fix' };
  let i = 0;
  const sections = entries
    .map((e, idx) => {
      const cards = e.items
        .map(
          (it) => `
        <div class="card" style="animation-delay:${0.25 + 0.08 * i++}s">
          <span class="tag ${tagClass[it.tag] || 'new'}">${esc(it.tag)}</span>
          <div class="ct">${esc(it.title)}</div>
          <div class="cb">${esc(it.body)}</div>
        </div>`
        )
        .join('');
      return `
      <section class="${idx === 0 ? 'latest' : 'older'}">
        <div class="ver"><span class="vlabel">Ver.</span>${esc(e.version)}<span class="date">${esc(e.date)}</span></div>
        <h2>${esc(e.title)}</h2>
        <div class="cards">${cards}</div>
      </section>`;
    })
    .join('');
  const showHistory = entries.length < CHANGELOG.length;
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root {
    --bg: #0d0f14; --panel: #161a22; --line: rgba(255,255,255,.08);
    --text: #f2f4f8; --sub: #a3abba; --accent: #ff4d3d; --accent2: #ffb238;
    --new: #ff4d3d; --imp: #3d8bff; --fix: #2fbf71;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
         font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Hiragino Kaku Gothic ProN", sans-serif; }
  .hero { position: relative; overflow: hidden; padding: 44px 32px 36px;
          background: linear-gradient(115deg, #1a0f12 0%, #2a1114 45%, #0d0f14 100%); border-bottom: 1px solid var(--line); }
  .hero::before { content: ""; position: absolute; inset: -50% -10%;
          background: repeating-linear-gradient(115deg, transparent 0 38px, rgba(255,77,61,.07) 38px 76px);
          animation: slide 1s ease-out both; }
  .hero::after { content: ""; position: absolute; left: 0; top: 0; height: 4px; width: 100%;
          background: linear-gradient(90deg, var(--accent), var(--accent2)); transform-origin: left; animation: bar .6s .1s ease-out both; }
  .kicker { position: relative; font-size: 13px; font-weight: 800; letter-spacing: .32em; color: var(--accent2); animation: up .5s ease-out both; }
  .big { position: relative; margin: 6px 0 0; font-size: 52px; font-weight: 900; font-style: italic; letter-spacing: .02em; line-height: 1;
         background: linear-gradient(90deg, #fff, #ffd9d4); -webkit-background-clip: text; background-clip: text; color: transparent;
         animation: punch .55s .1s cubic-bezier(.2,1.4,.4,1) both; }
  .lead { position: relative; margin-top: 12px; color: var(--sub); font-size: 13px; animation: up .5s .2s ease-out both; }
  main { max-width: 760px; margin: 0 auto; padding: 8px 24px 40px; }
  section { padding: 28px 0 8px; border-bottom: 1px solid var(--line); }
  section:last-child { border-bottom: 0; }
  .ver { display: flex; align-items: baseline; gap: 6px; font-size: 30px; font-weight: 900; font-style: italic; }
  .vlabel { font-size: 14px; color: var(--accent); font-style: normal; font-weight: 800; }
  .date { margin-left: auto; font-size: 12px; color: var(--sub); font-style: normal; font-weight: 500; }
  .older .ver { font-size: 22px; color: var(--sub); }
  h2 { margin: 4px 0 18px; font-size: 18px; font-weight: 700; }
  .older h2 { font-size: 15px; color: var(--sub); }
  .cards { display: grid; gap: 12px; }
  .card { position: relative; padding: 16px 18px 16px 18px; background: var(--panel); border: 1px solid var(--line);
          border-radius: 12px; animation: card .45s ease-out both; }
  .card::before { content: ""; position: absolute; left: 0; top: 12px; bottom: 12px; width: 3px; border-radius: 3px; background: var(--c, var(--new)); }
  .card:has(.imp) { --c: var(--imp); } .card:has(.fix) { --c: var(--fix); }
  .tag { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 11px; font-weight: 800; letter-spacing: .08em; color: #fff; }
  .tag.new { background: var(--new); } .tag.imp { background: var(--imp); } .tag.fix { background: var(--fix); }
  .ct { margin-top: 8px; font-size: 16px; font-weight: 700; }
  .cb { margin-top: 6px; font-size: 13.5px; line-height: 1.75; color: var(--sub); }
  .actions { display: flex; gap: 10px; justify-content: center; padding: 8px 24px 44px; }
  button { font: inherit; font-size: 14px; font-weight: 700; padding: 11px 28px; border-radius: 999px; cursor: pointer; border: 1px solid var(--line); }
  .ok { background: linear-gradient(90deg, var(--accent), #ff7a3d); color: #fff; border: 0; }
  .ok:hover { filter: brightness(1.08); }
  .ghost { background: transparent; color: var(--sub); }
  .ghost:hover { color: var(--text); }
  @keyframes slide { from { transform: translateX(-12%); opacity: 0; } }
  @keyframes bar { from { transform: scaleX(0); } }
  @keyframes up { from { transform: translateY(8px); opacity: 0; } }
  @keyframes punch { from { transform: scale(1.35) skewX(-8deg); opacity: 0; } }
  @keyframes card { from { transform: translateY(10px); opacity: 0; } }
  @media (max-width: 520px) { .hero { padding: 32px 20px 26px; } .big { font-size: 38px; } main { padding: 0 16px 32px; } }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; } }
</style></head><body>
  <div class="hero">
    <div class="kicker">UPDATE</div>
    <div class="big">アップデート情報</div>
    <div class="lead">日本語音声入力 が新しくなりました</div>
  </div>
  <main>${sections}</main>
  <div class="actions">
    ${showHistory ? '<button class="ghost" onclick="post(\'history\')">これまでの更新</button>' : ''}
    <button class="ok" onclick="post('close')">OK</button>
  </div>
<script>const vscode = acquireVsCodeApi(); function post(m) { vscode.postMessage(m); }</script>
</body></html>`;
}

// 作者IDを kougoto → yuukibk に変えたときの移行。古い版が残っていたら外して、再読み込みを促す。
// 同じコマンドを二重に登録すると失敗するので、古い版がいる間はこちらは何も始めない。
const OLD_ID = 'kougoto.jp-voice-input';

async function migrateFromOldId(context) {
  try {
    await vscode.commands.executeCommand('workbench.extensions.uninstallExtension', OLD_ID);
  } catch (e) {
    // すでに外す途中なら気にしない
  }
  const pick = await vscode.window.showInformationMessage(
    '日本語音声入力の作者IDが変わったため、古い版を外しました。再読み込みすると新しい版に切り替わります（APIキーの入れ直しが1回だけ必要です）。',
    '再読み込み'
  );
  if (pick) vscode.commands.executeCommand('workbench.action.reloadWindow');
}

async function remindApiKey() {
  const p = provider();
  if (await ctx.secrets.get(p.secret)) return;
  const pick = await vscode.window.showWarningMessage(
    `日本語音声入力: ${p.label} の APIキーが未設定です。設定すると fn キーで音声入力できます。`,
    'APIキーを設定'
  );
  if (pick) setApiKey();
}

function activate(context) {
  const old = vscode.extensions.getExtension(OLD_ID);
  if (old && old.id !== context.extension.id) {
    migrateFromOldId(context);
    return;
  }
  ctx = context;
  log = vscode.window.createOutputChannel('日本語音声入力');
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
  status.command = 'jpVoice.toggle';
  setState('idle');
  status.show();

  context.subscriptions.push(
    status,
    log,
    vscode.commands.registerCommand('jpVoice.toggle', () => {
      if (state === 'idle') {
        pressedAt = 0;
        startRecording();
      } else if (state === 'recording') {
        stopRecording();
      }
    }),
    vscode.commands.registerCommand('jpVoice.cancel', () => {
      if (state === 'recording') {
        pressedAt = 0;
        cancelRecording();
      }
    }),
    vscode.commands.registerCommand('jpVoice.setApiKey', setApiKey),
    vscode.commands.registerCommand('jpVoice.showUsage', showUsage),
    vscode.commands.registerCommand('jpVoice.chooseStyle', chooseStyle),
    vscode.commands.registerCommand('jpVoice.checkUpdate', () => checkUpdate(true)),
    vscode.commands.registerCommand('jpVoice.whatsNew', () => showWhatsNew(CHANGELOG)),
    vscode.window.registerWebviewViewProvider('jpVoice.previewView', panelProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('jpVoice.copyLast', async () => {
      if (!lastText) return;
      await vscode.env.clipboard.writeText(lastText);
      vscode.window.showInformationMessage('最後の文字起こしをコピーしました');
    }),
    { dispose: () => helper && helper.kill() },
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('jpVoice.hotkey')) return;
      if (helper) {
        const old = helper;
        helper = null;
        old.kill();
      }
      endSession();
      setState('idle');
      startHelper();
    })
  );

  startHelper();
  maybeShowWhatsNew();
  remindApiKey();
  if (cfg('autoUpdate')) setTimeout(() => checkUpdate(false), 5000);
}

function deactivate() {
  if (helper) helper.kill();
}

module.exports = { activate, deactivate };
