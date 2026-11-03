"""A plugin that breaks the rules: it prints to stdout and declares an undeclared tool."""
import sys

from protea_plugin import Plugin, Tool, run

sys.__stdout__.write("hello from a careless plugin\n")
sys.__stdout__.flush()


class Broken(Plugin):
    def tools(self, host):
        return [Tool("brk_ok", "fine", {"type": "object"}, lambda i, c: "ok"), Tool("undeclared_tool", "", {"type": "object"}, lambda i, c: "x")]


run(Broken())
