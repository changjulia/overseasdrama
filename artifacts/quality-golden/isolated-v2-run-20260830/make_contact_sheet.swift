import Foundation
import AppKit

guard CommandLine.arguments.count == 3 else { exit(2) }
let dir = CommandLine.arguments[1]
let output = CommandLine.arguments[2]
let files = try FileManager.default.contentsOfDirectory(atPath: dir)
    .filter { $0.hasPrefix("frame-") && $0.hasSuffix(".jpg") }.sorted()
let cellW = 240, cellH = 460, cols = 6
let rows = Int(ceil(Double(files.count) / Double(cols)))
let canvas = NSImage(size: NSSize(width: cols * cellW, height: rows * cellH))
canvas.lockFocus()
NSColor.black.setFill()
NSRect(x: 0, y: 0, width: cols * cellW, height: rows * cellH).fill()
for (i, name) in files.enumerated() {
    guard let img = NSImage(contentsOfFile: (dir as NSString).appendingPathComponent(name)) else { continue }
    let col = i % cols, row = i / cols
    let x = col * cellW, y = (rows - row - 1) * cellH
    img.draw(in: NSRect(x: x, y: y + 30, width: cellW, height: cellH - 30))
    let label = name.replacingOccurrences(of: "frame-", with: "").replacingOccurrences(of: ".jpg", with: "s")
    (label as NSString).draw(at: NSPoint(x: x + 6, y: y + 7), withAttributes: [.foregroundColor: NSColor.white, .font: NSFont.systemFont(ofSize: 15, weight: .bold)])
}
canvas.unlockFocus()
guard let tiff = canvas.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff), let data = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.88]) else { exit(3) }
try data.write(to: URL(fileURLWithPath: output))
