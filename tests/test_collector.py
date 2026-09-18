from mystery_video.collector import VideoCandidate, dedupe_candidates


def test_dedupe_candidates():
    item = VideoCandidate(
        source_video_id="abc",
        source_url="https://example.com/abc",
        title="Example",
        published_at=None,
    )
    result = dedupe_candidates([item, item])
    assert len(result) == 1
