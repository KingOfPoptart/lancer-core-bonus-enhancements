# Changelog

## 1.0.0

First stable release. All three core bonuses are automated and verified in-world.
Changes since 0.2.2:

- **Superheavy Mounting now adds a mount instead of tagging a weapon**, following
  the rule closely:
  - Dropping it anywhere on the mech sheet adds a `Superheavy`-type weapon mount —
    but only when the mech has fewer than 3 non-integrated mounts.
  - The mount is **superheavy-only**: a `preUpdateActor` hook strips any smaller
    weapon before it can be saved into the slot.
  - The added mount carries a "Superheavy Mounting" tag; removing the tag deletes
    the mount (with a confirm if a weapon is still in it — the weapon then stays
    on the mech, unmounted).
  - **Auto-bracing.** When a superheavy weapon is dropped into the mount, another
    mount is consumed as Bracing automatically — the Heavy mount if the mech has
    one (RAW: the superheavy weapon *must* use that mount), otherwise the last
    other weapon mount. The braced mount keeps its type, so its card still reads
    e.g. "Heavy Weapon Mount / LOCKED: BRACING". Whatever was on it is remembered
    and put back when the superheavy weapon leaves or the Superheavy Mounting
    mount is removed.
  - If you've manually braced some *other* mount while a free Heavy mount exists,
    the card still flags that the Heavy mount is the one that should be used.
  - **No mount to brace with.** If the superheavy weapon goes into the mount and
    there's no free mount left to consume as Bracing, it fails gracefully: a
    single warning toast tells you to add one (the system also flags "needs
    bracing"). The notice clears itself once you add a mount or remove the
    weapon.
  - Import: adopts an imported superheavy mount, or adds one for a mech whose
    Comp/Con superheavy slot held a weapon.
  - Tracked by a separate `superheavy` flag.
- **Drag-drop toasts no longer fire twice.** A single drop could reach both the
  native drop listener and the system's `onRootDrop`; the second is now
  swallowed within a short window.
- Auto-Stabilizing Hardpoints and Overpower Caliber are unchanged.

## 0.2.2

- **Fixed:** dragging a core bonus **from a compendium** still did nothing.
  On Foundry v13 a compendium row carries `data-entry-id`, which the LANCER
  system's global drag tracker doesn't recognise, so its whole sheet-drop
  pipeline never fires for compendium drags. The module now also adds its own
  capture-phase `dragover`/`drop` listeners on the mech sheet root: it
  `preventDefault`s dragover over a mount card so a `drop` actually fires, then
  reads the native drag payload itself. The pilot-sheet path (0.2.1) is kept for
  owned items.

## 0.2.1

- **Fixed:** dragging a core bonus onto a mount did nothing. The DIY drop
  listeners were being pre-empted by the system's own drop pipeline. Pinning now
  goes through that pipeline: `LancerMechSheet.canRootDrop` / `onRootDrop` are
  extended to accept a `core_bonus` drop and pin it to the mount under the
  cursor. Works from the compendium, the pilot sheet, and the sidebar.
- The mount card highlights while you drag a core bonus over it.

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
