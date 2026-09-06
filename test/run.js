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
  'profileOf,setWith,swapGroups,swapImpact,IMPACT_ROWS,LOWER_IS_BETTER,'+
  'spellAt,spellCastLevel,spellScale,spellCastChance,spellCastsPerRound,'+
  'spellAlignOk,spellsFor,spellScalingText,spellByNum,'+
  'bestDrop,dropTooltip,monByNum,monLocText,candidatePool,'+
  'swingSchedule,MAX_SWINGS,ENERGY_PER_ROUND,setRounds:n=>{fightRounds=n},'+
  'passesRestrictions,isSundry,dropsByMonster,stockByShop,ctxFromChar,itemTags,spellName,'+
  'sortRows,sourceOrder,sortState,itemTab,hidesItem,FROM_REF,'+
  'getRounds:()=>fightRounds,damageMargins,DAMAGE_MODELLED,weaponThroughput,' +
  'MV,drawMap,indexMap};', ctx);

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

/* ------------------------------------------------------------------ spells */
section('Spell scaling (vs MMUD Explorer)');

const spell = n => D.spells.find(sp => sp.name === n);

// GetCurrentSpellMinMax / GetSpellDuration clamp the caster's level into the
// spell's own band before anything scales off it.
const mmis = spell('magic missile');   // req 1, cap 6
eq(X.spellCastLevel(mmis, 20), 6, 'a level past the cap scales as if you were at the cap');
eq(X.spellCastLevel(mmis, 0), 1, 'a level below the requirement scales at the requirement');
eq(X.spellCastLevel(spell('ethereal shield'), 12), 12, 'a level inside the band is used as it is');

// Fix() truncates, so a fractional increment is dropped rather than rounded.
eq(X.spellScale([1, 1, 10], 29), 3, '+1 per 10 levels at level 29 is +2, not +3');
eq(X.spellScale([60, 3, 1], 18), 114, '+3 per level compounds linearly');
eq(X.spellScale([12, 0, 1], 40), 12, 'a zero increment never scales');
eq(X.spellScale([12, 1, 0], 40), 12, '...and neither does a zero level step');

// Values a player can check in game.
const at = (name, lvl, sc, bonus) => X.spellAt(spell(name), lvl, sc || 0, bonus || 0);
let a = at('magic missile', 20);
eq(a.min, 4, 'magic missile stays 4 at any level (no min scaling)');
eq(a.max, 12, '...and 12, because its max step is zero levels');
ok(a.dmg && a.dmg.min === 4 && a.dmg.max === 12, 'ability 17 marks it as a damage spell');

a = at('ethereal shield', 30);
eq(a.castLevel, 18, 'ethereal shield caps at 18');
eq(a.dur, 114, '60 + 3/level at the cap is 114 rounds');
ok(a.effects.some(e => e === 'AC Blur +12'), 'its AC is the spell min/max, scaled', a.effects.join(' | '));
ok(a.effects.some(e => e === 'DR 1'), 'a DR ability value is stored x10, exactly as on items');
ok(!a.effects.some(e => /DescMsg|RemovesSpell/.test(e)), 'bookkeeping abilities are not shown');
ok(a.capped, 'and the row knows it is capped');

a = at('smite', 20);
eq(a.dur, 100, 'smite lasts 60 + 2/level rounds');
ok(a.effects.some(e => e === 'MaxDamage +3'), 'its +MaxDamage is 1 + 1 per 10 levels');
ok(!a.dmg, 'a buff is not counted as a damage spell');

// The worn +Spell Dmg bonus multiplies after level scaling, and truncates.
a = at('turn undead', 30);
eq(a.dmg.min, 32, 'turn undead at its cap is 12 + 20');
eq(a.dmg.max, 75, '...to 15 + 3/level');
a = at('turn undead', 30, 0, 25);
eq(a.dmg.min, 40, '+25% spell damage takes the min to 40');
eq(a.dmg.max, 93, '...and the max to 93, truncated not rounded');
ok(a.bonused, 'and the row reports that the bonus was applied');

// Stock MajorMUD bonuses damage but not healing; a drain is both.
a = at('vampiric touch', 30, 0, 50);
ok(a.dmg && a.heal, 'a drain both damages and heals');
eq(a.dmg.min, 8, 'a drain does not take the +Spell Dmg bonus in stock MajorMUD');
eq(a.heal.min, 8, '...on either side');

/* ------------------------------------------------------- cast chance */
section('Cast chance and casts per round');

// GetSpellCastChance: Diff adjusts your Spellcasting; it is not a target number.
eq(X.spellCastChance(mmis, 60), 75, 'Spellcasting 60 against difficulty +15 is 75%');
eq(X.spellCastChance(mmis, 200), 98, 'stock MajorMUD caps spell hit at 98%');
eq(X.spellCastChance(spell('way of the swan'), 200), 100, 'Kai caps at 100 instead');
eq(X.spellCastChance(mmis, 0), 100, 'with no Spellcasting set the chance is not guessed at');
ok(X.spellCastChance(spell('eldritch bolt'), 30) < X.spellCastChance(mmis, 30),
   'a harder spell fails more often at the same Spellcasting');

// A spell cheap enough in energy goes off more than once a round.
eq(X.spellCastsPerRound(mmis), 1, 'a 1000-energy spell is one cast per round');
eq(X.spellCastsPerRound(spell('eldritch fury')), 5, 'a 200-energy spell casts 5 times');
eq(X.spellCastsPerRound(spell('meteor swarm')), 4, 'a 250-energy spell casts 4 times');
eq(X.spellCastsPerRound(spell('magma blast')), 6, 'a 166-energy spell casts 6 times');
eq(X.spellCastsPerRound(spell('ethereal shield')), 1,
   'a spell that costs no energy is still one cast');
eq(X.spellCastsPerRound({ energy: 600 }), 1,
   'above 500 energy the multi-cast rule does not apply');
eq(X.spellCastsPerRound({ energy: 100 }), 1, '...and neither does it below 143');

/* --------------------------------------------------------- who can cast */
section('Which class casts what');

const cnum = n => D.classes.find(c => c.name === n).n;
eq((D.castable[cnum('Warrior')] || []).length, 0, 'a Warrior casts nothing');
eq((D.castable[cnum('Ninja')] || []).length, 0, '...and neither does a Ninja');
ok(D.castable[cnum('Mage')].length > 50, 'a Mage has a real spell list',
   String(D.castable[cnum('Mage')].length));
ok(D.castable[cnum('Priest')].length > D.castable[cnum('Paladin')].length,
   'higher magery level means more spells in the same school');

// Magery school, not just level, decides the list.
const mageList = new Set(D.castable[cnum('Mage')]);
const priestList = new Set(D.castable[cnum('Priest')]);
ok(!priestList.has(spell('magic missile').n), 'a Priest does not get Mage spells');
ok(mageList.has(spell('magic missile').n), '...and a Mage does');

// Level and alignment gate on top of that.
const lvl5 = X.spellsFor(cnum('Mage'), 5, '0', { knownOnly: true });
ok(lvl5.every(sp => sp.req <= 5), 'nothing above your level is offered as castable');
ok(lvl5.length < X.spellsFor(cnum('Mage'), 100, '0', { knownOnly: true }).length,
   'and the list grows as you level');

const holy = spell('holy force');      // carries the NotEvil ability
ok(X.spellAlignOk(holy, 'good'), 'a good character may cast holy force');
ok(!X.spellAlignOk(holy, 'evil'), '...but an evil one may not');
ok(X.spellAlignOk(holy, '0'), 'with no alignment set nothing is filtered out');
ok(X.spellsFor(cnum('Priest'), 100, 'evil', {}).length <
   X.spellsFor(cnum('Priest'), 100, '0', {}).length,
   'an alignment costs an evil Priest some of the list');

// The scaling rule is stated in words for the tooltip.
ok(/stops at level 18/.test(X.spellScalingText(spell('ethereal shield'))),
   'the scaling text names the cap', X.spellScalingText(spell('ethereal shield')));
ok(/does not scale/.test(X.spellScalingText(spell('magic missile'))),
   'and says so plainly when a spell does not scale');

// A penalty reads as a penalty. PullSpellEQ only prefixes "+" to a positive.
const curse = X.spellAt(spell('curse'), 22, 0, 0);
ok(curse.effects.some(e => e === 'Accuracy -6'), 'a negative effect is not printed as "+-6"',
   curse.effects.join(' | '));
ok(X.spellAt(spell('bless'), 22, 0, 0).effects.some(e => e === 'Accuracy +3'),
   '...while a bonus keeps its plus');

/* ------------------------------------------------------------ monster drops */
section('Where an item comes from');

const monByNum = X.monByNum;

// Every drop entry has to point at a monster that was actually exported, or the
// tooltip would name "monster #412" at the player.
let dropRows = 0, orphans = 0, badPct = 0;
for (const i of D.items) {
  if (!i.drop) continue;
  for (const [mnum, pct] of i.drop) {
    dropRows++;
    if (!monByNum.has(mnum)) orphans++;
    if (!(pct >= 1 && pct <= 100)) badPct++;
  }
}
ok(dropRows > 500, 'the database carries a real drop table', String(dropRows));
eq(orphans, 0, 'every drop names a monster that was exported');
eq(badPct, 0, 'every drop chance is a plain percentage between 1 and 100');
ok(D.items.filter(i => i.drop && i.type === 1).length > 150,
   'weapons in particular have drop sources',
   String(D.items.filter(i => i.drop && i.type === 1).length));

// Drops are exported best-chance-first, and bestDrop agrees.
for (const i of D.items) {
  if (!i.drop || i.drop.length < 2) continue;
  ok(i.drop[0][1] >= i.drop[1][1], 'drop lists lead with the best chance', i.name);
  break;
}
const tieB = X.bestDrop({ drop: [[D.monsters[0].n, 5], [D.monsters[1].n, 5]] });
ok(tieB.mon.exp <= Math.max(D.monsters[0].exp, D.monsters[1].exp),
   'on an equal chance the weaker monster is the one named');

// Earlier sections leave the shop filter narrowed; prices need it back.
X.setEnabled(D.shops.map(sh => sh.n));

// The item that caught a shop-pricing bug earlier: it is not sold anywhere.
const hb = item('hellblade');
eq(X.bestBuy(hb), null, 'the hellblade is not for sale in any shop');
const hbd = X.bestDrop(hb);
ok(hbd && hbd.mon.name === 'Devil Fiend Malivek', 'it drops off Devil Fiend Malivek',
   hbd ? hbd.mon.name : 'nothing');
eq(hbd.pct, 10, '...one time in ten');
ok(/map 15/.test(X.monLocText(hbd.mon)), 'and the tooltip says where that monster lives',
   X.monLocText(hbd.mon));
const hbTip = X.dropTooltip(hb);
ok(/Devil Fiend Malivek \(10%\)/.test(hbTip), 'the tooltip names the monster and the chance');
ok(/60,000 exp/.test(hbTip), '...and how hard it is');
ok(!X.bestBuy(hb) && X.bestDrop(hb), 'an unsold item has a drop source and no price');
// An item you can both buy and kill for leads with the price -- that is the
// route you control -- but the drop is shown beside it, not instead of it.
const dual = item('chainmail hauberk');
ok(X.bestBuy(dual) && dual.drop && dual.drop.length, 'the chainmail hauberk is both sold and dropped');
eq(X.sourceOrder(dual), X.bestBuy(dual).cost,
   '...and the cheaper certainty, the shop, is what it leads with');
ok(X.dropTooltip(dual).length > 0, '...while the drop route is still described');
ok(X.bestBuy(item('scroll of blight')), 'a sold-only item reports its price');
// The plain gold ring is not sold anywhere, which is the sort of thing this
// feature exists to surface.
ok(!X.bestBuy(item('gold ring')) && X.bestDrop(item('gold ring')),
   'even a basic gold ring is drop-only');

// Location coverage: Rooms.Lair matters, not just Rooms.NPC.
const located = D.monsters.filter(m => m.maps && m.maps.length).length;
ok(located > 340, 'most dropping monsters have a known location',
   `${located} of ${D.monsters.length}`);

// Feeding lair lists into the map difficulty tiers would wreck them, so they
// are deliberately built from Rooms.NPC alone. Guard that.
const mapTier = n => (D.maps.find(m => m.n === n) || {}).tier;
eq(mapTier(1), 'starter', 'map 1 is still the starter zone');
eq(mapTier(12), 'extreme', 'map 12 is still extreme, not drowned in wandering trash');
eq(mapTier(7), 'moderate', 'and the middle of the range is unchanged too');

/* ---------------------------------------------------------- the drop pool */
section('The obtainable item pool');

// A broke character who could actually wield the drop-only item being checked:
// the hellblade is evil-only, cursed, limited and level 50.
S.coins = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
S.equipped = {}; S.carried = [];
S.cls = D.classes.find(c => c.name === 'Warrior').n;
S.level = 60; S.align = 'evil';
const poolOpt = { allowLimited: true, allowCursed: true, requireInGame: false };
const buyable = X.candidatePool('buyable', poolOpt);
const obtainable = X.candidatePool('obtainable', poolOpt);
ok(obtainable.length > buyable.length,
   'allowing drops widens the pool beyond what a broke character can buy',
   `${obtainable.length} vs ${buyable.length}`);
ok(!buyable.some(i => i.n === hb.n), 'a drop-only item is not in the buyable pool');
ok(obtainable.some(i => i.n === hb.n), '...but is in the obtainable one');
ok(X.candidatePool('all', poolOpt).length >= obtainable.length,
   'and everything-in-the-game is still the widest pool');

/* --------------------------------------------------------- swings a round */
section('Swings, round by round');

// The Pascal quoted in MME's frmSwingCalc:
//   Temp := 1000; I := Temp div EU; Temp := (Temp mod EU) + 1000;
// Leftover energy carries, so a "2.5 swing" weapon really lands 2, 3, 2, 3.
const sched = (eu, n) => X.swingSchedule(eu, n).join(',');
eq(sched(400, 6), '2,3,2,3,2,3', 'a 2.5-swing weapon alternates 2 and 3, it does not average');
eq(sched(1000, 4), '1,1,1,1', 'a 1000-energy weapon is exactly one swing a round');
eq(sched(250, 4), '4,4,4,4', 'an exact divisor never drifts');
eq(sched(333, 4), '3,3,3,3', '3.003 swings is three a round, not four');
eq(sched(1054, 5), '0,1,1,1,1', 'a weapon costing more than a round of energy whiffs round one');
eq(sched(2100, 5), '0,0,1,0,1', '...and a very slow one only lands every other round');

// Five swings is the hard cap however fast the weapon is.
eq(sched(150, 3), '5,5,5', 'a fast weapon is capped at five swings a round');
eq(sched(10, 3), '5,5,5', '...however fast');
eq(X.MAX_SWINGS, 5, 'the cap is modMMudFunc.MAX_SWINGS');
eq(X.ENERGY_PER_ROUND, 1000, 'and a round is worth 1000 energy');

// The carry is taken before the cap, so a very fast weapon still burns the
// energy it was not allowed to spend.
eq(sched(1, 2), '5,5', 'burning the round on a one-energy weapon still lands only five');

// Totals track the fight length that is actually set.
X.setRounds(3);
eq(X.swingSchedule(400).length, 3, 'the schedule follows the configured fight length');
X.setRounds(5);
eq(X.swingSchedule(400).length, 5, '...and back again');

// The change that matters: a weapon whose fractional swings never land is worth
// less than its continuous rate suggests.
S.cls = D.classes.find(c => c.name === 'Warrior').n;
S.level = 24; S.base.str = 66; S.base.agi = 55; S.align = '0';
Object.assign(X.WCTX, { combat: 4, level: 24, agi: 55, str: 66, encPct: 16, crit: 0, plusMaxDmg: 0 });
// Two weapons that land the same twelve swings in five rounds, but whose
// continuous rates disagree about which is faster. Reality decides on damage.
const trident = X.weaponProfile(item('obsidian trident'));
const ripper = X.weaponProfile(item('Magus Ripper'));
eq(trident.schedule.join(','), '2,3,2,3,2', 'the trident lands 2,3,2,3,2');
eq(ripper.schedule.join(','), '2,2,3,2,3', 'the Magus Ripper lands 2,2,3,2,3');
eq(trident.swings, ripper.swings, 'both get exactly twelve swings in five rounds');
ok(trident.throughput > ripper.throughput,
   'the continuous rate says the trident is ahead',
   `${trident.throughput.toFixed(1)} vs ${ripper.throughput.toFixed(1)}`);
ok(ripper.perRound > trident.perRound,
   '...but on the swings you actually get, the harder-hitting Ripper wins',
   `${ripper.perRound.toFixed(1)} vs ${trident.perRound.toFixed(1)}`);

// A capped weapon is worth exactly its cap, and the rate agrees there.
const rapier = X.weaponProfile(item('silver rapier'));
eq(rapier.schedule.join(','), '5,5,5,5,5', 'a fast weapon sits on the five-swing cap');
ok(Math.abs(rapier.perRound - rapier.throughput) < 0.01,
   '...where the continuous rate and the round model agree exactly');

/* ------------------------------------------------------- crits, counted once */
section('Crits and +Max Damage are paid for exactly once');

Object.assign(X.WCTX, { combat: 4, level: 24, agi: 55, str: 66, encPct: 16,
                        crit: 0, plusMaxDmg: 0, refWeapon: null });

// With no weapon in the picture the damage model cannot price them, so the flat
// weights still apply -- a bare-handed martial artist keeps his crit gear.
X.WCTX.margins = X.damageMargins();
eq(X.WCTX.margins.crit, 0, 'with no weapon there is no marginal damage from a crit');
const ring = { stats: { crits: 2 }, type: 0 };
eq(X.scoreItem(ring, { crits: 40, dmg: 12 }), 80, 'so the flat Crits weight is what counts');

// With a weapon, the flat weight is ignored and the damage model prices them.
const hammers = item('throwing hammers');
X.WCTX.refWeapon = hammers;
X.WCTX.margins = X.damageMargins();
ok(X.WCTX.margins.crit > 0, 'with a weapon a crit point is worth real damage',
   X.WCTX.margins.crit.toFixed(3));
const scored = X.scoreItem(ring, { crits: 40, dmg: 12 });
const expected = 12 * X.WCTX.margins.crit * 2;
ok(Math.abs(scored - expected) < 1e-9,
   'and the flat Crits weight is no longer added on top', `${scored} vs ${expected}`);
ok(scored < 80, '...which is a lot less than the double count was paying', scored.toFixed(1));

// The marginal rate has to match what the damage model actually does. Move the
// context by one crit point and one +Max Damage point and check the difference.
const perRoundAt = (crit, maxdmg) => {
  const save = { crit: X.WCTX.crit, plusMaxDmg: X.WCTX.plusMaxDmg };
  X.WCTX.crit = crit; X.WCTX.plusMaxDmg = maxdmg;
  const v = X.weaponProfile(hammers).perRound;
  Object.assign(X.WCTX, save);
  return v;
};
const m = X.damageMargins();
const dCrit = perRoundAt(X.WCTX.crit + 1, X.WCTX.plusMaxDmg) - perRoundAt(X.WCTX.crit, X.WCTX.plusMaxDmg);
ok(Math.abs(dCrit - m.crit) < 1e-6,
   'one more Crit is worth exactly what the margin says', `${dCrit.toFixed(4)} vs ${m.crit.toFixed(4)}`);
const dMax = perRoundAt(X.WCTX.crit, X.WCTX.plusMaxDmg + 1) - perRoundAt(X.WCTX.crit, X.WCTX.plusMaxDmg);
ok(Math.abs(dMax - m.maxdmg) < 1e-6,
   'and so is one more point of +Max Damage', `${dMax.toFixed(4)} vs ${m.maxdmg.toFixed(4)}`);

// +Max Damage is worth more than half a point because crits multiply it.
ok(m.maxdmg > 0.5 * (X.weaponProfile(hammers).swings / X.getRounds()),
   '+Max Damage beats a plain damage point, because a crit rolls it 2x to 4x');

// Diminishing returns above 40 crit have to show up in the price.
X.WCTX.crit = 10; X.WCTX.margins = X.damageMargins();
const cheapCrit = X.damageMargins().crit;
X.WCTX.crit = 60; X.WCTX.margins = X.damageMargins();
const dearCrit = X.damageMargins().crit;
ok(dearCrit < cheapCrit, 'a crit point is worth less once you are past the 40 threshold',
   `${dearCrit.toFixed(3)} vs ${cheapCrit.toFixed(3)}`);
ok(Math.abs(dearCrit - cheapCrit / 3) < 1e-6, '...exactly a third as much, per critAfterDR');
X.WCTX.crit = 0; X.WCTX.refWeapon = null; X.WCTX.margins = X.damageMargins();

// End to end: the harder-hitting weapon now wins, which the double count had
// backwards -- a rapier's +2 Crits used to outweigh 17 more damage a round.
S.cls = D.classes.find(c => c.name === 'Warrior').n;
S.level = 24; S.align = '0';
S.base.str = 66; S.base.agi = 55; S.base.cha = 40;
S.equipped = {}; S.carried = []; S.coins = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
const meleeRes = X.optimize(X.PRESETS['Melee damage'],
  { pool: 'all', encTarget: 100, allowLimited: false, allowCursed: false, requireInGame: true });
ok(meleeRes.picks[16], 'the melee build still picks a weapon');
const chosen = X.weaponProfile(meleeRes.picks[16]);
ok(chosen.perRound > 50, 'and it is one that actually does damage',
   `${meleeRes.picks[16].name} at ${chosen.perRound.toFixed(1)}/round`);
eq(X.DAMAGE_MODELLED.has('crits'), true, 'crits are declared as model-priced');
eq(X.DAMAGE_MODELLED.has('maxdmg'), true, 'and so is +Max Damage');
eq(X.PRESETS['Melee damage'].crits, undefined,
   'the melee preset no longer carries a flat Crits weight');
eq(X.PRESETS['Martial arts'].crits, 30,
   'but martial arts keeps one, because its damage is not modelled');

/* -------------------------------------------------------- reference tabs */
section('The reference tabs');

// Every item lands on exactly one of the three item tabs. Weapons are type 1,
// armour is type 0 with a wear location, and everything else -- including the
// type-0 deeds and boxes you cannot put on -- is sundry.
const weaponTab = D.items.filter(i => i.type === 1);
const armourTab = D.items.filter(i => i.type === 0 && i.slot != null);
const sundryTab = D.items.filter(X.isSundry);
eq(weaponTab.length + armourTab.length + sundryTab.length, D.items.length,
   'weapons, armour and sundry partition the item table');
ok(!weaponTab.some(X.isSundry) && !armourTab.some(X.isSundry),
   'and nothing is counted twice');
ok(sundryTab.some(i => i.type === 0),
   'the wearable-nothing armour rows (deeds, boxes) are sundry');
ok(sundryTab.every(i => i.type !== 1), 'no weapon is sundry');

// The generic restrictions are exactly the part of isUsable that does not
// depend on wearing the thing, so gear that passes the full test must pass them.
S.cls = D.classes.find(c => c.name === 'Mage').n;
S.race = D.races.find(r => r.name === 'Human').n;
S.level = 20; S.align = 'good';
const gear = D.items.filter(i => (i.type === 0 || i.type === 1) && i.slot != null);
const strictOpt = { requireInGame: true, allowLimited: false, allowCursed: false };
ok(gear.every(i => !X.isUsable(i, strictOpt) || X.passesRestrictions(i, strictOpt)),
   'anything isUsable accepts also passes the shared restrictions');
ok(gear.some(i => X.passesRestrictions(i, strictOpt) && !X.isUsable(i, strictOpt)),
   'and the type rules still reject armour a Mage cannot wear on top of them');

// The drop table is exported on the item; the bestiary needs it the other way
// round, so check the inversion against the source it was built from.
const dropIdx = X.dropsByMonster();
let idxRows = 0;
for (const it of D.items) idxRows += (it.drop || []).length;
eq([...dropIdx.values()].reduce((a, r) => a + r.length, 0), idxRows,
   'the monster drop index holds every drop row the items carry');
const hell = item('hellblade');
const hellMon = X.bestDrop(hell).mon;
ok(dropIdx.get(hellMon.n).some(d => d.it.n === hell.n),
   'and the hellblade is listed under the fiend that drops it');
ok(dropIdx.get(hellMon.n).every((d, i, a) => !i || a[i - 1].pct >= d.pct),
   'each monster’s loot is listed best chance first');

// Same turn-around for shops: Items.buy says which shops stock it.
const stock = X.stockByShop();
let buyRows = 0;
for (const it of D.items) buyRows += (it.buy || []).length;
eq([...stock.values()].reduce((a, r) => a + r.length, 0), buyRows,
   'the shop stock index holds every shop-stock row');
const soldItem = D.items.find(i => i.buy && i.buy.length);
const soldShop = soldItem.buy[0][0];
ok(stock.get(soldShop).some(r => r.it.n === soldItem.n),
   'and an item sold at a shop appears in that shop’s stock');
ok(X.stockByShop() === stock, 'the index is built once and reused');

// The bestiary is the whole Monsters table now, not just the 421 that drop
// something, so "what else lives here" has an answer.
ok(D.monsters.length > 1000, 'every monster is exported, not just the droppers',
   String(D.monsters.length));
const droppers = new Set();
for (const it of D.items) for (const [mn] of it.drop || []) droppers.add(mn);
eq(droppers.size, 421, 'the droppers are still all present');
ok([...droppers].every(n => X.monByNum.has(n)), 'and every drop names a monster we know');
ok(D.monsters.some(m => m.dmg && m.dmg[1] > 0), 'monsters carry an attack damage spread');
ok(D.monsters.every(m => !m.dmg || m.dmg[0] <= m.dmg[1]), 'and it is the right way round');
// AttType 2 stores a flat 100 where a minimum would go on all 507 such rows, so
// only physical swings (AttType 1) may reach the damage column -- otherwise a
// violet spore reads as hitting for "100-10".
ok(D.monsters.every(m => !m.dmg || m.dmg[0] < 100 || m.dmg[1] >= 100),
   'no spell attack’s placeholder 100 leaked into a damage range');
const sorceress = D.monsters.find(m => m.name === 'ice sorceress');
eq(sorceress.dmg, undefined, 'a purely spell-slinging monster reports no swing range');
eq(sorceress.special, 2, 'its special attacks are counted instead');
ok(sorceress.avgDmg > 0, 'and the game’s own average damage stands in for them');

// The reference tabs are quoted for the active character: the shared weapon
// context has to describe them, innate crits included.
S.cls = D.classes.find(c => c.name === 'Ninja').n;
S.race = D.races.find(r => r.name === 'Dark-Elf').n;
S.level = 30; S.base.str = 70; S.base.agi = 80; S.equipped = {};
const wctx = X.ctxFromChar();
eq(X.WCTX.level, 30, 'the context takes the character’s level');
eq(X.WCTX.combat, wctx.cls.combat, 'and their class combat rating');
eq(X.WCTX.str, 70, 'and their Strength');
const innateCrit = X.sumAbil(wctx.cls.abils, 58) + X.sumAbil(wctx.race.abils, 58);
eq(X.WCTX.crit, innateCrit, 'and the crits their class and race are born with');
ok(innateCrit > 0, 'which for a Dark-Elf Ninja is not nothing', String(innateCrit));

// Tags are how an item's restrictions reach the eye, so the awkward ones have
// to survive the trip.
const tagText = it => X.itemTags(it).map(t => t[1]).join(' · ');
ok(tagText(item('hellblade')).includes('evil only'), 'an alignment-only item says so');
const twoH = D.items.find(i => i.type === 1 && (i.wtype === 1 || i.wtype === 3));
ok(tagText(twoH).includes('two-handed'), 'and a two-hander says that');

// A scroll's whole point is the spell it teaches, and that spell is usually one
// no class can learn from a trainer -- so names are carried for the whole spell
// table, not just the 256 the Spells tab lists.
eq(Object.keys(D.spellNames).length, 1378, 'every spell in the table has a name');
const teachers = D.items.filter(i => i.learns);
ok(teachers.length > 100, 'scrolls and tomes record what they teach', String(teachers.length));
const unnamed = [];
for (const it of D.items) {
  for (const n of (it.learns || []).concat(it.casts || [])) {
    if (X.spellName(n).startsWith('spell #')) unnamed.push(`${it.name} -> ${n}`);
  }
}
// Two items -- an onion and a carrot -- proc spell numbers 1410 and 1411, which
// are not rows in the Spells table at all. Nothing can name those, so the point
// is that they are the only ones left and they degrade to the number.
eq(unnamed.length, 2, 'every spell an item points at can be named, bar two dangling ones',
   unnamed.join(', '));
ok(tagText(item('ancient scroll')).includes('teaches soul rip'),
   'so the ancient scroll says what it teaches, not a spell number');

/* ------------------------------------------------------------ sorting */
section('Sortable columns');

const nameCol = { key: x => x.name };
const numCol = { key: x => x.v };
const sample = [{ name: 'beta', v: 2 }, { name: 'alpha', v: 10 }, { name: 'gamma', v: 2 }];

eq(X.sortRows(sample, numCol, 1).map(x => x.v).join(','), '2,2,10', 'a number column sorts numerically');
eq(X.sortRows(sample, numCol, -1).map(x => x.v).join(','), '10,2,2', 'and reverses');
eq(X.sortRows(sample, nameCol, 1).map(x => x.name).join(','), 'alpha,beta,gamma',
   'a string column sorts alphabetically');

// The tie-break must not flip with the column, or the names beside a reversed
// number column would come out backwards for no reason.
const tie = (a, b) => a.name.localeCompare(b.name);
eq(X.sortRows(sample, numCol, 1, tie).map(x => x.name).join(','), 'beta,gamma,alpha',
   'ties break by the tie-breaker');
eq(X.sortRows(sample, numCol, -1, tie).map(x => x.name).join(','), 'alpha,beta,gamma',
   'and the tie-break keeps its own direction when the column reverses');

// "No known source" is Infinity, which subtracting would turn into NaN and
// scramble the whole column.
const inf = [{ v: Infinity }, { v: 5 }, { v: Infinity }, { v: 1 }];
eq(X.sortRows(inf, numCol, 1).map(x => x.v).join(','), '1,5,Infinity,Infinity',
   'an unsourced row sorts last rather than scrambling the column');
eq(X.sortRows(sample, {}, 1).length, 3, 'a column with no key leaves the order alone');

// The "where to get it" order: buyable first and cheapest first, then drops by
// chance, then things with no source at all.
S.cls = D.classes.find(c => c.name === 'Warrior').n;
S.race = D.races.find(r => r.name === 'Human').n;
S.level = 30; S.align = '0'; S.base.cha = 50;
X.setEnabled(D.shops.map(sh => sh.n));
const sold = D.items.find(i => i.buy && i.buy.length && X.bestBuy(i));
const dropped = D.items.find(i => !(i.buy || []).length && i.drop && i.drop.length);
const neither = D.items.find(i => !(i.buy || []).length && !(i.drop || []).length);
ok(X.sourceOrder(sold) < X.sourceOrder(dropped), 'what a shop sells sorts before what a monster drops');
ok(X.sourceOrder(dropped) < X.sourceOrder(neither), 'and a drop sorts before no source at all');
eq(X.sourceOrder(sold), X.bestBuy(sold).cost, 'a bought item sorts on what it costs you');
const twoDrops = D.items.filter(i => !(i.buy || []).length && i.drop && i.drop.length >= 1);
const likelier = twoDrops.reduce((a, b) => (X.bestDrop(b).pct > (a ? X.bestDrop(a).pct : 0) ? b : a), null);
const rarer = twoDrops.reduce((a, b) => (X.bestDrop(b).pct < (a ? X.bestDrop(a).pct : 101) ? b : a), null);
ok(X.sourceOrder(likelier) < X.sourceOrder(rarer),
   'and among drops the likelier one comes first',
   `${likelier.name} ${X.bestDrop(likelier).pct}% vs ${rarer.name} ${X.bestDrop(rarer).pct}%`);

/* -------------------------------------------------------- cross-references */
section('Cross-reference links');

// A link has to know which tab its target is listed on, and the three item tabs
// partition the table, so this is the same rule isSundry enforces.
eq(X.itemTab(item('flamberge')), 'weapons', 'a weapon links to the weapons tab');
eq(X.itemTab(item('padded vest')), 'armour', 'wearable armour links to the armour tab');
eq(X.itemTab(item('torch')), 'sundry', 'a light source links to the sundry tab');
const deed = D.items.find(i => i.type === 0 && i.slot == null);
eq(X.itemTab(deed), 'sundry', 'and so does armour with no wear location', deed.name);
ok(D.items.every(i => ['weapons', 'armour', 'sundry'].includes(X.itemTab(i))),
   'every item has a tab to link to');

// Following a link must not land on "nothing matches", so the filters that
// would hide the target give way -- and only those.
S.cls = D.classes.find(c => c.name === 'Mage').n;
S.race = D.races.find(r => r.name === 'Human').n;
S.level = 20; S.align = '0';
const plate = D.items.find(i => i.type === 0 && i.atype === 9 && i.inGame && i.slot != null);
ok(X.hidesItem(plate).usable, 'a link to plate a Mage cannot wear relaxes "usable by me"', plate.name);
eq(X.hidesItem(plate).ingame, false, '...but leaves "in-game only" alone');
const staff = D.items.find(i => i.name === 'quarterstaff');
eq(X.hidesItem(staff).usable, false, 'a link to something they can use relaxes nothing');
const gone = D.items.find(i => !i.inGame);
ok(X.hidesItem(gone).ingame, 'and a link to an out-of-game item relaxes "in-game only"', gone.name);
S.cls = 0;
eq(X.hidesItem(plate).usable, false, 'with no class set there is no usability filter to relax');

// Items.from is a trail of raw references -- "Item #1727(68.4%), Room 1/2231".
// The numbered ones are rows we hold, so they become links; the rest stay text.
const parse = str => { const m = X.FROM_REF.exec(str); return m ? `${m[1].toLowerCase()}|${m[2]}|${m[3] || ''}` : null; };
eq(parse('Item #1727(68.4%)'), 'item|1727|(68.4%)', 'an item reference parses with its chance');
eq(parse('Monster #72(1%)'), 'monster|72|(1%)', 'so does a monster reference');
eq(parse('NPC #13'), 'npc|13|', 'and a bare NPC reference');
eq(parse('Shop(sell) #146'), 'shop(sell)|146|', 'and a sell-only shop');
eq(parse('Room 1/2231'), null, 'a room is not a reference to anything we hold');
eq(parse('Textblock #4104(25%)'), null, 'and neither is a text block');

let itemRefs = 0, monRefs = 0, shopRefs = 0, dangling = 0;
for (const it of D.items) {
  for (const part of (it.from || '').split(',').map(x => x.trim()).filter(Boolean)) {
    const m = X.FROM_REF.exec(part);
    if (!m) continue;
    const kind = m[1].toLowerCase(), n = +m[2];
    if (kind === 'item') { itemRefs++; if (!D.items.some(x => x.n === n)) dangling++; }
    else if (kind === 'monster' || kind === 'npc') { monRefs++; if (!X.monByNum.has(n)) dangling++; }
    else { shopRefs++; }
  }
}
ok(itemRefs > 1500, 'the from trails carry item references worth linking', String(itemRefs));
ok(monRefs > 800, '...and monster references', String(monRefs));
eq(dangling, 0, 'every item and monster reference names a row we can open');
// Shop references reach numbers outside the exported shop table; those fall back
// to plain text rather than a link that goes nowhere.
const badShops = [];
for (const it of D.items) {
  for (const part of (it.from || '').split(',').map(x => x.trim()).filter(Boolean)) {
    const m = X.FROM_REF.exec(part);
    if (m && m[1].toLowerCase().startsWith('shop') && !X.shopByNum.has(+m[2])) badShops.push(+m[2]);
  }
}
ok(shopRefs > 1000 && badShops.length > 0,
   'some shop references point outside the shop table and stay plain text',
   `${badShops.length} of ${shopRefs}`);

/* ------------------------------------------------------------------ maps */
section('The maps');

// The map files are loaded the way the page loads them: one plain script each.
for (const mi of D.mapIndex) {
  vm.runInContext(fs.readFileSync(path.join(root, `data/maps/map-${mi.n}.js`), 'utf8'), ctx);
}
const MAPS = ctx.window.MAPDATA;
const R_NUM = 0, R_NAME = 1, R_X = 2, R_Y = 3, R_AREA = 4, R_FLAG = 5, R_SHOP = 6, R_NPC = 7;
const F_DARK = 1, F_LAIR = 2, F_ITEMS = 4, F_SPELL = 8, F_CMD = 16, F_UP = 32, F_DOWN = 64, F_AWAY = 128;
const STEP = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0],
               NE: [1, -1], NW: [-1, -1], SE: [1, 1], SW: [-1, 1] };

eq(Object.keys(MAPS).length, D.mapIndex.length, 'every map in the index has a file');
eq(D.mapIndex.reduce((a, m) => a + m.rooms, 0), 26694, 'all 26,694 rooms are exported');
ok(D.mapDirs.join(',') === 'N,S,E,W,NE,NW,SE,SW,U,D', 'the ten directions are in a known order');

// A room's cell is invented by the layout, so the invariant that matters is
// that no two rooms are put in the same one -- a click has to mean one room.
let shared = 0, badArea = 0, outsideBox = 0;
for (const mi of D.mapIndex) {
  const m = MAPS[mi.n];
  eq(m.rooms.length, mi.rooms, `map ${mi.n} holds the rooms the index promises`);
  const cells = new Set();
  for (const r of m.rooms) {
    const key = r[R_X] + ',' + r[R_Y];
    if (cells.has(key)) shared++;
    cells.add(key);
    const a = m.areas[r[R_AREA]];
    if (!a) { badArea++; continue; }
    if (r[R_X] < a.x || r[R_X] >= a.x + a.w || r[R_Y] < a.y || r[R_Y] >= a.y + a.h) outsideBox++;
  }
}
eq(shared, 0, 'no two rooms are drawn in the same cell');
eq(badArea, 0, 'every room belongs to an area');
eq(outsideBox, 0, 'and sits inside that area’s box, so the area picker frames it');

// The point of the layout: inside an area, an exit is a step in its own
// direction. Where the world will not lie flat the room is torn into a new area
// rather than shoved somewhere free, which is what used to draw the sewers
// through the streets above them.
let clean = 0, stretched = 0, seams = 0;
const exactNeighbour = [];
for (const mi of D.mapIndex) {
  const m = MAPS[mi.n];
  const room = new Map(m.rooms.map(r => [r[R_NUM], r]));
  const happy = new Set();
  for (const [from, di, tm, to] of m.exits) {
    const step = STEP[D.mapDirs[di]];
    if (!step || tm !== mi.n) continue;
    const a = room.get(from), b = room.get(to);
    if (!a || !b) continue;
    if (a[R_AREA] !== b[R_AREA]) { seams++; continue; }
    if (b[R_X] - a[R_X] === step[0] && b[R_Y] - a[R_Y] === step[1]) {
      clean++; happy.add(from); happy.add(to);
    } else stretched++;
  }
  // A room in a multi-room area should sit at an exact offset from at least one
  // of its neighbours.
  const crowd = new Set(m.areas.map((a, i) => (a.rooms > 1 ? i : -1)));
  const inCrowd = m.rooms.filter(r => crowd.has(r[R_AREA]));
  exactNeighbour.push([inCrowd.filter(r => happy.has(r[R_NUM])).length, inCrowd.length]);
}
const cleanPct = 100 * clean / (clean + stretched);
ok(cleanPct > 95, 'inside an area, exits land one cell away in their own direction',
   `${cleanPct.toFixed(1)}% of ${clean + stretched}`);
// Seams are the price of never shoving a room: an exit the grid cannot honour
// is a link between two areas rather than a lie about where a room is. They
// should stay a small fraction of the walking you can actually draw.
ok(seams > 100 && seams < clean / 8, 'the exits that cannot are area seams, and there are few',
   `${seams} against ${clean} drawn`);
ok(stretched > 0, 'loops a grid cannot close are kept as stretched lines, not dropped',
   String(stretched));
// Nothing is nudged any more, so this is exact rather than nearly: a room the
// grid cannot place is torn into an area of its own, never left a cell off.
const anchored = exactNeighbour.reduce((a, b) => [a[0] + b[0], a[1] + b[1]], [0, 0]);
eq(anchored[0], anchored[1],
   'and every room sharing an area sits exactly where a neighbour puts it');

// Labels: a name on every area is a wall of overlapping text at any distance,
// so one is drawn only where it fits the ground it names and nothing else has
// been written. Drive the real canvas code with a stub context and check that
// no two labels ever share a pixel -- and that zoomed out there are none.
{
  const drawn = [];
  const state = { font: '11px x', textAlign: 'left' };
  const stub = {
    canvas: {}, setTransform() {},
    measureText: t => ({ width: t.length * (parseInt(state.font) || 11) * 0.6 }),
    fillText(t, x, y) { drawn.push([t, x, y, parseInt(state.font) || 11, state.textAlign]); },
  };
  const noop = new Proxy(stub, {
    get: (t, k) => (k in t ? t[k] : (k in state ? state[k] : () => {})),
    set: (t, k, v) => { state[k] = v; return true; },
  });
  ctx.document.querySelector = sel => (sel === '#mp-labels' ? { checked: true } : null);
  ctx.document.documentElement = {};
  ctx.getComputedStyle = () => ({ getPropertyValue: () => '' });
  const MV = X.MV;
  X.indexMap(MAPS[1]);
  MV.ctx = noop; MV.vw = 1200; MV.vh = 700;
  const town = MAPS[1].rooms.find(r => r[R_NUM] === 1);   // the Town Gates
  const counts = [];
  let clashes = 0;
  for (const scale of [3, 5, 8, 12, 18, 26, 40, 64]) {
    MV.scale = scale;
    MV.ox = town[R_X] - MV.vw / (2 * scale);
    MV.oy = town[R_Y] - MV.vh / (2 * scale);
    drawn.length = 0;
    X.drawMap();
    // the same boxes drawLabels claims, rebuilt from what it actually wrote
    const boxes = drawn.map(([t, x, y, size, align]) => {
      const w = t.length * size * 0.6;
      return align === 'center' ? [x - w / 2 - 3, y - size, x + w / 2 + 3, y + 3]
                                : [x - 2, y - 13, x + 4 + w, y + 3];
    });
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        if (a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]) clashes++;
      }
    counts.push([scale, drawn.length]);
  }
  eq(clashes, 0, 'no two map labels are ever drawn over each other');
  const zoomedOut = counts.filter(c => c[0] <= 5).reduce((a, c) => a + c[1], 0);
  eq(zoomedOut, 0, 'and zoomed out there are none at all, where they used to pile up');
  const close = counts.find(c => c[0] === 40)[1];
  ok(close > 20, 'but zoomed in the rooms are named', `${close} labels at 40px a cell`);
  ctx.document.querySelector = () => null;
  MV.ctx = null; MV.data = null;
}

// The bug this layout exists to fix: places drawn on top of each other. Map 1's
// biggest area used to hold the forest, the labyrinth, the graveyard and the
// slums at once; it should now be one place with a fringe of the caves and
// cottages that open off it, and the town, the sewers and the labyrinth should
// each be somewhere else.
{
  const m = MAPS[1];
  const big = m.areas.reduce((a, b, i) => (b.rooms > m.areas[a].rooms ? i : a), 0);
  const byPlace = new Map();
  for (const r of m.rooms) {
    if (r[R_AREA] !== big) continue;
    const place = (m.names[r[R_NAME]] || '').split(',')[0].trim();
    if (!byPlace.has(place)) byPlace.set(place, []);
    byPlace.get(place).push(r);
  }
  const biggest = [...byPlace.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  const share = 100 * biggest[1].length / m.areas[big].rooms;
  ok(share > 75, `map 1's biggest area is one place, not several`,
     `${biggest[0]} is ${share.toFixed(0)}% of its ${m.areas[big].rooms} rooms`);
  const label = p => m.areas.findIndex(a => p.test(a.label));
  const forest = label(/Darkwood/), town = label(/Slum Street/),
        sewer = label(/Sewer/), maze = label(/Labyrinth/);
  ok(forest >= 0 && town >= 0 && sewer >= 0 && maze >= 0,
     'the forest, the town, the sewers and the labyrinth are all named areas');
  ok(new Set([forest, town, sewer, maze]).size === 4,
     'and none of them is drawn through another',
     `forest ${forest}, town ${town}, sewers ${sewer}, labyrinth ${maze}`);
}

// Every exit has somewhere to go, on this map or another.
let danglingSame = 0, danglingAway = 0, badAnn = 0;
for (const mi of D.mapIndex) {
  const m = MAPS[mi.n];
  const here = new Set(m.rooms.map(r => r[R_NUM]));
  for (const [, di, tm, to, ann] of m.exits) {
    if (ann >= m.anns.length) badAnn++;
    if (tm === mi.n) { if (!here.has(to)) danglingSame++; }
    else {
      const other = MAPS[tm];
      if (other && !other.rooms.some(r => r[R_NUM] === to)) danglingAway++;
    }
    void di;
  }
}
// Five exits in the database lead to rooms that were never built -- 1/164,
// 1/288 and 1/2779, off a tournament room, a library, a gang house, the portal
// room and map 17's "Module Test Room". They are kept as the data has them and
// the map refuses to link them, rather than being quietly dropped.
eq(danglingSame + danglingAway, 5, 'the five exits to rooms that were never built are still there',
   `${danglingSame} inside a map, ${danglingAway} across maps`);
eq(badAnn, 0, 'every exit annotation resolves');

// Flags are what the renderer colours and marks rooms by, so they have to agree
// with the data they summarise.
let flagWrong = 0;
for (const mi of D.mapIndex) {
  const m = MAPS[mi.n];
  const ups = new Set(), downs = new Set(), away = new Set();
  for (const [from, di, tm] of m.exits) {
    if (D.mapDirs[di] === 'U') ups.add(from);
    if (D.mapDirs[di] === 'D') downs.add(from);
    if (tm !== mi.n) away.add(from);
  }
  for (const r of m.rooms) {
    const n = r[R_NUM], f = r[R_FLAG];
    if (!!(f & F_UP) !== ups.has(n)) flagWrong++;
    if (!!(f & F_DOWN) !== downs.has(n)) flagWrong++;
    if (!!(f & F_AWAY) !== away.has(n)) flagWrong++;
    if (!!(f & F_LAIR) !== !!m.lair[n]) flagWrong++;
    if (!!(f & F_ITEMS) !== !!m.items[n]) flagWrong++;
    if (!!(f & F_SPELL) !== !!m.spell[n]) flagWrong++;
    if (!!(f & F_CMD) !== !!m.cmd[n]) flagWrong++;
  }
}
eq(flagWrong, 0, 'the flags a room is drawn from match what it holds');

// What a room holds has to be something the rest of the tool knows about, or
// the tooltip would name a number.
let badShop = 0, badMon = 0, badItem = 0, darkRooms = 0, cmdRooms = 0;
for (const mi of D.mapIndex) {
  const m = MAPS[mi.n];
  for (const r of m.rooms) {
    if (r[R_SHOP] && !X.shopByNum.has(r[R_SHOP])) badShop++;
    if (r[R_NPC] && !X.monByNum.has(r[R_NPC])) badMon++;
    if (r[R_FLAG] & F_DARK) darkRooms++;
    if (r[R_FLAG] & F_CMD) cmdRooms++;
  }
  for (const list of Object.values(m.items)) {
    for (const n of list) if (!D.items.some(i => i.n === n)) badItem++;
  }
}
eq(badShop, 0, 'every shop in a room is a shop we hold');
eq(badMon, 0, 'every monster placed in a room is one we hold');
eq(badItem, 0, 'and every item lying in a room is one we hold');
ok(darkRooms > 10000, 'the dark rooms are marked — most of the world is unlit',
   String(darkRooms));
ok(cmdRooms > 300, 'and the rooms with something to do in them carry their commands',
   String(cmdRooms));

// Cross-check against the shop table: a shop says which room it stands in, and
// that room should be the one flagged with it.
let agreed = 0, disagreed = 0;
for (const sh of D.shops) {
  for (const loc of sh.locs || []) {
    const m = MAPS[loc.map];
    if (!m) continue;
    const room = m.rooms.find(r => r[R_NUM] === loc.room);
    if (!room) { disagreed++; continue; }
    if (room[R_SHOP] === sh.n) agreed++; else disagreed++;
  }
}
ok(agreed > 80, 'the room a shop stands in is flagged with that shop', String(agreed));
eq(disagreed, 0, '...for every shop location in the table');

// The commands are the "what do I do here" the tooltip exists for.
const portal = MAPS[1].cmd[2337];
ok(portal && portal.some(c => /dice/.test(c)),
   'the Portal Room lists the things you can type in it', (portal || []).join(', '));

/* ------------------------------------------------------------------ report */
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
