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
 *   - Superheavy Mounting          -> pin + display only (RAW grants an extra
 *                                     mount; no automation intended).
 *
 * How it works, without touching the system:
 *   - Pins live in an actor flag, keyed by a mount signature.
 *   - The mech sheet is decorated on `renderLancerMechSheet`: a row under each
 *     mount header showing pinned bonuses + (when editable) a picker of the
 *     piloting pilot's eligible core bonuses.
 *   - Accuracy is injected by a custom WeaponAttackFlow step (registered through
 *     the system's `lancer.registerFlows` hook) inserted after `initAttackData`
 *     and before `showAttackHUD`, so it pre-fills the Acc/Diff HUD and stays
 *     editable.
 *   - Overpower Caliber is a custom DamageRollFlow step inserted after
 *     `initDamageData`: if eligible and unused this round it asks whether to add
 *     +1d6 bonus damage, and on "yes" pushes it into the damage HUD and records
 *     the 1/round use against the current combat round.
 */

const MODULE_ID = "lancer-core-bonus-enhancements";
const AUTOSTAB_LID = "cb_auto_stabilizing_hardpoints";
const OVERPOWER_LID = "cb_overpower_caliber";

/**
 * The core bonuses this module understands.
 *   accuracy    - flat Accuracy added to attacks with weapons on a pinned mount
 *   bonusDamage - dice string offered as bonus damage, 1/round, on a hit
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
  cb_superheavy_mounting: {
    label: "Superheavy Mounting",
    effect: "Grants an extra superheavy mount. Pin/display only — no automation.",
  },
};

const isMountCoreBonus = lid => Object.prototype.hasOwnProperty.call(MOUNT_CORE_BONUSES, lid);

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
 * a mount's type or fittings also drops its pins, which is intended (the bonus
 * was chosen for that mount as it was configured).
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
  const clean = [...new Set(lids.filter(isMountCoreBonus))];
  if (clean.length) all[sig] = clean;
  else delete all[sig];
  await mech.setFlag(MODULE_ID, "mounts", all);
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
 * "1/round" is a combat concept. In combat, the use is recorded against the
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
/*  Sheet decoration                                                          */
/* -------------------------------------------------------------------------- */

function onRenderMechSheet(app, html) {
  try {
    const mech = app?.actor;
    if (!mech || mech.type !== "mech") return;

    const root = html?.[0] ?? html;
    if (!(root instanceof HTMLElement)) return;

    const editable = !!app.isEditable;
    const mounts = mech.system?.loadout?.weapon_mounts ?? [];

    root.querySelectorAll(".mount.card").forEach(card => {
      const header = card.querySelector(".mount-type-ctx-root");
      const idxMatch = /weapon_mounts\.(\d+)/.exec(header?.dataset?.path ?? "");
      if (!header || !idxMatch) return;

      const index = Number(idxMatch[1]);
      const mount = mounts[index];
      if (!mount || mount.bracing) return;

      card.querySelector(".lcbe-row")?.remove(); // avoid stacking on re-render

      const pins = getPins(mech, mount, index);
      const owned = pilotMountCoreBonusLids(mech);
      const pickable = [...owned].filter(lid => !pins.includes(lid));

      if (!pins.length && !(editable && pickable.length)) return;

      const row = document.createElement("div");
      row.className = "lcbe-row";

      for (const lid of pins) {
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
          const remove = document.createElement("a");
          remove.className = "lcbe-remove fas fa-times";
          remove.setAttribute("role", "button");
          remove.setAttribute("aria-label", game.i18n.localize(`${MODULE_ID}.detach`));
          remove.addEventListener("click", ev => {
            ev.preventDefault();
            ev.stopPropagation();
            setPins(mech, mount, index, pins.filter(l => l !== lid));
          });
          tag.append(remove);
        }
        row.append(tag);
      }

      if (editable && pickable.length) {
        const select = document.createElement("select");
        select.className = "lcbe-add";
        select.append(new Option(game.i18n.localize(`${MODULE_ID}.addPlaceholder`), ""));
        for (const lid of pickable) select.append(new Option(coreBonusLabel(mech, lid), lid));
        select.addEventListener("change", () => {
          if (select.value) setPins(mech, mount, index, [...pins, select.value]);
        });
        row.append(select);
      }

      header.after(row);
    });
  } catch (err) {
    console.error(`${MODULE_ID} | failed to decorate mech sheet`, err);
  }
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

    // Seed the Acc/Diff HUD; it stays editable, exactly like the Accurate tag.
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

    // "when you hit" — has_normal_hit is true when there are no target rolls too
    const hit = data.has_normal_hit || data.has_crit_hit;
    if (!hit) return true;

    if (overpowerUsedThisRound(mech)) {
      ui.notifications?.info(
        game.i18n.localize(`${MODULE_ID}.overpower.alreadyUsed`)
      );
      return true;
    }

    const proceed = await confirmDialog(
      coreBonusLabel(mech, OVERPOWER_LID),
      game.i18n.format(`${MODULE_ID}.overpower.prompt`, { dice: MOUNT_CORE_BONUSES[OVERPOWER_LID].bonusDamage })
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
      game.i18n.format(`${MODULE_ID}.overpower.applied`, { dice: MOUNT_CORE_BONUSES[OVERPOWER_LID].bonusDamage })
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

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | init`);
});

Hooks.once("lancer.registerFlows", registerFlowSteps);
Hooks.on("renderLancerMechSheet", onRenderMechSheet);

Hooks.once("ready", () => {
  if (game.system?.id !== "lancer") {
    console.warn(
      `${MODULE_ID} | active system is "${game.system?.id}", not "lancer" — module is inert`
    );
  }
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
};
