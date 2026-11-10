"""Protea plugin SDK for Python: the out-of-process plugin protocol (JSON-RPC 2.0 over stdio).

See docs/30-specs/03-plugin-protocol.md. Subclass :class:`Plugin`, describe tools with
:class:`Tool`, and call :func:`run`. Handlers run on worker threads, so they may call the
host (``host.push_event``, ``host.kv_get`` ...) synchronously.
"""

from __future__ import annotations

import base64
import json
import os
import sys
import threading
import traceback
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple, Union

__all__ = ["Plugin", "Tool", "ToolContext", "Host", "RpcError", "run", "PROTOCOL_VERSION"]

PROTOCOL_VERSION = 1

# JSON-RPC error codes (shared with the TypeScript implementation).
METHOD_NOT_FOUND = -32601
INTERNAL = -32603
TOOL_NOT_FOUND = -32004


class RpcError(Exception):
    def __init__(self, code: int, message: str, data: Any = None):
        super().__init__(message)
        self.code = code
        self.data = data


ToolResult = Union[str, Dict[str, Any]]


@dataclass
class ToolContext:
    call_id: str
    context: Dict[str, Any]
    host: "Host"
    #: Set when the host cancels the call (an interrupt); return a partial result soon after.
    cancelled: threading.Event = field(default_factory=threading.Event)


@dataclass
class Tool:
    name: str
    description: str
    input_schema: Dict[str, Any]
    handler: Callable[[Dict[str, Any], ToolContext], ToolResult]
    flags: Optional[Dict[str, bool]] = None
    timeout_ms: Optional[int] = None

    def declaration(self) -> Dict[str, Any]:
        d: Dict[str, Any] = {"name": self.name, "description": self.description, "inputSchema": self.input_schema}
        if self.flags:
            d["flags"] = self.flags
        if self.timeout_ms is not None:
            d["timeoutMs"] = self.timeout_ms
        return d


class Plugin:
    """Override what you need; every hook is optional."""

    display_name: Optional[str] = None

    def start(self, host: "Host") -> None:
        pass

    def stop(self, host: "Host", reason: str) -> None:
        pass

    def tools(self, host: "Host") -> List[Tool]:
        return []

    def env_prompt_vars(self, host: "Host") -> Optional[Dict[str, Any]]:
        return {}

    def on_config_changed(self, host: "Host", patch: Dict[str, Any], full: Dict[str, Any]) -> None:
        pass

    def on_events_settled(self, host: "Host", events: List[Dict[str, Any]]) -> None:
        pass

    def on_chat_send(self, host: "Host", req: Dict[str, Any]) -> Dict[str, Any]:
        """Override to be a chat platform (with the manifest block ``chat``): deliver ``req["text"]`` to the owner.

        Return ``{"ok": True, "messageIds": [...]}`` or ``{"ok": False, "error": "why"}``.
        """
        raise NotImplementedError

    def health(self, host: "Host") -> Dict[str, Any]:
        return {"ok": True}


class _Connection:
    def __init__(self, out):
        self._out = out
        self._lock = threading.Lock()
        self._next_id = 1
        self._pending: Dict[int, Dict[str, Any]] = {}
        self._pending_lock = threading.Lock()
        self.closed = False

    def send(self, msg: Dict[str, Any]) -> None:
        line = json.dumps(msg, ensure_ascii=False, separators=(",", ":")) + "\n"
        with self._lock:
            self._out.write(line)
            self._out.flush()

    def request(self, method: str, params: Any = None, timeout: float = 30.0) -> Any:
        if self.closed:
            raise RpcError(-32009, "connection closed")
        with self._pending_lock:
            rid = self._next_id
            self._next_id += 1
            slot: Dict[str, Any] = {"event": threading.Event()}
            self._pending[rid] = slot
        msg: Dict[str, Any] = {"jsonrpc": "2.0", "id": rid, "method": method}
        if params is not None:
            msg["params"] = params
        self.send(msg)
        if not slot["event"].wait(timeout):
            with self._pending_lock:
                self._pending.pop(rid, None)
            raise RpcError(-32008, "%s timed out" % method)
        if "error" in slot:
            err = slot["error"]
            raise RpcError(err.get("code", INTERNAL), err.get("message", "error"), err.get("data"))
        return slot.get("result")

    def notify(self, method: str, params: Any = None) -> None:
        msg: Dict[str, Any] = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            msg["params"] = params
        self.send(msg)

    def resolve(self, msg: Dict[str, Any]) -> None:
        with self._pending_lock:
            slot = self._pending.pop(msg.get("id"), None)
        if slot is None:
            return
        if "error" in msg:
            slot["error"] = msg["error"]
        else:
            slot["result"] = msg.get("result")
        slot["event"].set()

    def close(self) -> None:
        self.closed = True
        with self._pending_lock:
            pending = list(self._pending.values())
            self._pending.clear()
        for slot in pending:
            slot["error"] = {"code": -32009, "message": "connection closed"}
            slot["event"].set()


class Host:
    """What the plugin can ask of the host (docs/10-architecture/07-plugin-system.md §6)."""

    def __init__(self, conn: _Connection):
        self._conn = conn
        self._init: Dict[str, Any] = {}
        self.config: Dict[str, Any] = {}

    def _set_init(self, params: Dict[str, Any]) -> None:
        self._init = params
        self.config = dict(params.get("config") or {})

    @property
    def id(self) -> str:
        return self._init.get("pluginId", "")

    @property
    def data_dir(self) -> str:
        return self._init.get("dataDir", "")

    @property
    def host_data_dir(self) -> str:
        return self._init.get("hostDataDir", "")

    @property
    def timezone(self) -> str:
        return self._init.get("timezone", "UTC")

    @property
    def language(self) -> str:
        return self._init.get("language", "en")

    @property
    def level_cap(self) -> int:
        return int(self._init.get("levelCap", 4))

    @property
    def allowed_triggers(self) -> List[str]:
        return list(self._init.get("allowedTriggers", []))

    def push_event(self, **event: Any) -> Dict[str, Any]:
        """Push an event: type, ts, level, trigger, text, and optionally senderKey, dedupeKey, meta ..."""
        return self._conn.request("events/push", event)

    def kv_get(self, key: str) -> Any:
        return (self._conn.request("kv/get", {"key": key}) or {}).get("value")

    def kv_set(self, key: str, value: Any) -> None:
        self._conn.request("kv/set", {"key": key, "value": value})

    def kv_delete(self, key: str) -> None:
        self._conn.request("kv/delete", {"key": key})

    def owner_resolve(self, sender_key: str) -> str:
        return (self._conn.request("owner/resolve", {"senderKey": sender_key}) or {}).get("role", "unknown")

    def approvals_decide(self, approval_id: str, decision: str, sender_key: str, grant_ms: Optional[int] = None) -> Dict[str, Any]:
        params: Dict[str, Any] = {"id": approval_id, "decision": decision, "senderKey": sender_key}
        if grant_ms is not None:
            params["grantMs"] = grant_ms
        return self._conn.request("approvals/decide", params)

    def permissions_mode(self, sender_key: str, mode: Optional[str] = None, for_ms: Optional[int] = None) -> Dict[str, Any]:
        """Read the permission mode, or change it with `mode`; `sender_key` must be the owner."""
        params: Dict[str, Any] = {"senderKey": sender_key}
        if mode is not None:
            params["mode"] = mode
        if for_ms is not None:
            params["forMs"] = for_ms
        return self._conn.request("permissions/mode", params)

    def blob_put(self, data: bytes, mime: Optional[str] = None) -> Dict[str, Any]:
        """Store an image; use the returned ``handle`` in a tool result's ``images`` or an event's ``blobs``."""
        params: Dict[str, Any] = {"dataBase64": base64.b64encode(data).decode("ascii")}
        if mime is not None:
            params["mime"] = mime
        return self._conn.request("blob/put", params)

    def blob_get(self, handle: str) -> Tuple[bytes, str]:
        r = self._conn.request("blob/get", {"handle": handle})
        return base64.b64decode(r["dataBase64"]), r["mime"]

    def log(self, level: str, msg: str, **fields: Any) -> None:
        params: Dict[str, Any] = {"level": level, "msg": msg}
        if fields:
            params["fields"] = fields
        self._conn.notify("log", params)

    def secret(self, name: str) -> Optional[str]:
        """A secret the manifest declared; the host injects it into the environment at start."""
        return os.environ.get(name)


def _overrides(plugin: Plugin, name: str) -> bool:
    return getattr(type(plugin), name) is not getattr(Plugin, name)


def run(plugin: Plugin, max_workers: int = 8) -> None:
    """Serve ``plugin`` over stdio until the host stops it or closes stdin."""
    out = sys.stdout
    sys.stdout = sys.stderr  # print() goes to the host's log, never into the protocol stream
    conn = _Connection(out)
    host = Host(conn)
    pool = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="protea-plugin")
    calls: Dict[str, ToolContext] = {}
    calls_lock = threading.Lock()

    def tool_list() -> List[Tool]:
        return list(plugin.tools(host))

    def h_initialize(params: Dict[str, Any]) -> Dict[str, Any]:
        host._set_init(params or {})
        result: Dict[str, Any] = {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {
                "tools": True,
                "events": True,
                "envPrompt": _overrides(plugin, "env_prompt_vars"),
                "settled": _overrides(plugin, "on_events_settled"),
                "chat": _overrides(plugin, "on_chat_send"),
            },
        }
        if plugin.display_name:
            result["displayName"] = plugin.display_name
        return result

    def h_start(_params: Any) -> Dict[str, Any]:
        plugin.start(host)
        return {}

    def h_stop(params: Any) -> Dict[str, Any]:
        with calls_lock:
            for ctx in calls.values():
                ctx.cancelled.set()
        plugin.stop(host, (params or {}).get("reason", "stop"))
        # Leave once the reply has gone out.
        threading.Timer(0.05, lambda: os._exit(0)).start()
        return {}

    def h_config_changed(params: Dict[str, Any]) -> Dict[str, Any]:
        host.config = dict(params.get("full") or {})
        plugin.on_config_changed(host, params.get("patch") or {}, host.config)
        return {}

    def h_tools_list(_params: Any) -> Dict[str, Any]:
        return {"tools": [t.declaration() for t in tool_list()]}

    def h_tools_call(params: Dict[str, Any]) -> Dict[str, Any]:
        name = params.get("name")
        tool = next((t for t in tool_list() if t.name == name), None)
        if tool is None:
            raise RpcError(TOOL_NOT_FOUND, "no tool %s" % name)
        ctx = ToolContext(call_id=str(params.get("callId")), context=params.get("context") or {}, host=host)
        with calls_lock:
            calls[ctx.call_id] = ctx
        try:
            out_ = tool.handler(params.get("input") or {}, ctx)
            return {"text": out_} if isinstance(out_, str) else dict(out_)
        except Exception as exc:  # a failing tool is a failed receipt, not a protocol error
            return {"text": "%s: %s" % (type(exc).__name__, exc), "failed": True}
        finally:
            with calls_lock:
                calls.pop(ctx.call_id, None)

    def h_env_prompt(_params: Any) -> Dict[str, Any]:
        return {"vars": plugin.env_prompt_vars(host)}

    def h_settled(params: Dict[str, Any]) -> None:
        plugin.on_events_settled(host, list((params or {}).get("events") or []))

    def h_chat_send(params: Dict[str, Any]) -> Dict[str, Any]:
        if not _overrides(plugin, "on_chat_send"):
            raise RpcError(METHOD_NOT_FOUND, "this plugin is not a chat platform")
        try:
            return dict(plugin.on_chat_send(host, params or {}))
        except Exception as exc:  # the model gets the reason as a failed receipt
            return {"ok": False, "error": "%s: %s" % (type(exc).__name__, exc)}

    def h_health(_params: Any) -> Dict[str, Any]:
        return plugin.health(host)

    handlers: Dict[str, Callable[[Any], Any]] = {
        "initialize": h_initialize,
        "start": h_start,
        "stop": h_stop,
        "config/changed": h_config_changed,
        "tools/list": h_tools_list,
        "tools/call": h_tools_call,
        "env/prompt": h_env_prompt,
        "events/settled": h_settled,
        "chat/send": h_chat_send,
        "run/phase": lambda _p: None,
        "health": h_health,
        "shutdown/verify": lambda _p: {"snapshot": {}},
    }

    def dispatch(msg: Dict[str, Any]) -> None:
        method = msg["method"]
        rid = msg.get("id")
        try:
            handler = handlers.get(method)
            if handler is None:
                raise RpcError(METHOD_NOT_FOUND, "method not found: %s" % method)
            result = handler(msg.get("params"))
            if rid is not None:
                conn.send({"jsonrpc": "2.0", "id": rid, "result": result if result is not None else None})
        except RpcError as exc:
            if rid is not None:
                conn.send({"jsonrpc": "2.0", "id": rid, "error": {"code": exc.code, "message": str(exc)}})
        except Exception as exc:
            traceback.print_exc(file=sys.stderr)
            if rid is not None:
                conn.send({"jsonrpc": "2.0", "id": rid, "error": {"code": INTERNAL, "message": str(exc)}})

    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            sys.stderr.write("protocol: unparseable message\n")
            continue
        if not isinstance(msg, dict):
            continue
        if "method" in msg:
            if msg["method"] == "tools/cancel":
                with calls_lock:
                    ctx = calls.get(str((msg.get("params") or {}).get("callId")))
                if ctx is not None:
                    ctx.cancelled.set()
                continue
            pool.submit(dispatch, msg)
        elif "id" in msg:
            conn.resolve(msg)
    conn.close()
    os._exit(0)
