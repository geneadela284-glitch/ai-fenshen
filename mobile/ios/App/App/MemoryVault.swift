import Foundation
import CryptoKit
import Security

enum MemoryVaultError: String, Error { case unavailable = "LOCAL_MEMORY_UNAVAILABLE", corrupt = "LOCAL_MEMORY_CORRUPT", conflict = "LOCAL_MEMORY_CONFLICT", writeFailed = "LOCAL_MEMORY_WRITE_FAILED" }

protocol MemoryKeyProvider { func key(scope: String, create: Bool) throws -> SymmetricKey }

struct KeychainMemoryKeys: MemoryKeyProvider {
    func key(scope: String, create: Bool) throws -> SymmetricKey {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.aifenshen.mobilecompat.memory.v2", kSecAttrAccount as String: scope]
        var read = query; read[kSecReturnData as String] = true; read[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(read as CFDictionary, &result)
        if status == errSecSuccess, let data = result as? Data, data.count == 32 { return SymmetricKey(data: data) }
        guard status == errSecItemNotFound, create else { throw MemoryVaultError.unavailable }
        let key = SymmetricKey(size: .bits256)
        var item = query
        item[kSecValueData as String] = key.withUnsafeBytes { Data($0) }
        item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlocked
        guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw MemoryVaultError.unavailable }
        return key
    }
}

/// Only the native serial memory host can access this repository. No plaintext file is written.
final class MemoryVault {
    struct Snapshot: Codable { let revision: Int; let data: String? }
    private let folder: URL
    private let keys: MemoryKeyProvider
    init(folder: URL, keys: MemoryKeyProvider = KeychainMemoryKeys()) { self.folder = folder; self.keys = keys }
    private func url(_ scope: String) throws -> URL {
        guard scope.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw MemoryVaultError.corrupt }
        return folder.appendingPathComponent(scope + ".vault")
    }
    private func aad(_ scope: String) -> Data { Data(("aifenshen-memory-v2:1:" + scope).utf8) }
    func load(scope: String) throws -> Snapshot {
        let file = try url(scope)
        guard FileManager.default.fileExists(atPath: file.path) else { return Snapshot(revision: 0, data: nil) }
        let key = try keys.key(scope: scope, create: false)
        do {
            let raw = try Data(contentsOf: file)
            guard raw.count <= 32 * 1024 * 1024 else { throw MemoryVaultError.corrupt }
            let plaintext = try AES.GCM.open(AES.GCM.SealedBox(combined: raw), using: key, authenticating: aad(scope))
            let value = try JSONDecoder().decode(Snapshot.self, from: plaintext)
            guard value.revision > 0, value.data != nil else { throw MemoryVaultError.corrupt }
            return value
        } catch { throw MemoryVaultError.corrupt }
    }
    func commit(scope: String, expectedRevision: Int, data: String) throws -> Int {
        guard expectedRevision >= 0, data.utf8.count <= 24 * 1024 * 1024 else { throw MemoryVaultError.writeFailed }
        let existing = try load(scope: scope)
        guard existing.revision == expectedRevision else { throw MemoryVaultError.conflict }
        let key = try keys.key(scope: scope, create: true)
        do {
            let payload = try JSONEncoder().encode(Snapshot(revision: expectedRevision + 1, data: data))
            guard let cipher = try AES.GCM.seal(payload, using: key, authenticating: aad(scope)).combined else { throw MemoryVaultError.writeFailed }
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let file = try url(scope)
            #if os(iOS)
            try cipher.write(to: file, options: [.atomic, .completeFileProtection])
            #else
            try cipher.write(to: file, options: [.atomic])
            #endif
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
            let handle = try FileHandle(forWritingTo: file); defer { try? handle.close() }
            try handle.synchronize()
            return expectedRevision + 1
        } catch { throw MemoryVaultError.writeFailed }
    }
}
