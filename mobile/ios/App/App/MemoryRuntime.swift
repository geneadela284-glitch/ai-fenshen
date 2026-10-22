import Foundation
import CryptoKit
import Security
import JavaScriptCore

/// JavaScriptCore runs the same MemoryRecordV2 governance, separate from the WebView.
/// All methods must be called from the owning serial queue.
final class NativeMemoryRuntime {
    private let context: JSContext
    private var callbacks: [String: (Result<[String: Any], Error>) -> Void] = [:]
    private static func json(_ value: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: value), let text = String(data: data, encoding: .utf8) else { return "{\"error\":\"LOCAL_MEMORY_FAILED\"}" }; return text
    }
    init(bundle: String, vault: MemoryVault) throws {
        guard let context = JSContext() else { throw MemoryVaultError.unavailable }
        self.context = context
        let sha: @convention(block) (String) -> String = { text in SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined() }
        let uuid: @convention(block) () -> String = { UUID().uuidString.lowercased() }
        let random: @convention(block) (Int) -> String = { count in
            guard count > 0 && count <= 1024 else { return "" }; var bytes = [UInt8](repeating: 0, count: count)
            guard SecRandomCopyBytes(kSecRandomDefault, count, &bytes) == errSecSuccess else { return "" }
            return bytes.map { String(format: "%02x", $0) }.joined()
        }
        let crypto = JSValue(newObjectIn: context)!
        crypto.setObject(sha, forKeyedSubscript: "sha256" as NSString)
        crypto.setObject(uuid, forKeyedSubscript: "uuid" as NSString)
        crypto.setObject(random, forKeyedSubscript: "randomHex" as NSString)
        context.setObject(crypto, forKeyedSubscript: "__memoryCrypto" as NSString)
        let load: @convention(block) (String) -> String = { scope in
            do { let s = try vault.load(scope: scope); return Self.json(["value": ["revision": s.revision, "data": s.data as Any? ?? NSNull()]]) }
            catch { return Self.json(["error": (error as? MemoryVaultError)?.rawValue ?? "LOCAL_MEMORY_FAILED"]) }
        }
        let commit: @convention(block) (String, String) -> String = { scope, text in
            do {
                guard let raw = text.data(using: .utf8), let command = try JSONSerialization.jsonObject(with: raw) as? [String: Any],
                    let expected = command["expectedRevision"] as? Int, let data = command["data"] as? String else { throw MemoryVaultError.corrupt }
                let revision = try vault.commit(scope: scope, expectedRevision: expected, data: data)
                return Self.json(["value": ["revision": revision]])
            } catch { return Self.json(["error": (error as? MemoryVaultError)?.rawValue ?? "LOCAL_MEMORY_FAILED"]) }
        }
        context.setObject(load, forKeyedSubscript: "__memoryLoad" as NSString)
        context.setObject(commit, forKeyedSubscript: "__memoryCommit" as NSString)
        let done: @convention(block) (String, String) -> Void = { [weak self] id, text in
            guard let callback = self?.callbacks.removeValue(forKey: id) else { return }
            guard let raw = text.data(using: .utf8), let result = try? JSONSerialization.jsonObject(with: raw) as? [String: Any] else { callback(.failure(MemoryVaultError.corrupt)); return }
            if let error = result["error"] as? String { callback(.failure(NSError(domain: "LocalMemory", code: 1, userInfo: [NSLocalizedDescriptionKey: error]))) }
            else if let value = result["value"] as? [String: Any] { callback(.success(value)) }
            else { callback(.failure(MemoryVaultError.corrupt)) }
        }
        context.setObject(done, forKeyedSubscript: "__memoryDone" as NSString)
        context.evaluateScript(bundle)
        guard context.exception == nil, context.objectForKeyedSubscript("MobileMemoryHost")?.isUndefined == false else { throw MemoryVaultError.unavailable }
    }
    private func call(method: String, argument: String, completion: @escaping (Result<[String: Any], Error>) -> Void) {
        let id = UUID().uuidString; callbacks[id] = completion; context.exception = nil
        context.objectForKeyedSubscript("MobileMemoryHost")?.invokeMethod(method, withArguments: [id, argument])
        if context.exception != nil, let callback = callbacks.removeValue(forKey: id) { callback(.failure(MemoryVaultError.unavailable)) }
    }
    func initialize(owner: String, completion: @escaping (Result<[String: Any], Error>) -> Void) { call(method: "start", argument: owner, completion: completion) }
    func execute(command: [String: Any], completion: @escaping (Result<[String: Any], Error>) -> Void) { call(method: "invoke", argument: Self.json(command), completion: completion) }
    func close() {
        context.objectForKeyedSubscript("MobileMemoryHost")?.invokeMethod("close", withArguments: [])
        let pending = callbacks; callbacks.removeAll(); pending.values.forEach { $0(.failure(MemoryVaultError.unavailable)) }
    }
}
