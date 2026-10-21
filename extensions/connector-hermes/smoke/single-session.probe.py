"""Drive the REAL Cotal adapter in single-session mode and report where messages and replies go.

Invoked by `single-session.smoke.ts`. Only the upstream `gateway` package is stubbed, because it
is not installed in CI. The stub keys sessions the way Hermes' build_session_key does for a DM: by
chat_id. The adapter's inbound, reply routing and idle wait are connector code.

Modes:
    subject   single_session on
    control   single_session off (the per-peer default)
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import types

PLUGIN_PARENT, MODE = sys.argv[1], sys.argv[2]

_base = types.ModuleType("gateway.platforms.base")


class BasePlatformAdapter:
    def __init__(self, config=None, platform=None):
        self.config = config
        self.handled = []
        self._active_sessions = {}
        self._session_tasks = {}

    def build_source(self, **kw):
        return dict(kw)

    def _source_session_key(self, source):
        return f"cotal:{source.get('chat_type')}:{source.get('chat_id')}"

    def _session_task_is_stale(self, key):
        task = self._session_tasks.get(key)
        return bool(task is not None and task.done())

    async def on_processing_start(self, event):
        pass

    async def on_processing_complete(self, event, outcome):
        pass

    async def handle_message(self, event):
        self.handled.append(event)


class MessageEvent:
    def __init__(self, **kw):
        self.__dict__.update(kw)


class MessageType:
    TEXT = "text"


class SendResult:
    def __init__(self, success=True, message_id=None, error=None):
        self.success = success
        self.error = error


_base.BasePlatformAdapter = BasePlatformAdapter
_base.MessageEvent = MessageEvent
_base.MessageType = MessageType
_base.SendResult = SendResult

_cfg = types.ModuleType("gateway.config")


class Platform:
    def __init__(self, name):
        self.name = name


class PlatformConfig:
    def __init__(self, extra):
        self.extra = extra


_cfg.Platform = Platform
_cfg.PlatformConfig = PlatformConfig
# The gateway's per-task session env, as a tool call in the shared chat sees it.
_ctx = types.ModuleType("gateway.session_context")
SESSION_ENV: dict = {}
_ctx.get_session_env = lambda name, default="": SESSION_ENV.get(name, default)

sys.modules.update(
    {
        "gateway": types.ModuleType("gateway"),
        "gateway.platforms": types.ModuleType("gateway.platforms"),
        "gateway.platforms.base": _base,
        "gateway.config": _cfg,
        "gateway.session_context": _ctx,
    }
)
os.environ.setdefault("COTAL_BRIDGE_SOCKET", "/nonexistent/cotal-single-session.sock")
os.environ.setdefault("COTAL_CONTROL_TOKEN", "single-session-probe-token")
os.environ.pop("COTAL_HERMES_FORK_SESSION", None)
sys.path.insert(0, PLUGIN_PARENT)

from cotal import adapter as adapter_mod  # noqa: E402
from cotal import replies, tools  # noqa: E402

adapter_mod.IDLE_POLL_SECONDS = 0.01


class Client:
    def __init__(self):
        self.replies = []

    def reply(self, target, text, reply_to=None, context_id=None):
        self.replies.append({"target": target, "text": text, "replyTo": reply_to})


def make():
    adapter = adapter_mod.CotalAdapter(PlatformConfig({"single_session": MODE == "subject"}))
    adapter._client = Client()
    return adapter


A = {"kind": "dm", "id": "m-ada", "fromId": "ada-id", "fromName": "Ada", "text": "hi from Ada"}
B = {"kind": "dm", "id": "m-bob", "fromId": "bob-id", "fromName": "Bob", "text": "hi from Bob"}
C = {"kind": "channel", "id": "m-ch", "fromId": "cy-id", "fromName": "Cy", "channel": "ops", "text": "up?"}


async def main() -> None:
    out = {}

    # Two peers and a channel: which session does each land in, and where does each reply go?
    adapter = make()
    for msg in (A, B, C):
        await adapter._inject(msg)
    keys = [adapter._source_session_key(e.source) for e in adapter.handled]
    out["one_session"] = len(set(keys)) == 1
    out["sender_kept"] = [e.source.get("user_id") for e in adapter.handled] == ["ada-id", "bob-id", "cy-id"]
    out["channel_named"] = "#ops" in adapter.handled[2].text
    for msg in (A, B, C):
        await adapter.send(adapter.handled[0].source["chat_id"], "re " + msg["id"], reply_to=msg["id"])
    out["reply_targets"] = [r["target"] for r in adapter._client.replies]

    # A DM that arrives while a turn runs in its session: held until the turn ends?
    adapter = make()
    await adapter._inject(A)
    key = adapter._source_session_key(adapter.handled[0].source)
    if MODE == "control":
        key = adapter._source_session_key(dict(adapter.handled[0].source, chat_id="dm:bob-id"))
    running = asyncio.get_running_loop().create_future()
    adapter._active_sessions[key] = asyncio.Event()
    adapter._session_tasks[key] = running
    second = asyncio.create_task(adapter._inject(B))
    await asyncio.sleep(0.1)
    out["held_mid_turn"] = len(adapter.handled) == 1
    del adapter._active_sessions[key]
    running.set_result(None)
    await adapter.on_processing_complete(adapter.handled[0], None)
    await asyncio.wait_for(second, 2)
    out["runs_after_turn"] = len(adapter.handled) == 2
    # A progress send without an anchor goes to the turn now running (Bob's).
    await adapter.send(adapter.handled[1].source["chat_id"], "working")
    out["unanchored_target"] = adapter._client.replies[-1]["target"] if adapter._client.replies else None
    # A turn-error notice is sent after the complete hook and names no message: it still reaches
    # the finished turn's origin.
    await adapter.on_processing_complete(adapter.handled[1], None)
    await adapter.send(adapter.handled[1].source["chat_id"], "turn failed")
    notice = adapter._client.replies[-1] if adapter._client.replies else {}
    out["error_notice_target"] = notice.get("target") if notice.get("text") == "turn failed" else None
    # A send that names its own chat (send_message, a cron delivery) goes there, not to the last peer.
    await adapter.send("channel:general", "cron result")
    sent = adapter._client.replies[-1] if adapter._client.replies else {}
    out["explicit_target"] = sent.get("target") if sent.get("text") == "cron result" else None
    # Before any turn has run, a send that names no message has no origin and is not sent to a guess.
    adapter = make()
    result = await adapter.send(adapter_mod.SINGLE_CHAT_ID, "orphan")
    out["orphan_send_refused"] = result.success is False and not adapter._client.replies

    # An id-less message is keyed by its receive key, so its reply still finds its sender after
    # another peer's turn has started.
    adapter = make()
    await adapter._inject({"kind": "dm", "id": "", "recvKey": "rx7", "fromId": "dee-id", "fromName": "Dee", "text": "no id"})
    event = adapter.handled[0]
    await adapter.on_processing_complete(event, None)
    await adapter._inject(A)
    await adapter.send(event.source["chat_id"], "re", reply_to=event.message_id)
    out["idless_target"] = adapter._client.replies[-1]["target"] if adapter._client.replies else None

    # A second push of a message still held mid-turn (a resubscribe) runs no second turn, and its
    # ack waits until the original is admitted.
    adapter = make()
    await adapter._inject(A)
    key = adapter._source_session_key(adapter.handled[0].source)
    adapter._active_sessions[key] = asyncio.Event()
    first = asyncio.create_task(adapter._inject(B))
    await asyncio.sleep(0.05)
    again = asyncio.create_task(adapter._inject(B))
    await asyncio.sleep(0.05)
    out["dup_waits"] = not again.done()
    del adapter._active_sessions[key]
    await adapter.on_processing_complete(adapter.handled[0], None)
    await asyncio.wait_for(asyncio.gather(first, again), 2)
    out["held_once"] = [e.message_id for e in adapter.handled] == ["m-ada", "m-bob"]

    # A question asked from a turn reports its answer back to that turn's origin: Ada by DM, and
    # the #ops channel for a channel post, through the real tool-side session record.
    answers = []
    for msg in (A, C):
        adapter = make()
        await adapter._inject(msg)
        SESSION_ENV.clear()
        SESSION_ENV.update({"HERMES_SESSION_PLATFORM": "cotal", "HERMES_SESSION_CHAT_ID": adapter_mod.SINGLE_CHAT_ID,
                            "HERMES_SESSION_USER_ID": msg["fromId"]})
        ctx = replies.issue(tools._calling_session())
        await adapter.on_processing_complete(adapter.handled[0], None)
        await adapter._inject({"kind": "dm", "id": "m-ans", "fromId": "eve-id", "fromName": "Eve", "text": "42",
                               "contextId": ctx, "answersQuestion": True})
        await adapter.send(adapter.handled[1].source["chat_id"], "noted", reply_to="m-ans")
        answers.append(adapter._client.replies[-1]["target"] if adapter._client.replies else None)
    out["answer_targets"] = answers

    print("RESULT " + json.dumps(out))


asyncio.run(main())
