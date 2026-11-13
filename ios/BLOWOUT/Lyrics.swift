import SwiftUI

struct LyricLine: Identifiable {
    let id: Int
    let time: Double
    let text: String
}

/// Looks lyrics up on LRCLIB (https://lrclib.net), the same free database the desktop app uses.
/// Only the song's title, artist and length are sent, and only once you open the lyrics screen.
@MainActor
final class LyricsModel: ObservableObject {
    @Published var lines: [LyricLine] = []
    @Published var timed = false
    @Published var status = "Play a song on YouTube Music to see its lyrics here."
    private var loadedKey = ""

    func load(title: String, artist: String, duration: Double) async {
        let key = "\(title)|\(artist)"
        if title.isEmpty || key == loadedKey { return }
        loadedKey = key
        lines = []
        timed = false
        status = "Looking for lyrics…"

        // Sped-up, slowed and similar uploads are a different length from the original song, so
        // the lyrics come from the original with the timing stretched to fit.
        let tempo = title.range(of: "sped[ -]*up|speed(ed)?[ -]*up|slowed|nightcore|reverb|8d", options: [.regularExpression, .caseInsensitive]) != nil
        var cleanTitle = Self.cleanTitle(title)
        var cleanArtist = Self.cleanArtist(artist)
        var byInTitle = false
        let pieces = cleanTitle.components(separatedBy: " - ")
        if pieces.count == 2 { // "Artist - Song" all in the title
            cleanArtist = pieces[0].trimmingCharacters(in: .whitespaces)
            cleanTitle = pieces[1].trimmingCharacters(in: .whitespaces)
            byInTitle = true
        }
        var found: (synced: String, plain: String, length: Double)?

        if !tempo { // the exact lookup needs the length to match, which an edit never does
            var get = URLComponents(string: "https://lrclib.net/api/get")
            get?.queryItems = [
                URLQueryItem(name: "track_name", value: cleanTitle),
                URLQueryItem(name: "artist_name", value: cleanArtist),
                URLQueryItem(name: "duration", value: String(Int(duration.rounded()))),
            ]
            if let url = get?.url, let object = await Self.fetch(url) as? [String: Any] {
                found = Self.lyrics(in: object)
            }
        }

        if found == nil {
            var search = URLComponents(string: "https://lrclib.net/api/search")
            search?.queryItems = [URLQueryItem(name: "q", value: "\(cleanArtist) \(cleanTitle)")]
            if let url = search?.url, let results = await Self.fetch(url) as? [[String: Any]] {
                // Only entries that really name this song (a close length alone is not enough).
                let good = results.filter { object in
                    let name = object["trackName"] as? String ?? ""
                    let by = object["artistName"] as? String ?? ""
                    guard Self.similar(name, cleanTitle) else { return false }
                    if !byInTitle && Self.norm(name) == Self.norm(cleanTitle) { return true }
                    return Self.similar(by, cleanArtist)
                }
                let all = good.map { Self.lyrics(in: $0) }
                found = all.first(where: { !$0.synced.isEmpty }) ?? all.first(where: { !$0.plain.isEmpty })
            }
        }

        guard loadedKey == key else { return } // the song changed while we were looking
        if let found = found, !found.synced.isEmpty {
            var parsed = Self.parse(found.synced)
            if tempo, found.length > 0, duration > 0 {
                let k = duration / found.length
                if k > 0.5 && k < 2 { parsed = parsed.map { LyricLine(id: $0.id, time: $0.time * k, text: $0.text) } }
            }
            if !parsed.isEmpty {
                lines = parsed
                timed = true
                return
            }
        }
        if let found = found, !found.plain.isEmpty {
            let rows = found.plain.components(separatedBy: "\n")
            lines = rows.enumerated().map { LyricLine(id: $0.offset, time: 0, text: $0.element) }
            timed = false
            return
        }
        status = "No lyrics found for this one."
    }

    // MARK: helpers

    private static func lyrics(in object: [String: Any]) -> (synced: String, plain: String, length: Double) {
        (object["syncedLyrics"] as? String ?? "", object["plainLyrics"] as? String ?? "", (object["duration"] as? NSNumber)?.doubleValue ?? 0)
    }

    static func norm(_ text: String) -> String {
        var t = text.lowercased()
        t = t.replacingOccurrences(of: "[\\(\\[][^\\)\\]]*[\\)\\]]", with: " ", options: .regularExpression)
        t = t.replacingOccurrences(of: "[^\\p{L}\\p{N}\\s]", with: " ", options: .regularExpression)
        t = t.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        return t.trimmingCharacters(in: .whitespaces)
    }

    /// Do two names mean the same song or artist?
    static func similar(_ a: String, _ b: String) -> Bool {
        let x = norm(a)
        let y = norm(b)
        if x.isEmpty || y.isEmpty { return false }
        if x == y { return true }
        if min(x.count, y.count) >= 4 && (x.contains(y) || y.contains(x)) { return true }
        let wa = Set(x.split(separator: " "))
        let wb = Set(y.split(separator: " "))
        let shortest = min(wa.count, wb.count)
        return shortest >= 2 && Double(wa.intersection(wb).count) / Double(shortest) >= 0.6
    }

    private static func fetch(_ url: URL) async -> Any? {
        var request = URLRequest(url: url)
        request.timeoutInterval = 12
        request.setValue("BLOWOUT iOS (https://github.com/sucaline/blowout)", forHTTPHeaderField: "User-Agent")
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return try? JSONSerialization.jsonObject(with: data)
    }

    /// "[01:23.45] some words" becomes a line at 83.45 seconds. Tags like [ar:Someone] are skipped.
    static func parse(_ text: String) -> [LyricLine] {
        var entries: [(Double, String)] = []
        for raw in text.components(separatedBy: "\n") {
            var rest = Substring(raw)
            var stamps: [Double] = []
            while rest.first == "[", let close = rest.firstIndex(of: "]") {
                let inside = rest[rest.index(after: rest.startIndex)..<close]
                let parts = inside.split(separator: ":")
                if parts.count == 2, let minutes = Double(parts[0]), let seconds = Double(parts[1]) {
                    stamps.append(minutes * 60 + seconds)
                }
                rest = rest[rest.index(after: close)...]
            }
            let words = rest.trimmingCharacters(in: .whitespaces)
            for stamp in stamps { entries.append((stamp, words)) }
        }
        entries.sort { $0.0 < $1.0 }
        return entries.enumerated().map { LyricLine(id: $0.offset, time: $0.element.0, text: $0.element.1) }
    }

    /// Drops "(Official Video)", "[Lyrics]" and the like.
    static func cleanTitle(_ title: String) -> String {
        var result = title.components(separatedBy: " | ").first ?? title
        for pattern in ["\\s*[\\(\\[][^\\)\\]]*(official|video|audio|lyrics?|visualizer|remaster|sped[ -]*up|speed(ed)?[ -]*up|slowed|nightcore|reverb|8d|tiktok)[^\\)\\]]*[\\)\\]]"] {
            result = result.replacingOccurrences(of: pattern, with: "", options: [.regularExpression, .caseInsensitive])
        }
        return result.trimmingCharacters(in: .whitespaces)
    }

    static func cleanArtist(_ artist: String) -> String {
        var result = artist.replacingOccurrences(of: " - Topic", with: "")
        if let first = result.components(separatedBy: " & ").first, !first.isEmpty { result = first }
        return result.trimmingCharacters(in: .whitespaces)
    }
}

struct LyricsView: View {
    @ObservedObject var browser: Browser
    @ObservedObject var lyrics: LyricsModel
    @Environment(\.dismiss) private var dismiss
    @State private var now = Date()
    private let tick = Timer.publish(every: 0.25, on: .main, in: .common).autoconnect()

    private var position: Double {
        guard let t = browser.track else { return 0 }
        return t.time + (t.paused ? 0 : now.timeIntervalSince(t.at) * t.rate)
    }

    private var current: Int {
        guard lyrics.timed else { return -1 }
        var index = -1
        for line in lyrics.lines where line.time <= position + 0.15 { index = line.id }
        return index
    }

    private var songKey: String {
        guard let t = browser.track else { return "" }
        return "\(t.title)|\(t.artist)"
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            if lyrics.lines.isEmpty {
                Spacer()
                Text(lyrics.status)
                    .foregroundColor(Color.white.opacity(0.6))
                    .multilineTextAlignment(.center)
                    .padding(32)
                Spacer()
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 16) {
                            ForEach(lyrics.lines) { line in
                                Text(line.text.isEmpty ? "♪" : line.text)
                                    .font(.system(size: 26, weight: .heavy))
                                    .foregroundColor(color(for: line))
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .id(line.id)
                                    .onTapGesture {
                                        if lyrics.timed { browser.control("seek", time: line.time) }
                                    }
                            }
                        }
                        .padding(20)
                    }
                    .onChange(of: current) { value in
                        if value >= 0 { withAnimation { proxy.scrollTo(value, anchor: .center) } }
                    }
                }
            }
            controls
        }
        .background(Color.black.ignoresSafeArea())
        .onReceive(tick) { now = $0 }
        .task(id: songKey) {
            if let t = browser.track {
                await lyrics.load(title: t.title, artist: t.artist, duration: t.duration)
            }
        }
    }

    private func color(for line: LyricLine) -> Color {
        if !lyrics.timed { return Color.white.opacity(0.85) }
        return line.id == current ? Theme.yellow : Color.white.opacity(0.3)
    }

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(browser.track?.title ?? "Nothing playing")
                    .font(.system(size: 17, weight: .heavy))
                    .foregroundColor(.white)
                    .lineLimit(1)
                Text(browser.track?.artist ?? "")
                    .font(.system(size: 13))
                    .foregroundColor(Color.white.opacity(0.6))
                    .lineLimit(1)
            }
            Spacer()
            Button("DONE") { dismiss() }
                .font(.system(size: 13, weight: .heavy))
                .foregroundColor(Theme.yellow)
        }
        .padding(16)
    }

    private var controls: some View {
        HStack(spacing: 36) {
            button("backward.fill") { browser.control("prev") }
            button((browser.track?.paused ?? true) ? "play.fill" : "pause.fill") { browser.control("toggle") }
            button("forward.fill") { browser.control("next") }
        }
        .padding(.vertical, 14)
    }

    private func button(_ symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 24, weight: .bold))
                .foregroundColor(.white)
                .frame(width: 52, height: 52)
        }
    }
}
