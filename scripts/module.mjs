/**
 * Lancer Core Bonus Enhancements
 * ------------------------------
 * Mechanical support for the mount-/weapon-scoped core bonuses that the LANCER
 * system does not automate (foundryvtt-lancer#724):
 *
 *   - Auto-Stabilizing Hardpoints  -> +1 Accuracy to attacks with any weapon on
 *                                     the chosen mount (automated)
 *   - Overpower Caliber            -> pin + display only; the 1/round +1d6 waits
 *                                     on system issue #189 (damage HUD)
 *   - Superheavy Mounting          -> pin + display only (RAW grants an extra
 *                                     mount; no automation intended)
 *
 * How it works, without touching the system:
 *   - Pins are stored in an actor flag, keyed by a mount "signature" so they
 *     survive most loadout edits.
 *   - The mech sheet is decorated on `renderLancerMechSheet`: a row under each
 *     mount header showing pinned bonuses + (when editable) a picker of the
 *     piloting pilot's eligible core bonuses.
 *   - Accuracy is injected with a custom flow step registered through the
 *     system's `lancer.registerFlows` hook and inserted into WeaponAttackFlow
 *     right after `initAttackData` (which builds the Acc/Diff data) and before
 *     `showAttackHUD` (which renders it). The player can still adjust it.
 */

const MODULE_ID = "lancer-core-bonus-enhancements";
const AUTOSTAB_LID = "cb_auto_stabilizing_hardpoints";

/**
 * The core bonuses this module understands. `accuracy` is the flat Accuracy
 * bonus applied to attacks with weapons on a mount the bonus is pinned to.
 */
const MOUNT_CORE_BONUSES = {
  [AUTOSTAB_LID]: {
    label: "Auto-Stabilizing Hardpoints",
    effect: "Weapons attached to this mount gain +1 Accuracy.",
    accuracy: 1,
  },
  cb_overpower_caliber: {
    label: "Overpower Caliber",
    effect: "One weapon on this mount deals +1d6 bonus damage, 1/round on hit. (Display only for now — pending system #189.)",
    accuracy: 0,
  },
  cb_superheavy_mounting: {
    label: "Superheavy Mounting",
    effect: "Grants an extra superheavy mount. Pin/display only — no automation.",
    accuracy: 0,
  },
};

const isMountCoreBonus = lid => Object.prototype.hasOwnProperty.call(MOUNT_CORE_BONUSES, lid);

/* -------------------------------------------------------------------------- */
/*  Storage — an actor flag: { mounts: { <signature>: [lid, ...] } }          */
/* -------------------------------------------------------------------------- */

/**
 * A key for a mount that is stable across most loadout edits: mount type + the
 * ordered list of its fitting sizes, plus its current index to disambiguate
 * duplicates. On read we fall back to a same-type/same-sizes match at a
 * different index (handles a mount being inserted or removed earlier in the list).
 */
function mountSignature(mount, index) {
  const sizes = (mount?.slots ?? []).map(s => s?.size ?? "?").join(",");
  return `${mount?.type ?? "?"}|${sizes}|${index}`;
}

function readAllPins(mech) {
  return foundry.utils.deepClone(mech.getFlag(MODULE_ID, "mounts") ?? {});
}

/** LIDs pinned to one mount, with the single-near-match fallback described above. */
function getPins(mech, mount, index) {
  const all = readAllPins(mech);
  const sig = mountSignature(mount, index);
  if (Array.isArray(all[sig])) return all[sig];

  const prefix = sig.slice(0, sig.lastIndexOf("|") + 1);
  const near = Object.keys(all).filter(k => k !== sig && k.startsWith(prefix));
  if (near.length === 1 && Array.isArray(all[near[0]])) return all[near[0]];
  return [];
}

async function setPins(mech, mount, index, lids) {
  const all = readAllPins(mech);
  const sig = mountSignature(mount, index);

  // If we had been reading via the single-near-match fallback, move that entry
  // onto the real signature rather than orphaning it.
  if (!Array.isArray(all[sig])) {
    const prefix = sig.slice(0, sig.lastIndexOf("|") + 1);
    const near = Object.keys(all).filter(k => k !== sig && k.startsWith(prefix));
    if (near.length === 1) delete all[near[0]];
  }

  const clean = [...new Set(lids.filter(isMountCoreBonus))];
  if (clean.length) all[sig] = clean;
  else delete all[sig];

  await mech.setFlag(MODULE_ID, "mounts", all);
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
    if (!mech || mech.type !== "mech" || !weapon || !accDiff?.base) return true;

    const mounts = mech.system?.loadout?.weapon_mounts ?? [];
    const index = mounts.findIndex(m =>
      (m?.slots ?? []).some(s => s?.weapon?.value?.id === weapon.id)
    );
    if (index < 0) return true;

    const pins = getPins(mech, mounts[index], index);
    if (!pins.includes(AUTOSTAB_LID)) return true;
    if (!pilotMountCoreBonusLids(mech).has(AUTOSTAB_LID)) return true;

    // Seed the Acc/Diff HUD; it stays editable, exactly like the Accurate tag.
    accDiff.base.accuracy += MOUNT_CORE_BONUSES[AUTOSTAB_LID].accuracy;
  } catch (err) {
    console.error(`${MODULE_ID} | Auto-Stab accuracy step failed`, err);
  }
  return true; // never block the attack flow
}

function registerFlowSteps(flowSteps, flows) {
  const stepKey = `${MODULE_ID}.autostabAccuracy`;
  flowSteps.set(stepKey, autostabAccuracyStep);

  const weaponAttackFlow = flows.get("WeaponAttackFlow");
  if (weaponAttackFlow?.insertStepAfter) {
    weaponAttackFlow.insertStepAfter("initAttackData", stepKey);
    console.log(`${MODULE_ID} | inserted "${stepKey}" into WeaponAttackFlow`);
  } else {
    console.warn(`${MODULE_ID} | WeaponAttackFlow not available — Auto-Stab accuracy automation disabled`);
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
  pilotMountCoreBonusLids,
};
