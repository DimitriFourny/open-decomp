/* Itanium C++ ABI runtime entry points (libstdc++, libc++abi/libsupc++) and the global
 * allocation functions. Names, parameter types and noreturn follow the published ABI
 * (https://itanium-cxx-abi.github.io/cxx-abi/abi.html) and the C++ library headers. */
typedef unsigned long size_t;
typedef long ptrdiff_t;

void *__cxa_allocate_exception(size_t thrown_size);
void __cxa_free_exception(void *thrown_exception);
void *__cxa_allocate_dependent_exception(void);
void *__cxa_begin_catch(void *exception_object);
void __cxa_end_catch(void);
void *__cxa_get_exception_ptr(void *exception_object);
void __cxa_pure_virtual(void) __attribute__((noreturn));
void __cxa_deleted_virtual(void) __attribute__((noreturn));
void __cxa_bad_cast(void) __attribute__((noreturn));
void __cxa_bad_typeid(void) __attribute__((noreturn));
void __cxa_throw_bad_array_new_length(void) __attribute__((noreturn));
void __cxa_call_unexpected(void *exception_object) __attribute__((noreturn));
int __cxa_guard_acquire(long long *guard_object);
void __cxa_guard_release(long long *guard_object);
void __cxa_guard_abort(long long *guard_object);
char *__cxa_demangle(const char *mangled_name, char *output_buffer, size_t *length, int *status);
void *__dynamic_cast(const void *src_ptr, const void *src_type, const void *dst_type,
                     ptrdiff_t src2dst_offset);
void _Unwind_Resume(void *exception_object) __attribute__((noreturn));
int __gxx_personality_v0(int version, int actions, unsigned long long exception_class,
                         void *exception_object, void *context);
void *_Znwm(size_t size);
void *_Znam(size_t size);
void *_ZnwmRKSt9nothrow_t(size_t size, const void *nothrow);
void *_ZnamRKSt9nothrow_t(size_t size, const void *nothrow);
void _ZdlPv(void *pointer);
void _ZdaPv(void *pointer);
void _ZdlPvm(void *pointer, size_t size);
void _ZdaPvm(void *pointer, size_t size);
void _ZdlPvRKSt9nothrow_t(void *pointer, const void *nothrow);
void _ZdaPvRKSt9nothrow_t(void *pointer, const void *nothrow);
