// Self-owned reflection metadata fixture. No metadata accessor is executed.
public struct MetadataPoint {
    public var x: Int32
    public var y: Int64
    public init(x: Int32, y: Int64) { self.x = x; self.y = y }
}
public enum MetadataChoice {
    case empty
    case amount(Int)
    case point(MetadataPoint)
}
public class MetadataBase {
    public var label: String
    public init(label: String) { self.label = label }
}
public final class MetadataChild: MetadataBase {
    public var count: Int
    public init(label: String, count: Int) { self.count = count; super.init(label: label) }
}
public func metadataSum(_ x: Int32, _ y: Int32) -> Int32 { x &+ y }
