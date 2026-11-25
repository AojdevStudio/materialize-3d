import XCTest

/// The simulator proof of the Phase 3 phone and tablet layouts: tabs on iPhone, the model beside the chat on iPad, the
/// Lead and Helper pickers in the composer, and the model viewer. `scripts/mobile/layout-proof.sh` runs it on a fresh
/// simulator against `sidecar/test/fixtures/scripted-computer.ts`, whose one chat holds a saved handoff from lead
/// Astra to helper gpt-6.3-sol, with the chat's pairing code as the newest picture in Photos.
final class LayoutsAndRolesUITests: XCTestCase {
    private let app = XCUIApplication()
    private var web: XCUIElement { app.webViews.firstMatch }
    private var iPad: Bool { UIDevice.current.userInterfaceIdiom == .pad }

    /// The saved handoff, and the one the next message makes once the lead and then the helper change, as the chat
    /// reads them in order: role, model, role, model.
    private let saved = ["Lead", "Astra", "asked", "helper", "gpt-6.3-sol"]
    private let next = ["Lead", "gpt-6.3-sol", "asked", "helper", "Astra"]

    override func setUp() {
        continueAfterFailure = false
        // Tauri copies stderr into the system log, and this mode copies the log back to stderr: a loop that stalls the app.
        app.launchEnvironment["OS_ACTIVITY_DT_MODE"] = "NO"
        XCUIDevice.shared.orientation = .portrait
    }

    private func shot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "\(iPad ? "iPad" : "iPhone") \(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// The first control on screen with this label, whichever role the web view gives it. The web view gives a picker,
    /// a button that opens a menu, no button role, so `other` counts too. Text never does.
    private func control(_ label: String, at index: Int = 0) -> XCUIElement {
        web.descendants(matching: .any).matching(NSPredicate(format: "label == %@ AND elementType IN %@", label, [
            XCUIElement.ElementType.button.rawValue, XCUIElement.ElementType.tab.rawValue, XCUIElement.ElementType.menuItem.rawValue,
            XCUIElement.ElementType.radioButton.rawValue, XCUIElement.ElementType.popUpButton.rawValue, XCUIElement.ElementType.other.rawValue,
        ])).element(boundBy: index)
    }

    private func tap(_ label: String, at index: Int = 0) {
        let found = control(label, at: index)
        if !found.waitForExistence(timeout: 20) {
            // What the web view shows instead, to tell a renamed control from a missing one.
            let tree = XCTAttachment(string: web.debugDescription)
            tree.name = "web view when \(label) was missing"
            tree.lifetime = .keepAlways
            add(tree)
            XCTFail("no control \(label)")
        }
        found.tap()
    }

    /// Every line of text the chat shows, in order, read from one snapshot of the web view, so a redraw while it reads
    /// cannot pull an element out from under it. Empty when the snapshot could not be taken.
    private func lines() -> [String] {
        func texts(_ node: XCUIElementSnapshot) -> [String] {
            (node.elementType == .staticText ? [node.label] : []) + node.children.flatMap(texts)
        }
        return (try? web.snapshot()).map(texts) ?? []
    }

    /// How many times `run` appears in order, back to back, in `lines`.
    private func count(_ run: [String], in lines: [String]) -> Int {
        guard lines.count >= run.count else { return 0 }
        return (0...(lines.count - run.count)).filter { Array(lines[$0..<($0 + run.count)]) == run }.count
    }

    private func pickNewestPicture() {
        // Unit 5 makes this a button over a hidden file input. Its label finds it whatever role the web view gives it.
        web.buttons["Choose a picture of the code"].tap()
        app.buttons["Photo Library"].tap()
        let photos = app.images.matching(identifier: "PXGGridLayout-Info")
        XCTAssertTrue(photos.firstMatch.waitForExistence(timeout: 20), "the photo picker shows the pictures")
        photos.firstMatch.tap()
        if app.buttons["Done"].waitForExistence(timeout: 3) { app.buttons["Done"].tap() }
    }

    private func openChat() {
        let chat = control("make the project")
        XCTAssertTrue(chat.waitForExistence(timeout: 30), "the paired computer lists its chat")
        chat.tap()
        XCTAssertTrue(web.staticTexts["parent saw: gpt-6.3-sol drew it"].waitForExistence(timeout: 30), "the chat opens")
    }

    /// Drags across the viewer, and fails unless the web view looks different after it, so a viewer that never drew or
    /// never turns cannot pass.
    private func orbit(from start: CGVector, to end: CGVector) {
        let before = web.screenshot().pngRepresentation
        web.coordinate(withNormalizedOffset: start).press(forDuration: 0.1, thenDragTo: web.coordinate(withNormalizedOffset: end))
        sleep(1)
        XCTAssertNotEqual(web.screenshot().pngRepresentation, before, "the drag turns the model")
    }

    private var viewer: XCUIElement { web.images["3D model cube-p2s-petg.3mf"] }

    /// Waits until the viewer drew the model, which only then shows as an image named for its file.
    private func modelDrawn() {
        XCTAssertTrue(viewer.waitForExistence(timeout: 30), "the viewer draws the model: \(lines())")
    }

    /// The mean difference per color channel between two screenshots of the same element, from 0 to 255.
    private func difference(_ one: XCUIScreenshot, _ other: XCUIScreenshot) throws -> Double {
        func pixels(_ shot: XCUIScreenshot) throws -> [UInt8] {
            let image = try XCTUnwrap(shot.image.cgImage)
            var bytes = [UInt8](repeating: 0, count: image.width * image.height * 4)
            // The context draws into the bytes only while their pointer is valid, inside this closure.
            let drawn = bytes.withUnsafeMutableBytes { buffer in
                guard let context = CGContext(data: buffer.baseAddress, width: image.width, height: image.height, bitsPerComponent: 8,
                    bytesPerRow: image.width * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
                else { return false }
                context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
                return true
            }
            XCTAssertTrue(drawn, "the screenshot draws into a bitmap")
            return bytes
        }
        let (a, b) = (try pixels(one), try pixels(other))
        XCTAssertEqual(a.count, b.count, "both screenshots have the viewer's size")
        let total = zip(a, b).reduce(0) { $0 + abs(Int($1.0) - Int($1.1)) }
        return Double(total) / Double(a.count)
    }

    /// Orbits, taps Reset view, and fails unless the viewer then looks far closer to its first angle than the orbit left
    /// it, so a Reset that does nothing cannot pass. Redrawing the same angle is not pixel for pixel, so this compares
    /// how far each view is from the first.
    private func orbitThenReset(from start: CGVector, to end: CGVector, orbited: String, reset: String) throws {
        let first = viewer.screenshot()
        orbit(from: start, to: end)
        let turned = try difference(first, viewer.screenshot())
        shot(orbited)
        tap("Reset view")
        sleep(3)
        let back = try difference(first, viewer.screenshot())
        let note = XCTAttachment(string: "\(reset): the orbit moved \(turned), and after Reset the view is \(back) from the first angle")
        note.lifetime = .keepAlways
        add(note)
        XCTAssertLessThan(back, turned / 4, "Reset view turns the model back to its first angle: the orbit moved \(turned), Reset left \(back)")
        shot(reset)
    }

    func testLayoutsRolesAndViewer() throws {
        app.launch()
        XCTAssertTrue(web.staticTexts["Pair with your computer"].waitForExistence(timeout: 60))
        pickNewestPicture()
        openChat()
        sleep(4)
        XCTAssertEqual(count(saved, in: lines()), 1, "the saved handoff names its own pair: \(lines())")

        if iPad {
            XCTAssertFalse(control("Model").exists, "the iPad shows no tabs")
            XCTAssertTrue(web.switches["cube-p2s-petg.3mf"].exists, "the iPad shows the model beside the chat")
            modelDrawn()
            sleep(2)
            shot("01 portrait, model above the chat")
            try orbitThenReset(from: CGVector(dx: 0.5, dy: 0.2), to: CGVector(dx: 0.2, dy: 0.18), orbited: "02 portrait, orbited", reset: "02b portrait, view reset")
            XCUIDevice.shared.orientation = .landscapeLeft
            sleep(3)
            shot("03 landscape, chat beside the model")
            try orbitThenReset(from: CGVector(dx: 0.75, dy: 0.5), to: CGVector(dx: 0.55, dy: 0.45), orbited: "04 landscape, orbited", reset: "05 landscape, view reset")
        } else {
            shot("01 chat tab")
            tap("Model")
            XCTAssertTrue(web.switches["cube-p2s-petg.3mf"].waitForExistence(timeout: 10), "the Model tab names the file it shows")
            modelDrawn()
            sleep(4)
            XCTAssertEqual(count(saved, in: lines()), 1, "the Model tab keeps the newest handoff line under the part")
            shot("02 model tab, newest handoff under the part")
            try orbitThenReset(from: CGVector(dx: 0.5, dy: 0.4), to: CGVector(dx: 0.15, dy: 0.35), orbited: "03 model tab, orbited", reset: "04 model tab, view reset")
            tap("Chat")
        }

        // The lead first, then the helper, for the next message.
        tap("Lead: Astra")
        tap("GPT 6.3 Sol")
        sleep(2)
        shot("06 lead changed")
        tap("Helper: gpt-6.3-sol")
        XCTAssertTrue(control("No helper").waitForExistence(timeout: 10), "the helper menu offers No helper")
        shot("07 helper menu")
        tap("Astra")
        sleep(2)
        shot("08 helper changed")

        let message = web.textViews.firstMatch
        message.tap()
        message.typeText("ask: Draw it as an HTML page.")
        tap("Send")
        sleep(8)
        // Opening the chat again reads it as the computer saved it.
        tap("Chats")
        openChat()
        // Read the chat again each second until the new handoff shows, for up to 30 seconds.
        var waited = 0
        while count(next, in: lines()) != 1 && waited < 30 {
            sleep(1)
            waited += 1
        }
        XCTAssertEqual(count(next, in: lines()), 1, "the next handoff names the new pair: \(lines())")
        XCTAssertEqual(count(saved, in: lines()), 1, "the saved handoff keeps its own pair: \(lines())")
        shot("09 next handoff names the new pair, the saved one keeps its own")
    }
}
