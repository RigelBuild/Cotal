# @cotal-ai/reconciler-shim

Serves the reconciler's seat commands (`wave-seats.*`) as a Cotal endpoint. Each call is checked
against a closed schema, then forwarded over a private Unix socket to the Go reconciler, which
authorizes and journals it. The shim holds no authority. Every socket failure is `unavailable`.

Run: `cotal-reconciler-shim --creds <path> [--socket /run/cotal-reconciler/shim.sock]`.
