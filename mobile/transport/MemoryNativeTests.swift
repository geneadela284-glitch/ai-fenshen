import Foundation
import CryptoKit

private final class TestKeys: MemoryKeyProvider {
    var values: [String: SymmetricKey] = [:]
    func key(scope: String, create: Bool) throws -> SymmetricKey {
        if let value = values[scope] { return value }; guard create else { throw MemoryVaultError.unavailable }
        let key = SymmetricKey(size: .bits256); values[scope] = key; return key
    }
}
@main struct MemoryNativeTests {
    static func result(_ run: (@escaping (Result<[String: Any], Error>) -> Void) -> Void) throws -> [String: Any] {
        var returned: Result<[String: Any], Error>?
        run { returned = $0 }
        let deadline = Date().addingTimeInterval(3)
        while returned == nil && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.005)) }
        guard let returned else { fatalError("JAVASCRIPTCORE_CALLBACK_TIMEOUT") }
        return try returned.get()
    }
    static func main() throws {
        let identity = MemoryAccountScope()
        let old = identity.capture()
        identity.accept(owner: "a", status: 200, generation: old.generation)
        identity.reset()
        identity.accept(owner: "a", status: 200, generation: old.generation)
        precondition(identity.capture().owner == nil)
        let fresh = identity.capture()
        identity.accept(owner: "b", status: 200, generation: fresh.generation)
        identity.accept(owner: nil, status: 401, generation: old.generation)
        precondition(identity.capture().owner == "b")
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("aiwc-memory-test-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let keys = TestKeys(), vault = MemoryVault(folder: folder, keys: keys)
        let bundle = try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
        var runtime = try NativeMemoryRuntime(bundle: bundle, vault: vault)
        _ = try result { runtime.initialize(owner: "isolated-native-a", completion: $0) }
        let saved = try result { runtime.execute(command: ["operation": "remember", "requestId": "native-save-1",
            "text": "请记住：我喜欢喝龙井。", "source": ["type": "user_text", "id": "synthetic-message-1"]], completion: $0) }
        precondition(saved["status"] as? String == "stored")
        precondition((saved["receipt"] as? [String: Any])?["durable"] as? Bool == true)
        let files = try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
        precondition(files.count == 1)
        let encrypted = try Data(contentsOf: files[0]); precondition(encrypted.range(of: Data("龙井".utf8)) == nil)
        runtime.close(); runtime = try NativeMemoryRuntime(bundle: bundle, vault: vault)
        _ = try result { runtime.initialize(owner: "isolated-native-a", completion: $0) }
        let recalled = try result { runtime.execute(command: ["operation": "query", "text": "我喜欢喝什么？"], completion: $0) }
        precondition((recalled["items"] as? [[String: Any]])?.first?["text"] as? String == "我喜欢喝龙井。")
        let corrected = try result { runtime.execute(command: ["operation": "correct", "requestId": "correct-1",
            "memoryId": saved["memoryId"]!, "expectedVersion": 1, "text": "我喜欢喝红茶。", "confirmed": true], completion: $0) }
        precondition(corrected["status"] as? String == "corrected")
        _ = try result { runtime.execute(command: ["operation": "delete", "requestId": "delete-1", "memoryId": corrected["memoryId"]!, "expectedVersion": 2, "confirmed": true], completion: $0) }
        runtime.close(); runtime = try NativeMemoryRuntime(bundle: bundle, vault: vault)
        _ = try result { runtime.initialize(owner: "isolated-native-a", completion: $0) }
        let empty = try result { runtime.execute(command: ["operation": "list"], completion: $0) }
        precondition((empty["items"] as? [Any])?.isEmpty == true)
        runtime.close()
        var corrupt = try Data(contentsOf: files[0]); corrupt[corrupt.count - 1] ^= 0xff; try corrupt.write(to: files[0])
        runtime = try NativeMemoryRuntime(bundle: bundle, vault: vault)
        do { _ = try result { runtime.initialize(owner: "isolated-native-a", completion: $0) }; fatalError("TAMPER_ACCEPTED") }
        catch { precondition(error.localizedDescription == "LOCAL_MEMORY_CORRUPT") }
        runtime.close()
        let other = try NativeMemoryRuntime(bundle: bundle, vault: vault)
        _ = try result { other.initialize(owner: "isolated-native-b", completion: $0) }
        let isolated = try result { other.execute(command: ["operation": "list"], completion: $0) }
        precondition((isolated["items"] as? [Any])?.isEmpty == true)
        // Replacing another owner's encrypted file also fails authentication.
        let aScope = files[0].deletingPathExtension().lastPathComponent
        do { _ = try vault.commit(scope: aScope, expectedRevision: 1, data: "{}"); fatalError("CORRUPT_OVERWRITTEN") } catch {}
        print("NATIVE_MEMORY_PASS: JavaScriptCore V2 governance; CryptoKit encryption; restart; correction; deletion; owner isolation; auth generation fencing; tamper rejection. Keychain device lifecycle remains unverified.")
    }
}
