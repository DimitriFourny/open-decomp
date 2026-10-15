// Self-owned static metadata fixture. The resulting image is never executed.
@protocol ODProtocol
- (int)ping:(int)value;
@end

__attribute__((objc_root_class))
@interface ODObject {
  void *_isa;
  int _number;
}
- (int)number;
- (void)setNumber:(int)value;
+ (int)kind;
@end
@implementation ODObject
- (int)number { return _number; }
- (void)setNumber:(int)value { _number = value; }
+ (int)kind { return 7; }
@end

@interface ODObject (Extras) <ODProtocol>
- (int)doubled;
@end
@implementation ODObject (Extras)
- (int)doubled { return [self number] * 2; }
- (int)ping:(int)value { return value + 1; }
@end

// Deliberately use an external class identity without importing a header corpus.
__attribute__((objc_root_class))
@interface NSObject
@end
@interface ODChild : NSObject {
  int _tag;
}
- (int)tag;
@end
@implementation ODChild
- (int)tag { return _tag; }
@end
