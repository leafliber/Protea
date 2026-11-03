"""Example Protea plugin in Python. The host puts the protea_plugin SDK on PYTHONPATH."""

import datetime

from protea_plugin import Plugin, Tool, run


def now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


class Notes(Plugin):
    display_name = "Notes (Python example)"

    def tools(self, host):
        return [
            Tool(
                "nts_add",
                "Add a note.",
                {"type": "object", "required": ["text"], "properties": {"text": {"type": "string", "minLength": 1}}},
                self.add,
            ),
            Tool("nts_list", "List the notes.", {"type": "object"}, self.list, flags={"readOnly": True}),
            Tool(
                "nts_wait",
                "Wait up to `seconds`; stops early with a partial result when cancelled.",
                {"type": "object", "properties": {"seconds": {"type": "number"}}},
                self.wait,
                flags={"interruptible": True},
            ),
        ]

    def add(self, i, ctx):
        notes = ctx.host.kv_get("notes") or []
        notes.append(i["text"])
        ctx.host.kv_set("notes", notes)
        r = ctx.host.push_event(
            type="py-notes.added",
            ts=now(),
            level=4,
            trigger="piggyback",
            text="Note added: %s" % i["text"],
            dedupeKey="note-%d" % len(notes),
        )
        return "added note %d (event #%s)" % (len(notes), r["cursor"])

    def list(self, _i, ctx):
        notes = ctx.host.kv_get("notes") or []
        return "\n".join("%d. %s" % (n + 1, t) for n, t in enumerate(notes)) or "no notes"

    def wait(self, i, ctx):
        if ctx.cancelled.wait(float(i.get("seconds", 5))):
            return {"text": "partial: cancelled", "partial": True}
        return "waited"

    def env_prompt_vars(self, host):
        return {"count": len(host.kv_get("notes") or [])}


run(Notes())
