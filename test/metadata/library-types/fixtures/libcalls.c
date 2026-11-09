#include <arpa/inet.h>
#include <dirent.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

static void on_signal(int number) { (void)number; }

__attribute__((noinline)) long file_size(const char *path) {
  struct stat st;
  if (stat(path, &st) != 0) return -1;
  if (S_ISDIR(st.st_mode)) return 0;
  return st.st_size + st.st_blocks;
}

__attribute__((noinline)) int write_file(const char *path, const char *text) {
  int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
  if (fd == -1) return -1;
  write(fd, text, strlen(text));
  return close(fd);
}

__attribute__((noinline)) void *map_buffer(size_t size) {
  void *p = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  if (p == MAP_FAILED) return NULL;
  return p;
}

__attribute__((noinline)) int connect_local(unsigned short port) {
  int s = socket(AF_INET, SOCK_STREAM, 0);
  struct sockaddr_in addr;
  memset(&addr, 0, sizeof addr);
  addr.sin_family = AF_INET;
  addr.sin_port = htons(port);
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (connect(s, (struct sockaddr *)&addr, sizeof addr) < 0) return -1;
  return s;
}

__attribute__((noinline)) int count_entries(const char *path) {
  DIR *dir = opendir(path);
  if (!dir) return -1;
  int count = 0;
  struct dirent *entry;
  while ((entry = readdir(dir)) != NULL)
    if (entry->d_name[0] != '.' && entry->d_type == DT_REG) count++;
  closedir(dir);
  return count;
}

__attribute__((noinline)) int current_hour(void) {
  time_t now = time(NULL);
  struct tm *tm = localtime(&now);
  return tm->tm_hour * 60 + tm->tm_min;
}

__attribute__((noinline)) int read_stream(FILE *stream) {
  return stream->_fileno + (stream->_flags & 1);
}

int main(int argc, char **argv) {
  signal(SIGINT, on_signal);
  signal(SIGPIPE, SIG_IGN);
  if (argc < 2) return 1;
  printf("%ld %d %p %d %d %d %d\n", file_size(argv[1]), write_file(argv[1], "x"), map_buffer(4096),
         connect_local(8080), count_entries(argv[1]), current_hour(), read_stream(stdin));
  return 0;
}
