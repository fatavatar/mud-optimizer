# MajorMUD Gear Optimizer

A single-page web tool that reads a MegaMUD-format MajorMUD database (`.mdb`),
takes a character pasted straight out of the game, and works out the best
equipment that character can actually wear.

Everything runs locally in the browser — no server, no build step, no network.

## Quick start

```bash
./init.sh --serve
```

Then open <http://localhost:8000>. That is all it takes from a fresh clone.

`init.sh` fetches the game database, generates the data file the page loads, and
runs the test suite. It is safe to re-run and skips anything already done:

| | |
|---|---|
| `./init.sh` | fetch if missing, then build |
| `./init.sh --serve` | build, then serve on <http://localhost:8000> |
| `./init.sh --force` | re-download even if the database is already here |
| `./init.sh path/to.mdb` | build from an `.mdb` you already have |

Its only dependency is Python's `access-parser`. If your Python already has it,
the script uses it; otherwise it creates a local `.venv` rather than touching
your system Python. `node` is used only for the tests and is optional.

### The game database

The repository does not carry the MegaMUD database itself — it is 12 MB of
third-party binary, and `data/gamedata.js` (the export the page actually loads)
is committed instead. `init.sh` pulls it from
[Tehshortbus/Majormud_MDB_Repo](https://github.com/Tehshortbus/Majormud_MDB_Repo),
which mirrors the MegaMUD `.mdb` files:

```
https://github.com/Tehshortbus/Majormud_MDB_Repo/raw/refs/heads/main/data-v1.11p.mdb
```

The shipped data was built from `data-v1.11p.mdb` (dat `v1.11p`, nmr `v1.8.3`,
sha256 `eba20f06…`), 1,950 items. `init.sh` checks that hash and tells you when
your file is a different build — not an error, just worth knowing, since the
export will then describe your database rather than the one documented here.

## Using it

Once the data is generated you can also just serve the directory yourself:

```bash
python3 -m http.server 8000
```

Opening `index.html` directly from disk works too; the data is loaded as a plain
`<script>`, not via `fetch`, so `file://` is fine.

1. **Character** — paste the output of `stat` and `inv` (both together is fine)
   and press *Parse*. Class, race, level, stats, coins, worn equipment and carried
   items are all read out of it. Anything the parser misses can be typed in.

   The parser handles real `inv` output, which is messier than it looks: it is
   hard-wrapped at the terminal width, so an item and its slot tag routinely land
   on different lines (`skullcap` … newline … `(Head)`); worn and carried items
   share one list, distinguished only by whether they carry a `(Slot)` tag; slot
   labels are title case and may contain spaces (`(Two handed)`); and coins appear
   both inline and again on the `Wealth:` line, which must not be double-counted.

   Pasting `inv` on its own works — Strength is inferred from your reported max
   encumbrance — but class, level and alignment still have to be set by hand.
2. **Optimize** — pick a goal, pick how much of the game you want to draw from,
   and press *Optimize*.
3. **Browse Items** — the whole item table, filtered to what your character can use.

### What a swap is actually worth

Each row of the recommendation carries an **Impact of this swap** column: what the
whole set changes if you make that one change and nothing else. It is computed by
profiling the full recommendation, then profiling it again with only that slot put
back the way you wear it today, and diffing the two — so it reports knock-on
effects, not the item's stat line.

That distinction is the whole point. A breastplate that reads *AC +19, DR +12*
also weighs 1,400, and the weight pushes you past 33% encumbrance, which halves
quick-and-deadly, which cuts your crit chance, which cuts your damage. The column
shows all of that together:

```
Torso   padded vest -> spiked plate corselet
        DPS −39.5   Dmg/swing −4.2   Crit % −10   AC +19   DR +12   Dodge −17
```

Derived numbers (DPS, damage per swing, crit chance, dodge, accuracy) are
recomputed from scratch for both sets, so Strength changing the encumbrance
ceiling and +Max Damage being amplified by crits are both accounted for.

Two things to know about reading it:

- **The column does not add up to the totals in the summary.** Every row is
  measured against the same baseline — the full recommendation — so the rows are
  marginal values, not a decomposition. Gear interacts, and weight taken off one
  slot pays for itself on another.
- **A two-handed weapon empties the off-hand**, so scoring those two swaps
  separately would price a set you cannot wear. When the recommendation changes
  handedness the two slots are scored as one decision, reported on the weapon row.

One case is flagged rather than silently wrong: if the ring you wear on one hand
is also the ring recommended for the other, the "put it back" baseline would have
you wearing two of it. That row is marked with an asterisk and the number is a
lower bound.

### Several characters at once

The bar at the top right holds a roster. *+ New* opens an empty slot, *Duplicate*
copies the current one, and the dropdown switches between them — so comparing two
alts, or trying a different build on the same character, never means clearing and
re-pasting.

Everything on the Character tab belongs to the active character: name, class,
race, level, alignment, stats, purse, worn and carried gear, the raw text you
pasted, and the optimizer goal with any weights you hand-edited. A warrior and a
mage do not want the same weights, so those travel with the character rather than
being global.

Two things are deliberately *not* per character:

- **Shop access.** Which shops you can reach describes where you can travel in
  the world, not a property of one alt, so the filter stays global.
- **Optimizer results.** They are cheap to recompute and would otherwise be shown
  stale against a character that has since been edited, so switching clears them.

The roster is saved in the browser under `mudtool.characters` and reloads with the
page. Gear is stored by item number rather than by value, so saved characters
follow the database across a regeneration; an item that no longer exists is
dropped from the character instead of breaking it. Deleting the last character
leaves a fresh empty one rather than nothing, which is why that button reads
*Clear* when only one character remains.

The name shown in the dropdown is whatever you typed in the *Name* field, falling
back to the name the game printed in your `stat` block — so a straight paste needs
no naming step.

### Shops

Any item a shop stocks is underlined; hovering it lists every shop that carries
it, the room each shop is in, what it would cost you there, and how many the shop
keeps in stock. Prices account for your Charm.

### Which shops count

There is **no shop accessibility field in the game data.** `Shops.MinLVL`/`MaxLVL`
looks like one but is the level range a *trainer* covers — which is why the Mage
Spell Shop reads "1 to 1". Nor is a shop's stock a useful proxy: Skali's Fine
Armour sells level-40 gear and stands in the starting town.

What actually stops a low-level character is the journey, so shops are grouped by
**map**, and each map is tiered by how strong the monsters placed in its rooms are:

| Tier | Median local monster | Maps |
| --- | --- | --- |
| starter | under 100 exp | 1 (43 shops) |
| low | under 2,000 | 2 |
| moderate | under 10,000 | 7, 10 |
| high | under 25,000 | 6, 8 |
| extreme | 25,000+ | 3, 12, 15, 16, 17 |

Under *Shops to consider* you can switch whole regions or individual shops off.
Prices, tooltips, the shopping list and the "what I can afford" pool are then all
quoted only from shops you left on, and the choice is remembered in your browser.
*Starter + low only* is a one-click setting for a new character.

This is a heuristic over monster placement, not a route calculation — it cannot
know that one corner of map 1 is lethal. Treat it as a starting point and switch
off individual shops you know you cannot reach.

### The three item pools

| Pool | What it considers |
| --- | --- |
| Everything in the game | Every item you are eligible for, however you would get it |
| Only what I own | Just what you have equipped or in your pack — a pure re-shuffle |
| What I own + can afford | Adds shop stock you could pay for right now |

### Encumbrance

MajorMUD gives an accuracy and dodge bonus while you are under 33% encumbered,
so the tool offers that as an explicit target. The default ("anything I can
carry") maximises the score against your full capacity instead; switching to the
33% target usually trades a lot of armour class for the bonus.

Because gear can raise Strength, and Strength sets the encumbrance ceiling, the
solver iterates that fixed point a few times before settling.

The 33% cliff is not the only one. Quick-and-deadly is halved at 33% and gone
past 66%, and energy per swing scales with encumbrance directly, so a kit that
lands near your ceiling can cost more damage than the armour is worth. The
per-swap impact column is where that shows up: watch for a heavy piece with a
large negative DPS next to its AC gain.

While the solver is *searching*, it assumes encumbrance lands on the target,
because it has to score items before it knows what the final set weighs. Every
number the results page displays is then recomputed from the set it actually
chose, so what you read is the kit you are being handed, not the working
assumption.

## Regenerating the item database

`data/gamedata.js` is generated. To rebuild it from a different `.mdb`:

```bash
pip install access-parser
python3 build_db.py path/to/your.mdb
```

`./init.sh` does both of those steps for you, including fetching the database —
see [The game database](#the-game-database) above for where it comes from.

## Tests

```bash
node test/run.js
```

175 assertions covering the formulas, the paste parser, the eligibility rules,
the optimizer's invariants, the per-swap impact maths and the character roster's
save/restore round trip.

## How the database was decoded

The `.mdb` stores everything as bare integers — wear locations, item types and a
sparse `Abil-0..19` / `AbilVal-0..19` array whose codes are the whole game. None
of that is documented in the file. The mappings used here were read out of the
[MMUD Explorer](https://github.com/syntax53/MMUD-Explorer) source, which is the
long-standing community database viewer for this format:

| What | Where it came from |
| --- | --- |
| Ability code → name (187 codes) | `modMMudFunc.GetAbilityName` |
| Ability code → character stat | `modMain.GetAbilityStatSlot` |
| `Worn` value → equipment slot | `frmMain.InvenAddEquip` |
| Class / level / alignment gating | `frmMain.ItemIsUsableByChar` |
| Encumbrance, dodge, accuracy formulas | `modMMudFunc` |
| Swing energy, crit chance and crit damage | `modMMudFunc.CalcEnergyUsed`, `CalcQuickAndDeadlyBonus` |
| Coin denominations | `frmCoinConvert` |
| Shop pricing (markup and Charm) | `modMMudDatabase.GetItemValue` |
| Shop type / trainer level range | `modMMudFunc.GetShopTypeEnum`, `modMain` |

Things worth knowing, all of which the tool handles:

- **The `ArmourClass` and `DamageResist` columns are both stored ×10.** A stored
  `20` is AC +2. The `AC` *ability* (code 2) is the exception — MME adds that one
  raw, unscaled, and only three items use it.
- **Accuracy from ability 22 does not stack.** Only the single largest value
  across all your gear counts. Item-level `Accy` (to-hit) *is* additive. The
  optimizer scores non-stacking accuracy additively as an approximation — those
  values are marked with `*` in the results — but the totals row applies the
  real max-of-one rule.
- **Rings use two different `Worn` codes** (4 and 13) which both feed the same
  pair of finger slots. Wrists work the same way. The solver treats each pair as
  one group so it can never put the same ring on both hands.
- **Ability 59 (`ClassOk`) whitelists an item for a class** and bypasses the
  armour- and weapon-type checks entirely.
- **Staff-only classes** (Mage, and anything else with class weapon type 9) can
  additionally use item 68 (dagger) and 100 (quarterstaff) — hardcoded in the
  game's own dll, not expressed in the data.
- **A class with ability 51 (`AntiMagic`) cannot use any magical item.**
- **`StrReq` is not a restriction.** Nothing in the game's eligibility path checks
  it; being under a weapon's Strength requirement multiplies your energy cost per
  swing by `(3 × deficit + 200) / 200`, so you swing slower rather than being
  refused. Under-strength weapons are still offered, tagged with what they need.
- Alignment is expressed twice: 97/98/112 are *good/evil/neutral only*, and
  110/111/113 are *not good/not evil/not neutral*.
- **Shop markup is additive, not a multiplier.** `cost = base + base × markup/100`,
  so the common `Markup% = 100` means *double* the base price, and `0` means no
  markup rather than free. Charm then scales it: `1 - (⌊Charm/5⌋ - 10)/100`, which
  makes Charm 50 neutral.
- **A shop stock entry with `Max = 0` is not for sale there.** Those are the
  recycler / sell-only rows that MME renders as `Shop(sell) #n`; treating them as
  purchasable would claim, for example, that the hellblade is available in a shop.
- A `Price` of 0 is real — the starter kit is free — and is shown as such.

### Picking the gear

Choosing one item per slot to maximise a weighted score, subject to a shared
encumbrance budget, is a multiple-choice knapsack problem. The tool solves it
exactly with dynamic programming over quantised encumbrance rather than picking
greedily per slot — a greedy pass overshoots badly when it has to shed weight,
dropping a breastplate and then leaving half the budget unspent.

Weapon configurations are solved twice, once one-handed (leaving the off-hand
free for a shield) and once two-handed, and the better result wins.

Weapons are scored on **expected damage throughput**, not raw average damage.
For each candidate weapon:

- **Energy per swing** comes from `CalcEnergyUsed` — weapon speed against your
  level, combat rating and agility, times an encumbrance penalty, times the
  under-Strength penalty if the weapon is too heavy for you. Fewer energy means
  more swings per round.
- **Crit chance** is your Crits stat from *class, race and every equipped item*
  (ability 58), plus the **Quick and Deadly** bonus `CalcQuickAndDeadlyBonus`
  gives for swinging fast — up to +20, but nothing at 200+ energy per swing,
  halved past 33% encumbrance and gone past 66%. Anything over 40 is damped:
  `40 + (excess / 3)`.
- **Crit damage** is 2×–4× the weapon's **max** damage, averaging 3×. Crucially
  `nDmgMax = nDmgMax + nPlusMaxDamage` runs *before* that multiplier, so every
  point of +Max Damage you are wearing is amplified 2–4× on a crit.
- Expected damage per swing is therefore
  `(1 - p) × (min + max)/2 + p × 3 × max`, and throughput is that over energy.

This is why the tool cares which class and race you are even when comparing two
weapons: a Ninja or Mystic starts with +10 crits and a Dark-Elf another +1, which
changes the ranking outright. It also means a heavy weapon's worth depends on the
crit gear elsewhere in the kit — and that kit depends on the weapon — so the
solver iterates the two to a fixed point, seeded from what you are wearing.

That fixed point is not guaranteed to settle, so once a set is chosen the
reported crit chance and damage are re-derived from *that* set. The numbers you
see always describe the kit you are being shown.

A consequence worth knowing: this favours fast weapons, because Quick and Deadly
only pays out below 200 energy per swing. If you disagree with that trade for
your build, raise the flat damage weights.

### Scoring weights

The presets are reasonable starting points, not received wisdom — they encode a
view about how much a point of DR is worth against a point of AC. Open
*Fine-tune weights* and change them; the browse tab will re-sort by your build's
score too.
