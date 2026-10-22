import Foundation
import UIKit
import Capacitor

private final class MobileDiagnosticStore {
    static let shared = MobileDiagnosticStore()
    private let queue = DispatchQueue(label: "com.aifenshen.mobilecompat.diagnostics", qos: .utility)
    private let maxRecordsPerCall = 64
    private let maxFileBytes = 256 * 1024
    private var enabled = false
    private let events: Set<String> = [
        "request_start", "request_headers", "request_end", "request_error",
        "media_start_call", "media_start", "media_data", "media_error",
        "media_pause_call", "media_pause", "media_resume_call", "media_resume",
        "media_stop_call", "media_stop", "media_get_user_media_call",
        "media_get_user_media_ready", "media_get_user_media_error",
        "viewport", "native_keyboard", "scenario"
    ]
    private let categories: Set<String> = [
        "auth", "meeting_gate", "learning_tts", "learning_asr",
        "voice_create", "voice_events", "voice_upload", "voice_control", "other_api"
    ]
    private let states: Set<String> = ["inactive", "recording", "paused", "unknown"]
    private let triggers: Set<String> = [
        "initial", "resize", "scroll", "focusin", "focusout",
        "keyboard_will_show_before", "keyboard_will_show_after",
        "keyboard_did_show_before", "keyboard_did_show_after",
        "keyboard_did_hide_before", "keyboard_did_hide_after"
    ]
    private let numberFields: Set<String> = [
        "atMs", "durationMs", "status", "bytes", "inflight", "innerHeight",
        "visualHeight", "offsetTop", "scrollY", "nativeOffsetY",
        "webViewHeight", "contentHeight", "keyboardHeight"
    ]
    private var folderURL: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("AI-Fenshen-Diagnostics", isDirectory: true)
    }
    private var fileURL: URL { folderURL.appendingPathComponent("compat-r08.jsonl") }

    private func prepareFolder() throws {
        try FileManager.default.createDirectory(at: folderURL, withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.complete, .posixPermissions: 0o700])
        var folder = folderURL
        var resource = URLResourceValues(); resource.isExcludedFromBackup = true
        try folder.setResourceValues(resource)
    }
    private func normalizedNumber(_ value: Any, maximum: Double = 9_007_199_254_740_991) -> NSNumber? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite else { return nil }
        return NSNumber(value: Int64(max(0, min(maximum, number.doubleValue)).rounded()))
    }
    private func matches(_ value: String, pattern: String) -> Bool {
        value.range(of: pattern, options: .regularExpression) != nil
    }
    private func sanitize(_ raw: [String: Any]) -> [String: Any]? {
        guard let event = raw["event"] as? String, events.contains(event) else { return nil }
        var clean: [String: Any] = ["event": event]
        for (key, value) in raw {
            if numberFields.contains(key), let number = normalizedNumber(value, maximum: key == "status" ? 999 : 9_007_199_254_740_991) {
                clean[key] = number
            } else if key == "category", let text = value as? String, categories.contains(text) {
                clean[key] = text
            } else if key == "state", let text = value as? String, states.contains(text) {
                clean[key] = text
            } else if key == "trigger", let text = value as? String, triggers.contains(text) {
                clean[key] = text
            } else if key == "mimeType", let text = value as? String, text.count <= 64,
                      matches(text, pattern: "^audio/(mp4|wav|webm)(;codecs=[A-Za-z0-9._-]+)?$") {
                clean[key] = text
            } else if key == "code", let text = value as? String,
                      matches(text, pattern: "^[A-Z][A-Z0-9_]{0,63}$") {
                clean[key] = text
            }
        }
        if clean["atMs"] == nil { clean["atMs"] = NSNumber(value: Int64(Date().timeIntervalSince1970 * 1000)) }
        return clean
    }
    private func appendSanitized(_ records: [[String: Any]]) throws -> Int {
        let clean = records.compactMap(sanitize)
        guard !clean.isEmpty else { return 0 }
        var payload = Data()
        for record in clean {
            payload.append(try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]))
            payload.append(0x0A)
        }
        guard payload.count <= maxFileBytes else { throw CocoaError(.fileWriteOutOfSpace) }
        try prepareFolder()
        let existingSize = (try? fileURL.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        if existingSize + payload.count > maxFileBytes || !FileManager.default.fileExists(atPath: fileURL.path) {
            try payload.write(to: fileURL, options: [.atomic, .completeFileProtection])
        } else {
            let handle = try FileHandle(forWritingTo: fileURL)
            defer { try? handle.close() }
            try handle.seekToEnd()
            try handle.write(contentsOf: payload)
        }
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete, .posixPermissions: 0o600], ofItemAtPath: fileURL.path)
        return clean.count
    }
    func reset(completion: @escaping (Bool) -> Void) {
        queue.async {
            do {
                try self.prepareFolder()
                try Data().write(to: self.fileURL, options: [.atomic, .completeFileProtection])
                try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete, .posixPermissions: 0o600], ofItemAtPath: self.fileURL.path)
                self.enabled = true
                DispatchQueue.main.async { completion(true) }
            } catch {
                self.enabled = false
                DispatchQueue.main.async { completion(false) }
            }
        }
    }
    func append(records: [JSObject], completion: @escaping (Int?) -> Void) {
        guard !records.isEmpty, records.count <= maxRecordsPerCall else { completion(nil); return }
        let raw = records.map { object in
            object.reduce(into: [String: Any]()) { result, entry in result[entry.key] = entry.value }
        }
        queue.async {
            guard self.enabled else { DispatchQueue.main.async { completion(nil) }; return }
            let count = try? self.appendSanitized(raw)
            DispatchQueue.main.async { completion(count) }
        }
    }
    func appendNativeKeyboard(trigger: String, webView: UIView?, scrollView: UIScrollView?, keyboardHeight: CGFloat) {
        queue.async {
            guard self.enabled else { return }
            let record: [String: Any] = [
                "event": "native_keyboard",
                "atMs": NSNumber(value: Int64(Date().timeIntervalSince1970 * 1000)),
                "trigger": trigger,
                "nativeOffsetY": NSNumber(value: max(0, scrollView?.contentOffset.y ?? 0)),
                "webViewHeight": NSNumber(value: max(0, webView?.bounds.height ?? 0)),
                "contentHeight": NSNumber(value: max(0, scrollView?.contentSize.height ?? 0)),
                "keyboardHeight": NSNumber(value: max(0, keyboardHeight))
            ]
            _ = try? self.appendSanitized([record])
        }
    }
}

@objc(MobileTransportPlugin)
public final class MobileTransportPlugin: CAPPlugin, CAPBridgedPlugin, URLSessionDataDelegate {
    public let identifier = "MobileTransportPlugin"
    public let jsName = "MobileTransport"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "request", returnType: CAPPluginReturnCallback),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearSessionCookie", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "fileContext", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "shareFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setChromeStyle", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "recordDiagnostics", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resetDiagnostics", returnType: CAPPluginReturnPromise)
    ]
    @objc func resetDiagnostics(_ call: CAPPluginCall) {
        MobileDiagnosticStore.shared.reset { success in
            if success { call.resolve() } else { call.reject("MOBILE_DIAGNOSTICS_RESET_FAILED") }
        }
    }
    @objc func recordDiagnostics(_ call: CAPPluginCall) {
        guard let records = call.getArray("records", JSObject.self), !records.isEmpty, records.count <= 64 else {
            call.reject("MOBILE_DIAGNOSTICS_INVALID"); return
        }
        MobileDiagnosticStore.shared.append(records: records) { count in
            if let count { call.resolve(["count": count]) } else { call.reject("MOBILE_DIAGNOSTICS_WRITE_FAILED") }
        }
    }
    @objc func setChromeStyle(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let light = call.getBool("light"),
                  let controller = self.bridge?.viewController as? CAPBridgeViewController else {
                call.reject("MOBILE_CHROME_STYLE_INVALID"); return
            }
            controller.setStatusBarStyle(light ? .lightContent : .darkContent)
            call.resolve()
        }
    }
    private var fileEpoch = UUID().uuidString
    private var exportCall: CAPPluginCall?
    private var exportFolder: URL?
    private var shareController: UIActivityViewController?
    private var exportRoot: URL { FileManager.default.temporaryDirectory.appendingPathComponent("AI-Fenshen-MobileExports", isDirectory: true) }
    public override func load() {
        // Only this plugin's disposable exports; never business or user-selected files.
        try? FileManager.default.removeItem(at: exportRoot)
    }
    private func finishExport(completed: Bool, error: String? = nil) {
        guard let call = exportCall else { return }
        exportCall = nil
        if let folder = exportFolder { try? FileManager.default.removeItem(at: folder) }
        exportFolder = nil
        shareController = nil
        if let error = error { call.reject(error) } else { call.resolve(["completed": completed]) }
    }
    private func invalidateExports() {
        fileEpoch = UUID().uuidString
        shareController?.dismiss(animated: false)
        finishExport(completed: false, error: "MOBILE_EXPORT_ACCOUNT_CHANGED")
    }
    @objc func fileContext(_ call: CAPPluginCall) {
        DispatchQueue.main.async { call.resolve(["epoch": self.fileEpoch]) }
    }
    @objc func shareFile(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard call.getString("epoch") == self.fileEpoch else { call.reject("MOBILE_EXPORT_ACCOUNT_CHANGED"); return }
            guard self.exportCall == nil else { call.reject("MOBILE_EXPORT_BUSY"); return }
            guard let name = call.getString("name"), !name.isEmpty, name.count <= 180,
                  name != ".", name != "..", !name.contains("/"), !name.contains("\\"),
                  name.rangeOfCharacter(from: .controlCharacters) == nil,
                  let encoded = call.getString("base64"), encoded.utf8.count <= 44739244,
                  let data = Data(base64Encoded: encoded), data.count <= 32 * 1024 * 1024
            else { call.reject("MOBILE_EXPORT_FILE_INVALID"); return }
            guard let presenter = self.bridge?.viewController, presenter.viewIfLoaded?.window != nil,
                  presenter.presentedViewController == nil else { call.reject("MOBILE_EXPORT_SCREEN_UNAVAILABLE"); return }
            let folder = self.exportRoot.appendingPathComponent(UUID().uuidString, isDirectory: true)
            do {
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true,
                    attributes: [.protectionKey: FileProtectionType.complete])
                let file = folder.appendingPathComponent(name)
                try data.write(to: file, options: [.atomic, .completeFileProtection])
                var resource = URLResourceValues(); resource.isExcludedFromBackup = true
                var excludedFolder = folder; try excludedFolder.setResourceValues(resource)
                let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
                sheet.completionWithItemsHandler = { [weak self] _, completed, _, error in
                    self?.finishExport(completed: completed, error: error == nil ? nil : "MOBILE_EXPORT_SHARE_FAILED")
                }
                if let popover = sheet.popoverPresentationController {
                    popover.sourceView = presenter.view
                    popover.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.maxY - 1, width: 1, height: 1)
                    popover.permittedArrowDirections = []
                }
                self.exportCall = call; self.exportFolder = folder; self.shareController = sheet
                presenter.present(sheet, animated: true)
            } catch {
                try? FileManager.default.removeItem(at: folder)
                call.reject("MOBILE_EXPORT_WRITE_FAILED")
            }
        }
    }
    private struct Pending { let id: String; let call: CAPPluginCall; let task: URLSessionDataTask; let memoryAuthGeneration: UInt64; let auth: SessionVault.Snapshot }
    private var sessionVault: SessionVault?
    private func vault(base: URL) throws -> SessionVault {
        if let sessionVault { return sessionVault }
        let value = try SessionVault(base: base); sessionVault = value; return value
    }
    @objc func clearSessionCookie(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            do {
                guard let raw = self.getConfig().getString("serverUrl"), let base = URL(string: raw) else { throw SessionVaultError.invalidOrigin }
                try self.vault(base: base).clearSession()
                MemoryAccountScope.shared.reset(); self.invalidateExports()
                call.resolve(["cleared": true])
            } catch { call.reject("MOBILE_SESSION_CLEAR_FAILED") }
        }
    }
    private var pending: [Int: Pending] = [:]
    private let pendingQueue = DispatchQueue(label: "com.aifenshen.mobilecompat.transport.pending")
    private lazy var networkDelegateQueue: OperationQueue = {
        let queue = OperationQueue()
        queue.name = "com.aifenshen.mobilecompat.transport.network"
        queue.maxConcurrentOperationCount = 1
        queue.qualityOfService = .userInitiated
        return queue
    }()
    private func hasPending(id: String) -> Bool {
        pendingQueue.sync { pending.values.contains(where: { $0.id == id }) }
    }
    private func pendingEntry(taskIdentifier: Int) -> Pending? {
        pendingQueue.sync { pending[taskIdentifier] }
    }
    private func pendingEntry(id: String) -> Pending? {
        pendingQueue.sync { pending.values.first(where: { $0.id == id }) }
    }
    private func storePending(_ entry: Pending, taskIdentifier: Int) {
        pendingQueue.sync { pending[taskIdentifier] = entry }
    }
    private func removePending(taskIdentifier: Int) -> Pending? {
        pendingQueue.sync { pending.removeValue(forKey: taskIdentifier) }
    }
    private func diagnosticNetworkCode(_ error: URLError) -> String {
        switch error.code {
        case .cannotFindHost, .dnsLookupFailed:
            return "MOBILE_DNS_FAILED"
        case .timedOut:
            return "MOBILE_TIMEOUT"
        case .notConnectedToInternet, .networkConnectionLost:
            return "MOBILE_OFFLINE"
        case .secureConnectionFailed, .serverCertificateHasBadDate,
             .serverCertificateUntrusted, .serverCertificateHasUnknownRoot,
             .serverCertificateNotYetValid:
            return "MOBILE_TLS_FAILED"
        case .cancelled:
            return "MOBILE_ABORTED"
        default:
            return "MOBILE_NETWORK_FAILED"
        }
    }
    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil
        config.urlCredentialStorage = nil
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = 45
        config.timeoutIntervalForResource = 86400
        return URLSession(configuration: config, delegate: self, delegateQueue: networkDelegateQueue)
    }()
    @objc func request(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let id = call.getString("id"), UUID(uuidString: id) != nil,
                  !self.hasPending(id: id),
                  let rawBase = self.getConfig().getString("serverUrl"),
                  let base = URL(string: rawBase), base.scheme == "https", base.host != nil,
                  base.user == nil, base.password == nil, base.query == nil,
                  let path = call.getString("path"), path.hasPrefix("/api/"), !path.contains("\\"),
                  let url = URL(string: path, relativeTo: base)?.absoluteURL,
                  url.scheme == base.scheme, url.host == base.host, url.port == base.port,
                  url.path.hasPrefix("/api/"), url.user == nil, url.password == nil,
                  let method = call.getString("method"), ["GET","POST","PUT","PATCH","DELETE","HEAD"].contains(method)
            else { call.reject("MOBILE_ENDPOINT_OR_REQUEST_INVALID"); return }
            if method != "GET", ["/api/auth/login", "/api/auth/logout", "/api/privacy/deletion-requests/confirm"].contains(url.path) {
                self.invalidateExports()
                MemoryAccountScope.shared.reset()
            }
            var request = URLRequest(url: url)
            request.httpMethod = method
            request.timeoutInterval = url.path == "/api/meeting/analysis" ? 105 : (call.getBool("longLived", false) ? 86400 : 45)
            request.httpShouldHandleCookies = false
            request.cachePolicy = .reloadIgnoringLocalCacheData
            for (key, value) in (call.getObject("headers") ?? [:]) {
                guard !["cookie","authorization","host","origin","referer","connection","content-length"].contains(key.lowercased()),
                      let text = value as? String else { continue }
                request.setValue(text, forHTTPHeaderField: key)
            }
            if let encoded = call.getString("body") {
                guard !["GET","HEAD"].contains(method), let body = Data(base64Encoded: encoded) else {
                    call.reject("MOBILE_BODY_INVALID"); return
                }
                request.httpBody = body
            }
            let auth: SessionVault.Snapshot
            do {
                auth = try self.vault(base: base).prepare(url: url, method: method, credentials: call.getBool("includeCredentials", true))
                if let header = auth.header { request.setValue(header, forHTTPHeaderField: "Cookie") }
                if auth.acceptsLogin { request.setValue("1", forHTTPHeaderField: "X-AI-Remember-Session") }
            } catch { call.reject("MOBILE_SESSION_UNAVAILABLE"); return }
            call.keepAlive = true
            self.bridge?.saveCall(call)
            let task = self.session.dataTask(with: request)
            self.storePending(Pending(id: id, call: call, task: task, memoryAuthGeneration: MemoryAccountScope.shared.capture().generation, auth: auth), taskIdentifier: task.taskIdentifier)
            task.resume()
        }
    }
    @objc func cancel(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let id = call.getString("id"), let entry = self.pendingEntry(id: id) {
                entry.task.cancel()
            }
            call.resolve()
        }
    }
    public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                           completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let entry = pendingEntry(taskIdentifier: dataTask.taskIdentifier),
              let response = response as? HTTPURLResponse else {
            completionHandler(.cancel); return
        }
        var headers: [String: String] = [:]
        for (key, value) in response.allHeaderFields {
            let name = String(describing: key)
            if !["set-cookie","set-cookie2"].contains(name.lowercased()) { headers[name] = String(describing: value) }
        }
        DispatchQueue.main.async {
            do { try self.sessionVault?.accept(response: response, snapshot: entry.auth) }
            catch {
                entry.call.resolve(["type": "error", "code": "MOBILE_SESSION_UNAVAILABLE"])
                completionHandler(.cancel); return
            }
            MemoryAccountScope.shared.accept(owner: response.value(forHTTPHeaderField: "X-AI-Account-Context"), status: response.statusCode, generation: entry.memoryAuthGeneration)
            entry.call.resolve(["type": "headers", "status": response.statusCode, "headers": headers])
            completionHandler(.allow)
        }
    }
    public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard let entry = pendingEntry(taskIdentifier: dataTask.taskIdentifier) else { return }
        let encoded = data.base64EncodedString()
        DispatchQueue.main.async {
            entry.call.resolve(["type": "data", "base64": encoded])
        }
    }
    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let entry = removePending(taskIdentifier: task.taskIdentifier) else { return }
        DispatchQueue.main.async {
            entry.call.keepAlive = false
            if let error = error as? URLError {
                entry.call.resolve([
                    "type": "error",
                    "code": error.code == .cancelled ? "MOBILE_ABORTED" : "MOBILE_NETWORK_FAILED",
                    "diagnosticCode": self.diagnosticNetworkCode(error)
                ])
            } else if error != nil {
                entry.call.resolve(["type": "error", "code": "MOBILE_NETWORK_FAILED"])
            } else { entry.call.resolve(["type": "end"]) }
            self.bridge?.releaseCall(entry.call)
        }
    }
    public func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                           newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        // No credential-bearing request may be redirected to another endpoint.
        completionHandler(nil)
    }
}

@objc(MobileBridgeViewController)
final class MobileBridgeViewController: CAPBridgeViewController {
    private let mobileTransport = MobileTransportPlugin()
    private let mobileMemory = MobileMemoryPlugin()
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(mobileTransport)
        bridge?.registerPluginInstance(mobileMemory)
        // The app owns its fixed outer viewport; feature views keep their own scrolling.
        webView?.scrollView.contentInsetAdjustmentBehavior = .never
        webView?.scrollView.automaticallyAdjustsScrollIndicatorInsets = false
        webView?.scrollView.bounces = false
    }
}
