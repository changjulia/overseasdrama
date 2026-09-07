"""Opt-in narration support; episode highlights never become external hooks."""

def is_pre_roll_hook(hook: dict) -> bool:
    return hook.get("source_class") == "external_material" or (
        hook.get("source_class") == "narration_opening" and hook.get("usage_role") == "pre_roll"
    )


def narration_boundaries_verified(hook: dict) -> bool:
    if hook.get("source_class") != "narration_opening":
        return True
    return hook.get("boundary_status") == "verified" and all(
        isinstance(hook.get(name), dict) and hook[name].get("status") == "verified"
        for name in ("safe_start", "safe_end")
    )
