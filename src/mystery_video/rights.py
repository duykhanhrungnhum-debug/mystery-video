from dataclasses import dataclass


@dataclass(frozen=True)
class RightsDecision:
    allowed: bool
    reason: str


def can_download(*, source_auto_eligible: bool, item_rights_verified: bool) -> RightsDecision:
    if item_rights_verified:
        return RightsDecision(True, "Item-level reuse rights were verified.")
    if source_auto_eligible:
        return RightsDecision(
            True,
            "Source policy marks this source as automatically eligible; item-level exclusions still need to be honored.",
        )
    return RightsDecision(False, "No verified reuse right is recorded for this item.")
