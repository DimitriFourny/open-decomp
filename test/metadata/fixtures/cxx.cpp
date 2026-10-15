// Self-owned C++ symbol fixture for Itanium and Microsoft mangling.
#if defined(_WIN32)
#define EXPORTED __declspec(dllexport)
#else
#define EXPORTED __attribute__((visibility("default")))
#endif
namespace fixture {
EXPORTED int bar(int value) { return value + 9; }
}
