import XCTest

/// The simulator proof of the mobile shell: pair from a picture of the computer's code, open a chat's model files, and
/// relaunch without pairing again. `scripts/mobile/sim-proof.sh` runs it on a fresh simulator against a computer whose
/// service is reachable, with a picture of that computer's pairing code as the newest picture in Photos.
final class PairAndViewUITests: XCTestCase {
    private let app = XCUIApplication()
    private let environment = ProcessInfo.processInfo.environment
    private var web: XCUIElement { app.webViews.firstMatch }

    override func setUp() {
        continueAfterFailure = false
        // Tauri copies stderr into the system log, and this mode copies the log back to stderr: a loop that stalls the app.
        app.launchEnvironment["OS_ACTIVITY_DT_MODE"] = "NO"
    }

    private func shot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func note(_ name: String, _ text: String) {
        let attachment = XCTAttachment(string: text)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// A setting from the proof script, which passes an unset one as empty.
    private func setting(_ name: String) -> String? {
        environment[name].flatMap { $0.isEmpty ? nil : $0 }
    }

    private func text(_ label: String) -> XCUIElement { web.staticTexts[label] }

    /// The last line of text on screen, where the window shows an error.
    private func lastLine() -> String {
        web.staticTexts.allElementsBoundByIndex.last?.label ?? ""
    }

    /// Opens the photo picker from the pairing screen and picks the newest picture.
    private func pickNewestPicture() {
        text("Choose a picture of the code").tap()
        app.buttons["Photo Library"].tap()
        let photos = app.images.matching(identifier: "PXGGridLayout-Info")
        XCTAssertTrue(photos.firstMatch.waitForExistence(timeout: 20), "the photo picker shows the pictures")
        photos.firstMatch.tap()
        // The iOS 27 picker marks the choice and waits for Done.
        if app.buttons["Done"].waitForExistence(timeout: 3) { app.buttons["Done"].tap() }
    }

    func testPairFromAPictureOpenTheModelsAndRelaunch() throws {
        // The computer, one of its chats with model files, and a line of that chat, as the proof script passes them.
        let computer = try XCTUnwrap(setting("M3D_COMPUTER"), "set M3D_COMPUTER")
        let chat = try XCTUnwrap(setting("M3D_CHAT"), "set M3D_CHAT")
        let line = try XCTUnwrap(setting("M3D_LINE"), "set M3D_LINE")
        let expected = try XCTUnwrap(setting("M3D_MODELS"), "set M3D_MODELS").split(separator: ";").map(String.init)
        XCTAssertFalse(expected.isEmpty, "M3D_MODELS names no model file")

        app.launch()
        XCTAssertTrue(text("Pair with your computer").waitForExistence(timeout: 60))
        // The accessibility tree can lead the first paint.
        sleep(1)
        shot("01 pairing screen")

        // The simulator has no camera, so the native scanner can only say so.
        web.buttons["Scan the code"].tap()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        if springboard.alerts.firstMatch.waitForExistence(timeout: 5) {
            note("camera alert", springboard.alerts.firstMatch.label)
            springboard.alerts.buttons.element(boundBy: 1).tap()
        }
        sleep(3)
        shot("02 camera scan on a simulator")
        note("camera scan result", lastLine())
        if web.buttons["Cancel"].exists { web.buttons["Cancel"].tap() }

        pickNewestPicture()
        XCTAssertTrue(web.buttons[chat].waitForExistence(timeout: 30), "paired with \(computer): \(lastLine())")
        XCTAssertTrue(text(computer).exists)
        shot("03 paired, the computer's chats")

        web.buttons[chat].tap()
        // The file buttons carry aria-pressed, so the web view shows them as switches.
        XCTAssertTrue(web.switches.firstMatch.waitForExistence(timeout: 30), "the chat lists its model files")
        // The transcript loads apart from the model files.
        XCTAssertTrue(text(line).waitForExistence(timeout: 30), "the chat shows its transcript")
        for name in expected {
            let model = web.switches[name]
            XCTAssertTrue(model.exists, "the chat lists \(name)")
            model.tap()
            // ModelView names itself after the file, without its folder, once that file is drawn.
            let file = name.split(separator: "/").last.map(String.init) ?? name
            XCTAssertTrue(web.otherElements["3D model \(file)"].waitForExistence(timeout: 90), "\(name) draws: \(lastLine())")
            shot("04 model \(name)")
        }
        let view = web.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3))
        view.press(forDuration: 0.1, thenDragTo: web.coordinate(withNormalizedOffset: CGVector(dx: 0.15, dy: 0.25)))
        sleep(1)
        shot("05 orbited")

        app.terminate()
        app.launch()
        XCTAssertTrue(web.buttons[chat].waitForExistence(timeout: 60), "a relaunch opens on the paired computer's chats")
        XCTAssertFalse(text("Pair with your computer").exists)
        shot("06 relaunched, still paired")
    }

    /// Runs after the proof script resets the simulator's Keychain: the pairing lived there, so it is gone.
    func testAKeychainResetForgetsThePairing() throws {
        app.launch()
        XCTAssertTrue(text("Pair with your computer").waitForExistence(timeout: 60))
        shot("07 after a Keychain reset, pair again")
    }
}
