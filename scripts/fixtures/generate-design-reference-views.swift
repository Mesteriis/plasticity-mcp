#!/usr/bin/env swift
import AppKit
import Foundation

let output = CommandLine.arguments.dropFirst().first
    .map { URL(fileURLWithPath: $0, isDirectory: true) }
    ?? URL(fileURLWithPath: "scripts/fixtures/design-reference-views", isDirectory: true)
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)

let ink = NSColor(calibratedWhite: 0.12, alpha: 1)
let muted = NSColor(calibratedWhite: 0.55, alpha: 1)
let font = NSFont.systemFont(ofSize: 22, weight: .semibold)
let canvas = NSSize(width: 768, height: 512)

func line(_ points: [NSPoint], width: CGFloat = 7, color: NSColor = ink, close: Bool = false) {
    let path = NSBezierPath()
    path.lineWidth = width
    path.lineCapStyle = .round
    path.lineJoinStyle = .round
    path.move(to: points[0])
    for point in points.dropFirst() { path.line(to: point) }
    if close { path.close() }
    color.setStroke()
    path.stroke()
}

func rect(_ rect: NSRect, width: CGFloat = 7, color: NSColor = ink) {
    let path = NSBezierPath(rect: rect)
    path.lineWidth = width
    color.setStroke()
    path.stroke()
}

func circle(_ center: NSPoint, radius: CGFloat, width: CGFloat = 7) {
    let path = NSBezierPath(ovalIn: NSRect(x: center.x-radius, y: center.y-radius, width: radius*2, height: radius*2))
    path.lineWidth = width
    ink.setStroke()
    path.stroke()
}

func label(_ text: String, at point: NSPoint, size: CGFloat = 22, color: NSColor = ink) {
    (text as NSString).draw(at: point, withAttributes: [.font: NSFont.systemFont(ofSize: size, weight: .semibold), .foregroundColor: color])
}

func draw(_ name: String, _ title: String, body: (NSRect) -> Void) throws {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(canvas.width), pixelsHigh: Int(canvas.height), bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    NSColor.white.setFill()
    NSRect(origin: .zero, size: canvas).fill()
    label(title, at: NSPoint(x: 42, y: 450), size: 25)
    line([NSPoint(x: 42, y: 430), NSPoint(x: 726, y: 430)], width: 2, color: muted)
    body(NSRect(x: 80, y: 70, width: 608, height: 330))
    NSGraphicsContext.current?.flushGraphics()
    NSGraphicsContext.restoreGraphicsState()
    let data = bitmap.representation(using: .png, properties: [:])!
    try data.write(to: output.appendingPathComponent(name), options: .atomic)
}

// All four views describe the same unscaled, gusseted L-bracket fixture.
try draw("view-1-front.png", "VIEW 1  /  FRONT PLATE", body: { _ in
    rect(NSRect(x: 260, y: 92, width: 248, height: 292))
    circle(NSPoint(x: 384, y: 180), radius: 25)
    circle(NSPoint(x: 384, y: 295), radius: 25)
    line([NSPoint(x: 384, y: 150), NSPoint(x: 384, y: 325)], width: 2, color: muted)
    label("TWO ROUND HOLES", at: NSPoint(x: 278, y: 45), size: 17, color: muted)
})

try draw("view-2-side.png", "VIEW 2  /  SIDE PROFILE", body: { _ in
    line([NSPoint(x: 242, y: 95), NSPoint(x: 550, y: 95), NSPoint(x: 550, y: 153), NSPoint(x: 342, y: 153), NSPoint(x: 342, y: 375), NSPoint(x: 277, y: 375), NSPoint(x: 277, y: 153), NSPoint(x: 242, y: 153)], close: true)
    line([NSPoint(x: 342, y: 153), NSPoint(x: 456, y: 153), NSPoint(x: 342, y: 267)], close: true)
    line([NSPoint(x: 279, y: 376), NSPoint(x: 342, y: 376)], width: 2, color: muted)
    label("BENT FOOT + GUSSET", at: NSPoint(x: 350, y: 54), size: 17, color: muted)
})

try draw("view-3-top.png", "VIEW 3  /  TOP OF FOOT", body: { _ in
    rect(NSRect(x: 170, y: 124, width: 428, height: 205))
    rect(NSRect(x: 188, y: 282, width: 392, height: 48), width: 5)
    circle(NSPoint(x: 315, y: 205), radius: 24)
    circle(NSPoint(x: 495, y: 205), radius: 24)
    line([NSPoint(x: 170, y: 282), NSPoint(x: 598, y: 282)], width: 2, color: muted)
    label("FOOT  /  TWO MOUNTING HOLES", at: NSPoint(x: 208, y: 72), size: 17, color: muted)
})

try draw("view-4-detail.png", "VIEW 4  /  INNER CORNER DETAIL", body: { _ in
    line([NSPoint(x: 244, y: 96), NSPoint(x: 530, y: 96), NSPoint(x: 530, y: 163), NSPoint(x: 347, y: 163), NSPoint(x: 347, y: 372), NSPoint(x: 274, y: 372), NSPoint(x: 274, y: 163), NSPoint(x: 244, y: 163)], close: true)
    line([NSPoint(x: 347, y: 163), NSPoint(x: 465, y: 163), NSPoint(x: 347, y: 281)], close: true)
    let arc = NSBezierPath()
    arc.lineWidth = 3
    arc.appendArc(withCenter: NSPoint(x: 347, y: 163), radius: 44, startAngle: 0, endAngle: 90)
    muted.setStroke()
    arc.stroke()
    label("TRIANGULAR WEB", at: NSPoint(x: 394, y: 236), size: 17, color: muted)
})

print("Wrote four synthetic unscaled bracket views to \(output.path)")
