from __future__ import annotations

from collections import Counter
import re


def _words(text: str) -> list[str]:
    return re.findall(r"[\wÀ-ỹĐđ]+", text.casefold(), flags=re.UNICODE)


def is_degenerate_rewrite(text: str, source: str) -> bool:
    """Detect runaway/repetitive local-model rewrites before they reach TTS."""
    text = re.sub(r"\s+", " ", text).strip()
    source = re.sub(r"\s+", " ", source).strip()
    if not text:
        return True

    # A rewrite should stay close to the already-Vietnamese translated group.
    if len(text) < max(120, int(len(source) * 0.35)):
        return True
    if len(text) > max(int(len(source) * 1.70), len(source) + 700):
        return True

    tokens = _words(text)
    if len(tokens) < 80:
        return False

    counts = Counter(tokens)
    if len(counts) / len(tokens) < 0.20:
        return True
    if counts.most_common(1)[0][1] / len(tokens) > 0.12:
        return True

    max_run = 1
    run = 1
    for prev, current in zip(tokens, tokens[1:]):
        if current == prev:
            run += 1
            max_run = max(max_run, run)
        else:
            run = 1
    if max_run >= 5:
        return True

    trigrams = list(zip(tokens, tokens[1:], tokens[2:]))
    if trigrams:
        tri_counts = Counter(trigrams)
        top = tri_counts.most_common(1)[0][1]
        if top >= 5 and top / len(trigrams) > 0.035:
            return True

    sentences = [
        re.sub(r"\s+", " ", item).strip().casefold()
        for item in re.split(r"(?<=[.!?…])\s+|\n+", text)
        if len(item.strip()) >= 30
    ]
    if len(sentences) >= 4:
        sentence_counts = Counter(sentences)
        if sentence_counts.most_common(1)[0][1] >= 3:
            return True

    return False
