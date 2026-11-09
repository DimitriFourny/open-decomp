#include <winsock2.h>
#include <windows.h>

__attribute__((noinline, dllexport)) HANDLE open_log(const wchar_t *name) {
  return CreateFileW(name, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ, NULL, OPEN_ALWAYS,
                     FILE_ATTRIBUTE_NORMAL, NULL);
}

__attribute__((noinline, dllexport)) void *alloc_pages(SIZE_T size) {
  return VirtualAlloc(NULL, size, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
}

__attribute__((noinline, dllexport)) DWORD file_size_low(const wchar_t *pattern) {
  WIN32_FIND_DATAW data;
  HANDLE find = FindFirstFileW(pattern, &data);
  if (find == INVALID_HANDLE_VALUE) return 0;
  FindClose(find);
  return data.nFileSizeLow + (data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY);
}

__attribute__((noinline, dllexport)) int this_year(void) {
  SYSTEMTIME now;
  GetSystemTime(&now);
  return now.wYear * 12 + now.wMonth;
}

__attribute__((noinline, dllexport)) DWORD spawn(wchar_t *command) {
  STARTUPINFOW startup = {sizeof startup};
  PROCESS_INFORMATION info;
  if (!CreateProcessW(NULL, command, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, NULL, &startup,
                      &info))
    return 0;
  WaitForSingleObject(info.hProcess, INFINITE);
  CloseHandle(info.hThread);
  return info.dwProcessId;
}

__attribute__((noinline, dllexport)) int start_network(void) {
  WSADATA data;
  if (WSAStartup(MAKEWORD(2, 2), &data)) return -1;
  SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  return (int)s + data.wVersion;
}

__attribute__((noinline, dllexport)) DWORD read_overlapped(HANDLE file, void *buffer, OVERLAPPED *overlapped) {
  DWORD done = 0;
  overlapped->Offset = 512;
  ReadFile(file, buffer, 64, &done, overlapped);
  return done + overlapped->InternalHigh;
}

__attribute__((noinline, dllexport)) LONG open_key(HKEY *key) {
  return RegOpenKeyExW(HKEY_LOCAL_MACHINE, L"SOFTWARE", 0, KEY_READ | KEY_WOW64_64KEY, key);
}

int main(void) {
  OVERLAPPED overlapped = {0};
  HKEY key;
  HANDLE log = open_log(L"log.txt");
  char buffer[64];
  MessageBoxW(NULL, L"hello", L"title", MB_OK | MB_ICONERROR);
  return (int)(INT_PTR)alloc_pages(4096) + (int)file_size_low(L"*") + this_year() +
         (int)spawn(L"cmd") + start_network() + (int)read_overlapped(log, buffer, &overlapped) +
         (int)open_key(&key);
}
