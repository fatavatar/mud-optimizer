/* Regression tests.  Run with:  node test/run.js   (from the repo root)
 *
 * app.js is a plain browser script, so we evaluate it in a VM with a stub DOM
 * and export the internals we want to exercise.
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const root = path.join(__dirname, '..');
const ctx = {
  window: {}, console,
  document: { addEventListener() {}, querySelector: () => null, createElement: () => ({}) },
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'data/gamedata.js'), 'utf8'), ctx);
vm.runInContext(
  fs.readFileSync(path.join(root, 'app.js'), 'utf8') +
  '\n;globalThis.__X={S,isUsable,parseChar,optimize,PRESETS,calcMaxEncum,calcDodge,' +
  'calcAccuracy,coinsToCopper,totalsOf,scoreItem,calcEnergyUsed,weaponThroughput,WCTX,' +
  'buyCost,bestBuy,shopTooltip,shopByNum,priceText,activeBuy,shopMap,mapByNum,' +
  'setEnabled:a=>{enabledShops=new Set(a)},getEnabled:()=>enabledShops,' +
  'weaponProfile,calcQuickAndDeadly,critAfterDR,sumAbil,'+
  'snapshot,restore,blankState,newChar,switchChar,deleteChar,duplicateChar,'+
  'charLabel,activeChar,touch,getRoster:()=>roster,setRoster:r=>{roster=r},'+
  'profileOf,setWith,swapGroups,swapImpact,IMPACT_ROWS,LOWER_IS_BETTER};', ctx);

const X = ctx.__X;
const D = ctx.window.GAMEDATA;
const S = X.S;

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '  -- ' + detail : '')); }
}
function eq(got, want, label) { ok(got === want, label, `got ${got}, want ${want}`); }
function section(t) { console.log('\n' + t); }

const item = n => D.items.find(i => i.name === n);

/* ------------------------------------------------------------------- scaling */
section('Column scaling');
// frmMain: nAC = ArmourClass / 10 and nDR = DamageResist / 10. Both columns are
// stored x10 in the database; the AC *ability* (code 2/10) is not scaled.
eq(item('skullcap').stats.ac, 2, 'skullcap is AC +2, not +20');
eq(item('chainmail hauberk').stats.ac, 18, 'chainmail hauberk AC');
eq(item('chainmail hauberk').stats.dr, 4, 'chainmail hauberk DR');
eq(item('gold ring').stats.ac, 1, 'gold ring AC +1');
eq(item('tower shield').stats.ac, 6, 'tower shield AC +6');
const liveMaxAC = Math.max(...D.items.filter(i => i.inGame).map(i => i.stats.ac || 0));
ok(liveMaxAC <= 45, 'no in-game item has an implausible AC after scaling', String(liveMaxAC));
// The one exception is an out-of-game joke item whose AC comes from the raw
// ability (code 2), which MME deliberately does not scale.
eq(item('Indiana Jones hat').stats.ac, 52, 'ability-based AC is added raw, not divided by 10');
eq(item('Indiana Jones hat').inGame, false, '...and that item is flagged out-of-game anyway');

/* ---------------------------------------------------------------- formulas */
section('Formulas (vs MMUD Explorer / in-game values)');
eq(X.calcMaxEncum(55, 0), 2640, 'max encumbrance at Str 55 = Str x 48');
eq(X.calcMaxEncum(100, 0), 4800, 'max encumbrance at Str 100');
eq(X.calcMaxEncum(110, 0), 5640, 'above Str 100 the slope changes to 84/point');
eq(X.calcMaxEncum(50, 10), 2640, 'a +10% encumbrance bonus applies multiplicatively');
eq(X.calcDodge(24, 62, 40, 0, 1204, 2640), 6, 'dodge at level 24, agi 62, charm 40');
eq(X.calcDodge(24, 62, 40, 0, 100, 2640), 16, 'dodge gains the full +10 sub-33% encumbrance bonus');
eq(X.coinsToCopper({ 0: 0, 1: 15, 2: 22, 3: 4, 4: 0 }), 42350, 'coin values convert to copper');

/* ------------------------------------------------------------------ parsing */
section('Parsing pasted game output');
const paste = `Name: Kaltar                Lives/CP: 3/45
Race: Half-Elf              Exp: 1560234
Class: Warrior              Level: 24
Hits: 312/312               Armour Class: 148/6
Mana: 0/0                   Encumbrance: 1204/2640
Strength: 55   Intellect: 30   Willpower: 28
Agility: 62    Health: 51     Charm: 40
MagicRes: 8    Spellcasting: 0

You are equipped with:
a hard leather helm (HEAD), a chainmail hauberk (TORSO), a gold ring (FINGER), a tower shield (OFF-HAND), a longsword (WEAPONHAND)

You are carrying 4 platinum pieces, 22 gold crowns and 15 silver nobles.`;
X.parseChar(paste);
eq(S.cls, 1, 'class name resolves to Warrior');
eq(S.race, 6, 'race name resolves to Half-Elf');
eq(S.level, 24, 'level');
eq(S.base.str, 55, 'strength');
eq(S.base.cha, 40, 'charm (last stat on a shared line)');
eq(S.coins[3], 4, 'platinum from the carrying line');
eq(S.unmatched.length, 0, 'every equipped item resolved to a database row');
eq(Object.keys(S.equipped).length, 5, 'five equipped slots');
eq(S.equipped[16].name, 'longsword', 'WEAPONHAND maps to the weapon slot');
eq(S.equipped[15].name, 'tower shield', 'OFF-HAND maps to the off-hand slot');
eq(S.equipped[9].name, 'gold ring', 'FINGER maps to the first free finger');

// Names that differ only by spacing should still resolve.
S.equipped = {}; S.carried = []; S.unmatched = [];
X.parseChar('You are equipped with:\na long sword (WEAPONHAND)');
eq(S.equipped[16] && S.equipped[16].name, 'longsword', '"long sword" resolves to "longsword"');

/* Real `inv` output: hard-wrapped, Title-Case slot tags, worn and carried items
 * in one list, coins inline plus a Wealth line. */
section('Parsing real inv output');
const realInv =
  'You are carrying 7 silver nobles, 3 copper farthings, padded vest (Torso),   \n' +
  'padded pants (Legs), cloth shoes (Feet), padded gloves (Hands), skullcap     \n' +
  '(Head), flamberge (Two handed), club, curved bone dagger                     \n' +
  'You have no keys.                                                            \n' +
  'Wealth: 73 copper farthings                                                  \n' +
  'Encumbrance: 698/3168 - Light [22%]';
S.base = { str: 0, int: 0, wil: 0, agi: 0, hea: 0, cha: 0 };
const inv = X.parseChar(realInv);
eq(Object.keys(S.equipped).length, 6, 'six worn items found');
eq(S.equipped[0].name, 'skullcap', 'an item split across a wrapped line still pairs with its slot');
eq(S.equipped[16].name, 'flamberge', '"(Two handed)" maps to the weapon slot');
eq(S.currentTwoHanded, true, 'a two-handed weapon is recognised as such');
eq(S.equipped[4].name, 'padded vest', 'Title-case "(Torso)" resolves');
eq(S.equipped[12].name, 'padded pants', '"(Legs)" resolves');
eq(S.carried.length, 2, 'untagged entries are treated as carried, not worn');
eq(S.carried.map(i => i.name).join(','), 'club,curved bone dagger', 'carried items');
eq(S.unmatched.length, 0, 'nothing unmatched');
eq(X.coinsToCopper(S.coins), 73, 'coins come from the Wealth line only, never double-counted');
eq(S.parsedEnc[1], 3168, 'max encumbrance read');
eq(inv.strFromEncum, 66, 'Strength inferred from max encumbrance when stat was not pasted');
eq(X.calcMaxEncum(66, 0), 3168, 'the inferred Strength reproduces the reported ceiling');

/* -------------------------------------------------------------- eligibility */
section('Item eligibility');
const opt = { requireInGame: true, allowLimited: true, allowCursed: true };
function usable(clsName, lvl, align, str, itemName) {
  S.cls = D.classes.find(c => c.name === clsName).n;
  S.level = lvl; S.align = align; S.race = 0;
  S.base = { str, int: 80, wil: 80, agi: 80, hea: 80, cha: 80 };
  return X.isUsable(item(itemName), opt);
}
eq(usable('Mage', 50, '0', 80, 'plate boots'), false, 'a Mage cannot wear plate');
eq(usable('Warrior', 50, '0', 80, 'plate boots'), true, 'a Warrior can wear plate');
eq(usable('Mage', 50, '0', 80, 'longsword'), false, 'a Mage is restricted to staves');
eq(usable('Mage', 50, '0', 80, 'dagger'), true, 'dagger is a hardcoded staff-class exception');
eq(usable('Mage', 50, '0', 80, 'quarterstaff'), true, 'quarterstaff is the other exception');
eq(usable('Warrior', 10, '0', 95, 'hellblade'), false, 'hellblade needs level 50');
eq(usable('Warrior', 60, '0', 80, 'hellblade'), true,
   'Strength 80 vs a requirement of 90 does not block the item, only slows it');
eq(usable('Warrior', 60, 'evil', 95, 'hellblade'), true, 'an evil level-60 Warrior with Str 95 qualifies');
eq(usable('Warrior', 60, 'good', 95, 'hellblade'), false, 'a good character cannot use an evil-only item');
eq(usable('Warrior', 60, '0', 95, 'hellblade'), true, 'unset alignment does not restrict');

/* --------------------------------------------------------------- optimizer */
section('Optimizer');
X.parseChar(paste);
const run = (preset, o) => X.optimize(X.PRESETS[preset], Object.assign(
  { pool: 'all', encTarget: 100, allowLimited: false, allowCursed: false, requireInGame: true }, o));

const melee = run('Melee damage');
ok(melee.enc <= melee.maxEnc, 'result stays within the encumbrance ceiling',
   `${melee.enc} > ${melee.maxEnc}`);
ok(melee.picks[16], 'a weapon is chosen');
ok(melee.picks[4], 'the torso slot is filled when there is capacity for it');
ok(melee.enc > melee.maxEnc * 0.5, 'the encumbrance budget is actually used, not left idle');
ok(Object.values(melee.picks).filter(Boolean).length >= 14, 'most slots are filled');

const tight = run('Melee damage', { encTarget: 33 });
ok(tight.enc <= melee.maxEnc * 0.34, 'the 33% target is respected', String(tight.enc));
ok(tight.totals.ac < melee.totals.ac, 'a tighter encumbrance budget buys less armour');

// A two-handed weapon must leave the off-hand empty.
const caster = (() => { S.cls = 12; S.base.str = 30; return run('Spellcaster'); })();
if (caster.twoHanded) ok(!caster.picks[15], 'a two-handed weapon leaves the off-hand empty');
else ok(true, 'one-handed configuration chosen for the caster');

// Owned-only must never recommend something the character does not have.
X.parseChar(paste);
const owned = run('Melee damage', { pool: 'owned', allowLimited: true });
const ownedNums = new Set([...Object.values(S.equipped), ...S.carried].map(i => i.n));
ok(Object.values(owned.picks).filter(Boolean).every(i => ownedNums.has(i.n)),
   '"only what I own" never suggests an unowned item');
// The character owns exactly one gold ring, so it must not appear on both hands.
const fingers = [owned.picks[9], owned.picks[10]].filter(Boolean).map(i => i.n);
ok(new Set(fingers).size === fingers.length, 'the same ring is not worn on both fingers');

const all = run('Melee damage', { allowLimited: true });
const f2 = [all.picks[9], all.picks[10]].filter(Boolean).map(i => i.n);
ok(new Set(f2).size === f2.length, 'the two finger slots always hold distinct items');
const w2 = [all.picks[6], all.picks[7]].filter(Boolean).map(i => i.n);
ok(new Set(w2).size === w2.length, 'the two wrist slots always hold distinct items');

// Every recommendation must itself be legal.
S.cls = 1; S.level = 24; S.align = '0'; S.base.str = 55;
ok(Object.values(melee.picks).filter(Boolean).every(i => X.isUsable(i, {
  requireInGame: true, allowLimited: false, allowCursed: false })),
  'every recommended item passes the eligibility check');

section('Strength requirement is a penalty, not a gate');
// MMUD Explorer's ItemIsUsableByChar never checks StrReq; being under it costs
// extra energy per swing (modMMudFunc.CalcEnergyUsed).
eq(usable('Warrior', 20, '0', 40, 'flamberge'), true,
   'an under-strength weapon is still wieldable');
const eOk = X.calcEnergyUsed(4, 20, 1925, 50, 70, 50, 70);
const eShort = X.calcEnergyUsed(4, 20, 1925, 50, 66, 50, 70);
ok(eShort > eOk, 'being under the requirement costs more energy per swing',
   `${eShort} vs ${eOk}`);
eq(eShort, Math.trunc((((70 - 66) * 3 + 200) * eOk) / 200),
   'the penalty matches (3 x deficit + 200) / 200');
eq(X.calcEnergyUsed(4, 20, 1925, 50, 80, 50, 70), eOk,
   'no penalty once Strength meets the requirement');

section('Shops and pricing');
// GetItemValue: markup is ADDED to base price, and Charm scales the result.
const dagger = item('dagger');
const base = dagger.price * D.currencyInCopper[dagger.cur];
eq(X.buyCost(dagger, 0, 0), base, 'no markup and no charm is the base price');
eq(X.buyCost(dagger, 100, 0), base * 2, '100% markup doubles the price, it does not leave it unchanged');
eq(X.buyCost(dagger, 0, 50), base, 'Charm 50 is price-neutral');
ok(X.buyCost(dagger, 0, 100) < base, 'high Charm is a discount');
ok(X.buyCost(dagger, 0, 20) > base, 'low Charm is a surcharge');

ok(dagger.buy && dagger.buy.length >= 2, 'the dagger is stocked by more than one shop');
const tip = X.shopTooltip(dagger);
ok(/Helfgrim/.test(tip), 'the tooltip names the room the shop is in', tip);
ok(/Sword Shop/.test(tip), 'the tooltip names the shop');
ok(/markup/.test(tip), 'the tooltip states the markup');
S.base.cha = 50;
const bb = X.bestBuy(dagger);
ok(bb && bb.shop, 'bestBuy picks a stocking shop');
ok(dagger.buy.every(([n]) => X.buyCost(dagger, X.shopByNum.get(n).markup, 50) >= bb.cost),
   'bestBuy really is the cheapest of them');

// Sell-only recycler entries (Max 0) must not be reported as places to buy.
eq(item('hellblade').buy, undefined, 'a sell-only recycler entry is not a place to buy');
eq(X.shopTooltip(item('hellblade')), '', 'no shop tooltip for an item no shop stocks');
ok(D.shops.every(sh => sh.markup >= 0), 'every exported shop has a markup');
// The starter kit genuinely costs nothing; say "free" rather than "0 copper".
eq(item('padded vest').price, 0, 'starter gear has no price in the data');
ok(/free/.test(X.shopTooltip(item('padded vest'))), 'a zero price reads as "free"',
   X.shopTooltip(item('padded vest')));
ok(D.shops.filter(sh => sh.locs && sh.locs.length && sh.locs[0].name).length > D.shops.length * 0.7,
   'most shops resolve to a named room');

section('Shop region filter');
// Shops.MinLVL/MaxLVL is the trainer level range, not an access gate, so region
// is the only defensible proxy for "can a low-level character get there".
ok(D.maps && D.maps.length, 'per-map difficulty is exported');
ok(D.maps.every(m => ['starter','low','moderate','high','extreme'].includes(m.tier)),
   'every map carries a tier');
const m1 = D.maps.find(m => m.n === 1);
eq(m1.tier, 'starter', 'map 1, which holds most shops, is the starter region');
ok(D.maps.some(m => m.tier === 'extreme'), 'the deep maps are tiered extreme');
ok(D.maps.filter(m => m.tier === 'starter').every(m => m.medExp < 100),
   'starter tier really does mean weak local monsters');

const allShops = D.shops.map(sh => sh.n);
const daggerShops = dagger.buy.map(([n]) => n);
eq(X.activeBuy(dagger).length, dagger.buy.length, 'with every shop enabled, all stock entries count');

X.setEnabled([]);
eq(X.activeBuy(dagger).length, 0, 'disabling every shop leaves no stock entries');
eq(X.bestBuy(dagger), null, 'and nothing has a price');
eq(X.shopTooltip(dagger), '', 'and nothing has a shop tooltip');

X.setEnabled([daggerShops[0]]);
eq(X.activeBuy(dagger).length, 1, 'enabling one shop exposes exactly that one');
ok(X.bestBuy(dagger).shop.n === daggerShops[0], 'pricing comes from the enabled shop');

// Restricting to reachable regions must never make anything cheaper.
X.setEnabled(allShops);
const cheapAll = X.bestBuy(dagger).cost;
X.setEnabled(D.shops.filter(sh => {
  const m = X.mapByNum.get(X.shopMap(sh));
  return m && (m.tier === 'starter' || m.tier === 'low');
}).map(sh => sh.n));
const cheapNear = X.bestBuy(dagger) ? X.bestBuy(dagger).cost : Infinity;
ok(cheapNear >= cheapAll, 'narrowing to reachable regions never lowers a price');
X.setEnabled(allShops);

section('Critical hits');
// modMMudFunc: a crit rolls 2x-4x the weapon's MAX damage, and +Max Damage is
// folded in before that multiplier, so it is amplified by it.
eq(X.critAfterDR(30), 30, 'crit chance below 40 is unmodified');
eq(X.critAfterDR(40), 40, 'crit chance at 40 is unmodified');
eq(X.critAfterDR(55), 45, 'past 40 the excess is divided by three');
eq(X.critAfterDR(100), 60, 'and heavily damped at the top');

// Quick and Deadly: only for fast swings, capped, halved when encumbered.
eq(X.calcQuickAndDeadly(50, 250, 10), 0, 'no bonus at 200+ energy per swing');
eq(X.calcQuickAndDeadly(50, 190, 10), 10, 'a fast swing earns a bonus');
eq(X.calcQuickAndDeadly(150, 100, 10), 20, 'the bonus is capped at 20');
eq(X.calcQuickAndDeadly(50, 190, 40), 5, 'past 33% encumbrance the bonus halves');
eq(X.calcQuickAndDeadly(50, 190, 80), 0, 'past 66% encumbrance it is lost');

// Class and race contribute crits before any gear.
eq(X.sumAbil(D.classes.find(c => c.name === 'Ninja').abils, 58), 10, 'a Ninja has innate crits');
eq(X.sumAbil(D.races.find(r => r.name === 'Dark-Elf').abils, 58), 1, 'a Dark-Elf has an innate crit');
eq(X.sumAbil(D.classes.find(c => c.name === 'Warrior').abils, 58), 0, 'a Warrior has none');

Object.assign(X.WCTX, { combat: 4, level: 30, agi: 70, str: 90, encPct: 30, crit: 0, plusMaxDmg: 0 });
const gs = item('greatsword');
const noCrit = X.weaponProfile(gs);
eq(noCrit.perSwing, (gs.min + gs.max) / 2, 'with no crit chance, damage is the plain average');

X.WCTX.crit = 20;
const withCrit = X.weaponProfile(gs);
ok(withCrit.perSwing > noCrit.perSwing, 'crit chance raises expected damage per swing');
eq(withCrit.crit, 3 * gs.max, 'an average crit is 3x the weapon max');

X.WCTX.crit = 0; X.WCTX.plusMaxDmg = 10;
const withMax = X.weaponProfile(gs);
eq(withMax.normal, (gs.min + gs.max + 10) / 2, '+Max Damage raises the normal average by half of it');
X.WCTX.crit = 20;
const both = X.weaponProfile(gs);
eq(both.crit, 3 * (gs.max + 10), '...and the full amount through the crit multiplier');
ok(both.perSwing - withCrit.perSwing > (withMax.perSwing - noCrit.perSwing),
   '+Max Damage is worth more to a character who crits often');

// A slow weapon gets no Quick and Deadly; a fast one does.
X.WCTX.plusMaxDmg = 0;
ok(X.weaponProfile(item('dagger')).qnd > 0, 'a dagger earns the quick-and-deadly bonus');
ok(X.weaponProfile(item('greatsword')).qnd === 0, 'a greatsword does not');

// The reported crit chance must describe the kit actually recommended, even
// when the crit/gear fixed point oscillates rather than settling.
section('Crit reporting is self-consistent');
X.parseChar(paste);
for (const [clsName, raceName] of [['Warrior','Human'], ['Ninja','Dark-Elf'], ['Mystic','Human']]) {
  S.cls = D.classes.find(c => c.name === clsName).n;
  S.race = D.races.find(r => r.n && r.name === raceName).n;
  S.level = 30; S.align = '0';
  S.base = { str: 85, int: 50, wil: 50, agi: 80, hea: 60, cha: 50 };
  const r = run('Melee damage');
  const innate = X.sumAbil(D.classes.find(c => c.name === clsName).abils, 58) +
                 X.sumAbil(D.races.find(x => x.name === raceName).abils, 58);
  eq(r.critStat, innate + (r.totals.crits || 0),
     `${clsName}/${raceName}: reported Crits equals innate plus the chosen gear`);
  if (r.picks[16]) {
    const wp = X.weaponProfile(r.picks[16]);
    eq(wp.critPct, X.critAfterDR(r.critStat + wp.qnd),
       `${clsName}/${raceName}: weapon crit chance follows from that total`);
  }
}

/* ------------------------------------------------------------- the roster */
section('Multiple characters');

X.setRoster({ active: null, chars: [] });

const warrior = X.newChar();                 // becomes active, blank
X.parseChar(`Name: Kaltar                Lives/CP: 3/45
Race: Half-Elf              Exp: 1560234
Class: Warrior              Level: 24
Strength: 66                Agility: 55

You are carrying padded vest (Torso), skullcap (Head), flamberge (Two handed), club
Wealth: 73 copper farthings`);
S.coins[2] = 40;
S.weights = { ...X.PRESETS['Tank / survivability'] };
S.preset = 'Tank / survivability';
X.touch();

eq(S.name, 'Kaltar', 'the character name is read off the stat block');
eq(X.charLabel(X.activeChar()), 'Kaltar', 'an unnamed slot is labelled from the parsed name');

const mage = X.newChar();                    // switches away from the warrior
eq(X.getRoster().chars.length, 2, 'two characters are held at once');
eq(S.cls, 0, 'a new character starts blank');
eq(S.name, '', '...with no name');
eq(Object.keys(S.equipped).length, 0, '...and no gear');
eq(S.coins[2], 0, '...and an empty purse');
eq(S.weights.dr, X.PRESETS['Balanced'].dr, '...and the default goal, not the last one used');

// The warrior must be exactly as we left him, gear, coins, goal and all.
ok(X.switchChar(warrior.id), 'switching back to the first character');
eq(S.name, 'Kaltar', 'name survives the round trip');
eq(S.cls, ctx.window.GAMEDATA.classes.find(c => c.name === 'Warrior').n, 'class survives');
eq(S.level, 24, 'level survives');
eq(S.base.str, 66, 'stats survive');
eq(S.coins[2], 40, 'coins survive');
eq(S.preset, 'Tank / survivability', 'the optimizer goal is per character');
eq(S.weights.dr, X.PRESETS['Tank / survivability'].dr, '...including hand-edited weights');
ok(S.equipped[0] && S.equipped[0].name === 'skullcap', 'worn gear survives');
ok(S.carried.some(i => i.name === 'club'), 'carried gear survives');
ok(S.paste.includes('Kaltar'), 'the raw paste is kept for reference');
// Gear is stored by item number, so it is rehydrated from the live database
// rather than from a stale copy taken at parse time.
ok(S.equipped[0] === ctx.__X.S.equipped[0] && S.equipped[0].stats.ac === 2,
   'restored items are the live database objects');

// A snapshot of a character that never had a name still labels itself.
X.switchChar(mage.id);
eq(X.charLabel(X.activeChar()), 'Unnamed', 'a blank character is labelled Unnamed');
S.name = 'Zeb'; X.touch();
eq(X.charLabel(X.activeChar()), 'Zeb', 'labelling follows the name as it is set');

// Duplicating gives an independent copy, not a shared reference.
const copy = X.duplicateChar(warrior.id);
eq(X.charLabel(copy), 'Kaltar copy', 'a duplicate is named after its source');
eq(S.level, 24, 'the duplicate carries the gear and stats over');
S.level = 30; X.touch();
eq(X.getRoster().chars.find(c => c.id === warrior.id).snap.level, 24,
   'editing the duplicate does not touch the original');

// Deleting the active character falls through to a neighbour, never nothing.
X.deleteChar(copy.id);
eq(X.getRoster().chars.length, 2, 'deleting removes exactly one character');
ok(X.activeChar() !== null, 'something is always active after a delete');
X.deleteChar(X.getRoster().chars[0].id);
X.deleteChar(X.getRoster().chars[0].id);
eq(X.getRoster().chars.length, 1, 'deleting the last character leaves a fresh blank one');
eq(S.cls, 0, '...and that one is empty');

// An item that disappears from the database must not break a saved character.
X.restore({ name: 'Ghost', equipped: { 0: 999999 }, carried: [999999], cls: 1 });
eq(Object.keys(S.equipped).length, 0, 'gear that no longer exists is dropped, not crashed on');
eq(S.carried.length, 0, '...in the carried list too');
eq(S.name, 'Ghost', '...and the rest of the character still loads');

/* ------------------------------------------------------- per-swap impact */
section('Impact of a single swap');

X.setRoster({ active: null, chars: [] });
X.newChar();
X.parseChar(`Name: Kaltar                Lives/CP: 3/45
Race: Half-Elf              Exp: 1560234
Class: Warrior              Level: 24
Strength: 66                Agility: 55                Charm: 40
Health: 50                  Intellect: 30              Willpower: 30

You are carrying padded vest (Torso), padded pants (Legs), cloth shoes (Feet),
padded gloves (Hands), skullcap (Head), flamberge (Two handed), club
Wealth: 73 copper farthings`);

const R = X.optimize(X.PRESETS['Melee damage'],
  { pool: 'all', encTarget: 100, allowLimited: false, allowCursed: false, requireInGame: true });
const inn = { crit: R.innateCrit || 0, maxDmg: R.innateMaxDmg || 0 };
const best = X.profileOf(R.picks, inn);

// A profile has to agree with the optimizer about the set it was handed.
eq(best.enc, R.enc, 'profileOf agrees with the optimizer on encumbrance');
eq(best.maxEnc, R.maxEnc, '...and on the encumbrance ceiling');
eq(best.ac || 0, R.totals.ac || 0, '...and on AC');
ok(best.dps > 0, 'the recommended kit has a damage-per-energy figure', String(best.dps));

// Reverting one slot must reproduce exactly the item worn there, and nothing else.
const revert = X.setWith(R.picks, [0], S.equipped);
eq(revert[0] && revert[0].name, 'skullcap', 'setWith puts the worn item back in that slot');
eq(revert[4], R.picks[4], '...and leaves every other slot at the recommendation');

// Reverting a slot the character has nothing in must empty it, not keep the pick.
const bare = D.slots.find(sl => !S.equipped[sl.i] && R.picks[sl.i]);
eq(X.setWith(R.picks, [bare.i], S.equipped)[bare.i], null,
   `reverting an empty slot (${bare.name}) clears it rather than keeping the pick`);

// Swapping the head slot back must show up as a real, signed difference.
const headImp = X.swapImpact(R, [0], inn, best);
ok(headImp.rows.length > 0, 'swapping the head slot has a measurable impact');
const acRow = headImp.rows.find(r => r.k === 'ac');
ok(acRow && acRow.delta === (R.picks[0].stats.ac || 0) - (S.equipped[0].stats.ac || 0),
   'the AC impact equals the difference between the two helmets');
ok(acRow.to - acRow.from === acRow.delta, 'from/to and the delta agree');

// The baseline is the whole recommended kit, not the character's current kit:
// reverting nothing must therefore be a no-op.
const nil = X.swapImpact(R, [], inn, best);
eq(nil.rows.length, 0, 'reverting no slots at all reports no impact');

// Heavier armour has to pay for itself: a swap that adds encumbrance shows the
// knock-on cost, not just the armour value.
const heavy = D.slots.map(sl => sl.i).filter(i =>
  R.picks[i] && (R.picks[i].enc || 0) > (S.equipped[i] ? S.equipped[i].enc : 0) + 200);
ok(heavy.length > 0, 'the recommendation includes at least one much heavier piece');
const hi = X.swapImpact(R, [heavy[0]], inn, best);
ok(hi.rows.some(r => r.k === 'enc' && r.delta > 0), 'the extra weight is reported');
ok(X.LOWER_IS_BETTER.has('enc'), 'and extra weight counts as the bad direction');

// A two-handed weapon empties the off-hand, so those two slots are one decision.
// The character wields a flamberge (two handed) today.
eq(S.equipped[16].name, 'flamberge', 'the test character starts with a two-hander');
const groups = X.swapGroups(R);
const merged = groups.find(g => g.length > 1);
const oneHandedPick = R.picks[16] && !(R.picks[16].wtype === 1 || R.picks[16].wtype === 3);
if (oneHandedPick && R.picks[15]) {
  ok(merged && merged.includes(16) && merged.includes(15),
     'weapon and off-hand are scored together when handedness changes');
  eq(groups.filter(g => g.includes(16)).length, 1, '...and the weapon appears in exactly one group');
} else {
  ok(!merged, 'weapon and off-hand stay separate when handedness does not change');
}
eq(new Set(groups.flat()).size, D.slots.length, 'every slot belongs to exactly one group');
eq(groups.flat().length, D.slots.length, '...and no slot is counted twice');

// Impact rows are ordered by how much they matter, and only real changes appear.
const idx = k => X.IMPACT_ROWS.findIndex(r => r[0] === k);
ok(idx('dps') < idx('ac') && idx('ac') < idx('hp'), 'impact rows are ordered by decisiveness');
ok(headImp.rows.every(r => Math.abs(r.delta) >= (r.dp ? 0.05 : 0.5)),
   'rounding noise is not reported as an impact');

/* ------------------------------------------------------------------ report */
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
