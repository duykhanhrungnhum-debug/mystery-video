from mystery_video.rights import can_download


def test_verified_item_is_allowed():
    decision = can_download(
        source_auto_eligible=False,
        item_rights_verified=True,
    )
    assert decision.allowed is True


def test_unverified_item_is_blocked():
    decision = can_download(
        source_auto_eligible=False,
        item_rights_verified=False,
    )
    assert decision.allowed is False


def test_auto_eligible_source_is_allowed():
    decision = can_download(
        source_auto_eligible=True,
        item_rights_verified=False,
    )
    assert decision.allowed is True
