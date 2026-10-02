// Stage A probe: can this host virtualize a given macOS restore image (macOS 13.0 for the app's
// LSMinimumSystemVersion), install it, and boot it far enough to prove the guest kernel and
// userspace run? Usage, from the directory that holds the image and bundle:
//   macos13-guest inspect <restore.ipsw>
//   macos13-guest install <restore.ipsw> <bundle-dir>
//   macos13-guest boot <bundle-dir> <seconds>
// The boot proof is a DHCP lease for the VM's fixed MAC address that changes in /var/db/dhcpd_leases during the boot: a guest
// stuck before kernel boot (the 2024 M4 failure) never asks for one.
import Foundation
import Virtualization

let mac = "02:6d:33:64:13:00"

func fail(_ msg: String) -> Never { FileHandle.standardError.write(Data("error: \(msg)\n".utf8)); exit(1) }

func loadImage(_ path: String, _ done: @escaping (VZMacOSRestoreImage) -> Void) {
    VZMacOSRestoreImage.load(from: URL(fileURLWithPath: path)) { result in
        switch result {
        case .success(let image): DispatchQueue.main.async { done(image) }
        case .failure(let error): fail("load restore image: \(error)")
        }
    }
}

func config(bundle: URL, model: VZMacHardwareModel, machine: VZMacMachineIdentifier, aux: VZMacAuxiliaryStorage) throws -> VZVirtualMachineConfiguration {
    let platform = VZMacPlatformConfiguration()
    platform.hardwareModel = model
    platform.machineIdentifier = machine
    platform.auxiliaryStorage = aux
    let c = VZVirtualMachineConfiguration()
    c.platform = platform
    c.bootLoader = VZMacOSBootLoader()
    c.cpuCount = 4
    c.memorySize = 8 << 30
    let gfx = VZMacGraphicsDeviceConfiguration()
    gfx.displays = [VZMacGraphicsDisplayConfiguration(widthInPixels: 1920, heightInPixels: 1080, pixelsPerInch: 80)]
    c.graphicsDevices = [gfx]
    let disk = try VZDiskImageStorageDeviceAttachment(url: bundle.appendingPathComponent("disk.img"), readOnly: false)
    c.storageDevices = [VZVirtioBlockDeviceConfiguration(attachment: disk)]
    let net = VZVirtioNetworkDeviceConfiguration()
    net.attachment = VZNATNetworkDeviceAttachment()
    net.macAddress = VZMACAddress(string: mac)!
    c.networkDevices = [net]
    c.keyboards = [VZUSBKeyboardConfiguration()]
    c.pointingDevices = [VZUSBScreenCoordinatePointingDeviceConfiguration()]
    try c.validate()
    return c
}

final class Watcher: NSObject, VZVirtualMachineDelegate {
    func guestDidStop(_ vm: VZVirtualMachine) { print("guest stopped itself"); exit(0) }
    func virtualMachine(_ vm: VZVirtualMachine, didStopWithError error: Error) { fail("vm stopped with error: \(error)") }
}

func leaseFor(_ mac: String) -> String? {
    // The lease file drops leading zeros in each octet.
    let short = mac.split(separator: ":").map { String(Int($0, radix: 16)!, radix: 16) }.joined(separator: ":")
    guard let text = try? String(contentsOfFile: "/var/db/dhcpd_leases", encoding: .utf8) else { return nil }
    for block in text.components(separatedBy: "}") where block.contains("hw_address=1,\(short)") {
        return block.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { $0.hasPrefix("ip_address=") || $0.hasPrefix("lease=") }.joined(separator: " ")
    }
    return nil
}

setvbuf(stdout, nil, _IOLBF, 0)  // line-buffered so a killed run still leaves its log
let args = CommandLine.arguments
guard args.count >= 3 else { fail("usage: inspect <ipsw> | install <ipsw> <bundle> | boot <bundle> <seconds>") }
print("host: \(ProcessInfo.processInfo.operatingSystemVersionString), VZVirtualMachine.isSupported=\(VZVirtualMachine.isSupported)")
let watcher = Watcher()
var keep: AnyObject?

switch args[1] {
case "inspect":
    loadImage(args[2]) { image in
        let v = image.operatingSystemVersion
        print("image: macOS \(v.majorVersion).\(v.minorVersion).\(v.patchVersion) build \(image.buildVersion) isSupported=\(image.isSupported)")
        guard let req = image.mostFeaturefulSupportedConfiguration else { print("mostFeaturefulSupportedConfiguration: nil (this host cannot virtualize this image)"); exit(2) }
        print("hardwareModel.isSupported=\(req.hardwareModel.isSupported) minCPU=\(req.minimumSupportedCPUCount) minMemoryMiB=\(req.minimumSupportedMemorySize >> 20)")
        exit(0)
    }
case "install":
    guard args.count >= 4 else { fail("install needs <ipsw> <bundle>") }
    let bundle = URL(fileURLWithPath: args[3], isDirectory: true)
    loadImage(args[2]) { image in
        guard let req = image.mostFeaturefulSupportedConfiguration, req.hardwareModel.isSupported else { fail("image not supported on this host") }
        do {
            try FileManager.default.createDirectory(at: bundle, withIntermediateDirectories: true)
            let machine = VZMacMachineIdentifier()
            try req.hardwareModel.dataRepresentation.write(to: bundle.appendingPathComponent("hardware-model.bin"))
            try machine.dataRepresentation.write(to: bundle.appendingPathComponent("machine-id.bin"))
            let aux = try VZMacAuxiliaryStorage(creatingStorageAt: bundle.appendingPathComponent("aux.img"), hardwareModel: req.hardwareModel, options: [])
            let diskURL = bundle.appendingPathComponent("disk.img")
            FileManager.default.createFile(atPath: diskURL.path, contents: nil)
            let h = try FileHandle(forWritingTo: diskURL); try h.truncate(atOffset: 48 << 30); try h.close()
            let vm = VZVirtualMachine(configuration: try config(bundle: bundle, model: req.hardwareModel, machine: machine, aux: aux))
            let installer = VZMacOSInstaller(virtualMachine: vm, restoringFromImageAt: URL(fileURLWithPath: args[2]))
            let started = Date()
            keep = installer.progress.observe(\.fractionCompleted, options: [.new]) { p, _ in
                let pct = Int(p.fractionCompleted * 100)
                if pct % 10 == 0 { print("install \(pct)% at \(Int(Date().timeIntervalSince(started)))s") }
            }
            installer.install { result in
                switch result {
                case .success: print("install: ok in \(Int(Date().timeIntervalSince(started)))s"); exit(0)
                case .failure(let error): fail("install: \(error)")
                }
            }
        } catch { fail("install setup: \(error)") }
    }
case "boot":
    guard args.count >= 4, let seconds = Double(args[3]) else { fail("boot needs <bundle> <seconds>") }
    let bundle = URL(fileURLWithPath: args[2], isDirectory: true)
    do {
        guard let model = VZMacHardwareModel(dataRepresentation: try Data(contentsOf: bundle.appendingPathComponent("hardware-model.bin"))),
              let machine = VZMacMachineIdentifier(dataRepresentation: try Data(contentsOf: bundle.appendingPathComponent("machine-id.bin"))) else { fail("bad bundle") }
        let aux = VZMacAuxiliaryStorage(url: bundle.appendingPathComponent("aux.img"))
        let vm = VZVirtualMachine(configuration: try config(bundle: bundle, model: model, machine: machine, aux: aux))
        vm.delegate = watcher
        keep = vm
        // A lease left by an earlier boot is not proof; only a lease that changes during this boot counts.
        let before = leaseFor(mac)
        print("lease before boot: \(before ?? "none")")
        let started = Date()
        vm.start { result in
            if case .failure(let error) = result { fail("start: \(error)") }
            print("vm started, state=\(vm.state.rawValue)")
            var reported = false
            // dispatchMain() does not run the main run loop, so poll with a dispatch timer, not Timer.
            let timer = DispatchSource.makeTimerSource(queue: .main)
            timer.schedule(deadline: .now() + 1, repeating: 1)
            timer.setEventHandler {
                let elapsed = Date().timeIntervalSince(started)
                let now = leaseFor(mac)
                if !reported, let now, now != before { reported = true; print(String(format: "DHCP lease changed at %.0fs after start: %@", elapsed, now)) }
                if elapsed >= seconds {
                    timer.cancel()
                    print("final: state=\(vm.state.rawValue) leaseChangedDuringBoot=\(reported)")
                    vm.stop { _ in exit(reported ? 0 : 3) }
                }
            }
            timer.resume()
            keep = [vm, timer] as NSArray
        }
    } catch { fail("boot setup: \(error)") }
default:
    fail("unknown command \(args[1])")
}
dispatchMain()
