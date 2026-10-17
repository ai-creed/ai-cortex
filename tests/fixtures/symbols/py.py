# Symbol fixture: every Python kind in PY_SYMBOL_KINDS (A2.1 Python column).
import os

LIMIT = 10
name, other = "a", "b"


def helper(x):
    return x


class Service(object):
    def __init__(self):
        self.count = 0

    def run(self):
        return helper(self.count)


class Child(Service):
    pass
