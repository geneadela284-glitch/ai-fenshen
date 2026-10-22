import Foundation
import Security

enum SessionVaultError: Error { case unavailable, invalidResponse, invalidOrigin }
protocol SessionSecretStore {
    func read(origin: String) throws -> Data?
    func write(_ data: Data?, origin: String) throws
}
struct KeychainSessionStore: SessionSecretStore {
    private func query(_ origin: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "com.aifenshen.mobilecompat.login.v1",
         kSecAttrAccount as String: origin]
    }
    func read(origin: String) throws -> Data? {
        var q = query(origin); q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw SessionVaultError.unavailable }
        return data
    }
    func write(_ data: Data?, origin: String) throws {
        let q = query(origin)
        guard let data else {
            let status = SecItemDelete(q as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw SessionVaultError.unavailable }
            return
        }
        let values: [String: Any] = [kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let status = SecItemUpdate(q as CFDictionary, values as CFDictionary)
        if status == errSecItemNotFound {
            let item = q.merging(values) { _, new in new }
            guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw SessionVaultError.unavailable }
        } else if status != errSecSuccess { throw SessionVaultError.unavailable }
    }
}

// A private native cookie jar. No passwords, JS storage, URL cache or shared cookies.
// All requests and responses are fenced across login/logout and account changes.
final class SessionVault {
    struct Snapshot { let generation: UInt64; let header: String?; let acceptsLogin: Bool; let credentials: Bool }
    private struct Record: Codable { let value: String; let expires: Double? }
    private let lock = NSLock()
    private let store: SessionSecretStore
    private let origin: String
    private let host: String
    private let port: Int?
    private let clock: () -> Date
    private var loaded = false
    private var record: Record?
    private var generation: UInt64 = 0

    init(base: URL, store: SessionSecretStore = KeychainSessionStore(), clock: @escaping () -> Date = Date.init) throws {
        guard base.scheme == "https", let host = base.host, base.user == nil, base.password == nil else { throw SessionVaultError.invalidOrigin }
        self.host = host; port = base.port
        origin = "https://\(host):\(base.port ?? 443)"
        self.store = store; self.clock = clock
    }
    private func validate(_ url: URL) throws {
        guard url.scheme == "https", url.host == host, (url.port ?? 443) == (port ?? 443), url.user == nil, url.password == nil,
              url.path.hasPrefix("/api/") else { throw SessionVaultError.invalidOrigin }
    }
    private func validValue(_ value: String) -> Bool {
        value.range(of: "^[A-Za-z0-9_-]{1,512}\\.[A-Za-z0-9_-]{1,512}$", options: .regularExpression) != nil
    }
    private func load() throws {
        if !loaded {
            if let bytes = try store.read(origin: origin) {
                guard let value = try? JSONDecoder().decode(Record.self, from: bytes), validValue(value.value) else { throw SessionVaultError.unavailable }
                record = value
            }
            loaded = true
        }
        if let expires = record?.expires, expires <= clock().timeIntervalSince1970 { try clear() }
    }
    private func clear() throws {
        // Fence even when the device is locked and deleting the Keychain item fails.
        generation &+= 1; record = nil; loaded = false
        try store.write(nil, origin: origin); loaded = true
    }
    func clearSession() throws { lock.lock(); defer { lock.unlock() }; try clear() }
    func prepare(url: URL, method: String, credentials: Bool) throws -> Snapshot {
        lock.lock(); defer { lock.unlock() }
        try validate(url)
        guard credentials else { return Snapshot(generation:generation, header:nil, acceptsLogin:false, credentials:false) }
        try load()
        let header = record.map { "ai_secretary_session=\($0.value)" }
        let login = method == "POST" && url.path == "/api/auth/login"
        let logout = method == "POST" && url.path == "/api/auth/logout"
        if login || logout { try clear() }
        return Snapshot(generation:generation, header:login ? nil : header, acceptsLogin:login, credentials:true)
    }
    func accept(response: HTTPURLResponse, snapshot: Snapshot) throws {
        lock.lock(); defer { lock.unlock() }
        guard snapshot.credentials, snapshot.generation == generation else { return }
        guard let url = response.url else { throw SessionVaultError.invalidOrigin }
        try validate(url)
        if response.statusCode == 401 {
            // Only the credential sent by this request may be invalidated.
            if snapshot.header == record.map({ "ai_secretary_session=\($0.value)" }) { try clear() }
            return
        }
        guard snapshot.acceptsLogin, (200..<300).contains(response.statusCode) else { return }
        let fields = response.allHeaderFields.reduce(into: [String:String]()) { $0[String(describing:$1.key)] = String(describing:$1.value) }
        let cookies = HTTPCookie.cookies(withResponseHeaderFields:fields, for:url)
        guard let cookie = cookies.first(where: { $0.name == "ai_secretary_session" }), cookie.isSecure, cookie.isHTTPOnly,
              cookie.domain == host, cookie.path == "/", validValue(cookie.value),
              cookie.expiresDate == nil || cookie.expiresDate! > clock() else { throw SessionVaultError.invalidResponse }
        let next = Record(value:cookie.value, expires:cookie.expiresDate?.timeIntervalSince1970)
        try store.write(JSONEncoder().encode(next), origin:origin)
        record = next; loaded = true
        // Fence concurrent login responses even if multiple requests were queued.
        generation &+= 1
    }
}
