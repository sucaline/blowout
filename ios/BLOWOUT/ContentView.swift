import SwiftUI

struct ContentView: View {
    @StateObject private var browser = Browser()
    @StateObject private var lyrics = LyricsModel()
    @State private var typed = ""
    @State private var showLyrics = false
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 0) {
            addressBar
            WebViewHost(webView: browser.webView)
            toolbar
        }
        .background(Color.black.ignoresSafeArea())
        .sheet(isPresented: $showLyrics) {
            LyricsView(browser: browser, lyrics: lyrics)
        }
        .onReceive(browser.$address) { value in
            if !focused { typed = ContentView.pretty(value) }
        }
    }

    private var addressBar: some View {
        HStack(spacing: 8) {
            TextField("Link or search", text: $typed)
                .focused($focused)
                .keyboardType(.webSearch)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.go)
                .onSubmit {
                    browser.go(typed)
                    focused = false
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .background(Color.white.opacity(0.1))
                .cornerRadius(10)
                .foregroundColor(.white)
            if browser.loading {
                ProgressView().tint(Theme.yellow)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color.black)
    }

    private var toolbar: some View {
        HStack(spacing: 2) {
            icon("chevron.left", enabled: browser.canGoBack) { browser.webView.goBack() }
            icon("chevron.right", enabled: browser.canGoForward) { browser.webView.goForward() }
            Spacer()
            pill("MUSIC") { browser.go("https://music.youtube.com/") }
            pill("YOUTUBE") { browser.go("https://www.youtube.com/") }
            pill("LYRICS") { showLyrics = true }
            Spacer()
            icon("arrow.clockwise") { browser.webView.reload() }
            icon(browser.desktop ? "desktopcomputer" : "iphone") { browser.toggleDesktop() }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(Color.black)
    }

    private func icon(_ name: String, enabled: Bool = true, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: name)
                .font(.system(size: 18, weight: .semibold))
                .frame(width: 40, height: 40)
        }
        .foregroundColor(enabled ? Color.white : Color.white.opacity(0.25))
        .disabled(!enabled)
    }

    private func pill(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 12, weight: .heavy))
                .tracking(1.5)
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(Theme.red)
                .foregroundColor(.black)
                .cornerRadius(999)
        }
    }

    static func pretty(_ address: String) -> String {
        guard let url = URL(string: address), let host = url.host else { return address }
        return host + (url.path == "/" ? "" : url.path)
    }
}
