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
  sc: 0,               // Spellcasting, straight off the stat block if pasted
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
const spellByNum = new Map((D.spells || []).map(sp => [sp.n, sp]));
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
    name: '', cls: 0, race: 0, level: 1, align: '0', sc: 0,
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
    name: S.name, cls: S.cls, race: S.race, level: S.level, align: S.align, sc: S.sc,
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
  S.sc = +s.sc || 0;
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
  // Crits and Max Dmg carry no flat weight in the presets that swing a weapon:
  // the damage model prices them, and a flat weight on top would pay twice. They
  // are kept in the martial-arts preset, whose damage this tool does not model.
  'Melee damage': { ac:10, dr:25, accy:2, dmg:12, str:3, agi:1.5, hp:.5, dodge:3, hitMagic:5 },
  'Tank / survivability': { ac:15, dr:45, hp:1, dodge:7, hea:4, mr:3, str:2, accy:.5, dmg:3 },
  'Spellcaster': { mana:1, sc:9, manaRegen:7, int:5, wil:5, ac:6, dr:15, hp:.3, mr:3, alterSpellDmg:4 },
  'Backstab / thief': { bsAccy:6, bsMinDmg:10, bsMaxDmg:10, stealth:5, agi:4, accy:2, dmg:9, ac:6, dr:12 },
  'Martial arts': { punchDmg:25, kickDmg:25, jumpkickDmg:25, punchSkill:12, kickSkill:12, jumpkickSkill:12,
                    punchAccy:8, kickAccy:8, jumpkickAccy:8, ac:10, dr:25, agi:3, crits:30, maxdmg:30, dodge:4 },
  'Balanced': { ac:10, dr:25, accy:2, dmg:8, hp:.6, mana:.4, dodge:3, sc:2,
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
const WCTX = { combat: 0, level: 1, agi: 50, str: 50, encPct: 50, crit: 0, plusMaxDmg: 0,
               refWeapon: null, margins: { crit: 0, maxdmg: 0 } };

/* Stats that reach the score through the damage model rather than on their own.
 * Scoring them flatly as well would pay for the same point twice: +2 Crits on a
 * ring would earn its flat weight AND raise the weapon's damage per round on the
 * next pass of the fixed point. They keep their flat weight only when there is
 * no weapon for the model to work with -- a bare-handed martial artist, say. */
const DAMAGE_MODELLED = new Set(['crits', 'maxdmg']);

/* What one more point of Crits, or of +Max Damage, is worth in damage per round
 * to the weapon this pass is assuming. Both are exactly linear in the swing
 * maths, so a single marginal rate values them correctly wherever they are worn. */
function damageMargins() {
  const wep = WCTX.refWeapon;
  if (!wep || wep.type !== 1) return { crit: 0, maxdmg: 0 };
  const p = weaponProfile(wep);
  const perRoundSwings = p.swings / fightRounds;

  const maxD = (wep.max || 0) + WCTX.plusMaxDmg;
  const normal = ((wep.min || 0) + maxD) / 2;
  const crit = 3 * maxD;
  const pc = p.critPct / 100;

  // critAfterDR is piecewise: one for one up to 40, a third of that above it,
  // and nothing at all once the 99 cap is reached.
  const raw = WCTX.crit + p.qnd;
  const slope = p.critPct >= 99 ? 0 : (raw < 40 ? 1 : 1 / 3);

  return {
    crit: perRoundSwings * ((crit - normal) / 100) * slope,
    // +Max Damage lifts the normal roll by half a point and the crit by three,
    // because a crit rolls 2x to 4x the max.
    maxdmg: perRoundSwings * ((1 - pc) * 0.5 + 3 * pc),
  };
}

function sumAbil(abils, code) {
  return (abils || []).reduce((a, [c, v]) => a + (c === code ? v : 0), 0);
}

function weaponEnergy(it) {
  return calcEnergyUsed(WCTX.combat, WCTX.level, it.speed || 1000, WCTX.agi,
                        WCTX.str, WCTX.encPct, it.strReq || 0);
}

/* Combat is fought in rounds. Each round you are handed 1000 energy on top of
 * whatever was left over, and you swing as many times as that pays for -- so a
 * weapon worth "2.5 swings" really lands 2, 3, 2, 3, not two and a half every
 * round. The original Pascal is quoted in MME's frmSwingCalc:
 *
 *     Temp := 1000;
 *     repeat
 *       I    := Temp div EU;
 *       Temp := (Temp mod EU) + 1000;
 *       If (I > MAX_SWINGS) Then I := MAX_SWINGS;
 *     until False
 *
 * Note the order: the carry is taken from the uncapped division, so a very fast
 * weapon still burns all its energy but only ever lands five swings. */
const ENERGY_PER_ROUND = 1000;
const MAX_SWINGS = 5;               // modMMudFunc.MAX_SWINGS
/* Most fights are over quickly, so a weapon is judged on the opening rounds
 * rather than on a rate it would only reach in a long one. Five is the default
 * because that is about how long a fight lasts; the Optimize tab can change it. */
const FIGHT_ROUNDS_DEFAULT = 5;
let fightRounds = FIGHT_ROUNDS_DEFAULT;

function swingSchedule(energy, rounds) {
  const eu = Math.max(1, Math.trunc(energy));
  const out = [];
  let temp = ENERGY_PER_ROUND;
  for (let r = 0; r < (rounds || fightRounds); r++) {
    let n = Math.trunc(temp / eu);
    temp = (temp % eu) + ENERGY_PER_ROUND;
    out.push(Math.min(MAX_SWINGS, n));
  }
  return out;
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

  // What you actually get in a short fight, round by round.
  const schedule = swingSchedule(energy, fightRounds);
  const swings = schedule.reduce((a, b) => a + b, 0);
  const fightDamage = swings * perSwing;

  return { energy, qnd, critPct, normal, crit, perSwing,
           schedule, swings, fightDamage,
           perRound: fightDamage / fightRounds,
           // The continuous rate MME reports, kept for comparison. It is what
           // the weapon would do if fractional swings were real; over five
           // rounds they are not.
           throughput: Math.min(MAX_SWINGS, 1000 / energy) * perSwing };
}

function weaponThroughput(it) { return weaponProfile(it).perRound; }

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

/* ------------------------------------------------------------ monster drops */
/* A lot of the best gear is never sold anywhere -- you take it off something.
 * Monsters.DropItem-0..9 is the drop table, DropItem%-N the chance. */

const monByNum = new Map((D.monsters || []).map(m => [m.n, m]));

/* The drop worth hunting: the highest chance, and among equal chances the
 * weakest monster carrying it. */
function bestDrop(it) {
  if (!it || !it.drop || !it.drop.length) return null;
  let best = null;
  for (const [mnum, pct] of it.drop) {
    const m = monByNum.get(mnum);
    if (!m) continue;
    if (!best || pct > best.pct || (pct === best.pct && m.exp < best.mon.exp)) {
      best = { mon: m, pct };
    }
  }
  return best;
}

function monLocText(m) {
  if (!m.maps || !m.maps.length) return '';
  const named = m.maps.map(n => {
    const mp = mapByNum.get(n);
    return mp ? `map ${n} (${mp.tier})` : `map ${n}`;
  });
  return named.join(', ') + (m.room ? ` — ${m.room}` : '');
}

function dropTooltip(it) {
  if (!it || !it.drop || !it.drop.length) return '';
  const rows = it.drop.map(([mnum, pct]) => {
    const m = monByNum.get(mnum);
    if (!m) return null;
    const where = monLocText(m);
    return `- ${m.name || 'Monster #' + m.n} (${pct}%)` +
           (m.exp ? `, ${m.exp.toLocaleString()} exp` : '') +
           (m.hp ? `, ${m.hp.toLocaleString()} hp` : '') +
           (m.inGame ? '' : ', not in game') +
           (where ? `\n    ${where}` : '\n    location unknown');
  }).filter(Boolean);
  if (!rows.length) return '';
  return `Dropped by ${rows.length} monster${rows.length > 1 ? 's' : ''}:\n` + rows.join('\n');
}

/* Where an item can come from at all, in one line for a table cell. */
function sourceText(it) {
  const bb = bestBuy(it);
  if (bb) return { text: priceText(bb.cost), title: shopTooltip(it), kind: 'shop' };
  const d = bestDrop(it);
  if (d) {
    return {
      text: `${d.mon.name || 'monster #' + d.mon.n} ${d.pct}%`,
      title: dropTooltip(it),
      kind: 'drop',
    };
  }
  return { text: 'no known source', title: '', kind: 'none' };
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
  const modelled = !!WCTX.refWeapon;
  for (const k in it.stats) {
    if (modelled && DAMAGE_MODELLED.has(k)) continue;      // paid below, once
    s += (w[k] || 0) * it.stats[k];
  }
  if (it.ns) for (const k in it.ns) s += (w[k] || 0) * it.ns[k];
  if (it.accy) s += (w.accy || 0) * it.accy;

  if (modelled) {
    const m = WCTX.margins;
    s += (w.dmg || 0) * (m.crit * (it.stats.crits || 0) + m.maxdmg * (it.stats.maxdmg || 0));
  }
  // A weapon is additionally worth the damage it swings for on its own.
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

/* ------------------------------------------------------------------ spells */
/* Formulas ported from MMUD Explorer: modMMudDatabase.GetCurrentSpellMinMax,
 * GetSpellMinDamage/MaxDamage/Duration, PullSpellEQ, and
 * modMMudFunc.GetSpellCastChance / SpellIsUsable. */

const STOCK_SPELL_HIT_CAP = 98;      // modMMudFunc: Kai is capped at 100 instead

/* Abilities that carry no magnitude -- they are on or off. (PullSpellEQ's
 * "Case 23, 51, 52, 80, 97, 98, 100, 108 To 113, 119, 138, 144, 178".) */
const SPELL_FLAG_ABILS = new Set([23, 51, 52, 80, 97, 98, 100,
                                  108, 109, 110, 111, 112, 113, 119, 138, 144, 178]);
/* Abilities whose magnitude is a plain number rather than a bonus, so it is
 * printed without a leading "+". */
const SPELL_UNSIGNED_ABILS = new Set([1, 8, 17, 18, 19, 140, 141, 148]);
/* Bookkeeping abilities: which line of flavour text the game prints, which
 * spell this one strips. MME lists them; a player choosing a spell does not
 * need "DescMsg 8531" and it crowds out the effects that matter. */
const SPELL_NOISE_ABILS = new Set([101, 115, 120, 122, 137, 148]);

const SPELL_DMG_ABILS = new Set(D.spellDamageAbils || [1, 8, 17]);
const SPELL_HEAL_ABILS = new Set(D.spellHealAbils || [8, 18]);
/* Stock MajorMUD gives the worn +Spell Dmg bonus to damage only; the heal side
 * of a drain is bonused in GreaterMUD, which this tool does not model. */
const SPELL_BONUS_ABILS = new Set([1, 17]);

/* The caster's level is clamped into the spell's own band before anything
 * scales off it. Cap 0 means the spell never stops improving. */
function spellCastLevel(sp, level) {
  let n = Math.trunc(level) || 0;
  if (sp.cap > 0 && n > sp.cap) n = sp.cap;
  if (n < sp.req) n = sp.req;
  return n;
}

/* [base, increment, levels-per-increment] -> the value at this cast level.
 * Fix() truncates toward zero, so the fraction is dropped, not rounded. */
function spellScale(t, castLevel) {
  const [base, inc, lvls] = t;
  if (!lvls || !inc || castLevel < 1) return base;
  return base + Math.trunc((inc / lvls) * castLevel);
}

/* A spell cheap enough in energy goes off more than once a round. */
function spellCastsPerRound(sp) {
  const cost = sp.energy || 0;
  if (cost < 143 || cost > 500) return 1;
  const rem = Math.max(1, 1000 - cost);
  if (rem < 143) return 1;
  return 1 + Math.trunc(rem / cost);
}

/* GetSpellCastChance. Diff is usually negative -- it is a penalty on your
 * Spellcasting, not a target number. */
function spellCastChance(sp, spellcasting) {
  if (!(spellcasting > 0) || sp.diff >= 200) return 100;
  const cap = sp.magery === 5 ? 100 : STOCK_SPELL_HIT_CAP;
  return Math.min(cap, Math.max(0, spellcasting + sp.diff));
}

/* SpellIsUsable's alignment gate, carried on the spell as abilities. */
function spellAlignOk(sp, align) {
  if (!align || align === '0') return true;
  for (const [code] of sp.abils) {
    const only = D.spellAlignIs[code];
    if (only && only !== align) return false;
    const not = D.spellAlignNot[code];
    if (not && not === align) return false;
  }
  return true;
}

/* Everything one spell does at a given level, for a caster with this much
 * Spellcasting and this much worn +Spell Dmg. */
function spellAt(sp, level, spellcasting, bonusPct) {
  const cl = spellCastLevel(sp, level);
  const mult = bonusPct > 0 ? 1 + Math.round(bonusPct) / 100 : 1;

  const rawMin = spellScale(sp.min, cl), rawMax = spellScale(sp.max, cl);
  const bonMin = mult > 1 ? Math.trunc(rawMin * mult) : rawMin;
  const bonMax = mult > 1 ? Math.trunc(rawMax * mult) : rawMax;
  const dur = spellScale(sp.dur, cl);

  const out = {
    castLevel: cl, dur, min: rawMin, max: rawMax,
    casts: spellCastsPerRound(sp),
    chance: spellCastChance(sp, spellcasting),
    dmg: null, heal: null, effects: [], bonused: false,
    capped: sp.cap > 0 && level > sp.cap,
    scales: !!((sp.min[1] && sp.min[2]) || (sp.max[1] && sp.max[2]) || (sp.dur[1] && sp.dur[2])),
  };

  for (const [code, val] of sp.abils) {
    const name = D.abilityNames[code] || ('Ability ' + code);

    // A non-zero ability value is the effect outright; the spell's min/max
    // range then belongs to some other ability, or to nothing at all.
    if (val !== 0) {
      if (SPELL_DMG_ABILS.has(code)) out.dmg = { min: val, max: val, fixed: true };
      if (SPELL_HEAL_ABILS.has(code)) out.heal = { min: val, max: val, fixed: true };
      if (SPELL_NOISE_ABILS.has(code)) continue;
      out.effects.push(`${name} ${code === 7 ? val / 10 : val}`);
      continue;
    }

    const gets = SPELL_BONUS_ABILS.has(code);
    const lo = gets ? bonMin : rawMin, hi = gets ? bonMax : rawMax;
    if (gets && mult > 1) out.bonused = true;

    if (SPELL_DMG_ABILS.has(code) && !(code === 8 && out.dmg)) out.dmg = { min: lo, max: hi };
    if (SPELL_HEAL_ABILS.has(code)) out.heal = { min: rawMin, max: rawMax };

    if (SPELL_NOISE_ABILS.has(code)) continue;
    if (SPELL_FLAG_ABILS.has(code)) { out.effects.push(name); continue; }
    if (SPELL_DMG_ABILS.has(code) || code === 18) continue;   // shown as the damage line

    // Ability 7 (DR) is stored x10 here exactly as it is on items. PullSpellEQ
    // adds the "+" only to a positive value, so a penalty reads "Accuracy -6".
    const f = v => (code === 7 ? v / 10 : v);
    const w = v => (!SPELL_UNSIGNED_ABILS.has(code) && v > 0 ? '+' : '') + fmt(f(v));
    out.effects.push(lo === hi ? `${name} ${w(lo)}` : `${name} ${w(lo)} to ${w(hi)}`);
  }
  return out;
}

/* How the numbers grow, in words, so the table can say why they will change. */
function spellScalingText(sp) {
  const bits = [];
  const per = t => (t[2] === 1 ? 'level' : t[2] + ' levels');
  if (sp.min[1] && sp.min[2]) bits.push(`min +${sp.min[1]} / ${per(sp.min)}`);
  if (sp.max[1] && sp.max[2]) bits.push(`max +${sp.max[1]} / ${per(sp.max)}`);
  if (sp.dur[1] && sp.dur[2]) bits.push(`duration +${sp.dur[1]} / ${per(sp.dur)}`);
  if (!bits.length) return 'does not scale with level';
  return bits.join(', ') + (sp.cap > 0 ? `, stops at level ${sp.cap}` : ', no cap');
}

/* The spells one class can learn, gated by level and alignment. */
function spellsFor(clsNum, level, align, opt) {
  const list = (D.castable[clsNum] || []).map(n => spellByNum.get(n)).filter(Boolean);
  return list.filter(sp => {
    if (opt && opt.knownOnly && level > 0 && level < sp.req) return false;
    return spellAlignOk(sp, align);
  });
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
    p.dps = wp.perRound;        // average damage per round over the opening five
    p.swings = wp.swings;
    p.schedule = wp.schedule;
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
  ['dps', 'Dmg/round', 1], ['swings', 'Swings in the fight', 0],
  ['perSwing', 'Dmg/swing', 1], ['critPct', 'Crit %', 0],
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
  } else if (mode === 'buyable' || mode === 'obtainable') {
    const budget = coinsToCopper(S.coins);
    const owned = new Set([...Object.values(S.equipped), ...S.carried].map(i => i.n));
    // "Obtainable" also allows anything a monster drops. There is no price on
    // those -- you go and take them -- so the purse does not gate them.
    const drops = mode === 'obtainable';
    pool = D.items.filter(i => owned.has(i.n) || itemCostCopper(i) <= budget ||
                               (drops && i.drop && i.drop.length));
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
  // The reference weapon is what Crits and +Max Damage are priced against, so it
  // is seeded from the weapon in hand and then follows each pass's own pick.
  let refWeapon = S.equipped[16] || null;
  if (!refWeapon) {
    // Nothing in hand: price against the best weapon this character could pick
    // up, so crit gear is not written off before a weapon has been chosen.
    const weapons = cands.filter(i => i.type === 1 && slotPool(i.slot) === 'weapon');
    refWeapon = weapons.reduce((a, b) => (!a || (b.max || 0) > (a.max || 0) ? b : a), null);
  }
  for (let pass = 0; pass < 4; pass++) {
    WCTX.crit = innateCrit + gearCrit;
    WCTX.plusMaxDmg = innateMaxDmg + gearMax;
    WCTX.refWeapon = refWeapon;
    WCTX.margins = damageMargins();
    best = run();
    const nc = best.totals.crits || 0, nm = best.totals.maxdmg || 0;
    const nw = best.picks[16] || null;
    if (nc === gearCrit && nm === gearMax && nw === refWeapon) break;
    gearCrit = nc; gearMax = nm;
    if (nw) refWeapon = nw;
  }
  // The iteration can oscillate rather than settle. Whatever it ended on, the
  // numbers we report must describe the kit we are actually recommending, so
  // re-derive the context from the chosen set before anything renders from it.
  WCTX.crit = innateCrit + (best.totals.crits || 0);
  WCTX.plusMaxDmg = innateMaxDmg + (best.totals.maxdmg || 0);
  WCTX.refWeapon = best.picks[16] || null;
  WCTX.margins = damageMargins();
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
    else if (k === 'spellcasting') S.sc = v;
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

  const sc = $('#sp-class');
  sc.innerHTML = '<option value="0">— pick a class —</option>';
  for (const c of D.classes) {
    const n = (D.castable[c.n] || []).length;
    sc.append(new Option(`${c.name}${n ? '' : '  (no spells)'}`, c.n));
  }

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
  spellsOverridden = false;      // a different character, so start from theirs
  spellPrefsFromChar();
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
  syncSpellsToChar();
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
    const dpsCell = addCell('Dmg / round', then.dps.toFixed(1), armed ? delta(now.dps, then.dps) : null);
    dpsCell.append(el('div', 'k', `${then.schedule.join(', ')} swings over ${fightRounds} rounds`));
    dpsCell.title =
      `Each round hands you ${ENERGY_PER_ROUND} energy on top of what is left over, and ` +
      `this weapon costs ${then.energy} a swing, so the swings land ${then.schedule.join(', ')} ` +
      `— ${then.swings} in ${fightRounds} rounds, ${then.dps.toFixed(1)} damage a round on average. ` +
      `${MAX_SWINGS} swings is the hard cap in any one round.`;
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
    '<th>Where to get it</th></tr></thead>';
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
        if (nw.drop && nw.drop.length) {
          const t = el('span', 'tag drop', `drops from ${nw.drop.length} monster${nw.drop.length > 1 ? 's' : ''}`);
          t.title = dropTooltip(nw);
          tags.append(t);
        }
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
        bits.push(`swings ${wp.schedule.join('-')} = ${wp.perRound.toFixed(1)}/round`);
      }
      for (const k in nw.stats) if (nw.stats[k]) bits.push(`${D.statLabels[k] || k} ${nw.stats[k] > 0 ? '+' : ''}${fmt(nw.stats[k])}`);
      if (nw.ns) for (const k in nw.ns) bits.push(`${D.statLabels[k] || k} +${nw.ns[k]}*`);
      if (nw.accy) bits.push(`to-hit ${nw.accy > 0 ? '+' : ''}${nw.accy}`);
    }
    tr.append(el('td', 'bonus', bits.join(' · ')));

    const td$ = el('td', 'source');
    if (!nw) td$.textContent = '—';
    else if (isOwned(nw)) td$.append(el('span', 'imp-none', 'you have it'));
    else {
      const src = sourceText(nw);
      const sp = el('span', 'src ' + src.kind, src.text);
      if (src.title) { sp.title = src.title; sp.classList.add('has-shop'); }
      td$.append(sp);
    }
    tr.append(td$);
    tb.append(tr);
  }
  tbl.append(tb); wrap.append(tbl); box.append(wrap);

  const legend = el('div', 'hint legend');
  legend.textContent =
    'Damage is counted round by round over the first ' + fightRounds + ' rounds, because ' +
    'leftover energy carries between rounds and most fights are short — a weapon worth ' +
    '"2.5 swings" lands 2, 3, 2, 3, and never more than five in one round. ' +
    'Impact is measured against the whole recommendation with only that slot put back ' +
    'the way you wear it now, so it answers "what does changing this one thing buy me". ' +
    'The column does not add up to the totals above: gear interacts, and weight taken off ' +
    'one slot pays for itself somewhere else.';
  box.append(legend);

  const need = D.slots.map(s => res.picks[s.i]).filter(i => i && !isOwned(i));
  const buys = need.filter(i => bestBuy(i));
  if (buys.length) {
    const cost = buys.reduce((a, i) => a + bestBuy(i).cost, 0);
    const have = coinsToCopper(S.coins);
    const note = el('div', 'warn');
    note.textContent = `${buys.length} recommended item(s) are sold in shops — about ${priceText(cost)} total. ` +
      (have ? (cost <= have ? `You can afford that (you have ${copperToText(have)}).`
                            : `You have ${copperToText(have)}, so you are short ${copperToText(cost - have)}.`) : '');
    box.append(note);
  }

  const hunt = need.filter(i => !bestBuy(i) && bestDrop(i));
  if (hunt.length) {
    const note = el('div', 'warn');
    note.textContent = `${hunt.length} recommended item(s) are not sold anywhere and have to be ` +
      `taken off something: ` +
      hunt.map(i => { const d = bestDrop(i); return `${i.name} (${d.mon.name}, ${d.pct}%)`; }).join('; ') + '.';
    note.title = hunt.map(i => dropTooltip(i)).join('\n\n');
    box.append(note);
  }

  const nowhere = need.filter(i => !bestBuy(i) && !bestDrop(i));
  if (nowhere.length) {
    box.append(el('div', 'warn',
      `${nowhere.length} recommended item(s) have no shop and no drop source in the database: ` +
      nowhere.map(i => i.name).join(', ') + '. They may be quest or event items.'));
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

/* ------------------------------------------------------------ spells tab */

/* The spell controls follow the active character until the user overrides one
 * of them by hand; after that they are left alone, and "Use my character" is
 * how you hand them back. Search and sort are view options, not character
 * facts, so touching those does not count. */
let spellsOverridden = false;

function syncSpellsToChar() {
  if (!spellsOverridden) spellPrefsFromChar();
}

function spellPrefsFromChar() {
  if (!$('#sp-class')) return;
  $('#sp-class').value = S.cls || 0;
  $('#sp-level').value = S.level || 1;
  $('#sp-align').value = S.align || '0';
  // Spellcasting off the stat block already includes gear; if the character
  // was typed in rather than pasted, fall back to what the worn kit supplies.
  const gear = totalsOf(Object.values(S.equipped)).t;
  $('#sp-sc').value = S.sc || gear.sc || 0;
  $('#sp-bonus').value = gear.alterSpellDmg || 0;
}

function renderSpells() {
  const box = $('#sp-results'); box.innerHTML = '';
  const note = $('#sp-note');
  const clsNum = +$('#sp-class').value;
  const level = +$('#sp-level').value || 0;
  const sc = +$('#sp-sc').value || 0;
  const bonus = +$('#sp-bonus').value || 0;
  const align = $('#sp-align').value;
  const q = $('#sp-q').value.trim().toLowerCase();
  const sort = $('#sp-sort').value;
  const knownOnly = $('#sp-known').checked;

  const c = clsByNum.get(clsNum);
  if (!c) { note.textContent = ''; box.append(el('div', 'empty', 'Pick a class.')); return; }
  if (!(D.castable[clsNum] || []).length) {
    note.textContent = '';
    box.append(el('div', 'empty',
      `${c.name} casts no spells — magery ${D.mageryNames[c.magery] || c.magery}.`));
    return;
  }

  let list = spellsFor(clsNum, level, align, { knownOnly });
  if (q) list = list.filter(sp => sp.name.toLowerCase().includes(q) ||
                                  (sp.short || '').toLowerCase().includes(q));

  const at = new Map(list.map(sp => [sp.n, spellAt(sp, level, sc, bonus)]));
  const avg = sp => { const a = at.get(sp.n).dmg; return a ? (a.min + a.max) / 2 : 0; };
  const cmp = {
    level: (a, b) => a.req - b.req || a.name.localeCompare(b.name),
    name: (a, b) => a.name.localeCompare(b.name),
    dmg: (a, b) => avg(b) - avg(a) || a.req - b.req,
    dpm: (a, b) => (avg(b) / (b.mana || 1)) - (avg(a) / (a.mana || 1)) || a.req - b.req,
    dur: (a, b) => at.get(b.n).dur - at.get(a.n).dur || a.req - b.req,
    mana: (a, b) => a.mana - b.mana || a.req - b.req,
  }[sort];
  list = list.slice().sort(cmp);

  note.textContent =
    `${c.name} draws on ${D.mageryNames[c.magery]} magery, level ${c.mageryLvl}. ` +
    `${list.length} spell${list.length === 1 ? '' : 's'} shown at caster level ${level}` +
    (sc ? `, Spellcasting ${sc}` : ', no Spellcasting set — cast chance assumes 100%') +
    (bonus ? `, +${bonus}% spell damage` : '') + '.';

  if (!list.length) { box.append(el('div', 'empty', 'Nothing matches.')); return; }

  const wrap = el('div', 'tablewrap');
  const tbl = el('table');
  tbl.innerHTML = '<thead><tr><th>Spell</th><th class="num">Lvl</th><th class="num">Mana</th>' +
    '<th>Damage / heal</th><th class="num">Duration</th><th class="num">Cast</th>' +
    '<th>Effects</th><th>Target</th></tr></thead>';
  const tb = el('tbody');

  for (const sp of list) {
    const a = at.get(sp.n);
    const tr = el('tr');
    if (level > 0 && level < sp.req) tr.classList.add('locked');

    const tdName = el('td');
    tdName.append(el('div', 'pick', sp.name));
    const sub = el('div', 'tags');
    if (sp.short) sub.append(el('span', 'tag', sp.short));
    if (a.casts > 1) sub.append(el('span', 'tag mag', `${a.casts}x / round`));
    if (a.capped) sub.append(el('span', 'tag lim', `capped at ${sp.cap}`));
    if (a.bonused) sub.append(el('span', 'tag buy', `+${bonus}% applied`));
    if (level > 0 && level < sp.req) sub.append(el('span', 'tag lim', `needs level ${sp.req}`));
    tdName.append(sub);
    tdName.title = spellScalingText(sp) + (sp.from ? ` · learned from ${sp.from}` : '');
    tr.append(tdName);

    tr.append(el('td', 'num', String(sp.req)));
    tr.append(el('td', 'num', String(sp.mana)));

    const tdD = el('td');
    const range = r => (r.min === r.max ? fmt(r.min) : `${fmt(r.min)}–${fmt(r.max)}`);
    if (a.dmg) {
      const d = el('div', null, range(a.dmg) + ' dmg' + (a.casts > 1 ? ` ×${a.casts}` : ''));
      tdD.append(d);
      if (sp.mana > 0) {
        const per = ((a.dmg.min + a.dmg.max) / 2 * a.casts / sp.mana);
        tdD.append(el('div', 'k', `${per.toFixed(1)} per mana`));
      }
    }
    if (a.heal) tdD.append(el('div', null, range(a.heal) + ' healed'));
    if (!a.dmg && !a.heal) tdD.append(el('span', 'imp-none', '—'));
    tr.append(tdD);

    tr.append(el('td', 'num', a.dur > 0 ? `${a.dur} rd` : '—'));

    const tdC = el('td', 'num', a.chance + '%');
    tdC.title = sp.diff >= 200 ? 'Always succeeds.'
      : `Spellcasting ${sc || 0} ${sp.diff < 0 ? '−' : '+'} ${Math.abs(sp.diff)} difficulty` +
        `, capped at ${sp.magery === 5 ? 100 : STOCK_SPELL_HIT_CAP}%`;
    if (a.chance < 90) tdC.classList.add('down');
    tr.append(tdC);

    tr.append(el('td', 'bonus', a.effects.join(' · ')));

    const tdT = el('td', 'bonus');
    tdT.textContent = D.spellTargets[sp.targets] || ('Target ' + sp.targets);
    tdT.title = `${D.spellAttTypes[sp.att] || sp.att} attack type · ` +
                (D.spellResists[sp.res] || '');
    tr.append(tdT);

    tb.append(tr);
  }
  tbl.append(tb); wrap.append(tbl); box.append(wrap);

  const legend = el('div', 'hint legend');
  legend.textContent =
    'Numbers are for the level in the box, clamped into each spell’s own band: a spell ' +
    'never scales below its required level, and stops at its cap. Hover a spell name for its ' +
    'scaling rule, and a cast percentage for how it was worked out. Durations are in rounds. ' +
    'The +Spell Dmg bonus is applied to damage only — stock MajorMUD does not bonus heals.';
  box.append(legend);
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
    const dd = bestDrop(i);
    if (dd) notes.push(`drops: ${dd.mon.name || 'monster #' + dd.mon.n} ${dd.pct}%`);
    if (!bb && !dd && i.from) notes.push(i.from.slice(0, 48));
    const tdN = el('td', 'bonus', notes.join(' · '));
    // Both tooltips when an item is both bought and dropped -- either route counts.
    const tip = [bb ? shopTooltip(i) : '', dd ? dropTooltip(i) : ''].filter(Boolean).join('\n\n');
    if (tip) { tdN.title = tip; tdN.classList.add('has-shop'); }
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
  fightRounds = +$('#rounds').value || FIGHT_ROUNDS_DEFAULT;
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
    if (b.dataset.tab === 'spells') renderSpells();
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
    syncSpellsToChar();
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

  ['sp-q','sp-sort','sp-known']
    .forEach(id => $('#' + id).addEventListener('input', renderSpells));
  ['sp-class','sp-level','sp-sc','sp-bonus','sp-align'].forEach(id =>
    $('#' + id).addEventListener('input', () => { spellsOverridden = true; renderSpells(); }));
  $('#sp-fromchar').addEventListener('click', () => {
    spellsOverridden = false; spellPrefsFromChar(); renderSpells();
  });

  renderResults(null);
}

document.addEventListener('DOMContentLoaded', init);
