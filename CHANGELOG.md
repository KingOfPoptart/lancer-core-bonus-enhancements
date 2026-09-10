# Changelog

## 0.1.0

Initial release.

- Pin **Auto-Stabilizing Hardpoints**, **Overpower Caliber**, or **Superheavy Mounting**
  to a weapon mount from the mech sheet. A row under each mount header shows the
  pinned bonuses and, while the sheet is editable, a picker listing the piloting
  pilot's eligible core bonuses.
- **Auto-Stabilizing Hardpoints**: attacks with a weapon on a mount it is pinned
  to gain **+1 Accuracy**, pre-filled (and still adjustable) in the
  Accuracy/Difficulty dialog. Custom `WeaponAttackFlow` step via the system's
  `lancer.registerFlows` hook.
- **Overpower Caliber**: rolling damage for a weapon on a pinned mount, after a
  hit, prompts once per combat round to add **+1d6 bonus damage**. The use is
  recorded against the current combat round and frees up when the round advances.
  Custom `DamageRollFlow` step.
- **Superheavy Mounting** is pin/display only by design.
- Pins are stored in an actor flag keyed strictly by a mount signature (type +
  fitting sizes + index).

Known limitations:

- Core bonuses attached to mounts in Comp/Con are not carried in on import (the
  system discards that data); re-pin them by hand after importing.
- Pins are position-bound: reordering mounts, inserting a mount before a pinned
  one, or reconfiguring a mount's type/fittings clears its pin.
- Overpower Caliber's 1/round lock is only enforced during a tracked encounter;
  out of combat there is no round to limit against.
