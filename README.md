# Lancer Core Bonus Enhancements

A [Foundry VTT](https://foundryvtt.com/) module for the
[LANCER](https://foundryvtt.com/packages/lancer) system that adds mechanical
support for the mount- and weapon-scoped core bonuses the system leaves to manual
adjudication — implementing the request in
[foundryvtt-lancer#724](https://github.com/Eranziel/foundryvtt-lancer/issues/724).

It does this **as a standalone module**: no system fork, no patched files, no
world migration. It uses LANCER's documented extension points
(`lancer.registerFlows`, the sheet render hook) and stores its data in an actor
flag.

## What it does

| Core bonus | Behaviour |
| --- | --- |
| **Auto-Stabilizing Hardpoints** | Pin it to a mount. Attacks with any weapon on that mount get **+1 Accuracy**, pre-filled in the Accuracy/Difficulty dialog (still adjustable). |
| **Overpower Caliber** | Pin + display only. The 1/round +1d6 on hit needs a damage-roll hook that does not exist yet ([system #189](https://github.com/Eranziel/foundryvtt-lancer/issues/189)). |
| **Superheavy Mounting** | Pin + display only, by design — it grants an extra mount, which the mount controls already handle. |

Pinning is done from the **mech sheet**: a small row appears under each weapon
mount header showing what is pinned, plus a `+ pin core bonus…` dropdown listing
the core bonuses the **piloting pilot** actually owns. Only a pilot who has the
core bonus can have it take effect; if the pilot later loses it, the pin is kept
but flagged and does nothing until the pilot regains it (or you detach it).

## How it works

- **Storage.** Pins live in `mech.flags["lancer-core-bonus-enhancements"].mounts`,
  keyed by a mount *signature* (`type | fitting sizes | index`). The signature
  survives reordering and most edits; a same-type/same-sizes match at a new index
  is reconciled on read.
- **Sheet.** `renderLancerMechSheet` → a `.lcbe-row` is injected under each
  `.mount-type-ctx-root` header. The mount index is read from the header's
  `data-path`.
- **Accuracy.** On `lancer.registerFlows`, a step
  (`lancer-core-bonus-enhancements.autostabAccuracy`) is registered and inserted
  into `WeaponAttackFlow` right after `initAttackData`. It finds the mount holding
  the firing weapon, and if Auto-Stabilizing Hardpoints is pinned there and owned
  by the pilot, adds `1` to `state.data.acc_diff.base.accuracy` before the HUD
  opens.

## Install

Manifest URL:

```
https://github.com/KingOfPoptart/lancer-core-bonus-enhancements/releases/latest/download/module.json
```

Requires the LANCER system 3.0.0+ and Foundry v13. Built and tested against
LANCER 3.1.3.

## Development

Plain ES module — no build step. Symlink or copy the repo into your Foundry
`Data/modules/` directory and enable it in a LANCER world.

```
lancer-core-bonus-enhancements/
  module.json
  scripts/module.mjs   # all logic
  styles/…css
  lang/en.json
```

`globalThis.lancerCoreBonusEnhancements` exposes the internals for debugging.

## Known limitations

- Comp/Con stores core bonuses attached to mounts, but the LANCER importer
  discards that field — re-pin after importing a mech.
- If you have two identically configured mounts and delete one, the surviving
  mount may lose its pin. Signature reconciliation for that case is planned.

## Licence

MIT. LANCER is © Massif Press; this is an unofficial third-party module.
