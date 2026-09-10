# Changelog

## 0.1.0

Initial release.

- Pin **Auto-Stabilizing Hardpoints**, **Overpower Caliber**, or **Superheavy Mounting**
  to a weapon mount from the mech sheet. A row under each mount header shows the
  pinned bonuses and, while the sheet is editable, a picker listing the piloting
  pilot's eligible core bonuses.
- **Auto-Stabilizing Hardpoints** automation: attacks with a weapon on a mount it
  is pinned to gain **+1 Accuracy**, pre-filled (and still adjustable) in the
  Accuracy/Difficulty dialog. Implemented as a custom `WeaponAttackFlow` step via
  the system's `lancer.registerFlows` hook.
- Pins are stored in an actor flag keyed strictly by a mount signature (type +
  fitting sizes + index).
- **Overpower Caliber** is pin/display only for now — the 1/round +1d6 needs a
  damage-roll hook that does not exist yet (system issue #189).
- **Superheavy Mounting** is pin/display only by design.

Known limitations:

- Core bonuses attached to mounts in Comp/Con are not carried in on import (the
  system discards that data); re-pin them by hand after importing.
- Pins are position-bound: reordering mounts, inserting a mount before a pinned
  one, or reconfiguring a mount's type/fittings clears its pin.
