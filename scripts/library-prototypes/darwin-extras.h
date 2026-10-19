/* Darwin libSystem functions with no public header declaration: compiler-checked
 * (_FORTIFY_SOURCE) variants. Signatures follow the documented checked-builtin
 * contract (__builtin___*_chk): the original arguments plus object-size values. */
void *__memcpy_chk(void *dst, const void *src, size_t len, size_t dstlen);
void *__memmove_chk(void *dst, const void *src, size_t len, size_t dstlen);
void *__memset_chk(void *dst, int c, size_t len, size_t dstlen);
char *__strcpy_chk(char *dst, const char *src, size_t dstlen);
char *__stpcpy_chk(char *dst, const char *src, size_t dstlen);
char *__strcat_chk(char *dst, const char *src, size_t dstlen);
char *__strncpy_chk(char *dst, const char *src, size_t len, size_t dstlen);
char *__stpncpy_chk(char *dst, const char *src, size_t len, size_t dstlen);
char *__strncat_chk(char *dst, const char *src, size_t len, size_t dstlen);
int __sprintf_chk(char *s, int flag, size_t slen, const char *format, ...) __attribute__((format(printf, 4, 5)));
int __snprintf_chk(char *s, size_t maxlen, int flag, size_t slen, const char *format, ...) __attribute__((format(printf, 5, 6)));
int __vsprintf_chk(char *s, int flag, size_t slen, const char *format, __builtin_va_list ap);
int __vsnprintf_chk(char *s, size_t maxlen, int flag, size_t slen, const char *format, __builtin_va_list ap);
