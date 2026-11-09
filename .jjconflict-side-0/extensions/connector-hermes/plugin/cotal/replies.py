"""Context ids route a peer's answer to a Cotal session that asked.

A context id is an unauthenticated string any peer can set. So an id routes a DM only when this
plugin minted it, it has not expired, and the sidecar vouches that the DM's authenticated sender is
the peer the question went to (the frame's ``answersQuestion``). Questions asked from another
gateway platform carry no context id and use the sender's session.
"""
from __future__ import annotations

import secrets
import threading
import time
from typing import Optional

# How long a question's context id keeps routing answers after it was asked.
TTL_SECONDS = 24 * 3600
# How many unexpired questions are remembered; the oldest goes first.
MAX_QUESTIONS = 4096
# The one chat every mesh message runs in when the adapter's ``single_session`` is on.
SINGLE_CHAT_ID = "mesh"

_lock = threading.Lock()
_issued: dict[str, tuple[dict, float]] = {}
# The mesh origin ({"peerId"} or {"channel"}) of the turn the shared session runs or last ran.
_running: Optional[dict] = None


def set_running(origin: Optional[dict]) -> None:
    global _running
    _running = dict(origin) if origin else None


def running() -> Optional[dict]:
    return dict(_running) if _running else None


def issue(session: dict) -> str:
    """A fresh context id for one question asked from a cotal gateway source."""
    now = time.monotonic()
    token = "hermes-" + secrets.token_hex(16)
    with _lock:
        for old, (_, expires) in list(_issued.items()):
            if expires <= now:
                del _issued[old]
        while len(_issued) >= MAX_QUESTIONS:
            del _issued[next(iter(_issued))]
        _issued[token] = (dict(session), now + TTL_SECONDS)
    return token


def asking_session(context_id: object) -> Optional[dict]:
    """The session that asked the question ``context_id`` names, or None if none here did."""
    if not isinstance(context_id, str):
        return None
    with _lock:
        hit = _issued.get(context_id)
    if hit is None or hit[1] <= time.monotonic():
        return None
    return dict(hit[0])
