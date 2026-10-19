/* libc runtime-support symbols present in both glibc and Darwin libSystem. */
typedef unsigned long size_t;

int __cxa_atexit(void (*function)(void *), void *argument, void *dso_handle);
int __cxa_thread_atexit_impl(void (*function)(void *), void *argument, void *dso_handle);
void __cxa_finalize(void *dso_handle);
