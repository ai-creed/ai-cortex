/* Symbol fixture: the C grammar's kinds from C_SYMBOL_KINDS (A2.1 C-family column). */
#define MAX 4
#define TWICE(x) ((x) * 2)

typedef struct Node {
	int value;
	struct Node *next;
} Node;

enum Mode { MODE_A, MODE_B = 2 };

union Slot {
	int i;
	char c;
};

int total = 0;
static int cache;

int add(int a, int b);

int add(int a, int b) {
	int local = a + b;
	return local;
}

static void reset(void) { total = 0; }
