/**
 * Lancer Core Bonus Enhancements
 * ------------------------------
 * Mechanical support for the mount-/weapon-scoped core bonuses that the LANCER
 * system does not automate (foundryvtt-lancer#724):
 *
 *   - Auto-Stabilizing Hardpoints  -> +1 Accuracy to attacks with any weapon on
 *                                     the chosen mount.
 *   - Overpower Caliber            -> 1/round, when you hit, offer +1d6 bonus
 *                                     damage on one weapon on the chosen mount.
 *   - Superheavy Mounting          -> adds an extra superheavy-only weapon mount
 *                                     to the mech; removing it deletes that mount.
 *
 * How it works, without touching the system:
 *
 * Storage
 *   - Auto-Stab / Overpower pins live in `mech.flags[MODULE_ID].mounts`, keyed by
 *     a mount signature (`type | fitting sizes | index`) and matched strictly:
 *     changing a mount's type/fittings, or reordering/inserting a mount ahead of
 *     a pinned one, drops the pin. See `mountSignature` / `getPins` / `setPins`.
 *   - Superheavy Mounting is a separate `mech.flags[MODULE_ID].superheavy` flag.
 *     The mount it adds is a real `weapon_mounts` entry of type "Superheavy".
 *
 * Drag-drop (two paths, because the system's sheet-drop pipeline only fires for
 * drags it can resolve into a GlobalDragPreview — owned items, pilot-sheet refs
 * — not Foundry v13 compendium rows, which carry `data-entry-id`):
 *   - Path 1 (`installDropHook`): extend `LancerMechSheet.prototype.canRootDrop`
 *     / `onRootDrop` to accept and route a `core_bonus`.
 *   - Path 2 (`installNativeDropListeners`): capture-phase `dragover`/`drop`
 *     listeners on the sheet root — `preventDefault` so `drop` fires, then read
 *     the native `text/plain` payload and route it ourselves.
 *   - A single drop can hit both; `isDuplicateDrop` swallows the second within a
 *     short window so the confirmation toast fires once.
 *
 * Import (`installImportHook`): wrap `LancerPilotSheet.prototype._onPilotJsonParsed`
 *   so that after the system's Comp/Con import finishes, `applyImportedPins`
 *   matches each mech mount's `bonus_effects` to the imported Foundry mount by
 *   the weapon it holds and pins them; for Superheavy Mounting it adopts an
 *   imported superheavy mount or adds one when the Comp/Con superheavy slot held
 *   a weapon.
 *
 * Accuracy: a `WeaponAttackFlow` step (`…autostabAccuracy`), registered through
 *   `lancer.registerFlows` and inserted after `initAttackData`, adds 1 to
 *   `state.data.acc_diff.base.accuracy` before the HUD opens; it stays editable.
 *
 * Bonus damage: a `DamageRollFlow` step (`…overpowerDamage`) inserted after
 *   `initDamageData` — on a hit, if Overpower Caliber is pinned + owned + unused
 *   this round, it prompts to add `{type} 1d6` to `state.data.bonus_damage` and
 *   records the use against `game.combat.id` + `game.combat.round`.
 *
 * Superheavy Mounting: `addSuperheavyMount` appends a Superheavy `weapon_mounts`
 *   entry when the mech has < 3 non-integrated mounts. `enforceSuperheavyOnly`
 *   (preUpdateActor) nulls any non-superheavy weapon out of that mount before it
 *   saves, with an `updateActor` pass as the safety net. On that same pass,
 *   `syncSuperheavyBracing` runs: once the mount holds a superheavy weapon and
 *   nothing is braced, it sets another mount to `{ ...origType, bracing: true,
 *   slots: [] }` — the Heavy mount by preference, else the last other weapon
 *   mount — and stashes that mount's type and slots in the flag's `braced` key,
 *   restoring it when the weapon leaves or the mount is removed. With no free
 *   mount it warns once and records `noBrace` so routine updates don't re-warn.
 *   `superheavyBracingIssue` supplies the "must be the Heavy mount" note for a
 *   mount braced by hand while a free Heavy exists.
 *
 * Known limitations
 * ----------------
 *   - Pins are position-bound (see Storage above): reordering or inserting a
 *     mount ahead of a pinned one drops the pin.
 *   - Cloud / share-code pilot import does not restore pins; JSON import and
 *     drag-drop do.
 *   - Overpower Caliber treats a target-less damage roll as a hit (matching how
 *     the system rolls target-less damage), and its 1/round lock is only
 *     enforced inside a tracked encounter.
 *   - The Superheavy Mounting mount is kept superheavy-only by a preUpdateActor
 *     strip. Its Bracing mount is chosen automatically; brace a different one by
 *     hand and the module leaves it alone. With no free mount at all the weapon
 *     can't be braced — you get a warning and must add a mount.
 */

const MODULE_ID = "lancer-core-bonus-enhancements";
const AUTOSTAB_LID = "cb_auto_stabilizing_hardpoints";
const OVERPOWER_LID = "cb_overpower_caliber";
const SUPERHEAVY_LID = "cb_superheavy_mounting";

/**
 * The core bonuses this module understands.
 *   accuracy    - flat Accuracy added to attacks with weapons on a pinned mount
 *   bonusDamage - dice string offered as bonus damage, 1/round, on a hit
 *   addsMount   - drops onto the mech (not a mount) and adds a weapon mount
 */
const MOUNT_CORE_BONUSES = {
  [AUTOSTAB_LID]: {
    label: "Auto-Stabilizing Hardpoints",
    effect: "Weapons attached to this mount gain +1 Accuracy.",
    accuracy: 1,
  },
  [OVERPOWER_LID]: {
    label: "Overpower Caliber",
    effect: "1/round, when you hit with a weapon on this mount, it can deal +1d6 bonus damage.",
    bonusDamage: "1d6",
  },
  [SUPERHEAVY_LID]: {
    label: "Superheavy Mounting",
    effect: "Adds an extra superheavy-only weapon mount to the mech. Remove to delete the mount.",
    addsMount: true,
  },
};

const isMountCoreBonus = lid => Object.prototype.hasOwnProperty.call(MOUNT_CORE_BONUSES, lid);
/** Core bonuses that pin to a specific mount (as opposed to adding one). */
const isPinBonus = lid => isMountCoreBonus(lid) && !MOUNT_CORE_BONUSES[lid].addsMount;

/** Pull a LID out of a Comp/Con `bonus_effects` entry (string or {id: "..."}). */
const bonusEffectLid = be => (typeof be === "string" ? be : be?.id ?? be?.lid ?? null);

/* -------------------------------------------------------------------------- */
/*  Storage — an actor flag: { mounts: { <signature>: [lid, ...] } }          */
/* -------------------------------------------------------------------------- */

/**
 * A key for one mount: mount type + its ordered fitting sizes + its index.
 *
 * Matching is strict — no fuzzy fallback — because two identically configured
 * mounts (e.g. two Main mounts) would otherwise be indistinguishable and a pin
 * on one would leak onto the other. The trade-off: reordering or inserting a
 * mount ahead of a pinned one drops the pin, and it must be re-pinned. Changing
 * a mount's type or fittings also drops its pins, which is intended.
 */
function mountSignature(mount, index) {
  const sizes = (mount?.slots ?? []).map(s => s?.size ?? "?").join(",");
  return `${mount?.type ?? "?"}|${sizes}|${index}`;
}

function readAllPins(mech) {
  return foundry.utils.deepClone(mech.getFlag(MODULE_ID, "mounts") ?? {});
}

/** LIDs pinned to exactly this mount (strict signature match). */
function getPins(mech, mount, index) {
  const entry = readAllPins(mech)[mountSignature(mount, index)];
  return Array.isArray(entry) ? entry : [];
}

async function setPins(mech, mount, index, lids) {
  const all = readAllPins(mech);
  const sig = mountSignature(mount, index);
  const clean = [...new Set(lids.filter(isPinBonus))];
  if (clean.length) all[sig] = clean;
  else delete all[sig];

  // setFlag merges recursively, so it can't remove a key. Clear the whole map,
  // then write the fresh one back if anything is left.
  await mech.unsetFlag(MODULE_ID, "mounts");
  if (Object.keys(all).length) {
    await mech.setFlag(MODULE_ID, "mounts", all);
  }
}

/** The mount (and its index) holding a given equipped mech weapon, or null. */
function mountForWeapon(mech, weaponId) {
  const mounts = mech?.system?.loadout?.weapon_mounts ?? [];
  const index = mounts.findIndex(m =>
    (m?.slots ?? []).some(s => s?.weapon?.value?.id === weaponId)
  );
  return index < 0 ? null : { mount: mounts[index], index };
}

/** True when `lid` is pinned to the weapon's mount AND owned by the pilot. */
function activeCoreBonusForWeapon(mech, weaponId, lid) {
  if (!mech || mech.type !== "mech" || !weaponId) return false;
  const found = mountForWeapon(mech, weaponId);
  if (!found) return false;
  if (!getPins(mech, found.mount, found.index).includes(lid)) return false;
  return pilotMountCoreBonusLids(mech).has(lid);
}

/* -------------------------------------------------------------------------- */
/*  Pilot core bonuses                                                        */
/* -------------------------------------------------------------------------- */

/** Set of LIDs the piloting pilot actually owns, intersected with our set. */
function pilotMountCoreBonusLids(mech) {
  const pilot = mech.system?.pilot?.value;
  const items = pilot?.itemTypes?.core_bonus ?? [];
  return new Set(items.map(cb => cb?.system?.lid).filter(isMountCoreBonus));
}

/** Display name for a LID: the pilot's item name if owned, else our label. */
function coreBonusLabel(mech, lid) {
  const pilot = mech.system?.pilot?.value;
  const owned = pilot?.itemTypes?.core_bonus?.find(cb => cb?.system?.lid === lid);
  return owned?.name ?? MOUNT_CORE_BONUSES[lid]?.label ?? lid;
}

/* -------------------------------------------------------------------------- */
/*  Overpower Caliber — 1/round usage tracking                                */
/* -------------------------------------------------------------------------- */

/**
 * "1/round" is a combat concept. In combat the use is recorded against the
 * current combat id + round number and frees up when the round advances. Out of
 * combat there is no round, so no limit is enforced.
 */
function overpowerUsedThisRound(mech) {
  const combat = game.combat;
  if (!combat) return false;
  const used = mech.getFlag(MODULE_ID, "overpower");
  return !!used && used.combat === combat.id && used.round === combat.round;
}

async function markOverpowerUsed(mech) {
  const combat = game.combat;
  await mech.setFlag(MODULE_ID, "overpower", {
    combat: combat?.id ?? null,
    round: combat?.round ?? null,
    at: Date.now(),
  });
}

async function confirmDialog(title, content) {
  try {
    const DialogV2 = foundry.applications?.api?.DialogV2;
    if (DialogV2?.confirm) {
      return await DialogV2.confirm({
        window: { title },
        content: `<p>${content}</p>`,
        rejectClose: false,
        modal: true,
      });
    }
  } catch (err) {
    console.warn(`${MODULE_ID} | DialogV2 unavailable, falling back`, err);
  }
  return await Dialog.confirm({ title, content: `<p>${content}</p>` });
}

/* -------------------------------------------------------------------------- */
/*  Superheavy Mounting — adds a superheavy-only weapon mount                 */
/* -------------------------------------------------------------------------- */
/*
 * RAW (Dustgrave): "If your mech has fewer than 3 mounts (excluding integrated
 * mounts) it gains an additional superheavy mount. It can only take SUPERHEAVY
 * WEAPONS. They still require an additional mount to be installed. If your mech
 * also has a heavy mount the SUPERHEAVY WEAPON must use that mount as the
 * additional mount."
 *
 * This module:
 *  - adds the mount only when the mech has < 3 non-integrated mounts;
 *  - keeps the mount superheavy-only (strips a smaller weapon on any update);
 *  - flags on the mount card if the superheavy weapon isn't braced, and — when
 *    the mech has a heavy mount — if the braced mount isn't the heavy one.
 */

// Re-entrancy guard: the mount edits below trigger `updateActor`, which calls
// `syncSuperheavyBracing`; hold this while we're mid-edit so it doesn't race us.
let _shmSyncing = false;

function superheavyActive(mech) {
  return !!mech?.getFlag?.(MODULE_ID, "superheavy")?.active;
}

/** Non-integrated weapon mounts (what the "< 3 mounts" clause counts). */
function nonIntegratedMountCount(mech, mounts = mech?.system?.loadout?.weapon_mounts) {
  return (mounts ?? []).filter(m => m?.type && m.type !== "Integrated" && m.type !== "Superheavy").length;
}

/** Index of the module's superheavy mount (prefer an empty one), or -1. */
function superheavyMountIndex(mech) {
  const mounts = mech?.system?.loadout?.weapon_mounts ?? [];
  const sh = [];
  mounts.forEach((m, i) => {
    if (m?.type === "Superheavy" && !m.bracing) sh.push(i);
  });
  if (!sh.length) return -1;
  const empty = sh.find(i => !(mounts[i].slots ?? []).some(s => s?.weapon?.value));
  return empty ?? sh[sh.length - 1];
}

/**
 * Index of the weapon mount this module consumed as Bracing, or -1. The braced
 * mount keeps its real type (so its card still reads "Heavy Weapon Mount"), so
 * match `flag.braced.type` first; fall back to a mount blanked to "Unknown"
 * (older flags, or the system's own Superheavy Bracing action) then any bracing
 * mount.
 */
function bracedMountIndex(mech, mounts = mech?.system?.loadout?.weapon_mounts ?? []) {
  const want = mech?.getFlag?.(MODULE_ID, "superheavy")?.braced?.type;
  const bracing = mounts.map((m, i) => ({ m, i })).filter(x => x.m.bracing);
  return (
    bracing.find(x => x.m.type === want)?.i ??
    bracing.find(x => x.m.type === "Unknown")?.i ??
    bracing[0]?.i ??
    -1
  );
}

/** Size (`WeaponSize`) of an owned weapon by id, or null. */
function weaponSizeById(mech, id) {
  return mech?.items?.get?.(id)?.system?.size ?? null;
}

async function addSuperheavyMount(mech, doc) {
  if (!mech || mech.type !== "mech") return;
  if (superheavyActive(mech)) {
    ui.notifications?.info(game.i18n.localize(`${MODULE_ID}.superheavy.already`));
    return;
  }
  const count = nonIntegratedMountCount(mech);
  if (count >= 3) {
    ui.notifications?.warn(
      game.i18n.format(`${MODULE_ID}.superheavy.tooManyMounts`, { count })
    );
    return;
  }
  const mounts = foundry.utils.deepClone(mech.system._source.loadout.weapon_mounts ?? []);
  mounts.push({
    type: "Superheavy",
    bracing: false,
    slots: [{ size: "Superheavy", weapon: null, mod: null }],
  });
  await mech.update({ "system.loadout.weapon_mounts": mounts });
  await mech.setFlag(MODULE_ID, "superheavy", { active: true, at: Date.now() });
  ui.notifications?.info(game.i18n.localize(`${MODULE_ID}.superheavy.added`));
  if (doc && !pilotMountCoreBonusLids(mech).has(SUPERHEAVY_LID)) {
    ui.notifications?.warn(game.i18n.localize(`${MODULE_ID}.orphanWarning`));
  }
}

async function removeSuperheavyMount(mech) {
  if (!mech || mech.type !== "mech") return;
  const idx = superheavyMountIndex(mech);
  if (idx < 0) {
    await mech.unsetFlag(MODULE_ID, "superheavy");
    return;
  }
  const mounts = foundry.utils.deepClone(mech.system._source.loadout.weapon_mounts ?? []);
  const hasWeapon = (mounts[idx]?.slots ?? []).some(s => s?.weapon);
  if (hasWeapon) {
    const ok = await confirmDialog(
      MOUNT_CORE_BONUSES[SUPERHEAVY_LID].label,
      game.i18n.localize(`${MODULE_ID}.superheavy.confirmRemoveWithWeapon`)
    );
    if (!ok) return;
  }
  mounts.splice(idx, 1);

  // Restore the mount we braced for this superheavy weapon, in the same update.
  const flag = mech.getFlag(MODULE_ID, "superheavy");
  if (flag?.braced) {
    const bi = bracedMountIndex(mech, mounts);
    if (bi >= 0) {
      const t = flag.braced.type ?? "Main";
      mounts[bi] = {
        type: t,
        bracing: false,
        slots: Array.isArray(flag.braced.slots) && flag.braced.slots.length
          ? foundry.utils.deepClone(flag.braced.slots)
          : slotsFor(t),
      };
    }
  }

  // Hold the sync guard across both writes so the updateActor hook doesn't
  // resurrect the flag we're about to clear.
  _shmSyncing = true;
  try {
    await mech.update({ "system.loadout.weapon_mounts": mounts });
    await mech.unsetFlag(MODULE_ID, "superheavy");
  } finally {
    _shmSyncing = false;
  }
  ui.notifications?.info(game.i18n.localize(`${MODULE_ID}.superheavy.removed`));
}

/**
 * preUpdateActor: keep the superheavy mount(s) superheavy-only. Strips any
 * non-superheavy weapon out of the incoming `weapon_mounts` before it is saved.
 */
function enforceSuperheavyOnly(actor, changes) {
  try {
    if (actor?.type !== "mech" || !superheavyActive(actor)) return;
    const mounts =
      changes?.system?.loadout?.weapon_mounts ??
      changes?.["system.loadout.weapon_mounts"] ??
      foundry.utils.getProperty(changes, "system.loadout.weapon_mounts");
    if (!Array.isArray(mounts)) return;

    let bounced = null;
    for (const m of mounts) {
      if (m?.type !== "Superheavy" || m.bracing) continue;
      for (const slot of m.slots ?? []) {
        const id = typeof slot?.weapon === "string" ? slot.weapon : slot?.weapon?.id ?? slot?.weapon?.value?.id;
        if (!id) continue;
        const size = weaponSizeById(actor, id);
        if (size && size !== "Superheavy") {
          bounced = actor.items.get(id)?.name ?? "that weapon";
          slot.weapon = null;
        }
      }
    }
    if (bounced) {
      ui.notifications?.warn(
        game.i18n.format(`${MODULE_ID}.superheavy.onlySuperheavy`, { name: bounced })
      );
    }
  } catch (err) {
    console.error(`${MODULE_ID} | superheavy-only enforcement failed`, err);
  }
}

/**
 * The RAW nuance still worth flagging after auto-bracing: if the player has
 * manually braced some *other* mount while a free heavy mount exists, RAW says
 * the heavy mount is the one that must be used. "" if fine.
 */
function superheavyBracingIssue(mech) {
  const mounts = mech?.system?.loadout?.weapon_mounts ?? [];
  const shIdx = superheavyMountIndex(mech);
  if (shIdx < 0) return "";

  const hasSuperWeapon = (mounts[shIdx]?.slots ?? []).some(
    s => slotWeaponSize(mech, s) === "Superheavy"
  );
  if (!hasSuperWeapon) return "";

  const bracingMounts = mounts.filter((m, i) => m?.bracing && i !== shIdx);
  if (!bracingMounts.length) return ""; // system already flags "needs bracing"

  const hasFreeHeavy = mounts.some(m => m?.type === "Heavy" && !m.bracing);
  if (hasFreeHeavy && !bracingMounts.some(m => m.type === "Heavy")) {
    return game.i18n.localize(`${MODULE_ID}.superheavy.braceHeavy`);
  }
  return "";
}

/** Fitting sizes for a mount type — mirrors the system's fittingsForMount. */
function fittingsFor(type) {
  switch (type) {
    case "Aux": return ["Auxiliary"];
    case "Aux/Aux": return ["Auxiliary", "Auxiliary"];
    case "Flex": return ["Flex", "Auxiliary"];
    case "Main": return ["Main"];
    case "Main/Aux": return ["Main", "Auxiliary"];
    case "Heavy": return ["Heavy"];
    case "Superheavy": return ["Superheavy"];
    default: return ["Integrated"];
  }
}
const slotsFor = type => fittingsFor(type).map(size => ({ size, weapon: null, mod: null }));

/**
 * Weapon size for a mount slot, resilient to the embedded-ref not being resolved
 * yet: prefer the prepared `.value`, fall back to looking the item up by id (the
 * shape right after the LANCER sheet drops a weapon into a mount).
 */
function slotWeaponSize(mech, slot) {
  const resolved = slot?.weapon?.value?.system?.size;
  if (resolved) return resolved;
  const id =
    typeof slot?.weapon === "string"
      ? slot.weapon
      : slot?.weapon?.id ?? slot?.weapon?.value?.id ?? null;
  return id ? weaponSizeById(mech, id) : null;
}

/**
 * A superheavy weapon "requires a heavy mount and another mount" — the module's
 * bonus mount holds it, and a second mount is consumed as bracing. RAW: "if your
 * mech also has a heavy mount the SUPERHEAVY WEAPON must use that mount". So when
 * the module's superheavy mount gains a superheavy weapon and nothing is braced,
 * brace the heavy mount (else the last other weapon mount); restore it when the
 * weapon leaves or the mount is removed.
 */
async function syncSuperheavyBracing(mech) {
  if (_shmSyncing) return;
  const flag = mech.getFlag(MODULE_ID, "superheavy");
  if (!flag?.active) return;

  const mounts = mech.system.loadout.weapon_mounts ?? [];
  const shIdx = superheavyMountIndex(mech);
  const shHasSuper =
    shIdx >= 0 &&
    (mounts[shIdx].slots ?? []).some(s => slotWeaponSize(mech, s) === "Superheavy");
  const bracing = mounts.map((m, i) => ({ m, i })).filter(x => x.m.bracing);

  // restore the mount we braced, once the superheavy weapon is gone
  if (flag.braced && !shHasSuper) {
    _shmSyncing = true;
    try {
      const oursIdx = bracedMountIndex(mech, mounts);
      const t = flag.braced.type ?? "Main";
      if (oursIdx >= 0) {
        const next = foundry.utils.deepClone(mech.system._source.loadout.weapon_mounts ?? []);
        next[oursIdx] = {
          type: t,
          bracing: false,
          slots: Array.isArray(flag.braced.slots) && flag.braced.slots.length
            ? foundry.utils.deepClone(flag.braced.slots)
            : slotsFor(t),
        };
        await mech.update({ "system.loadout.weapon_mounts": next });
        ui.notifications?.info(
          game.i18n.format(`${MODULE_ID}.superheavy.unbraced`, { type: t })
        );
      }
      // setFlag merges, so drop the whole key then rewrite it without `braced`.
      await mech.unsetFlag(MODULE_ID, "superheavy");
      await mech.setFlag(MODULE_ID, "superheavy", { active: true, at: flag.at });
    } finally {
      _shmSyncing = false;
    }
    return;
  }

  // Clear a stale "no mount to brace with" notice once the situation resolves —
  // the superheavy weapon was removed, or the player braced a mount by hand.
  if (flag.noBrace && (!shHasSuper || bracing.length)) {
    _shmSyncing = true;
    try {
      await mech.unsetFlag(MODULE_ID, "superheavy");
      await mech.setFlag(MODULE_ID, "superheavy", { active: true, at: flag.at });
    } finally {
      _shmSyncing = false;
    }
    return;
  }

  // auto-brace once a superheavy weapon is installed and nothing is braced yet
  if (shHasSuper && !flag.braced && !bracing.length) {
    let pick = mounts.findIndex((m, i) => i !== shIdx && m.type === "Heavy" && !m.bracing);
    if (pick < 0) {
      for (let i = mounts.length - 1; i >= 0; i--) {
        const m = mounts[i];
        if (i !== shIdx && m.type !== "Integrated" && m.type !== "Superheavy" && !m.bracing) {
          pick = i;
          break;
        }
      }
    }
    if (pick < 0) {
      // No mount left to consume as Bracing — the build is invalid (a superheavy
      // weapon needs its mount plus another). Tell the player once; the system
      // also flags "needs bracing" on its own.
      if (!flag.noBrace) {
        const name =
          (mounts[shIdx]?.slots ?? []).map(s => s?.weapon?.value?.name).find(Boolean) ??
          "The superheavy weapon";
        ui.notifications?.warn(
          game.i18n.format(`${MODULE_ID}.superheavy.noBraceMount`, { name })
        );
        _shmSyncing = true;
        try {
          await mech.setFlag(MODULE_ID, "superheavy", { noBrace: true });
        } finally {
          _shmSyncing = false;
        }
      }
      return;
    }

    _shmSyncing = true;
    try {
      const origType = mounts[pick].type;
      const next = foundry.utils.deepClone(mech.system._source.loadout.weapon_mounts ?? []);
      // Preserve whatever was mounted so it can be put back when the brace lifts.
      const origSlots = foundry.utils.deepClone(next[pick].slots ?? []);
      // Keep the mount's real type so its card still reads e.g. "Heavy Weapon
      // Mount"; `bracing` alone makes the sheet render it as LOCKED: BRACING.
      next[pick] = { type: origType, bracing: true, slots: [] };
      await mech.update({ "system.loadout.weapon_mounts": next });
      await mech.unsetFlag(MODULE_ID, "superheavy");
      await mech.setFlag(MODULE_ID, "superheavy", {
        active: true,
        at: flag.at,
        braced: { type: origType, slots: origSlots },
      });
      ui.notifications?.info(
        game.i18n.format(`${MODULE_ID}.superheavy.braced`, { type: origType })
      );
    } finally {
      _shmSyncing = false;
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Drag-drop to pin — via the system's own canRootDrop / onRootDrop          */
/* -------------------------------------------------------------------------- */

/** Is this a drop entry for a core bonus this module handles? */
function isCoreBonusDrop(entry) {
  return (
    entry?.type === "Item" &&
    entry.document?.type === "core_bonus" &&
    isMountCoreBonus(entry.document.system?.lid)
  );
}

/**
 * A single drop can reach both the native capture-phase listener and the
 * system's `onRootDrop`. Swallow the second call for the same item within a
 * short window so its toast (and work) only happens once.
 */
let _lastHandledDrop = { key: null, at: 0 };
function isDuplicateDrop(doc) {
  const key = doc?.uuid ?? doc?.system?.lid ?? null;
  const now = Date.now();
  if (key && _lastHandledDrop.key === key && now - _lastHandledDrop.at < 800) {
    return true;
  }
  _lastHandledDrop = { key, at: now };
  return false;
}

/** Locate the weapon mount index from a drop event's target element. */
function mountIndexFromEvent(event) {
  const el = event?.target ?? event?.originalEvent?.target ?? event?.currentTarget;
  const node =
    el?.closest?.(".mount-type-ctx-root, .mount.card") ??
    (el?.nodeType === 3 ? el.parentElement?.closest?.(".mount-type-ctx-root, .mount.card") : null);
  if (!node) return -1;
  const path =
    node.dataset?.path ??
    node.querySelector?.(".mount-type-ctx-root")?.dataset?.path ??
    node.closest?.(".mount.card")?.querySelector?.(".mount-type-ctx-root")?.dataset?.path ??
    "";
  const m = /weapon_mounts\.(\d+)/.exec(path);
  return m ? Number(m[1]) : -1;
}

async function doPinCoreBonus(mech, index, doc) {
  const lid = doc?.system?.lid;
  const mount = index >= 0 ? mech?.system?.loadout?.weapon_mounts?.[index] : null;
  if (!mount || mount.bracing) {
    ui.notifications?.warn(game.i18n.localize(`${MODULE_ID}.drop.needMount`));
    return;
  }
  const pins = getPins(mech, mount, index);
  if (pins.includes(lid)) {
    ui.notifications?.info(game.i18n.format(`${MODULE_ID}.drop.already`, { name: doc.name }));
    return;
  }
  await setPins(mech, mount, index, [...pins, lid]);
  ui.notifications?.info(
    game.i18n.format(`${MODULE_ID}.drop.pinned`, { name: doc.name, mount: mount.type })
  );
  if (!pilotMountCoreBonusLids(mech).has(lid)) {
    ui.notifications?.warn(game.i18n.localize(`${MODULE_ID}.orphanWarning`));
  }
}

/**
 * Route a dropped core bonus. Superheavy Mounting adds a mount to the mech;
 * everything else pins to the weapon mount under the cursor (`cardEl`).
 */
async function routeCoreBonusDrop(mech, doc, cardEl) {
  if (isDuplicateDrop(doc)) return;
  if (doc?.system?.lid === SUPERHEAVY_LID) return addSuperheavyMount(mech, doc);
  let index = -1;
  const path = cardEl?.querySelector?.(".mount-type-ctx-root")?.dataset?.path
    ?? cardEl?.dataset?.path ?? "";
  const m = /weapon_mounts\.(\d+)/.exec(path);
  if (m) index = Number(m[1]);
  return doPinCoreBonus(mech, index, doc);
}

async function pinDroppedCoreBonus(mech, event, doc) {
  if (isDuplicateDrop(doc)) return;
  if (doc?.system?.lid === SUPERHEAVY_LID) return addSuperheavyMount(mech, doc);
  return doPinCoreBonus(mech, mountIndexFromEvent(event), doc);
}

/**
 * Path 1 — owned items / anything the system resolves into a `GlobalDragPreview`
 * (e.g. dragging a core bonus off the pilot sheet). The system routes those
 * through `canRootDrop` (which gates the dragover preventDefault) and
 * `onRootDrop`; we extend both on the mech sheet prototype.
 */
function installDropHook() {
  const proto = game.lancer?.applications?.LancerMechSheet?.prototype;
  if (!proto || proto.__lcbeDropPatched) return;

  const origCan = proto.canRootDrop;
  proto.canRootDrop = function (entry) {
    if (isCoreBonusDrop(entry)) return true;
    return origCan.call(this, entry);
  };

  const origOn = proto.onRootDrop;
  proto.onRootDrop = async function (entry, event, dest) {
    if (isCoreBonusDrop(entry)) {
      try {
        await pinDroppedCoreBonus(this.actor, event, entry.document);
      } catch (err) {
        console.error(`${MODULE_ID} | core bonus drop failed`, err);
      }
      return; // handled — do not let the sheet also process it
    }
    return origOn.call(this, entry, event, dest);
  };

  proto.__lcbeDropPatched = true;
  console.log(`${MODULE_ID} | patched LancerMechSheet drop handling for core bonuses`);
}

/**
 * Path 2 — native drops the system never sees. On Foundry v13 a compendium row
 * carries `data-entry-id` (not `data-documentId`), so the system's global
 * drag-tracker never resolves it, `GlobalDragPreview` stays null, and its
 * `handleDocDropping` never fires. We add our own capture-phase listeners on the
 * sheet root: preventDefault on dragover so a `drop` actually fires, then on
 * drop read the native `text/plain` payload ourselves.
 */
function installNativeDropListeners(rootEl, mech) {
  if (!rootEl || rootEl.dataset.lcbeNativeDrop === "1") return;
  rootEl.dataset.lcbeNativeDrop = "1";

  const cardFrom = ev => ev.target?.closest?.(".mount.card");

  rootEl.addEventListener(
    "dragover",
    ev => {
      if (mech.type !== "mech") return;
      const types = ev.dataTransfer ? Array.from(ev.dataTransfer.types) : [];
      if (!types.includes("text/plain")) return;
      // Allow the drop anywhere on the sheet — Superheavy Mounting is dropped on
      // the mech, not a mount. The drop handler validates and routes.
      ev.preventDefault(); // required or the browser never fires `drop`
      const card = cardFrom(ev);
      if (card && document.body.classList.contains("dragging-core_bonus")) {
        card.classList.add("lcbe-drop-ok");
      }
    },
    true
  );

  rootEl.addEventListener(
    "dragleave",
    ev => cardFrom(ev)?.classList.remove("lcbe-drop-ok"),
    true
  );

  rootEl.addEventListener(
    "drop",
    async ev => {
      if (mech.type !== "mech") return;
      cardFrom(ev)?.classList.remove("lcbe-drop-ok");

      let raw;
      try {
        raw = ev.dataTransfer?.getData("text/plain");
      } catch {
        return;
      }
      if (!raw) return;

      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        return;
      }
      if (data?.type !== "Item" || !data.uuid) return;

      let doc;
      try {
        doc = await fromUuid(data.uuid);
      } catch {
        return;
      }
      if (doc?.type !== "core_bonus" || !isMountCoreBonus(doc.system?.lid)) return;

      // It's ours — take it over completely.
      ev.preventDefault();
      ev.stopImmediatePropagation();
      try {
        await routeCoreBonusDrop(mech, doc, cardFrom(ev));
      } catch (err) {
        console.error(`${MODULE_ID} | native core bonus drop failed`, err);
      }
    },
    true
  );
}

/* -------------------------------------------------------------------------- */
/*  Sheet decoration — pinned-bonus tags                                      */
/* -------------------------------------------------------------------------- */

function decorateMountCard(card, mech, editable) {
  const header = card.querySelector(".mount-type-ctx-root");
  const idxMatch = /weapon_mounts\.(\d+)/.exec(header?.dataset?.path ?? "");
  if (!header || !idxMatch) return;

  const index = Number(idxMatch[1]);
  const mount = mech.system?.loadout?.weapon_mounts?.[index];
  if (!mount || mount.bracing) return;

  // Visual feedback only while dragging a core bonus over the card; the actual
  // drop is handled by the patched canRootDrop / onRootDrop.
  if (editable && card.dataset.lcbeHover !== "1") {
    card.dataset.lcbeHover = "1";
    const isCbDrag = () => document.body.classList.contains("dragging-core_bonus");
    card.addEventListener("dragenter", () => { if (isCbDrag()) card.classList.add("lcbe-drop-ok"); });
    card.addEventListener("dragleave", () => card.classList.remove("lcbe-drop-ok"));
    card.addEventListener("drop", () => card.classList.remove("lcbe-drop-ok"));
  }

  card.querySelector(".lcbe-row")?.remove(); // rebuilt each render

  const pins = getPins(mech, mount, index);
  const isShmMount = superheavyActive(mech) && index === superheavyMountIndex(mech);
  if (!pins.length && !isShmMount) return;

  const owned = pilotMountCoreBonusLids(mech);
  const row = document.createElement("div");
  row.className = "lcbe-row";

  const entries = pins.map(lid => ({ lid, shm: false }));
  if (isShmMount) entries.push({ lid: SUPERHEAVY_LID, shm: true });

  for (const { lid, shm } of entries) {
    const tag = document.createElement("span");
    tag.className = "lcbe-tag";
    const orphaned = !owned.has(lid);
    if (orphaned) tag.classList.add("lcbe-tag--orphan");
    tag.title = orphaned
      ? game.i18n.localize(`${MODULE_ID}.orphanWarning`)
      : MOUNT_CORE_BONUSES[lid]?.effect ?? "";

    const icon = document.createElement("i");
    icon.className = "cci cci-corebonus";
    tag.append(icon, document.createTextNode(" " + coreBonusLabel(mech, lid)));

    if (editable) {
      const remove = document.createElement("span");
      remove.className = "lcbe-remove";
      remove.textContent = "×"; // ×
      remove.title = shm
        ? game.i18n.localize(`${MODULE_ID}.superheavy.removeTitle`)
        : game.i18n.localize(`${MODULE_ID}.detach`);
      remove.setAttribute("role", "button");
      remove.setAttribute("tabindex", "0");
      remove.setAttribute("aria-label", remove.title);
      const doRemove = ev => {
        ev.preventDefault();
        ev.stopPropagation();
        if (shm) {
          removeSuperheavyMount(mech);
          return;
        }
        const live = mech.system.loadout.weapon_mounts[index];
        if (!live) return;
        setPins(mech, live, index, getPins(mech, live, index).filter(l => l !== lid));
      };
      remove.addEventListener("click", doRemove);
      remove.addEventListener("keydown", ev => {
        if (ev.key === "Enter" || ev.key === " ") doRemove(ev);
      });
      tag.append(remove);
    }
    row.append(tag);
  }

  header.after(row);

  // RAW bracing check on the module's superheavy mount.
  if (isShmMount) {
    const issue = superheavyBracingIssue(mech);
    if (issue) {
      const warn = document.createElement("div");
      warn.className = "lcbe-warn";
      warn.textContent = issue;
      row.after(warn);
    }
  }
}

function onRenderMechSheet(app, html) {
  try {
    const mech = app?.actor;
    if (!mech || mech.type !== "mech") return;
    installNativeDropListeners(html?.[0] ?? html, mech);
    const root = html?.[0] ?? html;
    if (!(root instanceof HTMLElement)) return;
    const editable = !!app.isEditable;
    root.querySelectorAll(".mount.card").forEach(card => decorateMountCard(card, mech, editable));
  } catch (err) {
    console.error(`${MODULE_ID} | failed to decorate mech sheet`, err);
  }
}

/* -------------------------------------------------------------------------- */
/*  Comp/Con import — restore pins from each mount's bonus_effects            */
/* -------------------------------------------------------------------------- */

async function applyImportedPins(rawPilotData) {
  const data = rawPilotData?.data ?? rawPilotData; // unwrap CCv3 EXPORT wrapper
  const ccMechs = data?.mechs;
  if (!Array.isArray(ccMechs)) return;

  const pilotHasShm = (data.core_bonuses ?? [])
    .map(bonusEffectLid)
    .includes(SUPERHEAVY_LID);

  let pinned = 0;
  let shmMechs = 0;
  for (const ccMech of ccMechs) {
    const mech = game.actors.find(a => a.type === "mech" && a.system?.lid === ccMech.id);
    if (!mech) continue;

    const loadout =
      ccMech.loadouts?.[ccMech.active_loadout_index ?? 0] ?? ccMech.loadout ?? null;
    if (!loadout) continue;

    const ccMounts = [
      ...(loadout.mounts ?? []),
      loadout.improved_armament,
      loadout.integratedWeapon,
      loadout.superheavy_mounting,
      ...(loadout.integratedMounts ?? []),
      ...(loadout.extraMounts ?? []),
    ].filter(Boolean);

    const allLids = ccMounts.flatMap(m => (m.bonus_effects ?? []).map(bonusEffectLid));

    // --- pin bonuses (Auto-Stab / Overpower) ---
    for (const ccMount of ccMounts) {
      const lids = (ccMount.bonus_effects ?? [])
        .map(bonusEffectLid)
        .filter(lid => lid && isPinBonus(lid));
      if (!lids.length) continue;

      const weaponLids = [...(ccMount.slots ?? []), ...(ccMount.extra ?? [])]
        .map(s => s?.weapon?.id)
        .filter(Boolean);
      if (!weaponLids.length) continue; // can't locate an empty mount reliably

      const fMounts = mech.system.loadout.weapon_mounts;
      const fi = fMounts.findIndex(m =>
        (m.slots ?? []).some(s => weaponLids.includes(s.weapon?.value?.system?.lid))
      );
      if (fi < 0) continue;

      const existing = getPins(mech, fMounts[fi], fi);
      const merged = [...new Set([...existing, ...lids])];
      if (merged.length !== existing.length) {
        await setPins(mech, fMounts[fi], fi, merged);
        pinned += merged.length - existing.length;
      }
    }

    // --- Superheavy Mounting ---
    // Adopt an imported superheavy mount so its remove control appears; add one
    // only when this mech's Comp/Con superheavy slot actually held a weapon (i.e.
    // the player built with it) so we don't stamp an empty mount on every mech.
    if (pilotHasShm) {
      const sh = loadout.superheavy_mounting;
      const ccShHasWeapon =
        [...(sh?.slots ?? []), ...(sh?.extra ?? [])].some(s => s?.weapon) ||
        allLids.includes(SUPERHEAVY_LID);
      const hasSh = mech.system.loadout.weapon_mounts.some(
        m => m?.type === "Superheavy" && !m.bracing
      );
      if (hasSh && !superheavyActive(mech)) {
        await mech.setFlag(MODULE_ID, "superheavy", { active: true, at: Date.now() });
        shmMechs++;
      } else if (!hasSh && ccShHasWeapon && !superheavyActive(mech)) {
        await addSuperheavyMount(mech, null);
        shmMechs++;
      }
    }
  }

  if (pinned || shmMechs) {
    ui.notifications?.info(
      game.i18n.format(`${MODULE_ID}.import.restored`, { count: pinned + shmMechs })
    );
  }
}

function installImportHook() {
  const proto = game.lancer?.applications?.LancerPilotSheet?.prototype;
  if (!proto || proto.__lcbePatched) return;
  const original = proto._onPilotJsonParsed;
  if (typeof original !== "function") {
    console.warn(`${MODULE_ID} | LancerPilotSheet._onPilotJsonParsed not found — import auto-pin disabled`);
    return;
  }
  proto._onPilotJsonParsed = async function (fileData) {
    const result = await original.call(this, fileData);
    try {
      await applyImportedPins(JSON.parse(fileData));
    } catch (err) {
      console.error(`${MODULE_ID} | import pin sync failed`, err);
    }
    return result;
  };
  proto.__lcbePatched = true;
  console.log(`${MODULE_ID} | patched LancerPilotSheet._onPilotJsonParsed for import auto-pin`);
}

/* -------------------------------------------------------------------------- */
/*  Attack flow — Auto-Stabilizing Hardpoints: +1 Accuracy                    */
/* -------------------------------------------------------------------------- */

async function autostabAccuracyStep(state) {
  try {
    const mech = state?.actor;
    const weapon = state?.item;
    const accDiff = state?.data?.acc_diff;
    if (!mech || !weapon || !accDiff?.base) return true;
    if (!activeCoreBonusForWeapon(mech, weapon.id, AUTOSTAB_LID)) return true;

    accDiff.base.accuracy += MOUNT_CORE_BONUSES[AUTOSTAB_LID].accuracy;
  } catch (err) {
    console.error(`${MODULE_ID} | Auto-Stab accuracy step failed`, err);
  }
  return true; // never block the attack flow
}

/* -------------------------------------------------------------------------- */
/*  Damage flow — Overpower Caliber: 1/round +1d6 on hit                      */
/* -------------------------------------------------------------------------- */

async function overpowerDamageStep(state) {
  try {
    const mech = state?.actor;
    const weapon = state?.item;
    const data = state?.data;
    if (!mech || !weapon || !data) return true;
    if (!activeCoreBonusForWeapon(mech, weapon.id, OVERPOWER_LID)) return true;

    const hit = data.has_normal_hit || data.has_crit_hit;
    if (!hit) return true;

    if (overpowerUsedThisRound(mech)) {
      ui.notifications?.info(game.i18n.localize(`${MODULE_ID}.overpower.alreadyUsed`));
      return true;
    }

    const proceed = await confirmDialog(
      coreBonusLabel(mech, OVERPOWER_LID),
      game.i18n.format(`${MODULE_ID}.overpower.prompt`, {
        dice: MOUNT_CORE_BONUSES[OVERPOWER_LID].bonusDamage,
      })
    );
    if (!proceed) return true;

    const dmgType =
      weapon.system?.active_profile?.damage?.[0]?.type ??
      weapon.system?.damage?.[0]?.type ??
      "Kinetic";

    data.bonus_damage = data.bonus_damage ?? [];
    data.bonus_damage.push({ type: dmgType, val: MOUNT_CORE_BONUSES[OVERPOWER_LID].bonusDamage });

    await markOverpowerUsed(mech);
    ui.notifications?.info(
      game.i18n.format(`${MODULE_ID}.overpower.applied`, {
        dice: MOUNT_CORE_BONUSES[OVERPOWER_LID].bonusDamage,
      })
    );
  } catch (err) {
    console.error(`${MODULE_ID} | Overpower Caliber step failed`, err);
  }
  return true; // never block the damage flow
}

/* -------------------------------------------------------------------------- */
/*  Flow registration                                                         */
/* -------------------------------------------------------------------------- */

function registerFlowSteps(flowSteps, flows) {
  const accKey = `${MODULE_ID}.autostabAccuracy`;
  const overpowerKey = `${MODULE_ID}.overpowerDamage`;
  flowSteps.set(accKey, autostabAccuracyStep);
  flowSteps.set(overpowerKey, overpowerDamageStep);

  const weaponAttackFlow = flows.get("WeaponAttackFlow");
  if (weaponAttackFlow?.insertStepAfter) {
    weaponAttackFlow.insertStepAfter("initAttackData", accKey);
    console.log(`${MODULE_ID} | inserted "${accKey}" into WeaponAttackFlow`);
  } else {
    console.warn(`${MODULE_ID} | WeaponAttackFlow not available — Auto-Stab accuracy automation disabled`);
  }

  const damageRollFlow = flows.get("DamageRollFlow");
  if (damageRollFlow?.insertStepAfter) {
    damageRollFlow.insertStepAfter("initDamageData", overpowerKey);
    console.log(`${MODULE_ID} | inserted "${overpowerKey}" into DamageRollFlow`);
  } else {
    console.warn(`${MODULE_ID} | DamageRollFlow not available — Overpower Caliber automation disabled`);
  }
}

/* -------------------------------------------------------------------------- */
/*  Wiring                                                                    */
/* -------------------------------------------------------------------------- */

Hooks.once("init", () => console.log(`${MODULE_ID} | init`));
Hooks.once("lancer.registerFlows", registerFlowSteps);
Hooks.on("renderLancerMechSheet", onRenderMechSheet);

// Keep the module's superheavy mount superheavy-only.
Hooks.on("preUpdateActor", (actor, changes) => enforceSuperheavyOnly(actor, changes));
// Safety net: if a non-superheavy weapon still landed in it, bounce it back out;
// and keep the superheavy weapon's bracing mount in sync.
Hooks.on("updateActor", async actor => {
  try {
    if (actor?.type !== "mech" || !superheavyActive(actor)) return;
    const mounts = actor.system.loadout.weapon_mounts ?? [];
    let dirty = false;
    const next = foundry.utils.deepClone(actor.system._source.loadout.weapon_mounts ?? []);
    mounts.forEach((m, i) => {
      if (m?.type !== "Superheavy" || m.bracing) return;
      (m.slots ?? []).forEach((s, j) => {
        const size = s?.weapon?.value?.system?.size;
        if (size && size !== "Superheavy") {
          next[i].slots[j].weapon = null;
          dirty = true;
        }
      });
    });
    if (dirty) {
      await actor.update({ "system.loadout.weapon_mounts": next });
      return;
    }
    await syncSuperheavyBracing(actor);
  } catch (err) {
    console.error(`${MODULE_ID} | superheavy-only safety net failed`, err);
  }
});

Hooks.once("ready", () => {
  if (game.system?.id !== "lancer") {
    console.warn(`${MODULE_ID} | active system is "${game.system?.id}", not "lancer" — module is inert`);
    return;
  }
  installImportHook();
  installDropHook();
});

// Exposed for debugging / other modules.
globalThis.lancerCoreBonusEnhancements = {
  MODULE_ID,
  MOUNT_CORE_BONUSES,
  getPins,
  setPins,
  mountSignature,
  mountForWeapon,
  pilotMountCoreBonusLids,
  activeCoreBonusForWeapon,
  overpowerUsedThisRound,
  applyImportedPins,
  pinDroppedCoreBonus,
  addSuperheavyMount,
  removeSuperheavyMount,
  superheavyMountIndex,
  superheavyActive,
  nonIntegratedMountCount,
  superheavyBracingIssue,
  syncSuperheavyBracing,
};
