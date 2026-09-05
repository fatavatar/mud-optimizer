/* MajorMUD Gear Optimizer
 *
 * Eligibility rules and enum semantics follow MMUD Explorer's
 * ItemIsUsableByChar / InvenAddEquip / GetAbilityStatSlot.
 */
'use strict';

const D = window.GAMEDATA;

/* ------------------------------------------------------------------ state */

const S = {
  name: '', preset: 'Balanced', paste: '',
  cls: 0, race: 0, level: 1, align: '0',
  base: { str: 0, int: 0, wil: 0, agi: 0, hea: 0, cha: 0 },
  coins: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 },
  equipped: {},        // slot index -> item
  carried: [],         // items
  unmatched: [],       // names we could not resolve
  parsedEnc: null,     // [current, max] straight from the game, if pasted
  weights: {},
  result: null,
};

/* Items can share a name; prefer the in-game one. */
const byName = new Map();
for (const it of D.items) {
  const k = it.name.toLowerCase();
  if (!byName.has(k)) byName.set(k, it);
  else if (it.inGame && !byName.get(k).inGame) byName.set(k, it);
}
const bySquashed = new Map();
for (const it of D.items) {
  const k = it.name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!bySquashed.has(k) || (it.inGame && !bySquashed.get(k).inGame)) bySquashed.set(k, it);
}
const byNum = new Map(D.items.map(i => [i.n, i]));
const clsByNum = new Map(D.classes.map(c => [c.n, c]));
const shopByNum = new Map((D.shops || []).map(sh => [sh.n, sh]));
const mapByNum = new Map((D.maps || []).map(m => [m.n, m]));
const shopMap = sh => (sh.locs && sh.locs.length ? sh.locs[0].map : 0);

const TIER_ORDER = ['starter', 'low', 'moderate', 'high', 'extreme'];

/* Shops the character can actually get to. Defaults to all; the user prunes
 * regions they cannot travel to, and the choice is remembered per browser. */
const SHOP_KEY = 'mudtool.enabledShops';
let enabledShops = new Set(D.shops.map(sh => sh.n));
try {
  const saved = JSON.parse(localStorage.getItem(SHOP_KEY) || 'null');
  if (Array.isArray(saved)) enabledShops = new Set(saved.filter(n => shopByNum.has(n)));
} catch (e) { /* private window, blocked storage -- defaults are fine */ }
function saveShops() {
  try { localStorage.setItem(SHOP_KEY, JSON.stringify([...enabledShops])); } catch (e) {}
}
/* ------------------------------------------------------- character roster */
/* Several characters are kept side by side so that swapping between them does
 * not mean clearing and re-pasting. Everything on the Character tab belongs to
 * the active character, and so does its optimizer goal -- a warrior and a mage
 * do not want the same weights. Shop access is deliberately *not* per
 * character: it describes where you can travel, which is a property of the
 * account and the world, not of one alt.
 *
 * Optimizer results are never stored. They are cheap to recompute and would
 * otherwise be shown stale against a character that has since been edited. */
const ROSTER_KEY = 'mudtool.characters';
let roster = { active: null, chars: [] };

function blankState() {
  return {
    name: '', cls: 0, race: 0, level: 1, align: '0',
    base: { str: 0, int: 0, wil: 0, agi: 0, hea: 0, cha: 0 },
    coins: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 },
    equipped: {}, carried: [], unmatched: [], parsedEnc: null,
    preset: 'Balanced', weights: { ...PRESETS['Balanced'] }, paste: '',
  };
}

/* Gear is stored by item number rather than by value: the database stays the
 * source of truth, so a saved character follows it across a data update. */
function snapshot() {
  const eq = {};
  for (const k in S.equipped) eq[k] = S.equipped[k].n;
  return {
    name: S.name, cls: S.cls, race: S.race, level: S.level, align: S.align,
    base: { ...S.base }, coins: { ...S.coins },
    equipped: eq,
    carried: S.carried.map(i => i.n),
    unmatched: [...S.unmatched],
    parsedEnc: S.parsedEnc ? [...S.parsedEnc] : null,
    preset: S.preset, weights: { ...S.weights }, paste: S.paste,
  };
}

function restore(snap) {
  const b = blankState(), s = snap || {};
  S.name = s.name || '';
  S.cls = +s.cls || 0; S.race = +s.race || 0;
  S.level = +s.level || 1; S.align = s.align || '0';
  S.base = { ...b.base, ...s.base };
  S.coins = { ...b.coins, ...s.coins };
  S.equipped = {};
  for (const k in (s.equipped || {})) {
    const it = byNum.get(s.equipped[k]);   // an item can vanish under a data update
    if (it) S.equipped[k] = it;
  }
  S.carried = (s.carried || []).map(n => byNum.get(n)).filter(Boolean);
  S.unmatched = [...(s.unmatched || [])];
  S.parsedEnc = s.parsedEnc ? [...s.parsedEnc] : null;
  S.preset = PRESETS[s.preset] ? s.preset : 'Balanced';
  S.weights = { ...(s.weights || PRESETS[S.preset]) };
  S.paste = s.paste || '';
  S.result = null;
}

/* A character shows the name you typed, falling back to the one the game
 * printed, so a straight paste needs no naming step. */
const charLabel = c => (c.label || (c.snap && c.snap.name) || 'Unnamed').trim() || 'Unnamed';
const activeChar = () => roster.chars.find(c => c.id === roster.active) || null;

function saveRoster() {
  try { localStorage.setItem(ROSTER_KEY, JSON.stringify(roster)); } catch (e) {}
}

/* Fold the live state back into the active roster entry and persist it. Called
 * after anything that edits the character, so nothing needs an explicit save. */
function touch() {
  const c = activeChar();
  if (!c) return;
  c.snap = snapshot();
  saveRoster();
}

let charSeq = 0;
function newChar(label, snap) {
  const id = 'c' + Date.now().toString(36) + (charSeq++).toString(36) + Math.random().toString(36).slice(2, 5);
  const c = { id, label: label || '', snap: snap || blankState() };
  roster.chars.push(c);
  touch();                       // save whatever we are leaving, under its own id
  roster.active = id;
  restore(c.snap);
  saveRoster();
  return c;
}

function switchChar(id) {
  const c = roster.chars.find(x => x.id === id);
  if (!c || id === roster.active) return false;
  touch();                       // keep the character we are leaving
  roster.active = id;
  restore(c.snap);
  saveRoster();
  return true;
}

function duplicateChar(id) {
  const c = roster.chars.find(x => x.id === id);
  if (!c) return null;
  if (c.id === roster.active) touch();
  return newChar(charLabel(c) + ' copy', JSON.parse(JSON.stringify(c.snap)));
}

function deleteChar(id) {
  const i = roster.chars.findIndex(c => c.id === id);
  if (i < 0) return;
  roster.chars.splice(i, 1);
  if (roster.active !== id) { saveRoster(); return; }
  const next = roster.chars[Math.min(i, roster.chars.length - 1)];
  if (next) { roster.active = next.id; restore(next.snap); saveRoster(); }
  else { roster.active = null; newChar(); }   // never leave the roster empty
}

function loadRoster() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(ROSTER_KEY) || 'null'); } catch (e) {}
  if (saved && Array.isArray(saved.chars) && saved.chars.length) {
    roster = { active: saved.active, chars: saved.chars };
    if (!activeChar()) roster.active = roster.chars[0].id;
    restore(activeChar().snap);
  } else {
    newChar();
  }
}

/* The stock entries for this item at shops that are currently switched on. */
function activeBuy(it) {
  return it.buy ? it.buy.filter(([n]) => enabledShops.has(n)) : null;
}

const SLOT = new Map(D.slots.map(s => [s.i, s]));
const POOL_SLOTS = {};                       // pool -> [slot indices]
for (const s of D.slots) (POOL_SLOTS[s.pool] ||= []).push(s.i);
const slotPool = i => SLOT.get(i).pool;

/* Slot labels as they appear in `inv` output, normalised to letters only:
 * "Two handed" -> TWOHANDED, "Off-hand" -> OFFHAND. */
const LOC_TO_POOL = {
  HEAD: 'head', EARS: 'ears', EAR: 'ears', EYES: 'eyes', EYE: 'eyes', FACE: 'face',
  NECK: 'neck', BACK: 'back', TORSO: 'torso', BODY: 'torso', ARMS: 'arms',
  WRIST: 'wrist', WRISTS: 'wrist', HANDS: 'hands', HAND: 'hands',
  FINGER: 'finger', FINGERS: 'finger', WAIST: 'waist', LEGS: 'legs', FEET: 'feet',
  OFFHAND: 'offhand', SHIELD: 'offhand', WORN: 'worn',
  WEAPONHAND: 'weapon', TWOHANDED: 'weapon', WIELDED: 'weapon', WEAPON: 'weapon',
};
const normLoc = t => t.toUpperCase().replace(/[^A-Z]/g, '');

const COIN_WORDS = [
  [4, /(\d[\d,]*)\s*runic/i], [3, /(\d[\d,]*)\s*plat/i], [2, /(\d[\d,]*)\s*gold/i],
  [1, /(\d[\d,]*)\s*silver/i], [0, /(\d[\d,]*)\s*copper/i],
];

/* --------------------------------------------------------------- presets */

const PRESETS = {
  'Melee damage': { ac:10, dr:25, maxdmg:60, crits:40, accy:2, dmg:3, str:3, agi:1.5, hp:.5, dodge:3, hitMagic:5 },
  'Tank / survivability': { ac:15, dr:45, hp:1, dodge:7, hea:4, mr:3, str:2, accy:.5, maxdmg:15 },
  'Spellcaster': { mana:1, sc:9, manaRegen:7, int:5, wil:5, ac:6, dr:15, hp:.3, mr:3, alterSpellDmg:4 },
  'Backstab / thief': { bsAccy:6, bsMinDmg:10, bsMaxDmg:10, stealth:5, agi:4, crits:30, accy:2, maxdmg:40, ac:6, dr:12 },
  'Martial arts': { punchDmg:25, kickDmg:25, jumpkickDmg:25, punchSkill:12, kickSkill:12, jumpkickSkill:12,
                    punchAccy:8, kickAccy:8, jumpkickAccy:8, ac:10, dr:25, agi:3, crits:30, dodge:4 },
  'Balanced': { ac:10, dr:25, maxdmg:35, crits:20, accy:2, dmg:2, hp:.6, mana:.4, dodge:3, sc:2,
                str:2, agi:2, hea:2, int:2, wil:2, cha:1, hpRegen:2, manaRegen:2 },
};

/* ------------------------------------------------------------- formulas */

/* modMMudFunc.CalcEncum */
function calcMaxEncum(str, bonusPct) {
  if (str < 0) return 0;
  let e = str < 101 ? str * 48 : 4800 + (str - 100) * 84;
  if (bonusPct > 0) e += e * (bonusPct / 100);
  return Math.round(e);
}

/* modMMudFunc.CalcDodge */
function calcDodge(level, agi, cha, plusDodge, curEnc, maxEnc) {
  let d = Math.trunc(level / 5) + Math.trunc((cha - 50) / 5) + Math.trunc((agi - 50) / 3) + plusDodge;
  if (maxEnc > 0) {
    const pct = Math.trunc((curEnc / maxEnc) * 100);
    if (pct < 33) d += 10 - Math.trunc(pct / 10);
  }
  return Math.round(d);
}

/* modMMudFunc.CalculateAccuracy (stock MajorMUD branch) */
function calcAccuracy(cls, level, str, agi, accyWorn, plusAccy, encPct) {
  if (!accyWorn) accyWorn = 1;
  if (!encPct) encPct = 1;
  if (accyWorn < 0) accyWorn = 0;
  let a = 0;
  if (encPct < 33) a += 15 - Math.trunc(encPct / 10);
  a = Math.trunc(a / 2) * 2;                        // stock "odd number penalty"
  let base = 0;
  if (level > 0) {
    base = Math.trunc(Math.sqrt(level));
    while ((base + 1) * (base + 1) <= level) base++;
  }
  const c = clsByNum.get(cls);
  if (c) {
    const combat = c.combat + 2;
    base = base * (combat - 1);
    base = (base + combat * 2 + Math.trunc(level / 2) - 2) * 2;
  }
  a += base;
  if (str > 0) a += Math.trunc((str - 50) / 3);
  if (agi > 0) a += Math.trunc((agi - 50) / 6);
  return a + accyWorn + plusAccy;
}

/* modMMudFunc.CalcEnergyUsed -- energy spent per swing. Fewer energy per swing
 * means more attacks per round, so this is what actually decides weapon output.
 * Wielding a weapon above your Strength is allowed; it just costs more energy. */
function calcEnergyUsed(combat, level, speed, agi, str, encPct, itemStr) {
  const denom = Math.trunc((((level * (combat + 2)) + 45) * (agi + 150)) / 6);
  if (denom <= 0) return Infinity;
  let e = Math.trunc((speed * 1000) / denom);
  if (str > 0 && itemStr > 0 && str < itemStr) e = Math.trunc((((itemStr - str) * 3 + 200) * e) / 200);
  if (encPct >= 0) e = Math.trunc((e * (Math.trunc(encPct / 2) + 75)) / 100);
  return Math.max(1, e);
}

/* modMMudFunc.CalcQuickAndDeadlyBonus -- extra crit chance for swinging fast.
 * Only applies below 200 energy, is capped at 20, halved once encumbered past
 * 33%, and lost entirely past 66%. */
function calcQuickAndDeadly(agi, eu, encPct) {
  if (eu >= 200 || encPct > 66) return 0;
  let b = (200 - eu) + Math.trunc((agi - 50) / 10);
  if (b > 20) b = 20;
  if (b < 0) b = 0;
  if (encPct >= 33) b = Math.trunc(b / 2);
  return b;
}

/* Crit chance suffers diminishing returns past 40% (modMMudFunc). */
function critAfterDR(c) {
  if (c <= 40) return Math.max(0, c);
  return Math.min(99, 40 + Math.trunc((c - 40) / 3));
}

/* Scoring context -- set before each optimize run.
 * `crit` is the character's Crits stat from class, race and gear; `plusMaxDmg`
 * is the +Max Damage those same sources contribute. */
const WCTX = { combat: 0, level: 1, agi: 50, str: 50, encPct: 50, crit: 0, plusMaxDmg: 0 };

function sumAbil(abils, code) {
  return (abils || []).reduce((a, [c, v]) => a + (c === code ? v : 0), 0);
}

function weaponEnergy(it) {
  return calcEnergyUsed(WCTX.combat, WCTX.level, it.speed || 1000, WCTX.agi,
                        WCTX.str, WCTX.encPct, it.strReq || 0);
}

/* Everything about how a weapon actually performs for this character. */
function weaponProfile(it) {
  const energy = weaponEnergy(it);
  const qnd = calcQuickAndDeadly(WCTX.agi, energy, WCTX.encPct);
  const critPct = critAfterDR(WCTX.crit + qnd);
  const p = critPct / 100;

  // +Max Damage is folded into max damage BEFORE the crit multiplier
  // (modMMudFunc: nDmgMax = nDmgMax + nPlusMaxDamage), so it is amplified by it.
  const maxD = (it.max || 0) + WCTX.plusMaxDmg;
  const minD = it.min || 0;
  const normal = (minD + maxD) / 2;
  const crit = 3 * maxD;                     // a crit rolls 2x to 4x max damage
  const perSwing = (1 - p) * normal + p * crit;

  return { energy, qnd, critPct, normal, crit, perSwing,
           throughput: (perSwing * 1000) / energy };
}

function weaponThroughput(it) { return weaponProfile(it).throughput; }

function coinsToCopper(c) {
  let t = 0;
  for (const k in c) t += (c[k] || 0) * D.currencyInCopper[k];
  return t;
}
function copperToText(cp) {
  const order = [[4,'runic'],[3,'plat'],[2,'gold'],[1,'silver'],[0,'copper']];
  const out = [];
  let rem = cp;
  for (const [k, label] of order) {
    const v = D.currencyInCopper[k];
    const n = Math.floor(rem / v);
    if (n > 0) { out.push(`${n.toLocaleString()} ${label}`); rem -= n * v; }
  }
  return out.length ? out.join(', ') : '0 copper';
}
/* modMMudDatabase.GetItemValue: markup is ADDED to the base price (100% markup
 * means double), then Charm scales it -- Charm 50 is neutral, higher is cheaper. */
function buyCost(it, markup, charm) {
  let c = (it.price || 0) * D.currencyInCopper[it.cur];
  if (!c) return 0;
  if (markup > 0) c += Math.trunc(c * (markup / 100));
  if (charm > 0) c = Math.round(c * (1 - ((Math.trunc(charm / 5) - 10) / 100)));
  return Math.max(0, c);
}

/* The cheapest shop that actually stocks this item, for this character. */
function bestBuy(it) {
  const buy = activeBuy(it);
  if (!buy || !buy.length) return null;
  let best = null;
  for (const [snum, max] of buy) {
    const sh = shopByNum.get(snum);
    if (!sh) continue;
    const cost = buyCost(it, sh.markup, S.base.cha || 0);
    if (!best || cost < best.cost) best = { shop: sh, cost, max };
  }
  return best;
}

function itemCostCopper(it) {
  const b = bestBuy(it);
  return b ? b.cost : Infinity;
}

/* Price 0 is a real value in this data -- the starter kit is free. */
function priceText(cp) { return cp > 0 ? copperToText(cp) : 'free'; }

function shopLocText(sh) {
  return (sh.locs || []).map(l => (l.name ? l.name + ' ' : '') + `(${l.map}/${l.room})`).join(', ');
}

/* Native tooltip listing every shop that stocks the item, where it is, and what
 * it would cost you there. */
function shopTooltip(it) {
  const buy = activeBuy(it);
  if (!buy || !buy.length) return '';
  const charm = S.base.cha || 0;
  const rows = buy.map(([snum, max]) => {
    const sh = shopByNum.get(snum);
    if (!sh) return null;
    const where = shopLocText(sh);
    const cls = sh.classRest ? `, ${(clsByNum.get(sh.classRest) || {}).name || '?'} only` : '';
    const mk = sh.markup ? `, ${sh.markup}% markup` : '';
    return `- ${sh.name || 'Shop #' + sh.n}${where ? '  [' + where + ']' : ''}\n` +
           `    ${priceText(buyCost(it, sh.markup, charm))}${mk}, stocks ${max}`+ cls;
  }).filter(Boolean);
  if (!rows.length) return '';
  return `Sold at ${rows.length} shop${rows.length > 1 ? 's' : ''}` +
         (charm ? ` (prices include your Charm ${charm})` : '') + ':\n' + rows.join('\n');
}

/* ---------------------------------------------------------- eligibility */

function isUsable(it, opt) {
  const o = opt || {};
  if (o.requireInGame && !it.inGame) return false;
  if (it.type !== 0 && it.type !== 1) return false;
  if (it.slot == null) return false;

  if (it.minLvl && it.minLvl > S.level) return false;
  if (it.maxLvl && it.maxLvl < S.level) return false;

  const f = it.flags || {};
  if (!o.allowCursed && f.cursed) return false;
  if (!o.allowLimited && it.limit) return false;

  if (S.align !== '0') {
    if (f.alignOnly && f.alignOnly !== S.align) return false;
    if (f.alignNot && f.alignNot.includes(S.align)) return false;
  }

  if (it.raceRest && S.race && !it.raceRest.includes(S.race)) return false;

  const c = clsByNum.get(S.cls);
  if (!c) return true;

  // ClassOk (ability 59) whitelists the item and bypasses the type checks.
  const classOk = !!(it.classOk && it.classOk.includes(S.cls));

  if (!classOk && it.classRest && !it.classRest.includes(S.cls)) return false;

  // A class with AntiMagic (ability 51) cannot use magical items at all.
  if (c.abils.some(a => a[0] === 51) && f.magical) return false;

  if (classOk) return true;

  if (it.type === 0) {
    if (c.armourType < (it.atype || 0)) return false;
    // One-handed classes cannot use shields without an explicit ClassOk.
    if (it.worn === 12 && [0, 2, 4, 9].includes(c.weaponType)) return false;
  } else if (it.type === 1) {
    if (c.weaponType === 9) return D.staffExceptions.includes(it.n);
    const ok = D.classWeaponOk[c.weaponType];
    if (ok && !ok.includes(it.wtype)) return false;
  }
  return true;
}

/* -------------------------------------------------------------- scoring */

function avgDmg(it) { return it.type === 1 ? ((it.min || 0) + (it.max || 0)) / 2 : 0; }

function scoreItem(it, w) {
  let s = 0;
  for (const k in it.stats) s += (w[k] || 0) * it.stats[k];
  if (it.ns) for (const k in it.ns) s += (w[k] || 0) * it.ns[k];
  if (it.accy) s += (w.accy || 0) * it.accy;
  if (it.type === 1) s += (w.dmg || 0) * weaponThroughput(it);
  return s;
}

function totalsOf(picks) {
  const t = {}; const ns = {}; let enc = 0;
  for (const it of picks) {
    if (!it) continue;
    enc += it.enc || 0;
    for (const k in it.stats) t[k] = (t[k] || 0) + it.stats[k];
    if (it.accy) t.accy = (t.accy || 0) + it.accy;
    if (it.ns) for (const k in it.ns) ns[k] = Math.max(ns[k] || 0, it.ns[k]);
  }
  for (const k in ns) t[k] = (t[k] || 0) + ns[k];
  return { t, enc };
}

/* ------------------------------------------------------- what a set does */

/* Everything a set of gear actually produces for this character: the raw stat
 * totals plus everything derived from them. Deriving is the whole point -- a
 * heavier breastplate costs dodge and accuracy and, through quick-and-deadly,
 * crit chance and damage, none of which appears anywhere on the item's own
 * stat line. `set` is keyed by slot index, like res.picks. */
function profileOf(set, innate) {
  const worn = Object.values(set).filter(Boolean);
  const { t, enc } = totalsOf(worn);
  const str = S.base.str + (t.str || 0);
  const agi = S.base.agi + (t.agi || 0);
  const cha = S.base.cha + (t.cha || 0);
  const maxEnc = calcMaxEncum(str, t.encumPct || 0);
  const encPct = maxEnc ? Math.trunc((enc / maxEnc) * 100) : 0;

  const p = { ...t, enc, maxEnc, encPct, str, agi, cha };
  p.dodgeTotal = calcDodge(S.level, agi, cha, t.dodge || 0, enc, maxEnc);
  p.accyTotal = calcAccuracy(S.cls, S.level, str, agi, t.accy || 0, 0, Math.min(100, encPct));

  const wep = set[16];
  if (wep && wep.type === 1) {
    // weaponProfile reads the shared context, so aim that at this set first --
    // its own Strength, Agility, encumbrance, Crits and +Max Damage, not the
    // optimizer's working assumptions.
    const save = { ...WCTX };
    WCTX.str = str; WCTX.agi = agi;
    WCTX.encPct = Math.min(100, encPct);
    WCTX.crit = (innate ? innate.crit : 0) + (t.crits || 0);
    WCTX.plusMaxDmg = (innate ? innate.maxDmg : 0) + (t.maxdmg || 0);
    const wp = weaponProfile(wep);
    Object.assign(WCTX, save);
    p.weapon = wp;
    p.perSwing = wp.perSwing;
    p.critPct = wp.critPct;
    p.energy = wp.energy;
    p.dps = wp.throughput;      // damage per 1000 energy -- comparable across speeds
  }
  return p;
}

/* The recommended set with `slots` put back the way the character wears them. */
function setWith(picks, slots, source) {
  const out = { ...picks };
  for (const i of slots) { if (source[i]) out[i] = source[i]; else out[i] = null; }
  return out;
}

/* Which slots have to be judged together. A two-handed weapon empties the
 * off-hand, so scoring those two swaps separately would price a set that cannot
 * exist -- a two-hander and a shield worn at once. */
function swapGroups(res) {
  const twoH = it => !!it && (it.wtype === 1 || it.wtype === 3);
  const merge = twoH(res.picks[16]) !== twoH(S.equipped[16]) &&
                !!(S.equipped[15] || res.picks[15]);
  const groups = [];
  if (merge) groups.push([16, 15]);
  for (const s of D.slots) if (!merge || (s.i !== 16 && s.i !== 15)) groups.push([s.i]);
  return groups;
}

/* The marginal worth of one swap: the whole recommended kit, against the same
 * kit with just these slots reverted to what is worn today. Everything else is
 * held at the recommendation, so the number answers "what does changing *this*
 * buy me", not "what is this item worth in a vacuum". */
function swapImpact(res, slots, innate, base) {
  const a = base || profileOf(res.picks, innate);
  const reverted = setWith(res.picks, slots, S.equipped);
  const b = profileOf(reverted, innate);
  const rows = [];
  for (const [k, label, dp] of IMPACT_ROWS) {
    // AC and DR are stored x10 and divided on export, so the totals carry float
    // noise; round it off before it reaches a tooltip as "+6.000000000000007".
    const av = round3(a[k] || 0), bv = round3(b[k] || 0), d = round3(av - bv);
    if (Math.abs(d) < (dp ? 0.05 : 0.5)) continue;
    rows.push({ k, label, delta: d, from: bv, to: av, dp: dp || 0 });
  }
  // Putting a ring back can collide with the same ring recommended on the other
  // hand. That baseline is not wearable, so the number would be understated.
  const seen = new Set(); let dup = false;
  for (const it of Object.values(reverted)) {
    if (!it) continue;
    if (seen.has(it.n)) dup = true;
    seen.add(it.n);
  }
  return { rows, dup };
}

/* Ordered most-decisive first, so a crowded cell truncates from the bottom. */
const IMPACT_ROWS = [
  ['dps', 'DPS', 1], ['perSwing', 'Dmg/swing', 1], ['critPct', 'Crit %', 0],
  ['ac', 'AC', 0], ['dr', 'DR', 0], ['mr', 'Magic Resist', 0],
  ['dodgeTotal', 'Dodge', 0], ['accyTotal', 'Accuracy', 0],
  ['hp', 'Max HP', 0], ['mana', 'Max Mana', 0],
  ['sc', 'Spellcasting', 0], ['manaRegen', 'Mana Regen', 0], ['hpRegen', 'HP Regen', 0],
  ['maxdmg', 'Max Dmg', 0], ['crits', 'Crits', 0],
  ['bsAccy', 'BS Accuracy', 0], ['bsMinDmg', 'BS Min Dmg', 0], ['bsMaxDmg', 'BS Max Dmg', 0],
  ['stealth', 'Stealth', 0], ['perception', 'Perception', 0],
  ['str', 'Strength', 0], ['int', 'Intellect', 0], ['wil', 'Willpower', 0],
  ['agi', 'Agility', 0], ['hea', 'Health', 0], ['cha', 'Charm', 0],
  ['alterSpellDmg', 'Spell Dmg', 0], ['hitMagic', 'Hit Magic', 0],
  ['protEvil', 'Prot. Evil', 0], ['protGood', 'Prot. Good', 0],
  ['resFire', 'Resist Fire', 0], ['resCold', 'Resist Cold', 0],
  ['resLightning', 'Resist Lightning', 0], ['resStone', 'Resist Stone', 0],
  ['resWater', 'Resist Water', 0],
  ['enc', 'Encumbrance', 0],
];

const round3 = n => Math.round(n * 1000) / 1000;

/* Rows where a bigger number is the worse outcome. */
const LOWER_IS_BETTER = new Set(['enc']);

/* ------------------------------------------------------------ optimizer */

function candidatePool(mode, opt) {
  let pool;
  if (mode === 'owned') {
    const owned = new Map();
    for (const it of [...Object.values(S.equipped), ...S.carried]) owned.set(it.n, it);
    pool = [...owned.values()];
  } else if (mode === 'buyable') {
    const budget = coinsToCopper(S.coins);
    const owned = new Set([...Object.values(S.equipped), ...S.carried].map(i => i.n));
    pool = D.items.filter(i => owned.has(i.n) || itemCostCopper(i) <= budget);
  } else {
    pool = D.items;
  }
  return pool.filter(i => isUsable(i, opt));
}

function optimize(w, opt) {
  const c = clsByNum.get(S.cls);
  const race = D.races.find(r => r.n === S.race);
  WCTX.combat = c ? c.combat : 0;
  WCTX.level = S.level;
  WCTX.agi = S.base.agi || 50;
  WCTX.str = S.base.str || 50;
  WCTX.encPct = Math.min(100, opt.encTarget);   // assume we land near the target

  // Crits and +Max Damage that do not come from gear (class and race abilities).
  const innateCrit = (c ? sumAbil(c.abils, 58) : 0) + (race ? sumAbil(race.abils, 58) : 0);
  const innateMaxDmg = (c ? sumAbil(c.abils, 4) : 0) + (race ? sumAbil(race.abils, 4) : 0);

  const cands = candidatePool(opt.pool, opt);

  const run = () => {
    const buckets = {};
    for (const it of cands) (buckets[slotPool(it.slot)] ||= []).push(it);
    for (const p in buckets) buckets[p].forEach(i => { i._s = scoreItem(i, w); });
    const configs = [];
    for (const twoHanded of [false, true]) {
      const weapons = (buckets.weapon || []).filter(i => {
        const th = i.wtype === 1 || i.wtype === 3;
        return twoHanded ? th : !th;
      });
      if (!weapons.length && twoHanded) continue;
      configs.push(solve(buckets, weapons, twoHanded, opt));
    }
    if (!configs.length) configs.push(solve(buckets, [], false, opt));
    configs.sort((a, b) => b.score - a.score);
    return configs[0];
  };

  // A weapon's worth depends on the Crits and +Max Damage the rest of the kit
  // supplies, and that kit depends on the weapon. Settle it by iteration, seeded
  // from what the character is wearing now.
  const seed = totalsOf(Object.values(S.equipped)).t;
  let gearCrit = seed.crits || 0, gearMax = seed.maxdmg || 0, best = null;
  for (let pass = 0; pass < 4; pass++) {
    WCTX.crit = innateCrit + gearCrit;
    WCTX.plusMaxDmg = innateMaxDmg + gearMax;
    best = run();
    const nc = best.totals.crits || 0, nm = best.totals.maxdmg || 0;
    if (nc === gearCrit && nm === gearMax) break;
    gearCrit = nc; gearMax = nm;
  }
  // The iteration can oscillate rather than settle. Whatever it ended on, the
  // numbers we report must describe the kit we are actually recommending, so
  // re-derive the context from the chosen set before anything renders from it.
  WCTX.crit = innateCrit + (best.totals.crits || 0);
  WCTX.plusMaxDmg = innateMaxDmg + (best.totals.maxdmg || 0);
  best.innateCrit = innateCrit;
  best.innateMaxDmg = innateMaxDmg;
  best.critStat = WCTX.crit;
  best.plusMaxDmg = WCTX.plusMaxDmg;
  return best;
}

/* Drop options that another option beats on both weight and value. */
function pareto(options) {
  const sorted = options.slice().sort((a, b) => a.enc - b.enc || b.score - a.score);
  const out = [];
  let best = -Infinity;
  for (const o of sorted) if (o.score > best) { out.push(o); best = o.score; }
  return out;
}

/* Slots that share a pool (the two fingers, the two wrists) are solved as one
 * group over unordered pairs, so the same ring is never worn twice. */
function buildGroups(buckets, weapons, twoHanded) {
  const groups = [];
  const done = new Set();
  for (const s of D.slots) {
    if (done.has(s.pool)) continue;
    const slots = POOL_SLOTS[s.pool];
    let list;
    if (s.pool === 'weapon') list = weapons;
    else if (s.pool === 'offhand' && twoHanded) list = [];
    else list = buckets[s.pool] || [];
    done.add(s.pool);

    let options = [{ items: [], enc: 0, score: 0 }];
    if (slots.length === 1) {
      for (const it of list) options.push({ items: [it], enc: it.enc || 0, score: it._s });
    } else {
      // Pair candidates: the value frontier plus the top scorers is more than
      // enough to contain the optimal pair.
      const front = pareto(list.map(it => ({ it, enc: it.enc || 0, score: it._s })));
      const top = list.slice().sort((a, b) => b._s - a._s).slice(0, 30);
      const seed = [...new Set([...front.map(o => o.it), ...top])];
      for (const it of seed) options.push({ items: [it], enc: it.enc || 0, score: it._s });
      for (let i = 0; i < seed.length; i++)
        for (let j = i + 1; j < seed.length; j++)
          options.push({
            items: [seed[i], seed[j]],
            enc: (seed[i].enc || 0) + (seed[j].enc || 0),
            score: seed[i]._s + seed[j]._s,
          });
    }
    groups.push({ slots, options: pareto(options) });
  }
  return groups;
}

/* Exact multiple-choice knapsack over encumbrance. */
function knapsack(groups, budget) {
  const unit = Math.max(1, Math.ceil(budget / 3000));
  const W = Math.max(0, Math.floor(budget / unit));
  const NEG = -Infinity;
  let dp = new Float64Array(W + 1).fill(NEG);
  dp[0] = 0;
  const optAt = [], prevAt = [];

  for (let g = 0; g < groups.length; g++) {
    const ndp = new Float64Array(W + 1).fill(NEG);
    const oa = new Int32Array(W + 1).fill(-1);
    const pa = new Int32Array(W + 1).fill(-1);
    const opts = groups[g].options;
    for (let wgt = 0; wgt <= W; wgt++) {
      const base = dp[wgt];
      if (base === NEG) continue;
      for (let oi = 0; oi < opts.length; oi++) {
        const o = opts[oi];
        const w2 = wgt + Math.ceil(o.enc / unit);
        if (w2 > W) continue;
        const v = base + o.score;
        if (v > ndp[w2]) { ndp[w2] = v; oa[w2] = oi; pa[w2] = wgt; }
      }
    }
    dp = ndp; optAt.push(oa); prevAt.push(pa);
  }

  let bestW = 0, bestV = NEG;
  for (let wgt = 0; wgt <= W; wgt++) if (dp[wgt] > bestV) { bestV = dp[wgt]; bestW = wgt; }
  if (bestV === NEG) return { picks: {}, score: 0 };

  const picks = {};
  let wgt = bestW;
  for (let g = groups.length - 1; g >= 0; g--) {
    const oi = optAt[g][wgt];
    if (oi < 0) break;
    const o = groups[g].options[oi];
    o.items.forEach((it, k) => { picks[groups[g].slots[k]] = it; });
    wgt = prevAt[g][wgt];
  }
  return { picks, score: bestV };
}

function solve(buckets, weapons, twoHanded, opt) {
  const groups = buildGroups(buckets, weapons, twoHanded);

  // Gear can raise Strength, which raises the encumbrance ceiling. Iterate the
  // fixed point a few times instead of solving it analytically.
  let strBonus = 0, encBonus = 0, out = null, maxEnc = 0, budget = 0;
  for (let pass = 0; pass < 4; pass++) {
    maxEnc = calcMaxEncum(S.base.str + strBonus, encBonus);
    budget = maxEnc * (opt.encTarget / 100);
    out = knapsack(groups, budget);
    const { t } = totalsOf(Object.values(out.picks));
    const nb = t.str || 0, ne = t.encumPct || 0;
    if (nb === strBonus && ne === encBonus) break;
    strBonus = nb; encBonus = ne;
  }

  const picks = {};
  for (const s of D.slots) picks[s.i] = out.picks[s.i] || null;
  const { t, enc } = totalsOf(Object.values(picks));
  return { picks, totals: t, enc, maxEnc, budget, score: out.score, twoHanded };
}

/* ---------------------------------------------------------------- parse */

function parseChar(text) {
  const found = { fields: 0 };
  S.paste = text;          // kept with the character so a switch does not lose it
  S.unmatched = [];
  S.equipped = {}; S.carried = [];

  const lines = text.split(/\r?\n/).map(l => l.replace(/\s+$/, ''));

  /* ---- numeric stat fields -------------------------------------------- */
  const two = /(Armour Class|Hits|Mana|Encumbrance):\s*\*?\s*(-?\d+)\s*\/\s*(\d+)/gi;
  const one = /(MagicRes|Level|Spellcasting|Strength|Agility|Willpower|Charm|Intellect|Health):\s*\*?\s*(\d+)/gi;
  const word = /(Name|Race|Class):\s*([^\s:]+(?:\s[^\s:]+)?)/gi;

  let m;
  while ((m = two.exec(text))) {
    const k = m[1].toLowerCase(), a = +m[2], b = +m[3];
    found.fields++;
    if (k === 'armour class') { found.ac = a; found.dr = b; }
    else if (k === 'hits') found.hp = b;
    else if (k === 'mana') found.mana = b;
    else if (k === 'encumbrance') S.parsedEnc = [a, b];
  }
  while ((m = one.exec(text))) {
    const k = m[1].toLowerCase(), v = +m[2];
    found.fields++;
    if (k === 'level') S.level = v;
    else if (k === 'strength') S.base.str = v;
    else if (k === 'agility') S.base.agi = v;
    else if (k === 'intellect') S.base.int = v;
    else if (k === 'willpower') S.base.wil = v;
    else if (k === 'health') S.base.hea = v;
    else if (k === 'charm') S.base.cha = v;
  }
  while ((m = word.exec(text))) {
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === 'name') {
      S.name = v; found.fields++;
    } else if (k === 'class') {
      const c = D.classes.find(x => x.name.toLowerCase() === v.toLowerCase());
      if (c) { S.cls = c.n; found.fields++; }
    } else if (k === 'race') {
      const r = D.races.find(x => x.name.toLowerCase() === v.toLowerCase());
      if (r) { S.race = r.n; found.fields++; }
    }
  }

  /* ---- the inventory block --------------------------------------------
   * `inv` hard-wraps at the terminal width, so an item and its "(Head)" tag
   * routinely land on different lines. Rejoin the whole block before parsing.  */
  const STOP = /^\s*(you have\b|wealth\s*:|encumbrance\s*:|hits\s*:|name\s*:)/i;
  const START = /you are carrying|you are equipped with|you are wearing/i;
  let inv = '';
  for (let i = 0; i < lines.length; i++) {
    if (!START.test(lines[i])) continue;
    const buf = [lines[i]];
    for (let j = i + 1; j < lines.length; j++) {
      if (!lines[j].trim() || STOP.test(lines[j]) || START.test(lines[j])) break;
      buf.push(lines[j]);
    }
    inv += (inv ? ', ' : '') + buf.join(' ');   // keep blocks from merging into one entry
  }
  inv = inv.replace(/you are carrying|you are equipped with:?|you are wearing:?/gi, '')
           .replace(/\s+/g, ' ').trim();

  /* ---- coins -----------------------------------------------------------
   * A "Wealth:" line is the authoritative total; without it, fall back to the
   * coins listed inline. Never read both, or they double-count.            */
  for (const k in S.coins) S.coins[k] = 0;
  const wealth = text.match(/^[^\S\r\n]*wealth\s*:(.*)$/im);
  const coinSrc = wealth ? wealth[1] : inv;
  let sawCoin = false;
  for (const [k, re] of COIN_WORDS) {
    const mm = coinSrc.match(re);
    if (mm) { S.coins[k] = +mm[1].replace(/,/g, ''); sawCoin = true; }
  }
  if (sawCoin) found.fields++;

  /* ---- items -----------------------------------------------------------
   * Worn items carry a "(Slot)" tag; everything else is just being carried. */
  const usedPool = {};
  for (let entry of inv.split(',')) {
    entry = entry.trim().replace(/\.$/, '');
    if (!entry) continue;
    if (/^\d[\d,]*\s+(runic|platinum|plat|gold|silver|copper)/i.test(entry)) continue;

    let name = entry, loc = null;
    const tag = entry.match(/^(.*?)\s*\(([^)]*)\)$/);
    if (tag && !/^\d+$/.test(tag[2].trim())) { name = tag[1]; loc = tag[2]; }
    else if (tag) name = tag[1];                     // "(2)" is a quantity, not a slot

    const pool = loc ? LOC_TO_POOL[normLoc(loc)] : null;
    if (loc && !pool) { S.unmatched.push(entry); continue; }

    const it = resolveEntry(name);
    if (!it) { S.unmatched.push(entry); continue; }
    found.fields++;

    if (pool) {
      const slots = POOL_SLOTS[pool] || [];
      usedPool[pool] = usedPool[pool] || 0;
      const slot = slots[Math.min(usedPool[pool], slots.length - 1)];
      usedPool[pool]++;
      S.equipped[slot] = it;
      if (loc && normLoc(loc) === 'TWOHANDED') S.currentTwoHanded = true;
    } else {
      S.carried.push(it);
    }
  }

  /* Without a `stat` paste there is no Strength, but max encumbrance implies
   * it (Str x 48 below 100). Better than leaving the budget at zero.        */
  if (!S.base.str && S.parsedEnc && S.parsedEnc[1]) {
    const mx = S.parsedEnc[1];
    S.base.str = mx <= 4800 ? Math.round(mx / 48) : Math.round((mx - 4800) / 84) + 100;
    found.strFromEncum = S.base.str;
  }
  return found;
}

/* An entry may be a single item, or two joined by "and" ("club and dagger").
 * Try the whole string first — some real item names contain "and". */
function resolveEntry(raw) {
  const whole = lookupItem(raw);
  if (whole) return whole;
  if (/\sand\s/i.test(raw)) {
    for (const part of raw.split(/\sand\s/i)) {
      const it = lookupItem(part);
      if (it) return it;
    }
  }
  return null;
}

/* Item names arrive with articles, quantities and stray spacing. */
function lookupItem(raw) {
  let s = String(raw).toLowerCase().trim().replace(/\s+/g, ' ');
  s = s.replace(/^(?:a|an|the|some)\s+/, '').replace(/\s*\(\d+\)$/, '');
  if (byName.has(s)) return byName.get(s);
  const squash = x => x.replace(/[^a-z0-9]/g, '');
  return bySquashed.get(squash(s)) || null;
}

/* --------------------------------------------------------------- render */

const $ = s => document.querySelector(s);
const el = (t, c, txt) => { const e = document.createElement(t); if (c) e.className = c; if (txt != null) e.textContent = txt; return e; };

function fmt(n) {
  if (n == null) return '—';
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}
function delta(cur, next) {
  const d = (next || 0) - (cur || 0);
  if (Math.abs(d) < .05) return el('span', 'd flat', '');
  return el('span', 'd ' + (d > 0 ? 'up' : 'down'), (d > 0 ? '+' : '') + fmt(d));
}

function initForm() {
  const cs = $('#f-class'), rs = $('#f-race');
  cs.innerHTML = '<option value="0">— pick a class —</option>';
  for (const c of D.classes) cs.append(new Option(`${c.name}  (${D.classWeaponNames[c.weaponType]}, ${D.armourTypes[c.armourType]})`, c.n));
  rs.innerHTML = '<option value="0">— pick a race —</option>';
  for (const r of D.races) rs.append(new Option(r.name, r.n));

  const p = $('#preset');
  for (const k in PRESETS) p.append(new Option(k, k));
  p.value = 'Balanced';
  S.weights = { ...PRESETS['Balanced'] };

  const qs = $('#q-slot');
  const seen = new Set();
  for (const s of D.slots) {
    if (seen.has(s.pool)) continue;
    seen.add(s.pool);
    qs.append(new Option(s.name.replace(/ \d$/, ''), s.pool));
  }
  $('#dbmeta').textContent =
    `${D.meta.source} · dat ${D.meta.datVersion} · nmr ${D.meta.nmrVersion} · ${D.meta.itemCount.toLocaleString()} items`;
  $('#srcfile').textContent = D.meta.source;
}

function syncFormFromState() {
  $('#f-name').value = S.name;
  $('#f-class').value = S.cls; $('#f-race').value = S.race;
  $('#f-level').value = S.level; $('#f-align').value = S.align;
  for (const k in S.base) $('#s-' + k).value = S.base[k];
  for (const k in S.coins) $('#c-' + k).value = S.coins[k];
  $('#paste').value = S.paste;
  $('#preset').value = S.preset;
  renderWeights();
  renderPurse();
  renderEquipped();
}

function renderRoster() {
  const sel = $('#char-sel');
  if (!sel) return;
  sel.innerHTML = '';
  for (const c of roster.chars) sel.append(new Option(charLabel(c), c.id));
  sel.value = roster.active;
  $('#char-del').textContent = roster.chars.length > 1 ? 'Delete' : 'Clear';
}

/* Everything the active character owns, put on screen at once. */
function showActiveChar() {
  syncFormFromState();
  renderRoster();
  $('#parse-status').textContent = '';
  renderResults(null);
}
function syncStateFromForm() {
  S.name = $('#f-name').value.trim();
  S.cls = +$('#f-class').value; S.race = +$('#f-race').value;
  S.level = +$('#f-level').value || 1; S.align = $('#f-align').value;
  for (const k in S.base) S.base[k] = +$('#s-' + k).value || 0;
  for (const k in S.coins) S.coins[k] = +$('#c-' + k).value || 0;
  renderPurse();
  touch();
  renderRoster();      // the tab label follows the name field as it is typed
}
function renderPurse() {
  const cp = coinsToCopper(S.coins);
  $('#purse-total').textContent = cp ? `= ${cp.toLocaleString()} copper (${copperToText(cp)})` : '';
}

function renderEquipped() {
  const box = $('#eqlist'); box.innerHTML = '';
  const entries = D.slots.filter(s => S.equipped[s.i]);
  for (const s of entries) {
    const it = S.equipped[s.i];
    const r = el('div', 'eqrow');
    r.append(el('span', 'nm', it.name), el('span', 'loc', s.name));
    box.append(r);
  }
  for (const u of S.unmatched) {
    const r = el('div', 'eqrow unknown');
    r.append(el('span', 'nm', u), el('span', 'loc', 'not in db'));
    box.append(r);
  }
  $('#eq-count').textContent = entries.length ? `(${entries.length})` : '';

  const cb = $('#carrylist'); cb.innerHTML = '';
  for (const it of S.carried) {
    const r = el('div', 'eqrow');
    r.append(el('span', 'nm', it.name), el('span', 'loc', SLOT.get(it.slot) ? SLOT.get(it.slot).name : D.itemTypes[it.type]));
    cb.append(r);
  }
  $('#carry-count').textContent = S.carried.length ? `(${S.carried.length})` : '';
}

function renderWeights() {
  const g = $('#weight-grid'); g.innerHTML = '';
  const keys = Object.keys(D.statLabels).concat(['dmg']).sort();
  for (const k of keys) {
    const lab = el('label', null, k === 'dmg' ? 'Weapon damage' : D.statLabels[k]);
    const inp = el('input'); inp.type = 'number'; inp.step = '0.5'; inp.value = S.weights[k] || 0;
    inp.addEventListener('input', () => { S.weights[k] = +inp.value || 0; touch(); });
    lab.append(inp); g.append(lab);
  }
}

function renderShopFilter() {
  const box = $('#shop-groups');
  if (!box) return;
  box.innerHTML = '';

  const groups = new Map();
  for (const sh of D.shops) (groups.get(shopMap(sh)) || groups.set(shopMap(sh), []).get(shopMap(sh))).push(sh);

  const ordered = [...groups.keys()].sort((a, b) => {
    const ma = mapByNum.get(a), mb = mapByNum.get(b);
    const ta = ma ? TIER_ORDER.indexOf(ma.tier) : 9, tb = mb ? TIER_ORDER.indexOf(mb.tier) : 9;
    return ta - tb || (ma ? ma.medExp : 0) - (mb ? mb.medExp : 0) || a - b;
  });

  for (const mp of ordered) {
    const list = groups.get(mp).slice().sort((x, y) => (x.name || '').localeCompare(y.name || ''));
    const info = mapByNum.get(mp);
    const grp = el('div', 'shopgrp');

    const hdr = el('div', 'shophdr');
    const cb = el('input'); cb.type = 'checkbox';
    const on = list.filter(sh => enabledShops.has(sh.n)).length;
    cb.checked = on === list.length;
    cb.indeterminate = on > 0 && on < list.length;
    cb.addEventListener('change', () => {
      for (const sh of list) cb.checked ? enabledShops.add(sh.n) : enabledShops.delete(sh.n);
      saveShops(); renderShopFilter();
    });
    const lab = el('label'); lab.append(cb, el('span', null, `Map ${mp}`));
    hdr.append(lab);
    if (info) {
      hdr.append(el('span', 'tier ' + info.tier, info.tier));
      hdr.append(el('span', 'meta',
        `${list.length} shop${list.length > 1 ? 's' : ''} · local monsters ~${info.medExp.toLocaleString()} exp`));
    }
    grp.append(hdr);

    const ul = el('div', 'shoplist');
    for (const sh of list) {
      const l = el('label');
      const c = el('input'); c.type = 'checkbox'; c.checked = enabledShops.has(sh.n);
      c.addEventListener('change', () => {
        c.checked ? enabledShops.add(sh.n) : enabledShops.delete(sh.n);
        saveShops(); renderShopFilter();
      });
      l.append(c, el('span', null, sh.name || 'Shop #' + sh.n));
      const where = shopLocText(sh);
      if (where) l.append(el('span', 'where', where));
      ul.append(l);
    }
    grp.append(ul);
    box.append(grp);
  }

  const sum = $('#shop-summary');
  if (sum) {
    sum.textContent = enabledShops.size === D.shops.length
      ? `all ${D.shops.length}`
      : `${enabledShops.size} of ${D.shops.length}`;
  }
}

const SUMMARY_KEYS = ['ac','dr','maxdmg','accy','crits','dodge','hp','mana','sc','bsAccy','stealth','hpRegen','manaRegen','mr'];

function renderResults(res) {
  const box = $('#results'); box.innerHTML = '';
  if (!res) { box.append(el('div', 'empty', 'Set a class and level, then hit Optimize.')); return; }

  const innate = { crit: res.innateCrit || 0, maxDmg: res.innateMaxDmg || 0 };
  const now = profileOf(S.equipped, innate);    // what the character wears today
  const then = profileOf(res.picks, innate);    // what the recommendation gives

  // Every weapon number on this page describes the recommended kit, so aim the
  // shared context at that kit rather than at the optimizer's working
  // assumption that encumbrance lands exactly on the target.
  WCTX.str = then.str; WCTX.agi = then.agi;
  WCTX.encPct = Math.min(100, then.encPct);
  WCTX.crit = innate.crit + (then.crits || 0);
  WCTX.plusMaxDmg = innate.maxDmg + (then.maxdmg || 0);

  const cur = totalsOf(Object.values(S.equipped));

  // headline numbers
  const sum = el('div', 'summary');
  const addCell = (k, v, d) => {
    const c = el('div', 'stat-cell');
    c.append(el('div', 'k', k));
    const val = el('div', 'v'); val.textContent = v;
    if (d) val.append(d);
    c.append(val); sum.append(c); return c;
  };
  for (const k of SUMMARY_KEYS) {
    const nv = res.totals[k] || 0, cv = cur.t[k] || 0;
    if (!nv && !cv) continue;
    addCell(D.statLabels[k] || k, fmt(nv), delta(cv, nv));
  }
  // derived character numbers
  const encPct = then.encPct;
  addCell('Dodge (total)', then.dodgeTotal, delta(now.dodgeTotal, then.dodgeTotal));
  addCell('Accuracy (total)', then.accyTotal, delta(now.accyTotal, then.accyTotal));

  const wep = res.picks[16];
  if (wep) {
    // `now` carries the character's real current numbers -- their own weapon
    // under their own encumbrance and crits -- so these deltas are what the
    // whole recommendation is worth, not just the weapon swap.
    const armed = now.weapon != null;
    addCell('Crit chance', then.critPct + '%', armed ? delta(now.critPct, then.critPct) : null);
    addCell('Dmg / swing', then.perSwing.toFixed(1), armed ? delta(now.perSwing, then.perSwing) : null);
    addCell('DPS (per 1000 energy)', then.dps.toFixed(1), armed ? delta(now.dps, then.dps) : null);
    const cell = addCell('Crit hits for', `${(2 * (wep.max + res.plusMaxDmg))}-${(4 * (wep.max + res.plusMaxDmg))}`);
    cell.append(el('div', 'k', res.plusMaxDmg
      ? `2-4x max dmg, incl. your +${res.plusMaxDmg} max`
      : '2-4x the weapon max'));
  }

  const encCell = addCell('Encumbrance', `${res.enc.toLocaleString()} / ${res.maxEnc.toLocaleString()}`);
  const bar = el('div', 'encbar' + (encPct >= 100 ? ' over' : encPct >= 33 ? ' warn' : ''));
  const fill = el('span'); fill.style.width = Math.min(100, encPct) + '%';
  bar.append(fill); encCell.append(bar);
  encCell.append(el('div', 'k', encPct + '% — ' + (encPct < 33 ? 'under 33%, bonus kept' : 'over 33%, bonus lost')));
  box.append(sum);

  // per-slot table
  const wrap = el('div', 'tablewrap');
  const tbl = el('table');
  tbl.innerHTML = '<thead><tr><th>Slot</th><th>Currently</th><th>Recommended</th>' +
    '<th title="Everything the whole set changes if you make this one swap, ' +
    'including knock-on effects like encumbrance costing you dodge and crit chance.">' +
    'Impact of this swap</th><th class="num">Enc</th><th>What it gives</th>' +
    '<th class="num">Cost</th></tr></thead>';
  const tb = el('tbody');

  /* One impact figure per swap, worked out once and hung on the row that owns
   * the decision -- the weapon, when a two-hander is what empties the off-hand. */
  const same = (a, b) => (a ? a.n : 0) === (b ? b.n : 0);
  const impacts = new Map(), leadOf = new Map();
  for (const g of swapGroups(res)) {
    const lead = g.includes(16) ? 16 : g[0];
    for (const i of g) leadOf.set(i, lead);
    if (g.every(i => same(res.picks[i], S.equipped[i]))) continue;
    impacts.set(lead, swapImpact(res, g, innate, then));
  }

  for (const s of D.slots) {
    const nw = res.picks[s.i], od = S.equipped[s.i];
    if (!nw && !od) continue;
    const tr = el('tr');
    tr.append(el('td', 'slotname', s.name));
    tr.append(el('td', 'cur', od ? od.name : '—'));

    const tdNew = el('td');
    const changed = (nw && od) ? nw.n !== od.n : !!nw !== !!od;
    const nameEl = el('div', 'pick' + (changed ? ' changed' : ''), nw ? nw.name : '— leave empty —');
    if (nw) {
      const tip = shopTooltip(nw);           // empty once every stocking shop is switched off
      if (tip) { nameEl.title = tip; nameEl.classList.add('has-shop'); }
    }
    tdNew.append(nameEl);
    if (nw) {
      const tags = el('div', 'tags');
      if (nw.flags && nw.flags.magical) tags.append(el('span', 'tag mag', 'magical'));
      if (nw.limit) tags.append(el('span', 'tag lim', 'limited ' + nw.limit));
      if (nw.flags && nw.flags.cursed) tags.append(el('span', 'tag curse', 'cursed'));
      if (nw.strReq > (S.base.str || 0)) tags.append(el('span', 'tag lim', `needs Str ${nw.strReq}`));
      if (isOwned(nw)) tags.append(el('span', 'tag own', 'you have it'));
      else {
        const ab = activeBuy(nw);
        if (ab && ab.length) tags.append(el('span', 'tag buy', `in ${ab.length} shop${ab.length > 1 ? 's' : ''}`));
      }
      if (tags.children.length) tdNew.append(tags);
    }
    tr.append(tdNew);
    tr.append(impactCell(s.i, impacts, leadOf, changed));
    tr.append(el('td', 'num', nw ? (nw.enc || 0).toLocaleString() : '—'));

    const bits = [];
    if (nw) {
      if (nw.type === 1) {
        const wp = weaponProfile(nw);
        bits.push(`dmg ${nw.min}-${nw.max}`, D.weaponTypes[nw.wtype], `energy ${wp.energy}`);
        bits.push(`crit ${wp.critPct}%` + (wp.qnd ? ` (incl. +${wp.qnd} quick & deadly)` : ''));
        bits.push(`~${wp.perSwing.toFixed(1)}/swing`);
      }
      for (const k in nw.stats) if (nw.stats[k]) bits.push(`${D.statLabels[k] || k} ${nw.stats[k] > 0 ? '+' : ''}${fmt(nw.stats[k])}`);
      if (nw.ns) for (const k in nw.ns) bits.push(`${D.statLabels[k] || k} +${nw.ns[k]}*`);
      if (nw.accy) bits.push(`to-hit ${nw.accy > 0 ? '+' : ''}${nw.accy}`);
    }
    tr.append(el('td', 'bonus', bits.join(' · ')));

    const td$ = el('td', 'num');
    const bb = nw && !isOwned(nw) ? bestBuy(nw) : null;
    if (bb) { td$.textContent = priceText(bb.cost); td$.title = shopTooltip(nw); }
    else td$.textContent = nw && !isOwned(nw) ? 'drop only' : '—';
    tr.append(td$);
    tb.append(tr);
  }
  tbl.append(tb); wrap.append(tbl); box.append(wrap);

  const legend = el('div', 'hint legend');
  legend.textContent =
    'Impact is measured against the whole recommendation with only that slot put back ' +
    'the way you wear it now, so it answers "what does changing this one thing buy me". ' +
    'The column does not add up to the totals above: gear interacts, and weight taken off ' +
    'one slot pays for itself somewhere else.';
  box.append(legend);

  const buys = D.slots.map(s => res.picks[s.i]).filter(i => i && !isOwned(i) && bestBuy(i));
  if (buys.length) {
    const cost = buys.reduce((a, i) => a + bestBuy(i).cost, 0);
    const have = coinsToCopper(S.coins);
    const note = el('div', 'warn');
    note.textContent = `${buys.length} recommended item(s) are sold in shops — about ${priceText(cost)} total. ` +
      (have ? (cost <= have ? `You can afford that (you have ${copperToText(have)}).`
                            : `You have ${copperToText(have)}, so you are short ${copperToText(cost - have)}.`) : '');
    box.append(note);
  }
}

/* The cell that answers "what does this swap actually change". */
function impactCell(slot, impacts, leadOf, changed) {
  const td = el('td', 'impact');
  const lead = leadOf.get(slot);

  if (lead !== slot) {
    if (impacts.has(lead)) {
      const n = el('div', 'imp-note', 'counted with the weapon swap');
      n.title = 'A two-handed weapon empties this slot, so the two changes are ' +
                'only meaningful together and are scored on the weapon row.';
      td.append(n);
    } else td.append(el('span', 'imp-none', '—'));
    return td;
  }

  const imp = impacts.get(slot);
  if (!imp) {
    td.append(el('span', 'imp-none', changed ? '—' : 'no change'));
    return td;
  }
  if (!imp.rows.length) {
    const n = el('span', 'imp-none', 'no net effect');
    n.title = 'A different item, but nothing this character can measure changes.';
    td.append(n);
    return td;
  }

  for (const r of imp.rows.slice(0, 6)) {
    const good = LOWER_IS_BETTER.has(r.k) ? r.delta < 0 : r.delta > 0;
    const chip = el('span', 'imp ' + (good ? 'up' : 'down'));
    const n = r.dp ? Math.abs(r.delta).toFixed(r.dp) : Math.round(Math.abs(r.delta)).toLocaleString();
    chip.textContent = `${r.label} ${r.delta > 0 ? '+' : '−'}${n}`;
    chip.title = `${r.label}: ${fmt(r.from)} → ${fmt(r.to)} if you make this swap`;
    td.append(chip);
  }
  if (imp.rows.length > 6) {
    const more = el('span', 'imp-none', `+${imp.rows.length - 6} more`);
    more.title = imp.rows.slice(6)
      .map(r => `${r.label} ${r.delta > 0 ? '+' : '−'}${r.dp ? Math.abs(r.delta).toFixed(r.dp) : Math.round(Math.abs(r.delta))}`)
      .join('\n');
    td.append(more);
  }
  if (imp.dup) {
    const w = el('span', 'imp-none', '*');
    w.title = 'Your current item for this slot is also recommended for the ' +
              'matching slot on the other side, so this comparison assumes you ' +
              'could wear two of it. Treat the numbers as a lower bound.';
    td.append(w);
  }
  return td;
}

function isOwned(it) {
  if (!it) return false;
  for (const k in S.equipped) if (S.equipped[k].n === it.n) return true;
  return S.carried.some(c => c.n === it.n);
}

function renderBrowse() {
  const q = $('#q').value.trim().toLowerCase();
  const pool = $('#q-slot').value;
  const sort = $('#q-sort').value;
  const onlyUsable = $('#q-usable').checked;
  const opt = { requireInGame: $('#opt-ingame').checked, allowLimited: true, allowCursed: true };

  let list = D.items.filter(i => (i.type === 0 || i.type === 1) && i.slot != null);
  if (q) list = list.filter(i => i.name.toLowerCase().includes(q));
  if (pool) list = list.filter(i => slotPool(i.slot) === pool);
  if (onlyUsable && S.cls) list = list.filter(i => isUsable(i, opt));

  const w = S.weights;
  const key = {
    name: i => i.name, ac: i => -(i.stats.ac || 0), dr: i => -(i.stats.dr || 0),
    dmg: i => -avgDmg(i), enc: i => i.enc, score: i => -scoreItem(i, w),
  }[sort];
  list = list.slice().sort((a, b) => { const x = key(a), y = key(b); return x < y ? -1 : x > y ? 1 : 0; });

  const box = $('#browse'); box.innerHTML = '';
  if (!list.length) { box.append(el('div', 'empty', 'No items match.')); return; }

  const wrap = el('div', 'tablewrap');
  const tbl = el('table');
  tbl.innerHTML = '<thead><tr><th>Item</th><th>Slot</th><th class="num">AC</th><th class="num">DR</th>' +
    '<th class="num">Dmg</th><th class="num">Enc</th><th class="num">Score</th><th>Notes</th></tr></thead>';
  const tb = el('tbody');
  for (const i of list.slice(0, 500)) {
    const tr = el('tr');
    tr.append(el('td', null, i.name));
    tr.append(el('td', 'slotname', SLOT.get(i.slot).name.replace(/ \d$/, '')));
    tr.append(el('td', 'num', fmt(i.stats.ac || 0)));
    tr.append(el('td', 'num', fmt(i.stats.dr || 0)));
    tr.append(el('td', 'num', i.type === 1 ? `${i.min}-${i.max}` : '—'));
    tr.append(el('td', 'num', (i.enc || 0).toLocaleString()));
    tr.append(el('td', 'num', fmt(scoreItem(i, w))));
    const notes = [];
    if (i.limit) notes.push('limited ' + i.limit);
    if (i.minLvl) notes.push('lvl ' + i.minLvl + '+');
    if (i.flags && i.flags.alignOnly) notes.push(i.flags.alignOnly + ' only');
    const bb = bestBuy(i);
    if (bb) {
      const k = activeBuy(i).length;
      notes.push(`${k} shop${k > 1 ? 's' : ''}, from ${priceText(bb.cost)}`);
    }
    else if (i.from) notes.push(i.from.slice(0, 48));
    const tdN = el('td', 'bonus', notes.join(' · '));
    if (bb) { tdN.title = shopTooltip(i); tdN.classList.add('has-shop'); }
    tr.append(tdN);
    tb.append(tr);
  }
  tbl.append(tb); wrap.append(tbl); box.append(wrap);
  if (list.length > 500) box.append(el('div', 'empty', `showing first 500 of ${list.length}`));
}

/* ----------------------------------------------------------------- wire */

function runOptimize() {
  syncStateFromForm();
  const warn = $('#opt-warn'); warn.innerHTML = '';
  if (!S.cls) {
    warn.append(el('div', 'warn', 'Pick a class first — class decides which armour and weapons you can even wear.'));
    renderResults(null); return;
  }
  const msgs = [];
  if (S.align === '0') msgs.push('Alignment is unset, so good/evil-restricted items are all being allowed.');
  if (!S.base.str) msgs.push('Strength is 0, so the encumbrance budget is 0 — set your stats for a usable result.');
  if (msgs.length) warn.append(el('div', 'warn', msgs.join(' ')));

  const opt = {
    pool: $('#pool').value,
    encTarget: +$('#enctarget').value,
    allowLimited: $('#opt-limited').checked,
    allowCursed: $('#opt-cursed').checked,
    requireInGame: $('#opt-ingame').checked,
  };
  S.result = optimize(S.weights, opt);
  renderResults(S.result);
}

function init() {
  initForm();
  renderShopFilter();
  loadRoster();
  showActiveChar();

  $('#tabs').addEventListener('click', e => {
    const b = e.target.closest('.tab'); if (!b) return;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('is-active', t === b));
    document.querySelectorAll('.panel').forEach(p => p.classList.toggle('is-active', p.id === 'tab-' + b.dataset.tab));
    if (b.dataset.tab === 'browse') renderBrowse();
  });

  $('#paste').addEventListener('input', () => { S.paste = $('#paste').value; touch(); });
  $('#f-name').addEventListener('input', syncStateFromForm);

  $('#btn-parse').addEventListener('click', () => {
    const txt = $('#paste').value;
    const st = $('#parse-status');
    if (!txt.trim()) { st.className = 'parse-status err'; st.textContent = 'Nothing to parse.'; return; }
    const r = parseChar(txt);
    touch();
    syncFormFromState();
    renderRoster();
    st.className = 'parse-status ' + (r.fields ? 'ok' : 'err');
    const eq = Object.keys(S.equipped).length;
    st.textContent = r.fields
      ? `Read ${r.fields} field(s): ${eq} equipped, ${S.carried.length} carried` +
        (S.unmatched.length ? `, ${S.unmatched.length} unrecognised` : '') +
        (r.strFromEncum ? ` · Strength ${r.strFromEncum} inferred from encumbrance` : '') +
        (!S.cls ? ' · set your class below' : '')
      : 'Could not find anything recognisable — paste the raw stat/inv output.';
  });

  $('#btn-clear').addEventListener('click', () => {
    $('#paste').value = ''; $('#parse-status').textContent = '';
    S.paste = ''; S.equipped = {}; S.carried = []; S.unmatched = [];
    touch(); renderEquipped();
  });

  /* ---- roster ---- */
  $('#char-sel').addEventListener('change', e => {
    if (switchChar(e.target.value)) showActiveChar();
    else e.target.value = roster.active;
  });
  $('#char-new').addEventListener('click', () => { newChar(); showActiveChar(); $('#f-name').focus(); });
  $('#char-copy').addEventListener('click', () => { duplicateChar(roster.active); showActiveChar(); });
  $('#char-del').addEventListener('click', () => {
    const c = activeChar();
    if (!c) return;
    const used = c.snap && (c.snap.cls || c.snap.carried.length || Object.keys(c.snap.equipped).length);
    const verb = roster.chars.length > 1 ? 'Delete' : 'Clear';
    if (used && !confirm(`${verb} ${charLabel(c)}? This cannot be undone.`)) return;
    deleteChar(c.id);
    showActiveChar();
  });

  ['f-class','f-race','f-level','f-align'].forEach(id => $('#' + id).addEventListener('change', syncStateFromForm));
  Object.keys(S.base).forEach(k => $('#s-' + k).addEventListener('input', syncStateFromForm));
  Object.keys(S.coins).forEach(k => $('#c-' + k).addEventListener('input', syncStateFromForm));

  $('#preset').addEventListener('change', e => {
    S.preset = e.target.value; S.weights = { ...PRESETS[S.preset] }; renderWeights(); touch();
  });
  $('#btn-reset-w').addEventListener('click', () => {
    S.weights = { ...PRESETS[S.preset] }; renderWeights(); touch();
  });
  $('#btn-opt').addEventListener('click', runOptimize);

  const setShops = pred => {
    enabledShops = new Set(D.shops.filter(pred).map(sh => sh.n));
    saveShops(); renderShopFilter();
  };
  $('#shop-all').addEventListener('click', () => setShops(() => true));
  $('#shop-none').addEventListener('click', () => setShops(() => false));
  $('#shop-starter').addEventListener('click', () => setShops(sh => {
    const m = mapByNum.get(shopMap(sh));
    return m && (m.tier === 'starter' || m.tier === 'low');
  }));

  ['q','q-slot','q-sort','q-usable'].forEach(id => $('#' + id).addEventListener('input', renderBrowse));

  renderResults(null);
}

document.addEventListener('DOMContentLoaded', init);
