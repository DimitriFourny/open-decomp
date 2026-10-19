/* glibc (x86_64 Linux) entry points that no installed header declares. Written from
 * the glibc ABI and public man pages; only names, parameter types, noreturn and
 * printf/scanf format positions are recorded. Types resolve through the preamble. */
typedef unsigned long size_t;
typedef long ssize_t;
typedef long ptrdiff_t;
typedef int pid_t;
typedef unsigned int uid_t;
typedef unsigned int gid_t;
typedef unsigned int mode_t;
typedef long off_t;
typedef long time_t;
typedef long clock_t;
typedef unsigned int socklen_t;
typedef unsigned long nfds_t;
typedef unsigned long pthread_t;
typedef struct _IO_FILE FILE;
typedef __builtin_va_list va_list;

/* Exported data objects. glibc declares these in <stdio.h>, <unistd.h>, <getopt.h>,
 * <time.h> and <errno.h>; only the object's name and type are recorded. */
extern FILE *stdin;
extern FILE *stdout;
extern FILE *stderr;
extern char **environ;
extern char *optarg;
extern int optind;
extern int opterr;
extern int optopt;
extern long timezone;
extern int daylight;
extern char *program_invocation_name;
extern char *program_invocation_short_name;

int *__errno_location(void);
int *__h_errno_location(void);
int __libc_start_main(int (*main)(int, char **, char **), int argc, char **argv,
                      void (*init)(void), void (*fini)(void), void (*rtld_fini)(void),
                      void *stack_end);
void *__tls_get_addr(void *ti);
void __assert_fail(const char *assertion, const char *file, unsigned int line,
                   const char *function) __attribute__((noreturn));
void __assert_perror_fail(int errnum, const char *file, unsigned int line,
                          const char *function) __attribute__((noreturn));
void __chk_fail(void) __attribute__((noreturn));
void __longjmp_chk(void *env, int val) __attribute__((noreturn));
int __sigsetjmp(void *env, int savemask);
int __register_atfork(void (*prepare)(void), void (*parent)(void), void (*child)(void),
                      void *dso_handle);

int __printf_chk(int flag, const char *format, ...) __attribute__((format(printf, 2, 3)));
int __fprintf_chk(FILE *stream, int flag, const char *format, ...) __attribute__((format(printf, 3, 4)));
int __dprintf_chk(int fd, int flag, const char *format, ...) __attribute__((format(printf, 3, 4)));
int __sprintf_chk(char *s, int flag, size_t slen, const char *format, ...) __attribute__((format(printf, 4, 5)));
int __snprintf_chk(char *s, size_t maxlen, int flag, size_t slen, const char *format, ...) __attribute__((format(printf, 5, 6)));
int __asprintf_chk(char **result, int flag, const char *format, ...) __attribute__((format(printf, 3, 4)));
void __syslog_chk(int priority, int flag, const char *format, ...) __attribute__((format(printf, 3, 4)));
int __vprintf_chk(int flag, const char *format, va_list ap);
int __vfprintf_chk(FILE *stream, int flag, const char *format, va_list ap);
int __vdprintf_chk(int fd, int flag, const char *format, va_list ap);
int __vsprintf_chk(char *s, int flag, size_t slen, const char *format, va_list ap);
int __vsnprintf_chk(char *s, size_t maxlen, int flag, size_t slen, const char *format, va_list ap);
int __vasprintf_chk(char **result, int flag, const char *format, va_list ap);
void __vsyslog_chk(int priority, int flag, const char *format, va_list ap);

void *__memcpy_chk(void *dest, const void *src, size_t len, size_t destlen);
void *__memmove_chk(void *dest, const void *src, size_t len, size_t destlen);
void *__mempcpy_chk(void *dest, const void *src, size_t len, size_t destlen);
void *__memset_chk(void *dest, int c, size_t len, size_t destlen);
char *__strcpy_chk(char *dest, const char *src, size_t destlen);
char *__stpcpy_chk(char *dest, const char *src, size_t destlen);
char *__strcat_chk(char *dest, const char *src, size_t destlen);
char *__strncpy_chk(char *dest, const char *src, size_t len, size_t destlen);
char *__stpncpy_chk(char *dest, const char *src, size_t len, size_t destlen);
char *__strncat_chk(char *dest, const char *src, size_t len, size_t destlen);
void __explicit_bzero_chk(void *dest, size_t len, size_t destlen);
size_t __fread_chk(void *ptr, size_t ptrlen, size_t size, size_t n, FILE *stream);
char *__fgets_chk(char *s, size_t size, int n, FILE *stream);
ssize_t __read_chk(int fd, void *buf, size_t nbytes, size_t buflen);
ssize_t __pread_chk(int fd, void *buf, size_t nbytes, off_t offset, size_t buflen);
ssize_t __recv_chk(int fd, void *buf, size_t n, size_t buflen, int flags);
ssize_t __readlink_chk(const char *path, char *buf, size_t len, size_t buflen);
char *__getcwd_chk(char *buf, size_t size, size_t buflen);
char *__realpath_chk(const char *name, char *resolved, size_t resolvedlen);
long __fdelt_chk(long d);

int __isoc99_scanf(const char *format, ...) __attribute__((format(scanf, 1, 2)));
int __isoc99_fscanf(FILE *stream, const char *format, ...) __attribute__((format(scanf, 2, 3)));
int __isoc99_sscanf(const char *s, const char *format, ...) __attribute__((format(scanf, 2, 3)));
int __isoc23_scanf(const char *format, ...) __attribute__((format(scanf, 1, 2)));
int __isoc23_fscanf(FILE *stream, const char *format, ...) __attribute__((format(scanf, 2, 3)));
int __isoc23_sscanf(const char *s, const char *format, ...) __attribute__((format(scanf, 2, 3)));
long __isoc23_strtol(const char *nptr, char **endptr, int base);
unsigned long __isoc23_strtoul(const char *nptr, char **endptr, int base);
long long __isoc23_strtoll(const char *nptr, char **endptr, int base);
unsigned long long __isoc23_strtoull(const char *nptr, char **endptr, int base);

const unsigned short **__ctype_b_loc(void);
const int **__ctype_tolower_loc(void);
const int **__ctype_toupper_loc(void);
size_t __ctype_get_mb_cur_max(void);
const char *gnu_get_libc_version(void);
int __libc_current_sigrtmin(void);
int __libc_current_sigrtmax(void);

void *memrchr(const void *s, int c, size_t n);
void *mempcpy(void *dest, const void *src, size_t n);
char *strchrnul(const char *s, int c);
char *strcasestr(const char *haystack, const char *needle);
char *secure_getenv(const char *name);
char *canonicalize_file_name(const char *path);
char *get_current_dir_name(void);
unsigned long getauxval(unsigned long type);
long gettid(void);
long syscall(long number, ...);
int prctl(int option, ...);
int pipe2(int pipefd[2], int flags);
int accept4(int sockfd, void *addr, socklen_t *addrlen, int flags);
int dup3(int oldfd, int newfd, int flags);
int epoll_create(int size);
int epoll_create1(int flags);
int epoll_ctl(int epfd, int op, int fd, void *event);
int epoll_wait(int epfd, void *events, int maxevents, int timeout);
int epoll_pwait(int epfd, void *events, int maxevents, int timeout, const void *sigmask);
int eventfd(unsigned int initval, int flags);
int signalfd(int fd, const void *mask, int flags);
int timerfd_create(int clockid, int flags);
int timerfd_settime(int fd, int flags, const void *new_value, void *old_value);
int timerfd_gettime(int fd, void *curr_value);
int inotify_init(void);
int inotify_init1(int flags);
int inotify_add_watch(int fd, const char *pathname, unsigned int mask);
int inotify_rm_watch(int fd, int wd);
ssize_t sendfile(int out_fd, int in_fd, off_t *offset, size_t count);
ssize_t getrandom(void *buf, size_t buflen, unsigned int flags);
int memfd_create(const char *name, unsigned int flags);
int ppoll(void *fds, nfds_t nfds, const void *tmo_p, const void *sigmask);
int sched_getcpu(void);
int sched_setaffinity(pid_t pid, size_t cpusetsize, const void *mask);
int sched_getaffinity(pid_t pid, size_t cpusetsize, void *mask);
int posix_fadvise(int fd, off_t offset, off_t len, int advice);
int fallocate(int fd, int mode, off_t offset, off_t len);
int dl_iterate_phdr(int (*callback)(void *info, size_t size, void *data), void *data);
int backtrace(void **buffer, int size);
char **backtrace_symbols(void *const *buffer, int size);
void backtrace_symbols_fd(void *const *buffer, int size, int fd);
void error(int status, int errnum, const char *format, ...) __attribute__((format(printf, 3, 4)));
void error_at_line(int status, int errnum, const char *filename, unsigned int linenum,
                   const char *format, ...) __attribute__((format(printf, 5, 6)));
int pthread_setname_np(pthread_t thread, const char *name);
int pthread_getname_np(pthread_t thread, char *name, size_t len);
int pthread_getattr_np(pthread_t thread, void *attr);
int pthread_timedjoin_np(pthread_t thread, void **retval, const void *abstime);
int pthread_tryjoin_np(pthread_t thread, void **retval);
int pthread_yield(void);
void *dlvsym(void *handle, const char *name, const char *version);
