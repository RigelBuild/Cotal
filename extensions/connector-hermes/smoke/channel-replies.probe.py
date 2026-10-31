"""Drive the REAL Cotal adapter with channel replies off and report what reaches the mesh.

Invoked by `channel-replies.smoke.ts`. Only the upstream `gateway` package is stubbed, because it
is not installed in CI.

Modes:
    subject   channel_replies false
    control   channel_replies absent (the default: replies are posted)
    shared    channel_replies false with single_session true
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
        return False

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
_ctx = types.ModuleType("gateway.session_context")
_ctx.get_session_env = lambda name, default="": default

sys.modules.update(
    {
        "gateway": types.ModuleType("gateway"),
        "gateway.platforms": types.ModuleType("gateway.platforms"),
        "gateway.platforms.base": _base,
        "gateway.config": _cfg,
        "gateway.session_context": _ctx,
    }
)
os.environ.setdefault("COTAL_BRIDGE_SOCKET", "/nonexistent/cotal-channel-replies.sock")
os.environ.setdefault("COTAL_CONTROL_TOKEN", "channel-replies-probe-token")
os.environ.pop("COTAL_HERMES_FORK_SESSION", None)
sys.path.insert(0, PLUGIN_PARENT)

from cotal import adapter as adapter_mod  # noqa: E402


class Client:
    def __init__(self):
        self.replies = []

    def reply(self, target, text, reply_to=None, context_id=None):
        self.replies.append({"target": target, "text": text})


EXTRA = {
    "subject": {"channel_replies": False},
    "control": {},
    "shared": {"channel_replies": False, "single_session": True},
}[MODE]

DM = {"kind": "dm", "id": "m-dm", "fromId": "ada-id", "fromName": "Ada", "text": "hi"}
CH = {"kind": "channel", "id": "m-ch", "fromId": "cy-id", "fromName": "Cy", "channel": "ops", "text": "up?"}


async def main() -> None:
    adapter = adapter_mod.CotalAdapter(PlatformConfig(EXTRA))
    adapter._client = Client()
    out = {}
    await adapter._inject(CH)
    await adapter._inject(DM)
    ch_event, dm_event = adapter.handled
    out["channel_note"] = adapter_mod.CHANNEL_QUIET_NOTE in ch_event.text
    out["dm_note"] = adapter_mod.CHANNEL_QUIET_NOTE in dm_event.text
    channel_reply = await adapter.send(ch_event.source["chat_id"], "not for me", reply_to="m-ch")
    out["channel_reply_ok"] = channel_reply.success is True
    await adapter.send(dm_event.source["chat_id"], "hello Ada", reply_to="m-dm")
    # An explicit send naming no delivered message (send_message, cron delivery) still posts.
    await adapter.send("channel:general", "explicit channel send")
    # So does a channel send anchored to a DM, not a channel message.
    await adapter.send("channel:general", "anchored to a DM", reply_to="m-dm")
    out["sent"] = adapter._client.replies
    # A send in the channel turn that names no message (progress, a turn-error notice).
    adapter._client.replies = []
    await adapter._inject(dict(CH, id="m-ch2"))
    await adapter.send(adapter.handled[-1].source["chat_id"], "unanchored")
    out["unanchored_sent"] = adapter._client.replies
    # A question asked in a channel turn: the peer's answer runs a turn whose origin is the channel.
    from cotal import replies
    adapter._client.replies = []
    await adapter._inject(dict(CH, id="m-ch3"))
    await adapter.on_processing_start(adapter.handled[-1])
    ctx = replies.issue({"chat_id": adapter.handled[-1].source["chat_id"], "origin": replies.running()})
    await adapter._inject({"kind": "dm", "id": "m-ans", "fromId": "ada-id", "fromName": "Ada", "text": "answer", "contextId": ctx, "answersQuestion": True})
    answer = adapter.handled[-1]
    await adapter.on_processing_start(answer)
    await adapter.send(answer.source["chat_id"], "answer turn reply", reply_to=answer.message_id)
    out["answer_sent"] = adapter._client.replies
    print("RESULT " + json.dumps(out))


asyncio.run(main())
