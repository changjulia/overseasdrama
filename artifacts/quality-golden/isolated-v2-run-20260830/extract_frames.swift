import Foundation
import AVFoundation
import AppKit

guard CommandLine.arguments.count >= 3 else { exit(2) }
let input = CommandLine.arguments[1]
let outDir = CommandLine.arguments[2]
let asset = AVURLAsset(url: URL(fileURLWithPath: input))
let duration = CMTimeGetSeconds(asset.duration)
let generator = AVAssetImageGenerator(asset: asset)
generator.appliesPreferredTrackTransform = true
generator.requestedTimeToleranceBefore = .zero
generator.requestedTimeToleranceAfter = .zero

let baseTimes: [Double] = [0, 1, 2, 3, 5, 8, 12, 15, 18, 21, 24, 27, 30, 33, 36, 39, 42, 45, 48, 50, 54, 58, 62, 70, 90, 120]
let fracTimes = [0.25, 0.5, 0.75, 0.95].map { duration * $0 }
let times = Array(Set((baseTimes + fracTimes).filter { $0 < duration })).sorted()
try FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)
var emitted: [[String: Any]] = []
for sec in times {
    do {
        let result = try generator.copyCGImage(at: CMTime(seconds: sec, preferredTimescale: 600), actualTime: nil)
        let bitmap = NSBitmapImageRep(cgImage: result)
        if let data = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.9]) {
            let name = String(format: "frame-%08.3f.jpg", sec)
            try data.write(to: URL(fileURLWithPath: outDir).appendingPathComponent(name))
            emitted.append(["time": sec, "file": name, "width": result.width, "height": result.height])
        }
    } catch {
        emitted.append(["time": sec, "error": String(describing: error)])
    }
}
let payload: [String: Any] = [
    "input": input,
    "durationSeconds": duration,
    "frames": emitted
]
let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
try data.write(to: URL(fileURLWithPath: outDir).appendingPathComponent("metadata.json"))
print(String(data: data, encoding: .utf8)!)
