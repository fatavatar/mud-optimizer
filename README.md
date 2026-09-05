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
sha256 `eba20f06…`): 1,950 items, 1,101 monsters and 26,694 mapped rooms. `init.sh` checks that hash and tells you when
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
3. **Spells** — every spell your class can learn, with its numbers worked out at
   your level.
4. **Weapons**, **Armour**, **Sundry** — the item table, split three ways and
   quoted for whoever is active: what a weapon actually swings for in your hands,
   what a shop would charge you for a breastplate, what a scroll casts.
5. **Classes & Races**, **Monsters**, **Shops** — the rest of the database, for
   looking things up rather than optimising: what a class may wear, what lives in
   a region and what it drops, and what every shop stocks at your Charm.
6. **Maps** — all 26,694 rooms, drawn.

### The reference tabs

The optimizer only ever considers gear you can equip, which leaves most of the
database unseen. Six tabs open the rest of it up. All of them describe the
*active character* — almost nothing here is an absolute:

| Tab | What it lists |
| --- | --- |
| Weapons | 383 weapons, with the energy per swing, the swings they land over the fight, and the damage per round **your** character gets out of them |
| Armour | 494 wearable pieces, AC and DR unscaled, sorted by your own weights if you like |
| Sundry | the other 1,073 rows — scrolls, keys, potions, light, containers, scenery, and the handful of "armour" you cannot actually wear |
| Classes & Races | hits per level, combat rating, weapon and armour ceilings, magery and spell count; race stat bands and innate abilities |
| Monsters | the whole bestiary, 1,101 of them, with what they hit for, where they live, and what they drop |
| Shops | all 87 shops by region, with their full stock priced at your Charm |

**The page itself says very little.** Status lines are counts and context —
*166 weapons · Kaltar · level 24 Warrior · Str 66 · Agi 50 · 12% enc* — and the
reasoning behind every number lives in this README rather than in a paragraph
above each table. Tooltips are kept where they carry data you cannot see
otherwise: a drop table, a shop list, a swing schedule, a spell's scaling rule.

**There is one scroll bar.** Tables are not scroll boxes inside a scrolling page;
the page is the only thing that scrolls, in either direction, and column headings
stick below the top bar as you go. That is why the top bar's height is measured
rather than assumed — the tab row wraps at narrow widths.

**Every column of every table sorts.** Click a heading to sort by it, click it
again to reverse. The arrow marks the column in force, the first click picks the
useful end (damage descending, names A to Z), and ties fall back to the name —
which keeps its own direction, so the names beside a reversed damage column do
not come out backwards. This is not limited to the new tabs: the Spells table
and the Optimize tab's per-slot recommendation sort the same way, so you can ask
the recommendation "which single swap is worth the most" by sorting *Impact*.

A sort survives a filter change, so narrowing a search does not throw away the
order you chose. Because the headings do the whole job, the *Sort* dropdowns
those tabs used to carry are gone; the Shops tab keeps its one, because shops are
cards rather than rows.

### The maps

There are no coordinates in the database. A room lists the room each of its ten
exits leads to and nothing else, so the map has to be *derived*: `build_db.py`
walks the graph and puts each room one cell from its neighbour in the direction
the exit points, which is how you draw it in your head while playing.

That cannot always work. A grid has four right angles and the world does not —
walk north, east, south, west through a loop that does not close and two rooms
want the same cell. The layout places what it can exactly, keeps looking outward
when a cell is taken, and then relaxes: a room with unhappy exits is offered the
cell each neighbour would put it in and takes whichever free one satisfies the
most of them. **92.5% of exits end up exactly one cell away in their own
direction**; the rest are drawn as stretched lines rather than dropped, so the
connection is still true even where the geometry is not.

| | |
| --- | --- |
| Rooms | 26,694 across 17 maps |
| Areas | 881 — pieces with no walkable path between them, packed side by side onto one plane |
| Exits drawn cleanly | 92.5% (map 2 is 99.9%, map 1's dense forest 73.6%) |

**Up and down get no cell.** They lead somewhere that would sit on top of what
is already drawn, so they are wedges on the room — ▲ above, ▼ below — that you
click to follow. A doorway into another map is a mark on the room's edge and
loads that map. Every exit is also listed in the room panel with whatever the
database says about it: *(Door)*, *(Key: 1416 [or 101 picklocks])*, *(Trap, 40
damage)*, *(Hidden/Searchable)*, *(Toll: 500)*, *(Level: 0 to 3)*.

Hovering a room says what is in it, which is the question worth asking: the shop
standing there, the monster fixed to it, everything that lairs in it, items left
on the floor, whether it is dark enough to need a light, and **what you can type
in it** — `pull lever`, `roll dice`, `go vortex`, `dive pool`. Those come from
the room's command script, which is why the Portal Room lists seven things to
try. Clicking a room opens the same thing as links: the monster goes to the
Monsters tab, the shop to Shops, an item to its own entry.

Five exits in the database lead to rooms that were never built — off a
tournament room, a library, a gang house, the portal room, and map 17's *Module
Test Room*. They are kept as the data has them, and shown as *no such room*
rather than as a link into nothing.

The map files are generated beside `gamedata.js` and loaded one at a time, the
first time you open that map — 2 MB all told, which is not worth paying for up
front. They are plain `<script>` files like the rest of the data, so opening
`index.html` off the disk still works.

### Every reference is a link

A weapon says which monster drops it. That monster is a row on another tab, so
the name is a link that goes there — switching tab, putting the monster in the
search box, and flashing its row when it arrives. It works in every direction:

| From | To |
| --- | --- |
| an item's *Where to get it* | the shop that sells it, opened on its stock, or the monster that drops it |
| *N shops* / *+N more* beside it | every shop that stocks it, or every monster that drops it |
| a monster's *Drops* | each item's own entry (*+N more* unfolds the rest in place) |
| a monster's *Where* | everything else placed in that region |
| a shop's stock, and its region tag | the item's entry, and what lives around the shop |
| your worn and carried gear | each item's entry |
| a shop's room, and an item's `Room 1/2231` trail | that room on the map |
| the recommendation's *Currently* and *Recommended* | what you wear now, and what it would replace |

Following a link should never land you on *nothing matches*, so the target tab's
filters give way where they would hide what you were sent to — and only there. A
link to plate armour a Mage cannot wear switches *usable by me* off; a link to
something they can use changes nothing. Filters that were not in the way are left
exactly as you set them.

The raw trails in the database are linked too. `Items.from` records where a thing
turned up as `Item #1727(68.4%), Room 1/2231`; the numbered references name rows
we hold, so a pristine scroll now reads *large chest (68.4%) · silver casket
(76%)* instead of item numbers. There are 4,017 such references and every item
and monster one resolves. Shop numbers that fall outside the exported shop table
stay as plain text rather than becoming a link that goes nowhere.

Two columns sort on something other than what they print:

- **Where to get it** orders by route rather than alphabetically: what a shop
  sells first and cheapest first, then what you have to hunt for with the best
  drop chance first, and last the things with no known source at all.
- **Where** on the Monsters tab orders by the toughest region a monster is found
  in, so the unlocated ones fall to the bottom rather than the top.

Two things the tabs do that a flat table dump does not:

- **The damage columns are yours.** A weapon's swings per round depend on your
  class combat rating, level, Agility, Strength and how encumbered you are, so
  the Weapons tab aims the same context the optimizer uses at your character.
  Switch to another character in the roster and the numbers follow.
- **Search reaches through.** Searching the Monsters tab matches loot as well as
  names, so *hellblade* answers "what do I have to kill for this"; searching
  Shops matches stock, so *plate* finds the shops that sell it.
- **A scroll says what it teaches.** Items point at spells the Spells tab never
  lists — a scroll teaches a quest spell, a sword procs a monster one — so a name
  is carried for all 1,378 rows of the spell table rather than only the 256 a
  class can learn, and the tag reads *teaches soul rip* instead of *spell #211*.

An item you cannot use is struck through rather than hidden when you untick
*usable by me* — with the box off you are deliberately looking at what you are
missing.

### Swings, round by round

Combat is fought in rounds. Each round hands you 1,000 energy **on top of
whatever was left over**, and you swing as many times as that pays for. So a
weapon worth "2.5 swings" does not land two and a half every round — it lands
2, 3, 2, 3. The algorithm is the one quoted in MME's swing calculator:

```pascal
Temp := 1000;
repeat
  I    := Temp div EU;
  Temp := (Temp mod EU) + 1000;
  If (I > MAX_SWINGS) Then I := MAX_SWINGS;   { MAX_SWINGS = 5 }
until False
```

Note the order: the carry is taken from the *uncapped* division, so a very fast
weapon still burns all its energy but never lands more than five swings.

Weapons are scored on the swings they actually get over the opening **five
rounds**, because most fights are over by then, and a rate you would only reach
in a long fight is not worth optimising for. *Fight length* on the Optimize tab
changes that horizon — 3, 5, 8 or 12 rounds — and it does change which weapon
wins.

This is not a cosmetic difference. Two weapons for the same level-24 Warrior:

| | energy | continuous rate | actual swings | damage/round |
| --- | --- | --- | --- | --- |
| obsidian trident | 385 | 2.60 swings | 2, 3, 2, 3, 2 = 12 | 111.6 |
| Magus Ripper | 410 | 2.44 swings | 2, 2, 3, 2, 3 = 12 | **116.4** |

The rate says the trident is faster. Over five rounds they land exactly the same
twelve swings, so the weapon that hits harder wins — the opposite of what the
rate implies.

The impact column reports this directly: heavy armour now costs you *swings*,
not just an abstract rate. A spiked plate corselet reads **Swings in the fight
−2** next to its AC gain.

### Crits are paid for once

+Crits and +Max Damage both feed the damage model: crit chance multiplies your
max damage by two to four, and +Max Damage is folded in *before* that multiplier.
So they cannot also carry a flat scoring weight — a ring with +2 Crits would earn
its flat weight *and* raise the weapon's damage per round on the next pass of the
fixed point, and get paid twice for the same point.

They are now priced through the damage model only, at their true marginal rate:

```
crit point   = swings/round × (critDamage − normalDamage) / 100 × slope
maxdmg point = swings/round × ((1 − crit%) × 0.5 + 3 × crit%)
```

where `slope` is 1 below 40 crit, ⅓ above it (`critAfterDR`), and 0 at the 99
cap. Both are exactly linear in the swing maths, so one rate values a point
correctly wherever it is worn. A test moves the context by one point and checks
the price matches the damage the model actually produces, to 1e-6.

For a level-24 Warrior with throwing hammers that comes out at **3.5 damage a
round per crit point** and **4.0 per point of +Max Damage** — against the flat
weight of 40 the *Melee damage* preset used to apply. That distortion was large
enough to invert a choice: a rapier's `+2 Crits` beat throwing hammers despite
doing 17 less damage a round. It no longer does.

The `crits` and `maxdmg` weight boxes still work, and still apply **when there is
no weapon to price them against** — a bare-handed martial artist keeps his crit
gear, which is why the *Martial arts* preset is the one that still carries them.
Martial-arts damage itself is not modelled.

Two smaller overlaps are left alone deliberately. `str` and `agi` carry flat
weights while also feeding encumbrance, energy, dodge and accuracy — but there
their flat weight is standing in for effects that are not otherwise scored per
item, so removing it would lose signal rather than stop a double count.

### Where an item comes from

A lot of the best gear is never sold anywhere — you take it off something. Every
item now carries its drop table, so the results say **which monster drops it, at
what chance, and where that monster lives**:

```
hellblade    18-40 dmg   limited 1 · lvl 50+ · evil only

  Dropped by 1 monster:
  - Devil Fiend Malivek (10%), 60,000 exp, 4,500 hp
      map 15 (extreme) — Diamond Mine Tunnel
```

525 items have a drop source, 167 of them weapons, off 421 monsters. It matters
further down the level range than you might expect: a plain **gold ring** is not
sold in any shop in the game.

The *Where to get it* column leads with a shop price when there is one — that is
the route you control — and names the best drop otherwise. An item that is both
sold and dropped keeps both in its tooltip. Where several monsters drop the same
thing, the one named is the best chance, and among equal chances the weakest
monster carrying it.

The **What I own + shops + monster drops** item pool adds anything with a drop
source to the search. Your purse does not gate those, because there is no price
on them; the trade is that you have to go and take them, and the tooltip tells
you what you would be fighting.

Two things about the location data:

- A monster's whereabouts come from two different room columns. `Rooms.NPC` is
  the one monster fixed to a room; `Rooms.Lair` is a `(Max 3): 827,925,926` list
  of everything that can lair there. Using both locates 357 of the 421 dropping
  monsters — and 889 of all 1,101 — against 336 from `NPC` alone. The rest say
  *location unknown* rather than guessing.
- Those lair lists are deliberately **not** fed into the map difficulty tiers
  that drive the shop filter. They name every wanderer passing through, which
  drowns the median: fold them in and map 12 falls from a median of 45,000 exp
  to 55 and reads as a starter zone, which it certainly is not.

A `0%` drop row is treated as no source at all — the monster is listed but never
actually drops it.

### The spell calculator

The Spells tab takes a class, a level, your Spellcasting and any worn +Spell Dmg,
and shows what each spell actually does for that caster: damage or healing range,
duration in rounds, mana cost, damage per mana, chance to cast, and what the spell
does besides damage. It follows the active character automatically until you
change one of the boxes yourself; *Use my character* hands it back.

The numbers are not the raw database values. Every spell has its own level band,
and the caster's level is clamped into it before anything scales:

- a spell never scales below its **required level** — a level-3 spell cast at
  level 1 still uses its level-3 numbers;
- it stops improving at its **cap** — magic missile is capped at 6, so it is
  4–12 damage at level 6 and at level 60 alike;
- increments are **truncated, not rounded** — `+1 per 10 levels` is +2 at level
  29, not +3.

Hover a spell's name for its scaling rule in words (*"max +1 / level, stops at
level 6"*), and a cast percentage for how it was worked out.

A few things worth knowing, all taken from the game's own behaviour:

- **Difficulty adjusts your Spellcasting; it is not a target number.**
  Spellcasting 88 against difficulty +15 is a 98% cast. Stock MajorMUD caps spell
  hit at 98%; Kai is the exception and caps at 100.
- **Cheap spells go off more than once a round.** A spell costing between 143 and
  500 energy casts `1 + (1000 − cost) / cost` times, so a 200-energy spell lands
  five times a round. That is folded into the damage column.
- **+Spell Dmg applies to damage, not healing.** Stock MajorMUD only bonuses the
  damage side; the heal half of a drain is unbonused. It multiplies after level
  scaling and truncates.
- **Only spells a class can actually learn are listed.** The table also holds
  around 1,100 monster attacks and item procs. Without the learnability test a
  Warrior "knows" 849 spells; with it, a Warrior knows none, which is right.

Message and bookkeeping abilities (*DescMsg 8531*, *RemovesSpell 132*) are hidden.
They are real, but they crowd out the effects you are choosing between.

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

### The four item pools

| Pool | What it considers |
| --- | --- |
| Everything in the game | Every item you are eligible for, however you would get it |
| Only what I own | Just what you have equipped or in your pack — a pure re-shuffle |
| What I own + can afford | Adds shop stock you could pay for right now |
| What I own + shops + drops | Adds anything a monster drops, priced in effort rather than coin |

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

`data/gamedata.js` and `data/maps/map-*.js` are generated. To rebuild them from a
different `.mdb`:

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

391 assertions covering the formulas, the paste parser, the eligibility rules,
the optimizer's invariants, the per-round swing schedule, the marginal pricing of
crits, the per-swap impact maths, the spell scaling and cast chance, the drop
tables and their locations, the reference tabs' indexes and item partition, the
column sort rules, the cross-reference links and the filters they relax, and
the character roster's save/restore round trip.

## How the database was decoded

The `.mdb` stores everything as bare integers — wear locations, item types and a
sparse `Abil-0..19` / `AbilVal-0..19` array whose codes are the whole game. None
of that is documented in the file. The mappings used here were read out of the
[MMUD Explorer](https://github.com/syntax53/MMUD-Explorer) source, which is the
long-standing community database viewer for this format:

| What | Where it came from |
| --- | --- |
| Ability code → name (187 codes) | `modMMudFunc.GetAbilityName` |
| What a scroll teaches / an item casts | `Abil 42` (LearnSp), `Abil 43` (CastsSp) |
| Ability code → character stat | `modMain.GetAbilityStatSlot` |
| `Worn` value → equipment slot | `frmMain.InvenAddEquip` |
| Class / level / alignment gating | `frmMain.ItemIsUsableByChar` |
| Encumbrance, dodge, accuracy formulas | `modMMudFunc` |
| Swing energy, crit chance and crit damage | `modMMudFunc.CalcEnergyUsed`, `CalcQuickAndDeadlyBonus` |
| Swings per round and the 5-swing cap | `frmSwingCalc.CalcSwings` (and the Pascal it quotes), `modMMudFunc.MAX_SWINGS` |
| Coin denominations | `frmCoinConvert` |
| Shop pricing (markup and Charm) | `modMMudDatabase.GetItemValue` |
| Shop type / trainer level range | `modMMudFunc.GetShopTypeEnum`, `modMain` |
| Monster drop tables and chances | `Monsters.DropItem-N` / `DropItem%-N`, `modMain` |
| Monster attacks and their damage | `Monsters.AttType-N` / `AttMin-N` / `AttMax-N` / `AvgDmg` |
| Room exits, and what guards them | `Rooms.N/S/E/W/NE/NW/SE/SW/U/D`, whose text carries the door, key, trap and toll |
| What you can type in a room | `Rooms.CMD` into `TBInfo.Action` |
| Spell damage / duration scaling | `modMMudDatabase.GetCurrentSpellMinMax`, `GetSpellMinDamage`, `GetSpellDuration` |
| Spell effect rendering | `modMMudDatabase.PullSpellEQ` |
| Cast chance and its cap | `modMMudFunc.GetSpellCastChance`, `STOCK_SPELL_HIT_CAP` |
| Which class can learn which spell | `modMMudFunc.SpellIsUsable`, `SpellIsInGame` |
| Magery / target / attack-type enums | `modMMudFunc.GetMageryEnum`, `SpellAttackTypeEnum`, `modMain` |

Things worth knowing, all of which the tool handles:

- **The `ArmourClass` and `DamageResist` columns are both stored ×10.** A stored
  `20` is AC +2. The `AC` *ability* (code 2) is the exception — MME adds that one
  raw, unscaled, and only three items use it.
- **Accuracy from ability 22 does not stack.** Only the single largest value
  across all your gear counts. Item-level `Accy` (to-hit) *is* additive. The
  optimizer scores non-stacking accuracy additively as an approximation — those
  values are marked with `*` in the results — but the totals row applies the
  real max-of-one rule.
- **A spell's `Classes` column is a string, not a bitmask** — `(*)` for any
  class, or `(12)` for a specific one. It is a restriction on the *learning
  method* and applies on top of the magery school, not instead of it.
- **`MinBase` is not always damage.** For a spell whose damage abilities are
  absent, the min/max range is the magnitude of whatever ability has a zero
  value: `illuminate`'s 4012 is a text-block number, `ethereal shield`'s 3 is its
  AC. Only abilities 1, 8 and 17 make a spell a damage spell (18 and 8 make it a
  heal), which is what `GetSpellMinDamage` scans for.
- **Rings use two different `Worn` codes** (4 and 13) which both feed the same
  pair of finger slots. Wrists work the same way. The solver treats each pair as
  one group so it can never put the same ring on both hands.
- **Ability 59 (`ClassOk`) whitelists an item for a class** and bypasses the
  armour- and weapon-type checks entirely.
- **Staff-only classes** (Mage, and anything else with class weapon type 9) can
  additionally use item 68 (dagger) and 100 (quarterstaff) — hardcoded in the
  game's own dll, not expressed in the data.
- **A class with ability 51 (`AntiMagic`) cannot use any magical item.**
- **Only `AttType` 1 is a swing.** A monster's five attack rows mix physical
  attacks with spells and specials, and on an `AttType` 2 row `AttMin` is a flat
  100 on all 507 of them — plainly not a damage minimum. Only type 1 rows feed
  the damage range, so a violet spore reads *6 average* rather than *100–10*;
  the 42 monsters that only ever cast fall back to the game's own `AvgDmg`.
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
