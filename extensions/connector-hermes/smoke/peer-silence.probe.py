"""Drive the REAL Cotal adapter and report each peer event's ``reply_expected``.

Invoked by `peer-silence.smoke.ts`. Only the upstream `gateway` package is stubbed, because it
is not installed in CI.

Modes:
    subject   peer_silence true
    control   peer_silence absent (the default: the gateway decides)
    shared    peer_silence true with single_session true
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
os.environ.setdefault("COTAL_BRIDGE_SOCKET", "/nonexistent/cotal-peer-silence.sock")
os.environ.setdefault("COTAL_CONTROL_TOKEN", "peer-silence-probe-token")
os.environ.pop("COTAL_HERMES_FORK_SESSION", None)
sys.path.insert(0, PLUGIN_PARENT)

from cotal import adapter as adapter_mod  # noqa: E402


EXTRA = {
    "subject": {"peer_silence": True},
    "control": {},
    "shared": {"peer_silence": True, "single_session": True},
}[MODE]

DM = {"kind": "dm", "id": "m-dm", "fromId": "ada-id", "fromName": "Ada", "text": "hi"}
CH = {"kind": "channel", "id": "m-ch", "fromId": "cy-id", "fromName": "Cy", "channel": "ops", "text": "up?"}


async def main() -> None:
    adapter = adapter_mod.CotalAdapter(PlatformConfig(EXTRA))
    await adapter._inject(CH)
    await adapter._inject(DM)
    out = {"reply_expected": [getattr(e, "reply_expected", "unset") for e in adapter.handled]}
    print("RESULT " + json.dumps(out))


asyncio.run(main())
