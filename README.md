# 日本語音声入力 for VSCode

[![Release](https://img.shields.io/github/v/release/yuukiBK/jp-voice-input)](https://github.com/yuukiBK/jp-voice-input/releases/latest)
![macOS](https://img.shields.io/badge/macOS-11%2B-black)

fn キーを押している間だけ録音し、Whisper で日本語に文字起こしして、VSCode の Claude Code のチャット欄に入れる拡張です。
話している途中の文字も画面に出るので、聞き取れているかを確かめながら話せます。

- 文字起こし：Groq（無料枠あり、`whisper-large-v3`）または OpenAI（`gpt-4o-transcribe`）
- 対応：macOS 11 以降（Intel / Apple Silicon）。Windows には対応していません
- Claude Code が入っていなくても、エディタのカーソル位置に入れるモードで使えます

> このツールは個人が作った非公式のもので、Anthropic・OpenAI・Groq とは関係ありません。

**English:** Push-to-talk dictation for VS Code on macOS, tuned for Japanese. Hold `fn`, speak, release — the audio is transcribed with Whisper (Groq or OpenAI) and pasted into the Claude Code chat input (or at the editor cursor), with a live preview while you speak. Unofficial; not affiliated with Anthropic, OpenAI or Groq.

## インストール

1. [Releases](https://github.com/yuukiBK/jp-voice-input/releases/latest) から `jp-voice-input-x.y.z.vsix` をダウンロードする
2. VSCode の拡張機能ビュー → 右上の「…」→「VSIX からのインストール…」で選ぶ
3. 以降は新しい版が出ると VSCode が「更新する」と知らせてくれます（自分でダウンロードし直す必要はありません）

## 最初の設定

### 1. API キーを用意する（Groq なら無料・カード不要）

1. https://console.groq.com に登録する
2. 「API Keys」→「Create API Key」でキー（`gsk_...`）を作ってコピーする
3. VSCode で `Cmd+Shift+P` →「日本語音声入力: APIキーを設定」に貼り付ける

キーは Mac のキーチェーンに保存され、ファイルには残りません。
一人ひとり自分のアカウントでキーを作ってください（無料枠の上限はアカウント単位で共有されます）。

### 2. fn キーを空ける

システム設定 → キーボード →「🌐キーを押して」を **何もしない** にする。
（音声入力のショートカットが「🌐キーを2回押す」になっている場合は別のキーに変える）

### 3. マイクを許可する

初めて fn を押すと「Visual Studio Code がマイクへのアクセスを求めています」と出るので許可する。

## 使い方

| 操作 | 動き |
|---|---|
| fn を押したまま話す → 離す | 文字起こしして Claude Code のチャット欄に入れる（送信はしない） |
| `Cmd+Shift+Space` / 右下の 🎙 | 録音の開始・停止を切り替える（長く話すとき向け） |
| 録音中に `Esc` | 取り消す |

0.4 秒より短い録音や、fn と矢印キーなどを一緒に押したときは、誤操作として捨てます。

## 途中表示の見せ方

`Cmd+Shift+P` →「日本語音声入力: 途中表示の見せ方を切り替え」で選べます。

- **通知**（初期設定）：右下の VSCode 通知に末尾をひっそり出す
- **浮かぶ窓**：画面上部の中央に半透明の窓を出す（`jpVoice.hudPosition` で下にも出せる）
- **専用パネル**：下のパネルの「音声入力」タブに全文を出す

途中表示は 3 秒ごとに「録音の最初から今まで」を文字起こしし直します。チャット欄に入る最終結果は、離したときに全体を 1 回で文字起こししたものなので、途中表示があっても精度は変わりません。そのかわり無料枠を多めに使います。

## 主な設定

| 設定 | 既定 | 内容 |
|---|---|---|
| `jpVoice.provider` | `groq` | `groq` / `openai` |
| `jpVoice.hotkey` | `fn` | `fn` / `rightOption`（US 配列）/ `rightCommand` / `off` |
| `jpVoice.target` | `claude` | `claude`（チャット欄）/ `editor`（カーソル位置） |
| `jpVoice.vocabulary` | — | よく使う固有名詞（カンマ区切り）。足すと当たりやすくなる |
| `jpVoice.preview` | `true` | 途中表示のオン・オフ |
| `jpVoice.previewInterval` | `3` | 途中表示の更新間隔（秒） |

## プライバシーと動作について

- **音声の送り先**：話した音声は、選んだサービス（Groq か OpenAI）にだけ送られ、文字にして返されます。それ以外には送りません。
  Groq は既定では送られたデータを保存しませんが、障害対応や不正利用の調査のために最大 30 日ログを残すことがあると説明しています（[Your Data in GroqCloud](https://console.groq.com/docs/your-data)）。設定でゼロ保存（ZDR）にもできます。
- **周りの人の声**：会議中などに使うと、周りの人の声も一緒に送られます。必要に応じて一言断ってから使ってください。
- **マイク**：録音を止めたあとも 30 秒はマイクを開いたままにしています（次の録音の頭が欠けないようにするため）。その間はメニューバーにマイク使用中の印が出ます。録音していない間の音は、直前 0.3 秒ぶんをメモリに置いておくだけで、保存も送信もしません。
- **クリップボード**：チャット欄に入れるときに一瞬だけクリップボードを使い、すぐ元の内容に戻します。
- **API キー**：Mac のキーチェーン（VSCode の SecretStorage）に保存し、ファイルや設定には書きません。
- **キーの検知**：fn キーは修飾キーの状態を読むだけで、ほかのキー入力は記録しません（入力監視の権限は不要です）。
- **更新の確認**：起動時に GitHub の Releases に最新版があるかだけを問い合わせます（`jpVoice.autoUpdate` で止められます）。

## 使用量の確認

`Cmd+Shift+P` →「日本語音声入力: 使用量を表示」で、日ごとの話した長さ・送信回数と、Groq の残り枠を確認できます。
Groq の無料枠は 1 分あたり 20 回・1 時間あたり音声 7200 秒・1 日 2000 回が目安です。1 分の上限に近づくと途中表示を休み、最終結果は必要なら待ってから再送します（途中表示ありだと、話した長さの数倍を使います）。

## 動かないとき

- fn を押しても反応しない：ターミナルで次を実行して VSCode を再読み込みする
  ```
  xattr -dr com.apple.quarantine ~/.vscode/extensions/kougoto.jp-voice-input-*
  ```
- エラーの詳細：出力パネルの「日本語音声入力」を見る

## 開発

```
./build.sh   # 録音ヘルパーをビルドして vsix を作る
```

- `extension.js`：VSCode 拡張本体（録音の制御・文字起こし・入力・途中表示・自動更新）
- `helper/main.swift`：常駐ヘルパー（fn キーの検知、録音、浮かぶ窓）
