/* Debug-info corpus: structures, a linked list, enums, unions, function pointers and globals. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

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
  long total_area;
  int (*visit)(const struct shape *, void *);
} registry_t;

union number {
  long integer;
  double real;
};

registry_t global_registry;
int verbose_level = 2;
static const char *kind_names[] = {"none", "circle", "rect", "triangle"};

long shape_area(const struct shape *s) {
  long w = s->bounds.width, h = s->bounds.height;
  switch (s->kind) {
  case SHAPE_CIRCLE:
    return (long)(3 * w * w);
  case SHAPE_RECT:
    return w * h;
  case SHAPE_TRIANGLE:
    return w * h / 2;
  }
  return 0;
}

struct shape *shape_new(enum shape_kind kind, const char *name, int x, int y, unsigned w, unsigned h) {
  struct shape *s = calloc(1, sizeof *s);
  if (!s)
    return NULL;
  s->kind = kind;
  strncpy(s->name, name, sizeof s->name - 1);
  s->bounds.origin.x = x;
  s->bounds.origin.y = y;
  s->bounds.width = w;
  s->bounds.height = h;
  s->scale = 1.0;
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
  if (verbose_level > 1)
    printf("%s %s at (%d,%d) area %ld\n", kind_names[s->kind], s->name, s->bounds.origin.x,
           s->bounds.origin.y, shape_area(s));
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

int main(int argc, char **argv) {
  int counter = 0;
  global_registry.visit = print_shape;
  registry_add(&global_registry, shape_new(SHAPE_RECT, "box", 1, 2, 3, 4));
  registry_add(&global_registry, shape_new(SHAPE_CIRCLE, argc > 1 ? argv[1] : "disc", 5, 6, 7, 7));
  registry_visit(&global_registry, &counter);
  union number values[2] = {{.integer = 3}, {.real = 0.5}};
  struct point a = {1, 2}, b = {4, 6};
  printf("%d shapes, area %ld, sum %f, d2 %d\n", counter, global_registry.total_area,
         number_sum(values, 2, 0), point_distance2(a, b));
  return 0;
}
