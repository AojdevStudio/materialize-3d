import XCTest

/// The simulator proof of drafts and reconnects: a photo and message written while the computer is out of reach
/// survive a relaunch with Send off, reconnecting turns Send on and sends nothing until the tap, and a send whose
/// answer is lost makes one job. `scripts/mobile/sim-proof.sh` runs it after the pairing proof, against
/// `scripts/mobile/link-lever.ts`, whose link proxy this test takes down and brings back through its control port.
/// The newest picture in Photos is the one the draft takes. Each test leaves the state the next one starts from.
final class DraftAndReconnectUITests: XCTestCase {
    private let app = XCUIApplication()
    private let environment = ProcessInfo.processInfo.environment
    private var web: XCUIElement { app.webViews.firstMatch }
    private var chat: String { environment["M3D_CHAT"] ?? "Desk cable clip" }
    private var device: String { UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone" }
    private let draft = "Make the clip 2 mm thicker"

    override func setUp() {
        continueAfterFailure = false
        app.launchEnvironment["OS_ACTIVITY_DT_MODE"] = "NO"
    }

    // MARK: The link proxy

    /// Calls the lever's control port, which the simulator reaches on the Mac's loopback.
    @discardableResult
    private func link(_ command: String) -> Data {
        let port = environment["M3D_LINK_CONTROL"] ?? "47392"
        let url = URL(string: "http://127.0.0.1:\(port)/\(command)")!
        let done = expectation(description: command)
        var answer = Data()
        URLSession.shared.dataTask(with: url) { data, response, error in
            XCTAssertNil(error, "the link proxy answers \(command)")
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200, command)
            answer = data ?? Data()
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 10)
        return answer
    }

    /// Every request the proxy saw since the last clear, as "METHOD /path".
    private func requests() -> [String] {
        (try? JSONDecoder().decode([String].self, from: link("log"))) ?? []
    }

    private func writes(_ seen: [String]) -> [String] {
        seen.filter { $0.hasSuffix("/draft") || $0.hasSuffix("/send") }
    }

    // MARK: The screen

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

    private func text(_ label: String) -> XCUIElement { web.staticTexts[label] }
    private var send: XCUIElement { web.buttons["Send"] }
    private var message: XCUIElement { web.textViews.firstMatch }
    private var removePhoto: XCUIElement { web.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Remove'")).firstMatch }

    private func count(_ label: String) -> Int { web.staticTexts.matching(NSPredicate(format: "label == %@", label)).count }

    private func waitUntil(_ what: String, timeout: TimeInterval = 30, _ holds: () -> Bool) {
        let deadline = Date().addingTimeInterval(timeout)
        while !holds() {
            if Date() > deadline { return XCTFail("\(what) in \(Int(timeout)) s") }
            RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        }
    }

    /// Launches the app and opens the chat from its list, which the app keeps from the last time the computer answered.
    private func openChat() {
        app.launch()
        XCTAssertTrue(web.buttons[chat].waitForExistence(timeout: 60), "the chat list shows \(chat)")
        web.buttons[chat].tap()
        XCTAssertTrue(message.waitForExistence(timeout: 30), "the chat shows its composer")
    }

    private func pickNewestPhoto() {
        text("Add a photo").tap()
        app.buttons["Photo Library"].tap()
        let photos = app.images.matching(identifier: "PXGGridLayout-Info")
        XCTAssertTrue(photos.firstMatch.waitForExistence(timeout: 20), "the photo picker shows the pictures")
        photos.firstMatch.tap()
        if app.buttons["Done"].waitForExistence(timeout: 3) { app.buttons["Done"].tap() }
    }

    // MARK: The proof

    func test1ADraftWrittenWhileAwaySurvivesARelaunch() throws {
        link("up")
        openChat()
        XCTAssertTrue(text("Connected").waitForExistence(timeout: 30), "the link comes up first")
        link("down")
        let away = text("Computer not reachable")
        XCTAssertTrue(away.waitForExistence(timeout: 30), "the line says the computer is out of reach")
        XCTAssertFalse(send.isEnabled, "Send is off while the computer is away")

        message.tap()
        message.typeText(draft)
        pickNewestPhoto()
        XCTAssertTrue(removePhoto.waitForExistence(timeout: 20), "the draft holds the photo")
        let saved = text("Computer not reachable. Draft saved on this \(device)")
        XCTAssertTrue(saved.waitForExistence(timeout: 10), "the line says the draft is saved on this \(device)")
        XCTAssertFalse(send.isEnabled)
        // Past the text save's wait, as a person who puts the phone away.
        sleep(2)
        shot("10 draft written while the computer is away")

        app.terminate()
        openChat()
        XCTAssertTrue(saved.waitForExistence(timeout: 30), "after a relaunch, the line still says the draft is saved")
        XCTAssertEqual(message.value as? String, draft, "the message survives the relaunch")
        XCTAssertTrue(removePhoto.exists, "the photo survives the relaunch")
        XCTAssertFalse(send.isEnabled, "Send stays off")
        XCTAssertEqual(writes(requests()), [], "nothing was sent")
        shot("11 relaunched away from the computer, draft restored, Send off")
    }

    func test2ReconnectingTurnsSendOnAndNothingSendsBeforeTheTap() throws {
        openChat()
        XCTAssertTrue(text("Computer not reachable. Draft saved on this \(device)").waitForExistence(timeout: 30))
        XCTAssertEqual(message.value as? String, draft)
        link("clear-log")
        link("up")
        XCTAssertTrue(text("Connected").waitForExistence(timeout: 30), "the line turns to Connected")
        waitUntil("Send turns on") { send.isEnabled }
        // Long enough for a send that should not happen to show in the log.
        sleep(4)
        let before = requests()
        note("requests before the tap", before.joined(separator: "\n"))
        XCTAssertEqual(writes(before), [], "no draft or send went out before the tap")
        XCTAssertTrue(before.contains("GET /api/v1/events"), "the phone reconnected through the proxy")
        shot("20 reconnected, Send on, nothing sent")

        let answers = count("answered by faux-a")
        send.tap()
        waitUntil("the computer answers the message") { count("answered by faux-a") == answers + 1 }
        XCTAssertEqual(count(draft), 1, "the message shows once")
        let after = requests()
        note("requests after the tap", after.joined(separator: "\n"))
        XCTAssertEqual(writes(after).filter { $0.hasPrefix("POST") }.count, 1, "one send post")
        XCTAssertFalse(removePhoto.exists, "the sent draft is gone")
        shot("21 sent after the tap, one answer")
    }

    func test3ASendWhoseAnswerIsLostMakesOneJob() throws {
        link("up")
        openChat()
        XCTAssertTrue(text("Connected").waitForExistence(timeout: 30))
        let second = "Now round the edges"
        message.tap()
        message.typeText(second)
        waitUntil("Send turns on") { send.isEnabled }
        let answers = count("answered by faux-a")
        link("clear-log")
        link("drop-next-send")
        send.tap()
        XCTAssertTrue(text("Sent, not confirmed yet. The app asks the computer when it is back.").waitForExistence(timeout: 30), "the send waits to be confirmed")
        XCTAssertTrue(text("Computer not reachable").waitForExistence(timeout: 30) || text("Computer not reachable. Draft saved on this \(device)").exists)
        XCTAssertFalse(send.isEnabled, "no retry is offered before the computer is asked")
        shot("30 send went out, answer lost, not confirmed")

        link("up")
        XCTAssertTrue(text("Connected").waitForExistence(timeout: 30))
        waitUntil("the computer's answer shows") { count("answered by faux-a") == answers + 1 }
        waitUntil("the composer empties") { (message.value as? String ?? "") == "" }
        // Past a second answer that should not come.
        sleep(4)
        XCTAssertEqual(count("answered by faux-a"), answers + 1, "one answer")
        XCTAssertEqual(count(second), 1, "the message shows once")
        let seen = requests()
        note("requests", seen.joined(separator: "\n"))
        XCTAssertEqual(seen.filter { $0.hasPrefix("POST") && $0.hasSuffix("/send") }.count, 1, "one send post")
        XCTAssertTrue(seen.contains { $0.contains("/sends/") }, "the phone asked about its send by its revision")
        shot("31 reconnected, the one message and its one answer")
    }
}
