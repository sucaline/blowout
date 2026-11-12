import SwiftUI
import WebKit
import AVFoundation

/// What the page says is playing, as reported by the BLOWOUT engine inside it.
struct Track {
    var title: String
    var artist: String
    var album: String
    var time: Double
    var duration: Double
    var rate: Double
    var paused: Bool
    var at: Date
}

/// A web browser (WKWebView) with the BLOWOUT engine injected into YouTube, YouTube Music and
/// Spotify pages. The engine adds the on-page BLOWOUT panel and boosts the page's audio.
final class Browser: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    // Google refuses sign-in from web views that do not look like a real browser. WKWebView
    // is real Safari underneath, so say so: the same user agent Safari sends.
    static let iPhoneAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
    static let macAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"

    let webView: WKWebView
    @Published var address = ""
    @Published var canGoBack = false
    @Published var canGoForward = false
    @Published var loading = false
    @Published var desktop = false
    @Published var compat = UserDefaults.standard.bool(forKey: "compat")
    @Published var track: Track?

    private var observers: [NSKeyValueObservation] = []
    private var wasPlaying = false

    override init() {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.allowsAirPlayForMediaPlayback = true
        let controller = WKUserContentController()
        config.userContentController = controller
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()

        controller.add(self, name: "blowout")
        installScript()
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(aboutToLeave), name: UIApplication.willResignActiveNotification, object: nil)
        center.addObserver(self, selector: #selector(wentToBackground), name: UIApplication.didEnterBackgroundNotification, object: nil)
        center.addObserver(self, selector: #selector(cameBack), name: UIApplication.didBecomeActiveNotification, object: nil)

        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.customUserAgent = Browser.iPhoneAgent
        webView.allowsBackForwardNavigationGestures = true
        webView.isOpaque = false
        webView.backgroundColor = .black
        webView.scrollView.backgroundColor = .black
        if #available(iOS 16.4, *) { webView.isInspectable = true }

        observers = [
            webView.observe(\.canGoBack) { [weak self] web, _ in self?.canGoBack = web.canGoBack },
            webView.observe(\.canGoForward) { [weak self] web, _ in self?.canGoForward = web.canGoForward },
            webView.observe(\.isLoading) { [weak self] web, _ in self?.loading = web.isLoading },
            webView.observe(\.url) { [weak self] web, _ in self?.address = web.url?.absoluteString ?? "" },
        ]

        go("https://music.youtube.com/")
    }

    // MARK: the engine

    /// extension/page.js (the Chrome extension's engine), run only on the sites it is for, in
    /// the same standalone mode as the iPhone bookmark, plus a bridge that reports the song.
    static func engineScript(compat: Bool) -> String? {
        guard let url = Bundle.main.url(forResource: "page", withExtension: "js"),
              let page = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        // Compat mode hides MediaSource from the page, so YouTube plays with Safari's own
        // streaming instead, which (unlike MediaSource playback) iOS can feed through Web Audio.
        let compatCode = compat ? #"""
          ['MediaSource', 'ManagedMediaSource', 'WebKitMediaSource'].forEach(function (name) {
            try { delete window[name]; } catch (e) {}
            if (name in window) { try { Object.defineProperty(window, name, { value: undefined, configurable: true }); } catch (e) {} }
          });
        """# : ""
        let prelude = #"""
        (function () {
          if (!/^(music\.|www\.|m\.)youtube\.com$|^open\.spotify\.com$/.test(location.hostname)) return;
          window.__blowoutBookmarklet = 1;
          // Keep playing in the background: the page is told it is always visible, so it does
          // not pause itself when you switch apps or lock the phone.
          var realHidden = null;
          try { realHidden = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden').get; } catch (e) {}
          try {
            Object.defineProperty(document, 'hidden', { get: function () { return false; }, configurable: true });
            Object.defineProperty(document, 'visibilityState', { get: function () { return 'visible'; }, configurable: true });
          } catch (e) {}
          var stop = function (e) { e.stopImmediatePropagation(); };
          window.addEventListener('visibilitychange', stop, true);
          document.addEventListener('visibilitychange', stop, true);
          window.addEventListener('blur', stop, true);
          window.addEventListener('freeze', stop, true);
          try { document.hasFocus = function () { return true; }; } catch (e) {}
          window.__bwPlaying = false;
          document.addEventListener('play', function () { window.__bwPlaying = true; }, true);
          document.addEventListener('pause', function () {
            if (!realHidden || !realHidden.call(document)) window.__bwPlaying = false;
          }, true);
        """# + compatCode + #"""

          document.addEventListener('blowout:out', function (event) {
            try {
              var message = JSON.parse(event.detail);
              if (message.type === 'track') window.webkit.messageHandlers.blowout.postMessage(message.track);
            } catch (e) {}
          });
        """#
        return prelude + "\n" + page + "\n})();"
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "blowout", let d = message.body as? [String: Any] else { return }
        if d["compat"] != nil { // the panel's COMPAT MODE button
            toggleCompat()
            return
        }
        func number(_ key: String) -> Double { (d[key] as? NSNumber)?.doubleValue ?? 0 }
        let rate = number("rate")
        track = Track(
            title: d["title"] as? String ?? "",
            artist: d["artist"] as? String ?? "",
            album: d["album"] as? String ?? "",
            time: number("time"),
            duration: number("duration"),
            rate: rate > 0 ? rate : 1,
            paused: (d["paused"] as? NSNumber)?.boolValue ?? true,
            at: Date()
        )
    }

    /// Play, pause, skip or seek the page's player (the engine listens for these).
    func control(_ action: String, time: Double? = nil) {
        var message: [String: Any] = ["type": "control", "action": action]
        if let time = time { message["time"] = time }
        guard let data = try? JSONSerialization.data(withJSONObject: message),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("document.dispatchEvent(new CustomEvent('blowout:in', { detail: JSON.stringify(\(json)) }))", completionHandler: nil)
        if var t = track {
            if action == "seek", let time = time { t.time = time; t.at = Date() }
            if action == "toggle" { t.time = t.time + (t.paused ? 0 : Date().timeIntervalSince(t.at) * t.rate); t.at = Date(); t.paused.toggle() }
            track = t
        }
    }

    // MARK: going places

    /// A link goes there, something that looks like a site gets https://, anything else is a
    /// YouTube Music search.
    func go(_ text: String) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty { return }
        var target: URL?
        if t.hasPrefix("http://") || t.hasPrefix("https://") {
            target = URL(string: t)
        } else if !t.contains(" "), t.contains("."), let guess = URL(string: "https://" + t) {
            target = guess
        }
        if target == nil, var search = URLComponents(string: "https://music.youtube.com/search") {
            search.queryItems = [URLQueryItem(name: "q", value: t)]
            target = search.url
        }
        if let url = target { webView.load(URLRequest(url: url)) }
    }

    private func installScript() {
        let controller = webView.configuration.userContentController
        controller.removeAllUserScripts()
        if let source = Browser.engineScript(compat: compat) {
            controller.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
    }

    func toggleCompat() {
        compat.toggle()
        UserDefaults.standard.set(compat, forKey: "compat")
        installScript()
        webView.reload()
    }

    // MARK: background playback

    /// The page is told it is always visible (see engineScript) so it keeps playing. If it
    /// pauses anyway when the app goes to the background, press play again for it.
    @objc private func aboutToLeave() {
        // Remember whether a song was playing before iOS pauses it for us.
        if let t = track { wasPlaying = !t.paused && Date().timeIntervalSince(t.at) < 3 } else { wasPlaying = false }
    }

    @objc private func cameBack() {
        wasPlaying = false
    }

    @objc private func wentToBackground() {
        guard wasPlaying else { return }
        try? AVAudioSession.sharedInstance().setActive(true)
        for delay in [0.4, 1.0, 2.0, 4.0, 8.0, 15.0] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                guard let self = self, self.wasPlaying else { return }
                self.control("resume") // only ever starts a paused player
            }
        }
    }

    func toggleDesktop() {
        desktop.toggle()
        webView.customUserAgent = desktop ? Browser.macAgent : Browser.iPhoneAgent
        webView.reload()
    }

    // MARK: WKNavigationDelegate / WKUIDelegate

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, preferences: WKWebpagePreferences, decisionHandler: @escaping (WKNavigationActionPolicy, WKWebpagePreferences) -> Void) {
        preferences.preferredContentMode = desktop ? .desktop : .mobile
        if let scheme = navigationAction.request.url?.scheme?.lowercased(),
           !["http", "https", "about", "blob", "data"].contains(scheme) {
            decisionHandler(.cancel, preferences) // no jumping out to other apps
            return
        }
        decisionHandler(.allow, preferences)
    }

    // Pop-ups open in the same view.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if navigationAction.targetFrame == nil, let url = navigationAction.request.url {
            webView.load(URLRequest(url: url))
        }
        return nil
    }
}

struct WebViewHost: UIViewRepresentable {
    let webView: WKWebView
    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
