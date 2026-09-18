from dataclasses import dataclass


@dataclass(frozen=True)
class RightsDecision:
    allowed: bool
    reason: str


def can_download(*, source_auto_eligible: bool, item_rights_verified: bool) -> RightsDecision:
    """Require item-level rights evidence before any download.

    source_auto_eligible is informational: it means the source has a generally
    favorable reuse policy, but it does not override item-level exclusions.
    """
    if item_rights_verified:
        return RightsDecision(True, "Item-level reuse rights were verified.")

    if source_auto_eligible:
        return RightsDecision(
            False,
            "The source policy is generally reusable, but this specific item still needs rights verification.",
        )

    return RightsDecision(False, "No verified reuse right is recorded for this item.")
