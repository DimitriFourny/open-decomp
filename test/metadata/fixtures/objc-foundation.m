// Self-owned Objective-C/Foundation fixture. Only statically analyzed; tests never execute it.
#import <Foundation/Foundation.h>

@interface ODCounter : NSObject
@property(nonatomic, copy) NSString *label;
@property(nonatomic) NSInteger count;
- (instancetype)initWithLabel:(NSString *)label;
- (void)increment;
- (NSInteger)addValue:(NSInteger)value times:(NSInteger)times;
- (double)scaled:(double)factor;
+ (instancetype)counterWithLabel:(NSString *)label;
+ (NSString *)greeting;
@end

@implementation ODCounter
- (instancetype)initWithLabel:(NSString *)label {
  self = [super init];
  if (self) {
    _label = [label copy];
    _count = 0;
  }
  return self;
}
- (void)increment {
  self.count = self.count + 1;
}
- (NSInteger)addValue:(NSInteger)value times:(NSInteger)times {
  _count += value * times;
  return _count;
}
- (double)scaled:(double)factor {
  return (double)_count * factor;
}
+ (instancetype)counterWithLabel:(NSString *)label {
  return [[self alloc] initWithLabel:label];
}
+ (NSString *)greeting {
  return @"hello, fixture";
}
@end

@interface ODCounter (Describe)
- (NSString *)summary;
@end

@implementation ODCounter (Describe)
- (NSString *)summary {
  return [NSString stringWithFormat:@"%@=%ld", self.label, (long)self.count];
}
@end

__attribute__((noinline)) NSString *ODMakeSummary(NSString *name) {
  ODCounter *counter = [ODCounter counterWithLabel:name];
  [counter increment];
  [counter addValue:3 times:4];
  return [counter summary];
}

int main(void) {
  @autoreleasepool {
    NSLog(@"%@ %@", [ODCounter greeting], ODMakeSummary(@"main"));
  }
  return 0;
}
