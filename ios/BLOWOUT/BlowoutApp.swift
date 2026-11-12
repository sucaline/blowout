import SwiftUI
import AVFoundation

enum Theme {
    static let red = Color(red: 1.0, green: 0.239, blue: 0.122)
    static let yellow = Color(red: 1.0, green: 0.839, blue: 0.0)
}

@main
struct BlowoutApp: App {
    init() {
        // "playback" keeps the sound going with the screen locked and ignores the silent switch.
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .default, options: [])
        try? session.setActive(true)
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .preferredColorScheme(.dark)
        }
    }
}
