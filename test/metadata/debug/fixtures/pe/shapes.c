/* PDB debug-info corpus (freestanding Windows x64, no CRT): structures, a linked list, enums,
 * unions, bitfields, function pointers, arrays and globals. */

typedef unsigned long long size_t;

/* Floating-point code references this CRT marker; without a CRT the program defines it. */
int _fltused;

enum shape_kind { SHAPE_CIRCLE = 1, SHAPE_RECT = 2, SHAPE_TRIANGLE = 3 };

struct point {
  int x;
  int y;
};

struct rect {
  struct point origin;
  unsigned width;
  unsigned height;
};

struct shape {
  enum shape_kind kind;
  char name[16];
  struct rect bounds;
  double scale;
  struct shape *next;
};

typedef struct registry {
  struct shape *head;
  size_t count;
  long long total_area;
  int (*visit)(const struct shape *, void *);
} registry_t;

union number {
  long long integer;
  double real;
};

struct flags {
  unsigned visible : 1;
  unsigned layer : 4;
  unsigned short tag;
};

registry_t global_registry;
int verbose_level = 2;
volatile int trace_hits;
static const char *kind_names[] = {"none", "circle", "rect", "triangle"};
static struct shape pool[8];
static int pool_used;
static char log_buffer[4][32];

long long shape_area(const struct shape *s) {
  long long w = s->bounds.width, h = s->bounds.height;
  switch (s->kind) {
  case SHAPE_CIRCLE:
    return 3 * w * w;
  case SHAPE_RECT:
    return w * h;
  case SHAPE_TRIANGLE:
    return w * h / 2;
  }
  return 0;
}

static void copy_name(char *dst, const char *src, size_t n) {
  size_t i = 0;
  for (; i + 1 < n && src[i]; i++)
    dst[i] = src[i];
  dst[i] = 0;
}

struct shape *shape_new(enum shape_kind kind, const char *name, int x, int y, unsigned w, unsigned h) {
  if (pool_used >= 8)
    return 0;
  struct shape *s = &pool[pool_used++];
  s->kind = kind;
  copy_name(s->name, name, sizeof s->name);
  s->bounds.origin.x = x;
  s->bounds.origin.y = y;
  s->bounds.width = w;
  s->bounds.height = h;
  s->scale = 1.0;
  s->next = 0;
  return s;
}

void registry_add(registry_t *reg, struct shape *s) {
  s->next = reg->head;
  reg->head = s;
  reg->count++;
  reg->total_area += shape_area(s);
}

int registry_visit(registry_t *reg, void *cookie) {
  int visited = 0;
  for (struct shape *s = reg->head; s; s = s->next) {
    if (reg->visit && reg->visit(s, cookie) < 0)
      break;
    visited++;
  }
  return visited;
}

static int print_shape(const struct shape *s, void *cookie) {
  int *counter = cookie;
  (*counter)++;
  if (verbose_level > 1) {
    trace_hits++;
    copy_name(log_buffer[*counter & 3], kind_names[s->kind], 32);
  }
  return 0;
}

double number_sum(const union number *values, int count, int as_real) {
  double total = 0;
  for (int i = 0; i < count; i++)
    total += as_real ? values[i].real : (double)values[i].integer;
  return total;
}

int point_distance2(struct point a, struct point b) {
  int dx = a.x - b.x, dy = a.y - b.y;
  return dx * dx + dy * dy;
}

unsigned flags_pack(struct flags *f, unsigned layer) {
  f->visible = 1;
  f->layer = layer;
  f->tag = (unsigned short)(layer * 3);
  return f->tag + f->layer;
}

int shapes_main(void) {
  int counter = 0;
  global_registry.visit = print_shape;
  registry_add(&global_registry, shape_new(SHAPE_RECT, "box", 1, 2, 3, 4));
  registry_add(&global_registry, shape_new(SHAPE_CIRCLE, "disc", 5, 6, 7, 7));
  registry_visit(&global_registry, &counter);
  union number values[2];
  values[0].integer = 3;
  values[1].real = 0.5;
  struct point a = {1, 2}, b = {4, 6};
  struct flags f;
  int d2 = point_distance2(a, b);
  double sum = number_sum(values, 2, 0);
  return counter + d2 + (int)sum + (int)flags_pack(&f, 5) + (int)global_registry.total_area;
}
