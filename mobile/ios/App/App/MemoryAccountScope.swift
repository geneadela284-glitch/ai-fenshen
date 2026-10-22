import Foundation

/// Owner identity comes exclusively from the authenticated transport response.
/// Generation fencing prevents an older account's in-flight response from rebinding it.
final class MemoryAccountScope {
    static let shared = MemoryAccountScope()
    struct Binding: Equatable { let owner: String?; let generation: UInt64 }
    private let lock = NSLock()
    private var current = Binding(owner: nil, generation: 0)
    func capture() -> Binding { lock.lock(); defer { lock.unlock() }; return current }
    func reset() { lock.lock(); defer { lock.unlock() }; current = Binding(owner: nil, generation: current.generation &+ 1) }
    func accept(owner: String?, status: Int, generation: UInt64) {
        lock.lock(); defer { lock.unlock() }
        guard generation == current.generation else { return }
        if status == 401 { current = Binding(owner: nil, generation: current.generation &+ 1); return }
        guard (200..<300).contains(status), let owner, !owner.isEmpty, owner.count <= 256 else { return }
        if current.owner == nil { current = Binding(owner: owner, generation: current.generation) }
        else if current.owner != owner { current = Binding(owner: owner, generation: current.generation &+ 1) }
    }
    func isCurrent(_ binding: Binding) -> Bool { capture() == binding }
}
