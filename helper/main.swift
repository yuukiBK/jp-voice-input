// voicehelper: VSCode 拡張から起動される常駐プロセス。
// - 録音キー（既定は fn）の押下/解放を監視して stdout に "down" / "up" を出す
// - stdin の "start <path>" / "snapshot <path>" / "stop" / "cancel" で録音を制御する（WAVで書き出す）
// - stdin の "hud <rec|final> <top|bottom> <base64>" / "hudhide" で途中表示の浮かぶ窓を出す
// 出力は1行1イベント。
import AppKit
import AVFoundation
import CoreGraphics
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ s: String) {
    print(s)
}

// MARK: - マイク権限

func requestMic() {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized:
        emit("perm granted")
    case .notDetermined:
        AVCaptureDevice.requestAccess(for: .audio) { ok in
            emit(ok ? "perm granted" : "perm denied")
        }
    default:
        emit("perm denied")
    }
}

// MARK: - 録音
// AVAudioEngine で 16kHz・モノラル・16bit に変換しながらメモリにためる。
// "snapshot" でそこまでの分を WAV に書き出せる（途中経過の文字起こし用）。

let engine = AVAudioEngine()
let outFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!
let audioQueue = DispatchQueue(label: "voicehelper.audio")
var samples: [Int16] = []
var preroll: [Int16] = []  // 録音していない間も直前0.3秒ぶんを保持（押す直前の声を拾う）
let prerollMax = 4800
var recording = false  // audioQueue 上で読み書きする
var recordPath: String?
var idleStop: DispatchWorkItem?
let keepHotSeconds = 30.0  // 録音後もしばらくマイクを開けておき、次の録音の頭欠けを防ぐ

func startEngine() -> Bool {
    if engine.isRunning { return true }
    let input = engine.inputNode
    let inFormat = input.outputFormat(forBus: 0)
    guard inFormat.sampleRate > 0, inFormat.channelCount > 0, let converter = AVAudioConverter(from: inFormat, to: outFormat) else {
        emit("error マイクが見つかりません")
        return false
    }
    input.removeTap(onBus: 0)
    input.installTap(onBus: 0, bufferSize: 1024, format: inFormat) { buf, _ in
        let cap = AVAudioFrameCount(Double(buf.frameLength) * outFormat.sampleRate / inFormat.sampleRate) + 32
        guard let out = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: cap) else { return }
        var fed = false
        var err: NSError?
        converter.convert(to: out, error: &err) { _, status in
            if fed {
                status.pointee = .noDataNow
                return nil
            }
            fed = true
            status.pointee = .haveData
            return buf
        }
        guard err == nil, let ch = out.int16ChannelData else { return }
        let chunk = Array(UnsafeBufferPointer(start: ch[0], count: Int(out.frameLength)))
        audioQueue.async {
            if recording {
                samples.append(contentsOf: chunk)
            } else {
                preroll.append(contentsOf: chunk)
                if preroll.count > prerollMax { preroll.removeFirst(preroll.count - prerollMax) }
            }
        }
    }
    do {
        try engine.start()
        return true
    } catch {
        input.removeTap(onBus: 0)
        emit("error \(error.localizedDescription)")
        return false
    }
}

func stopEngine() {
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
    audioQueue.sync { preroll.removeAll() }
}

// マイクの切り替え（AirPods の接続など）で音声系の設定が変わったら、いったん止めて次の録音で作り直す。
// そのまま使い続けると形式の食い違いで落ちる。
NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { _ in
    idleStop?.cancel()
    let wasRecording = recordPath != nil
    if wasRecording {
        recordPath = nil
        audioQueue.sync {
            recording = false
            samples.removeAll()
        }
        emit("error マイクが切り替わったので録音を中断しました。もう一度話してください")
    }
    stopEngine()
}

func scheduleIdleStop() {
    idleStop?.cancel()
    let item = DispatchWorkItem { stopEngine() }
    idleStop = item
    DispatchQueue.main.asyncAfter(deadline: .now() + keepHotSeconds, execute: item)
}

func startRecording(_ path: String) {
    stopRecording(discard: true)
    idleStop?.cancel()
    guard startEngine() else { return }
    audioQueue.sync {
        samples = preroll
        preroll.removeAll()
        recording = true
    }
    recordPath = path
    emit("recording")
}

func writeWav(_ path: String) -> Double {
    let data: [Int16] = audioQueue.sync { samples }
    var wav = Data()
    func u32(_ v: UInt32) { var x = v.littleEndian; wav.append(Data(bytes: &x, count: 4)) }
    func u16(_ v: UInt16) { var x = v.littleEndian; wav.append(Data(bytes: &x, count: 2)) }
    let byteCount = UInt32(data.count * 2)
    wav.append("RIFF".data(using: .ascii)!); u32(36 + byteCount)
    wav.append("WAVEfmt ".data(using: .ascii)!); u32(16); u16(1); u16(1)
    u32(16000); u32(32000); u16(2); u16(16)
    wav.append("data".data(using: .ascii)!); u32(byteCount)
    data.withUnsafeBytes { wav.append(contentsOf: $0) }
    FileManager.default.createFile(atPath: path, contents: wav)
    return Double(data.count) / 16000
}

func snapshot(_ path: String) {
    guard recordPath != nil else { return }
    let sec = writeWav(path)
    emit(String(format: "snapshot %.2f %@", sec, path))
}

func stopRecording(discard: Bool) {
    guard let p = recordPath else { return }
    recordPath = nil
    // 押している間の最後の音を取りこぼさないよう少し待ってから締める
    DispatchQueue.main.asyncAfter(deadline: .now() + (discard ? 0 : 0.15)) {
        audioQueue.sync { recording = false }
        if discard {
            emit("cancelled")
        } else {
            let sec = writeWav(p)
            emit(String(format: "stopped %.2f %@", sec, p))
        }
        audioQueue.sync { samples.removeAll() }
        scheduleIdleStop()
    }
}

// MARK: - 録音キー監視
// CGEventSource の修飾キー状態をポーリングする（入力監視の権限は不要）。
// 起動引数でキーを選ぶ: fn（既定） / rightOption / rightCommand

let hotkey = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "fn"
let (keyMask, otherMods): (UInt64, CGEventFlags) = {
    switch hotkey {
    case "rightOption": return (0x40, [.maskCommand, .maskControl, .maskShift])  // NX_DEVICERALTKEYMASK
    case "rightCommand": return (0x10, [.maskAlternate, .maskControl, .maskShift])  // NX_DEVICERCMDKEYMASK
    default: return (CGEventFlags.maskSecondaryFn.rawValue, [.maskCommand, .maskControl, .maskShift, .maskAlternate])
    }
}()
// fn と一緒に押されがちなキー（矢印・Home/End・PageUp/Down・Delete・F1〜F12）。押されたら取り消す
let comboKeys: [CGKeyCode] = [123, 124, 125, 126, 115, 119, 116, 121, 117, 51,
                              122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111]
var held = false

let timer = DispatchSource.makeTimerSource(queue: .main)
timer.schedule(deadline: .now(), repeating: .milliseconds(25))
timer.setEventHandler {
    let flags = CGEventSource.flagsState(.combinedSessionState)
    let down = (flags.rawValue & keyMask) != 0
    let alone = flags.intersection(otherMods).isEmpty
        && !comboKeys.contains { CGEventSource.keyState(.combinedSessionState, key: $0) }
    if !held && down && alone {
        held = true
        emit("down")
    } else if held && !down {
        held = false
        emit("up")
    } else if held && !alone {
        // 他のキーと組み合わせた＝ショートカット操作なので取り消す
        held = false
        emit("abort")
    }
}
timer.resume()

// MARK: - 浮かぶ窓（途中表示）
// 画面の上（または下）中央に半透明の窓を出す。フォーカスは奪わず、クリックも素通しする。
// "hud <rec|final> <top|bottom> <base64のUTF-8テキスト>" で表示・更新、"hudhide" で隠す。

var hudPanel: NSPanel?
var hudBody: NSTextField?
var hudTitle: NSTextField?
var hudDot: NSView?
let hudWidth: CGFloat = 560
let hudPad: CGFloat = 18
let hudMaxChars = 150  // 長くなったら新しい部分だけ（4〜5行）

func makeHud() {
    let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: hudWidth, height: 80),
                        styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    panel.level = .floating
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = true
    panel.ignoresMouseEvents = true
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
    panel.appearance = NSAppearance(named: .darkAqua)  // テーマに関係なく濃い背景・白文字

    let bg = NSVisualEffectView()
    bg.material = .hudWindow
    bg.blendingMode = .behindWindow
    bg.state = .active
    // 角丸は maskImage で切る（layer の角丸だと影が四角く残る）
    bg.maskImage = NSImage(size: NSSize(width: 33, height: 33), flipped: false) { r in
        NSColor.black.setFill()
        NSBezierPath(roundedRect: r, xRadius: 16, yRadius: 16).fill()
        return true
    }
    bg.maskImage?.capInsets = NSEdgeInsets(top: 16, left: 16, bottom: 16, right: 16)
    bg.maskImage?.resizingMode = .stretch
    panel.contentView = bg

    let dot = NSView(frame: NSRect(x: 0, y: 0, width: 8, height: 8))
    dot.wantsLayer = true
    dot.layer?.cornerRadius = 4
    bg.addSubview(dot)

    let title = NSTextField(labelWithString: "")
    title.font = .systemFont(ofSize: 11, weight: .semibold)
    title.textColor = NSColor.white.withAlphaComponent(0.6)
    bg.addSubview(title)

    let body = NSTextField(wrappingLabelWithString: "")
    body.font = .systemFont(ofSize: 16, weight: .regular)
    body.textColor = .white
    body.preferredMaxLayoutWidth = hudWidth - hudPad * 2
    bg.addSubview(body)

    hudPanel = panel
    hudBody = body
    hudTitle = title
    hudDot = dot
}

func startPulse(_ v: NSView) {
    guard v.layer?.animation(forKey: "pulse") == nil else { return }
    let a = CABasicAnimation(keyPath: "opacity")
    a.fromValue = 1.0
    a.toValue = 0.25
    a.duration = 0.7
    a.autoreverses = true
    a.repeatCount = .infinity
    v.layer?.add(a, forKey: "pulse")
}

func showHud(_ args: String) {
    let parts = args.split(separator: " ", maxSplits: 2).map(String.init)
    let mode = parts.count > 0 ? parts[0] : "rec"
    let pos = parts.count > 1 ? parts[1] : "top"
    let b64 = parts.count > 2 ? parts[2] : ""
    if hudPanel == nil { makeHud() }
    guard let panel = hudPanel, let body = hudBody, let title = hudTitle, let dot = hudDot else { return }

    var text = Data(base64Encoded: b64).flatMap { String(data: $0, encoding: .utf8) } ?? ""
    if text.count > hudMaxChars { text = "…" + text.suffix(hudMaxChars) }
    let final = mode == "final"
    title.stringValue = final ? "仕上げ中…" : "聞き取り中"
    dot.layer?.backgroundColor = (final ? NSColor.systemBlue : NSColor.systemRed).cgColor
    if final { dot.layer?.removeAnimation(forKey: "pulse") } else { startPulse(dot) }
    body.stringValue = text.isEmpty ? "…" : text
    body.textColor = text.isEmpty ? NSColor.white.withAlphaComponent(0.45) : .white

    let inner = hudWidth - hudPad * 2
    let bodySize = body.sizeThatFits(NSSize(width: inner, height: .greatestFiniteMagnitude))
    let titleH: CGFloat = 14
    let gap: CGFloat = 6
    let h = hudPad + titleH + gap + ceil(bodySize.height) + hudPad - 2

    let screen = NSScreen.main ?? NSScreen.screens[0]
    let vf = screen.visibleFrame
    let y = pos == "bottom" ? vf.minY + 90 : vf.maxY - h - 24
    let frame = NSRect(x: vf.midX - hudWidth / 2, y: y, width: hudWidth, height: h)

    body.frame = NSRect(x: hudPad, y: hudPad - 2, width: inner, height: ceil(bodySize.height))
    dot.frame = NSRect(x: hudPad, y: h - hudPad - titleH / 2 - 4, width: 8, height: 8)
    title.frame = NSRect(x: hudPad + 14, y: h - hudPad - titleH, width: inner - 14, height: titleH)

    panel.setFrame(frame, display: true)
    panel.invalidateShadow()
    if !panel.isVisible {
        panel.alphaValue = 0
        panel.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.15
            panel.animator().alphaValue = 1
        }
    }
}

func hideHud() {
    guard let panel = hudPanel, panel.isVisible else { return }
    NSAnimationContext.runAnimationGroup({ ctx in
        ctx.duration = 0.2
        panel.animator().alphaValue = 0
    }, completionHandler: {
        panel.orderOut(nil)
        hudDot?.layer?.removeAnimation(forKey: "pulse")
    })
}

// MARK: - stdin コマンド

DispatchQueue.global().async {
    while let line = readLine() {
        let parts = line.split(separator: " ", maxSplits: 1).map(String.init)
        DispatchQueue.main.async {
            switch parts.first {
            case "start": if parts.count > 1 { startRecording(parts[1]) }
            case "snapshot": if parts.count > 1 { snapshot(parts[1]) }
            case "stop": stopRecording(discard: false)
            case "cancel": stopRecording(discard: true)
            case "perm": requestMic()
            case "hud": showHud(parts.count > 1 ? parts[1] : "")
            case "hudhide": hideHud()
            default: break
            }
        }
    }
    // 親（VSCode）が終了したら一緒に終わる
    exit(0)
}

// 初回録音の頭が欠けないよう、起動時に音声系を準備しておく
_ = engine.inputNode
engine.prepare()
emit("ready")
let app = NSApplication.shared
app.setActivationPolicy(.accessory)  // Dock にアイコンを出さない
app.run()
