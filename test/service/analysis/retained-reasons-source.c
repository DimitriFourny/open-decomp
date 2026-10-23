struct ops { long (*hook)(long); long base; };
/* The indirect call leaves "unresolved control flow" in dispatch's unit, which is no limit. */
__attribute__((noinline)) long dispatch(struct ops *o, long x) { return o->hook(x) + o->base; }
__attribute__((noinline)) long user_a(struct ops *o, long x) { return dispatch(o, x) * 2 + x; }
__attribute__((noinline)) long user_b(struct ops *o, long x) { return dispatch(o, x + 1) ^ 3; }
__attribute__((noinline)) long user_c(struct ops *o, long x) { return user_a(o, x) - dispatch(o, x ^ 7); }
long id(long x) { return x; }
int main(int argc, char **argv) { struct ops o = {id, 1}; return (int)(user_a(&o, argc) + user_b(&o, argc) + user_c(&o, argc)) & 1; }
