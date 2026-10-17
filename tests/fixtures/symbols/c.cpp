// Symbol fixture: every C-family kind in C_SYMBOL_KINDS (A2.1 C-family column).
#define LIMIT 10
#define SQUARE(x) ((x) * (x))

int prototype(int x);

int counter = 0;
static int hidden = 1;

typedef unsigned int uint_t;

enum Color { Red, Green };

struct Point {
	int x;
	int y;
};

union Value {
	int i;
	float f;
};

class Widget {
public:
	int size;
	int area() { return size * size; }
	void resize(int s);
};

void Widget::resize(int s) { size = s; }

namespace geo {
	int dist(int a) { return a; }
}

int prototype(int x) { return x + LIMIT; }

static int local_helper() { return 0; }
