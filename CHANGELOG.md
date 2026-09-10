# Changelog

## 0.2.0

- **Pinning is now drag-drop.** Drop a core bonus item (from a compendium, the
  pilot sheet, the sidebar) onto a weapon mount on the mech sheet to pin it. The
  always-visible "pin core bonus" dropdown is gone.
- **Comp/Con import restores pins.** Importing a pilot from a Comp/Con JSON now
  reads each mount's `bonus_effects` and re-pins them to the matching imported
  mount (matched by the weapon the mount holds). Handles both the string and
  object shapes Comp/Con exports use.
- **Fixed:** the remove control on a pinned tag did nothing (it was a zero-size
  icon-font element). It's now a real × button.
- Overpower Caliber automation and Auto-Stabilizing Hardpoints accuracy are
  unchanged from 0.1.0.

## 0.1.0

Initial release.

- Pin **Auto-Stabilizing Hardpoints**, **Overpower Caliber**, or **Superheavy
  Mounting** to a weapon mount.
- **Auto-Stabilizing Hardpoints**: attacks with a weapon on a pinned mount gain
  **+1 Accuracy**, pre-filled and adjustable in the Accuracy/Difficulty dialog.
- **Overpower Caliber**: rolling damage for a weapon on a pinned mount, after a
  hit, prompts once per combat round to add **+1d6 bonus damage**.
- **Superheavy Mounting** is pin/display only by design.
- Pins stored in an actor flag keyed strictly by a mount signature.
