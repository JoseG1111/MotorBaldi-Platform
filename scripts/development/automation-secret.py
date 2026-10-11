#!/usr/bin/env python3
"""Noninteractive OS Secret Service bridge. Never print provider exceptions."""
import json
import sys

ATTRIBUTES = {"service": "motorbaldi-development-automation", "environment": "development"}


def main():
    import secretstorage
    connection = secretstorage.dbus_init()
    collection = secretstorage.get_default_collection(connection)
    if collection.is_locked():
        raise RuntimeError()
    items = list(collection.search_items(ATTRIBUTES))
    if len(items) > 1 or any(item.is_locked() for item in items):
        raise RuntimeError()
    operation = sys.argv[1] if len(sys.argv) == 2 else ""
    if operation == "lookup-optional" and not items:
        sys.stdout.write("null")
    elif operation in ("lookup", "lookup-optional"):
        if len(items) != 1:
            raise RuntimeError()
        sys.stdout.buffer.write(items[0].get_secret())
    elif operation == "store":
        raw = sys.stdin.buffer.read(16385)
        if len(raw) > 16384:
            raise RuntimeError()
        value = json.loads(raw)
        if set(value) != {"keyId", "version", "secret"}:
            raise RuntimeError()
        collection.create_item("MotorBaldi Development automation", ATTRIBUTES, raw, replace=True)
    else:
        raise RuntimeError()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.stderr.write("Development automation secret service unavailable.\n")
        sys.exit(1)
