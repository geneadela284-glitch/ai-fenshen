import Foundation

final class FixtureStore: SessionSecretStore {
    var values: [String:Data] = [:]; var unavailable = false
    func read(origin:String) throws -> Data? { if unavailable {throw SessionVaultError.unavailable}; return values[origin] }
    func write(_ data:Data?, origin:String) throws { if unavailable {throw SessionVaultError.unavailable}; values[origin] = data }
}
@main struct SessionVaultTests {
    static func check(_ value: @autoclosure () throws -> Bool, _ message: String = "assertion") throws { let result = try value(); precondition(result, message) }
    static func main() throws {
        let base=URL(string:"https://fixture.invalid:18443")!, store=FixtureStore()
        func url(_ path:String)->URL { URL(string:path,relativeTo:base)!.absoluteURL }
        func response(_ path:String="/api/auth/login", _ status:Int=200, _ cookie:String="ai_secretary_session=fixtureA.signatureA; Path=/; HttpOnly; Secure; SameSite=Lax")->HTTPURLResponse {
            HTTPURLResponse(url:url(path),statusCode:status,httpVersion:nil,headerFields:["Set-Cookie":cookie])!
        }
        func login(_ vault:SessionVault) throws { let s=try vault.prepare(url:url("/api/auth/login"),method:"POST",credentials:true);try vault.accept(response:response(),snapshot:s) }
        func request(_ vault:SessionVault)throws->SessionVault.Snapshot {try vault.prepare(url:url("/api/auth/me"),method:"GET",credentials:true)}
        let ephemeral=URLSessionConfiguration.ephemeral, cookie=HTTPCookie.cookies(withResponseHeaderFields:["Set-Cookie":"ai_secretary_session=fixtureA.signatureA; Path=/; HttpOnly; Secure"],for:base)[0]
        ephemeral.httpCookieStorage!.setCookie(cookie)
        precondition(URLSessionConfiguration.ephemeral.httpCookieStorage!.cookies?.isEmpty != false,"baseline new session must lose cookies")
        let first=try SessionVault(base:base,store:store); try login(first)
        let restarted=try SessionVault(base:base,store:store,clock:{Date(timeIntervalSince1970:2200000000)})
        try check(try request(restarted).header != nil,"remember login across instance/process storage reload")
        let anonymous=try restarted.prepare(url:url("/api/auth/me"),method:"GET",credentials:false); precondition(anonymous.header == nil)
        let old=try request(restarted)
        let logout=try restarted.prepare(url:url("/api/auth/logout"),method:"POST",credentials:true)
        precondition(logout.header != nil); try check(try request(restarted).header == nil)
        try restarted.accept(response:response(),snapshot:old)
        try check(try request(try SessionVault(base:base,store:store)).header == nil,"logout must survive restart")
        let lateLogin=try restarted.prepare(url:url("/api/auth/login"),method:"POST",credentials:true)
        try restarted.clearSession();try restarted.accept(response:response(),snapshot:lateLogin)
        try check(try request(restarted).header == nil,"late login cannot resurrect logout")
        try login(restarted); let beforeSwitch=try request(restarted);try login(restarted)
        try restarted.accept(response:response("/api/auth/me",401),snapshot:beforeSwitch)
        try check(try request(restarted).header != nil,"stale401 cannot log out new account")
        try restarted.accept(response:response("/api/auth/me",503),snapshot:try request(restarted));try check(try request(restarted).header != nil)
        try restarted.accept(response:response("/api/auth/me",401),snapshot:try request(restarted));try check(try request(restarted).header == nil)
        for untrusted in ["http://fixture.invalid:18443/api/auth/me","https://evil.invalid:18443/api/auth/me","https://fixture.invalid/api/auth/me","https://fixture.invalid:18443/assets/a"] {
            do {_ = try restarted.prepare(url:URL(string:untrusted)!,method:"GET",credentials:true);fatalError("origin/path leak")} catch SessionVaultError.invalidOrigin {}
        }
        for bad in ["ai_secretary_session=a.b; Path=/; Secure", "ai_secretary_session=a.b; Path=/; HttpOnly", "ai_secretary_session=a.b; Domain=.invalid; Path=/; Secure; HttpOnly"] {
            let snap=try restarted.prepare(url:url("/api/auth/login"),method:"POST",credentials:true)
            do { try restarted.accept(response:response("/api/auth/login",200,bad),snapshot:snap);fatalError("untrusted cookie accepted") } catch SessionVaultError.invalidResponse {}
        }
        store.unavailable=true
        do { _ = try request(try SessionVault(base:base,store:store));fatalError("locked keychain treated as logged out") } catch SessionVaultError.unavailable {}
        print("SESSION_VAULT_PASS: restart, logout, stale login/401, revocation, service failure, origin, cookie validation, locked storage")
    }
}
