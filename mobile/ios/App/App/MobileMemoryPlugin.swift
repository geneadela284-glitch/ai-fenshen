import Foundation
import Capacitor

@objc(MobileMemoryPlugin)
public final class MobileMemoryPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MobileMemoryPlugin"
    public let jsName = "MobileMemory"
    public let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "execute", returnType: CAPPluginReturnPromise)]
    private let queue = DispatchQueue(label: "com.aifenshen.mobilecompat.memory", qos: .userInitiated)
    private var runtime: NativeMemoryRuntime?
    private var runtimeBinding: MemoryAccountScope.Binding?
    @objc func execute(_ call: CAPPluginCall) {
        let scope = MemoryAccountScope.shared
        let binding = scope.capture()
        guard let owner = binding.owner, call.getString("expectedOwner") == owner,
              let input = call.getObject("command"), JSONSerialization.isValidJSONObject(input) else {
            call.reject("LOCAL_MEMORY_AUTH_REQUIRED"); return
        }
        let command = input.reduce(into: [String: Any]()) { $0[$1.key] = $1.value }
        queue.async {
            guard scope.isCurrent(binding) else { call.reject("OWNER_SCOPE_MISMATCH"); return }
            func complete(_ result: Result<[String: Any], Error>) {
                DispatchQueue.main.async {
                    guard scope.isCurrent(binding) else { call.reject("OWNER_SCOPE_MISMATCH"); return }
                    switch result {
                    case .success(let value): call.resolve(value)
                    case .failure(let error):
                        let raw = (error as? MemoryVaultError)?.rawValue ?? error.localizedDescription
                        let code = raw.range(of: "^[A-Z][A-Z0-9_]{1,80}$", options: .regularExpression) != nil ? raw : "LOCAL_MEMORY_FAILED"
                        call.reject(code)
                    }
                }
            }
            if self.runtimeBinding != binding {
                self.runtime?.close(); self.runtime = nil; self.runtimeBinding = nil
                do {
                    guard let bundleURL = Bundle.main.url(forResource: "memory-runtime", withExtension: "js") else { throw MemoryVaultError.unavailable }
                    let bundle = try String(contentsOf: bundleURL, encoding: .utf8)
                    let folder = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("AI-Fenshen-MemoryV2", isDirectory: true)
                    let runtime = try NativeMemoryRuntime(bundle: bundle, vault: MemoryVault(folder: folder))
                    self.runtime = runtime
                    runtime.initialize(owner: owner) { result in
                        switch result {
                        case .failure(let error): self.runtime = nil; complete(.failure(error))
                        case .success:
                            guard scope.isCurrent(binding) else { runtime.close(); self.runtime = nil; complete(.failure(NSError(domain: "LocalMemory", code: 1, userInfo: [NSLocalizedDescriptionKey: "OWNER_SCOPE_MISMATCH"]))); return }
                            self.runtimeBinding = binding; runtime.execute(command: command, completion: complete)
                        }
                    }
                } catch { complete(.failure(error)) }
            } else { self.runtime?.execute(command: command, completion: complete) }
        }
    }
}
