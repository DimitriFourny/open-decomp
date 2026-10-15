/* SPDX-License-Identifier: MIT */
/* Test-only: explicitly loads these known trusted fixture dylibs, never user binaries. */
#include <dlfcn.h>
#include <stdio.h>
int main(int argc, char **argv) {
    if (argc != 2) return 100;
    void *library = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
    if (!library) { fprintf(stderr, "%s\n", dlerror()); return 101; }
    int (*check)(void) = (int (*)(void))dlsym(library, "fixture_check");
    if (!check) { fprintf(stderr, "%s\n", dlerror()); dlclose(library); return 102; }
    int result = check();
    if (dlclose(library)) return 103;
    return result;
}
