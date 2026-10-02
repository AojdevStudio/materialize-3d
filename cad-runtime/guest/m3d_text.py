"""Bounded error text for the guest's JSON answers.

Every error the guest sends must fit the host's 4096-byte DONE frame after JSON encoding, and the runner's and
inspector's result.json must fit what the agent reads. Bounding by characters is not enough: one CJK character is
three bytes of UTF-8, and one control character escapes to six bytes of JSON. So errors are cut by their encoded
size, on a character boundary, keeping the longest prefix that fits.
"""

import json

# The budget for one error string as encoded JSON (UTF-8, quotes included). DONE adds about 30 bytes around it.
ERROR_MAX_BYTES = 2048


def _encoded_size(text):
    return len(json.dumps(text, ensure_ascii=False).encode("utf-8"))


def fit_error(text, max_bytes=ERROR_MAX_BYTES):
    """The longest prefix of `text` whose JSON encoding (UTF-8, quotes included) fits in `max_bytes`.

    Lone surrogates become "?" so the result always encodes. Every character encodes to at least one byte, so no
    prefix longer than `max_bytes` characters can fit, which bounds the work for any input size.
    """
    text = str(text)[:max_bytes].encode("utf-8", "replace").decode("utf-8")
    if _encoded_size(text) <= max_bytes:
        return text
    lo, hi = 0, len(text)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if _encoded_size(text[:mid]) <= max_bytes:
            lo = mid
        else:
            hi = mid - 1
    return text[:lo]


def failure_json(message):
    """A failed job's verdict, `{"ok": false, "error": ...}`, as bytes within the error budget."""
    return json.dumps({"ok": False, "error": fit_error(message)}, ensure_ascii=False).encode("utf-8")
