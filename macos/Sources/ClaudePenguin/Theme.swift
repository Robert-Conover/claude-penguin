import SwiftUI

enum Theme {
    static let accent = Color(red: 0.16, green: 0.45, blue: 0.82)
    static let skyTop = Color(light: .init(red: 0.78, green: 0.90, blue: 0.98), dark: .init(red: 0.07, green: 0.15, blue: 0.26))
    static let snow = Color(light: .init(red: 0.95, green: 0.98, blue: 1.0), dark: .init(red: 0.05, green: 0.09, blue: 0.16))
    static let warm = Color(red: 0.96, green: 0.62, blue: 0.22)
}

extension Color {
    init(light: Color, dark: Color) {
        self.init(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(dark) : NSColor(light)
        })
    }
}

/// Soft winter-sky backdrop shared by every non-game screen.
struct CozyBackground: View {
    var body: some View {
        ZStack {
            LinearGradient(colors: [Theme.skyTop, Theme.snow], startPoint: .top, endPoint: .bottom)
            GeometryReader { geo in
                ForEach(0..<14, id: \.self) { i in
                    let seed = Double(i)
                    Image(systemName: "snowflake")
                        .font(.system(size: 14 + CGFloat(i % 4) * 8))
                        .foregroundStyle(.white.opacity(0.18 + 0.05 * Double(i % 3)))
                        .position(x: geo.size.width * ((seed * 0.37).truncatingRemainder(dividingBy: 1)),
                                  y: geo.size.height * ((seed * 0.23 + 0.07).truncatingRemainder(dividingBy: 0.9)))
                }
            }
            .accessibilityHidden(true)
        }
        .ignoresSafeArea()
    }
}

struct Card<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        content
            .padding(28)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
            .shadow(color: .black.opacity(0.08), radius: 18, y: 8)
    }
}

extension Font {
    static func cozy(_ style: Font.TextStyle, weight: Font.Weight = .regular) -> Font {
        .system(style, design: .rounded, weight: weight)
    }
}

enum ByteFormat {
    static func string(_ bytes: Int64?) -> String {
        guard let bytes else { return "Not known yet" }
        return ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }
}
