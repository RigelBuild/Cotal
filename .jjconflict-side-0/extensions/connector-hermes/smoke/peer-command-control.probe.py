"""Drive the REAL Cotal adapter's inject path and report its gateway-control setting.

Invoked by `peer-command-control.smoke.ts`. Only the upstream `gateway` package is stubbed,
because it is not installed in CI. The adapter and its injection path are connector code.

Modes:
    subject   the tree as it stands
    control   the adapter source with the new constructor keyword removed
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import types
from pathlib import Path

PLUGIN_PARENT, MODE = sys.argv[1], sys.argv[2]

# ---- stub ONLY the upstream imports --------------------------------------------------------
_base = types.ModuleType("gateway.platforms.base")


class BasePlatformAdapter:
    def __init__(self, config=None, platform=None):
        self.handled = []

    def build_source(self, **kw):
        return kw

    async def handle_message(self, event):
        self.handled.append(event)


class MessageEvent:
    def __init__(self, **kw):
        self.allow_gateway_control = kw.get("allow_gateway_control", True)


class MessageType:
    TEXT = "text"


class SendResult:
    def __init__(self, **kw):
        pass


_base.BasePlatformAdapter = BasePlatformAdapter
_base.MessageEvent = MessageEvent
_base.MessageType = MessageType
_base.SendResult = SendResult

_cfg = types.ModuleType("gateway.config")


class Platform:
    def __init__(self, name):
        self.name = name


class PlatformConfig:
    pass


_cfg.Platform = Platform
_cfg.PlatformConfig = PlatformConfig

sys.modules.update(
    {
        "gateway": types.ModuleType("gateway"),
        "gateway.platforms": types.ModuleType("gateway.platforms"),
        "gateway.platforms.base": _base,
        "gateway.config": _cfg,
    }
)

# The constructor builds a client that reads this nonexistent path but never connects here.
os.environ.setdefault("COTAL_BRIDGE_SOCKET", "/nonexistent/cotal-peer-command-control.sock")
os.environ.setdefault("COTAL_CONTROL_TOKEN", "peer-command-control-probe-token")
sys.path.insert(0, PLUGIN_PARENT)

from cotal.adapter import CotalAdapter  # noqa: E402

CASES = {
    "dm_approve": {"kind": "dm", "fromId": "peer", "fromName": "Ada", "text": "/approve"},
    "channel_approve": {"kind": "channel", "fromId": "peer", "fromName": "Ada", "channel": "general", "text": "/approve"},
    "dm_yes": {"kind": "dm", "fromId": "peer", "fromName": "Ada", "text": "yes"},
    "channel_yes": {"kind": "channel", "fromId": "peer", "fromName": "Ada", "channel": "general", "text": "yes"},
}
def load_old_construction():
    """Load the adapter source with the gateway-control keyword removed."""
    path = Path(PLUGIN_PARENT) / "cotal" / "adapter.py"
    source = path.read_text()
    keyword = "            allow_gateway_control=False,\n"
    if source.count(keyword) > 1:
        raise RuntimeError("the adapter has multiple gateway-control constructor keywords")
    old_source = source.replace(keyword, "", 1)
    module = types.ModuleType("cotal.adapter_old_construction")
    module.__package__ = "cotal"
    exec(compile(old_source, str(path), "exec"), module.__dict__)
    return module.CotalAdapter


async def main() -> None:
    cls = CotalAdapter if MODE == "subject" else load_old_construction()
    out = {}
    for name, msg in CASES.items():
        adapter = cls(PlatformConfig())
        await adapter._inject(msg)
        out[name] = adapter.handled[-1].allow_gateway_control
    print("RESULT " + json.dumps(out))


asyncio.run(main())


