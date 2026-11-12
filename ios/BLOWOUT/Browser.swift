import SwiftUI
import WebKit

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
    @Published var track: Track?

    private var observers: [NSKeyValueObservation] = []

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
        if let source = Browser.engineScript() {
            controller.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }

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
    static func engineScript() -> String? {
        guard let url = Bundle.main.url(forResource: "page", withExtension: "js"),
              let page = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        let prelude = #"""
        (function () {
          if (!/^(music\.|www\.|m\.)youtube\.com$|^open\.spotify\.com$/.test(location.hostname)) return;
          window.__blowoutBookmarklet = 1;
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
