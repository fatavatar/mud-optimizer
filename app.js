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

/* The restrictions that apply to any item at all, worn or not: level band,
 * alignment, race, class whitelist, and the AntiMagic rule. The armour- and
 * weapon-type checks on top of these only mean anything for gear you equip, so
 * they stay in isUsable; the reference tabs, which list keys and potions too,
 * ask this one instead. */
function passesRestrictions(it, o) {
  if (o.requireInGame && !it.inGame) return false;

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

  return true;
}

function isUsable(it, opt) {
  const o = opt || {};
  if (it.type !== 0 && it.type !== 1) return false;
  if (it.slot == null) return false;
  if (!passesRestrictions(it, o)) return false;

  const c = clsByNum.get(S.cls);
  if (!c) return true;

  const classOk = !!(it.classOk && it.classOk.includes(S.cls));
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

  const as = $('#a-slot');
  const seen = new Set();
  for (const s of D.slots) {
    if (seen.has(s.pool)) continue;
    seen.add(s.pool);
    as.append(new Option(s.name.replace(/ \d$/, ''), s.pool));
  }
  for (const k in D.weaponTypes) $('#w-type').append(new Option(D.weaponTypes[k], k));
  for (const k in D.armourTypes) $('#a-type').append(new Option(D.armourTypes[k], k));
  // The sundry tab is everything that is not a weapon or wearable armour, so the
  // kind list skips weapons -- but keeps Armour, which is where the deeds and
  // boxes with no wear location end up.
  for (const k in D.itemTypes) {
    if (+k === 1) continue;
    $('#u-type').append(new Option(D.itemTypes[k], k));
  }
  for (const m of D.maps || []) {
    $('#m-map').append(new Option(`map ${m.n} (${m.tier})`, m.n));
  }
  for (const t of TIER_ORDER) {
    const n = D.shops.filter(sh => (mapByNum.get(shopMap(sh)) || {}).tier === t).length;
    if (n) $('#sh-tier').append(new Option(`${t} (${n} shop${n === 1 ? '' : 's'})`, t));
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
  refreshActiveTab();            // the reference tabs describe whoever is active
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

  const rows = [];
  for (const [order, sl] of D.slots.entries()) {
    const nw = res.picks[sl.i], od = S.equipped[sl.i];
    if (!nw && !od) continue;
    const changed = (nw && od) ? nw.n !== od.n : !!nw !== !!od;
    rows.push({ sl, nw, od, changed, order });
  }

  const givesBits = nw => {
    const bits = [];
    if (!nw) return bits;
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
    return bits;
  };

  // What the swap is worth in damage a round, which is what the column leads
  // with -- so sorting it answers "which of these changes matters most".
  const impactDps = r => {
    const imp = impacts.get(leadOf.get(r.sl.i));
    if (!imp || leadOf.get(r.sl.i) !== r.sl.i) return 0;
    const dps = imp.rows.find(x => x.k === 'dps');
    return dps ? dps.delta : 0;
  };

  tableInto(box, [
    { h: 'Slot', key: r => r.order,
      title: 'Sorts back into the order you wear it in.',
      cell: r => el('td', 'slotname', r.sl.name) },
    { h: 'Currently', key: r => (r.od ? r.od.name : ''),
      cell: r => el('td', 'cur', r.od ? r.od.name : '—') },
    { h: 'Recommended', key: r => (r.nw ? r.nw.name : ''), cell: r => {
        const { nw } = r;
        const td = el('td');
        const nameEl = el('div', 'pick' + (r.changed ? ' changed' : ''), nw ? nw.name : '— leave empty —');
        if (nw) {
          const tip = shopTooltip(nw);         // empty once every stocking shop is switched off
          if (tip) { nameEl.title = tip; nameEl.classList.add('has-shop'); }
        }
        td.append(nameEl);
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
          if (tags.children.length) td.append(tags);
        }
        return td;
      } },
    { h: 'Impact of this swap', dir: -1, key: impactDps,
      title: 'Everything the whole set changes if you make this one swap, including ' +
             'knock-on effects like encumbrance costing you dodge and crit chance. ' +
             'Sorts on the damage per round it moves.',
      cell: r => impactCell(r.sl.i, impacts, leadOf, r.changed) },
    { h: 'Enc', cls: 'num', dir: -1, key: r => (r.nw ? r.nw.enc || 0 : -1),
      cell: r => el('td', 'num', r.nw ? (r.nw.enc || 0).toLocaleString() : '—') },
    { h: 'What it gives', key: r => givesBits(r.nw).join(' · '),
      cell: r => el('td', 'bonus', givesBits(r.nw).join(' · ')) },
    { h: 'Where to get it', key: r => (!r.nw ? Infinity : isOwned(r.nw) ? -1 : sourceOrder(r.nw)),
      title: 'What you already own first, then what you can buy, then what you have to hunt for.',
      cell: r => {
        const { nw } = r;
        const td = el('td', 'source');
        if (!nw) td.textContent = '—';
        else if (isOwned(nw)) td.append(el('span', 'imp-none', 'you have it'));
        else {
          const src = sourceText(nw);
          const sp = el('span', 'src ' + src.kind, src.text);
          if (src.title) { sp.title = src.title; sp.classList.add('has-shop'); }
          td.append(sp);
        }
        return td;
      } },
  ], rows, {
    id: 'results', sort: 0, cap: rows.length, redraw: () => renderResults(res),
    tie: (a, b) => a.order - b.order,
  });

  const legend = el('div', 'hint legend');
  legend.textContent =
    'Damage is counted round by round over the first ' + fightRounds + ' rounds, because ' +
    'leftover energy carries between rounds and most fights are short — a weapon worth ' +
    '"2.5 swings" lands 2, 3, 2, 3, and never more than five in one round. ' +
    'Impact is measured against the whole recommendation with only that slot put back ' +
    'the way you wear it now, so it answers "what does changing this one thing buy me". ' +
    'The column does not add up to the totals above: gear interacts, and weight taken off ' +
    'one slot pays for itself somewhere else.' +
    ' Every column here sorts too — by impact, to see which single change is worth the most.';
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

  note.textContent =
    `${c.name} draws on ${D.mageryNames[c.magery]} magery, level ${c.mageryLvl}. ` +
    `${list.length} spell${list.length === 1 ? '' : 's'} shown at caster level ${level}` +
    (sc ? `, Spellcasting ${sc}` : ', no Spellcasting set — cast chance assumes 100%') +
    (bonus ? `, +${bonus}% spell damage` : '') + '.' + SORT_HINT;

  if (!list.length) { box.append(el('div', 'empty', 'Nothing matches.')); return; }

  const range = r => (r.min === r.max ? fmt(r.min) : `${fmt(r.min)}–${fmt(r.max)}`);
  const perMana = sp => {
    const d = at.get(sp.n).dmg;
    return d && sp.mana > 0 ? (d.min + d.max) / 2 * at.get(sp.n).casts / sp.mana : 0;
  };

  tableInto(box, [
    { h: 'Spell', key: sp => sp.name, cell: sp => {
        const a = at.get(sp.n);
        const td = el('td');
        td.append(el('div', 'pick', sp.name));
        const sub = el('div', 'tags');
        if (sp.short) sub.append(el('span', 'tag', sp.short));
        if (a.casts > 1) sub.append(el('span', 'tag mag', `${a.casts}x / round`));
        if (a.capped) sub.append(el('span', 'tag lim', `capped at ${sp.cap}`));
        if (a.bonused) sub.append(el('span', 'tag buy', `+${bonus}% applied`));
        if (level > 0 && level < sp.req) sub.append(el('span', 'tag lim', `needs level ${sp.req}`));
        td.append(sub);
        td.title = spellScalingText(sp) + (sp.from ? ` · learned from ${sp.from}` : '');
        return td;
      } },
    { h: 'Lvl', cls: 'num', key: sp => sp.req,
      cell: sp => el('td', 'num', String(sp.req)) },
    { h: 'Mana', cls: 'num', key: sp => sp.mana,
      cell: sp => el('td', 'num', String(sp.mana)) },
    { h: 'Damage / heal', cls: 'num', dir: -1,
      key: sp => { const a = at.get(sp.n); return a.dmg ? (a.dmg.min + a.dmg.max) / 2 * a.casts
                                                       : a.heal ? (a.heal.min + a.heal.max) / 2 : 0; },
      title: 'Sorts on the middle of the range, times the casts a round buys.',
      cell: sp => {
        const a = at.get(sp.n);
        const td = el('td');
        if (a.dmg) td.append(el('div', null, range(a.dmg) + ' dmg' + (a.casts > 1 ? ` ×${a.casts}` : '')));
        if (a.heal) td.append(el('div', null, range(a.heal) + ' healed'));
        if (!a.dmg && !a.heal) td.append(el('span', 'imp-none', '—'));
        return td;
      } },
    { h: 'Per mana', cls: 'num', dir: -1, key: perMana,
      title: 'Average damage a round divided by what the spell costs to cast.',
      cell: sp => {
        const v = perMana(sp);
        const td = el('td', 'num');
        if (v) td.textContent = v.toFixed(1);
        else td.append(el('span', 'imp-none', '—'));
        return td;
      } },
    { h: 'Duration', cls: 'num', dir: -1, key: sp => at.get(sp.n).dur,
      cell: sp => el('td', 'num', at.get(sp.n).dur > 0 ? `${at.get(sp.n).dur} rd` : '—') },
    { h: 'Cast', cls: 'num', dir: -1, key: sp => at.get(sp.n).chance,
      cell: sp => {
        const a = at.get(sp.n);
        const td = el('td', 'num', a.chance + '%');
        td.title = sp.diff >= 200 ? 'Always succeeds.'
          : `Spellcasting ${sc || 0} ${sp.diff < 0 ? '−' : '+'} ${Math.abs(sp.diff)} difficulty` +
            `, capped at ${sp.magery === 5 ? 100 : STOCK_SPELL_HIT_CAP}%`;
        if (a.chance < 90) td.classList.add('down');
        return td;
      } },
    { h: 'Effects', key: sp => at.get(sp.n).effects.join(' · '),
      cell: sp => el('td', 'bonus', at.get(sp.n).effects.join(' · ')) },
    { h: 'Target', key: sp => D.spellTargets[sp.targets] || String(sp.targets),
      cell: sp => {
        const td = el('td', 'bonus');
        td.textContent = D.spellTargets[sp.targets] || ('Target ' + sp.targets);
        td.title = `${D.spellAttTypes[sp.att] || sp.att} attack type · ` +
                   (D.spellResists[sp.res] || '');
        return td;
      } },
  ], list, {
    id: 'spells', sort: 1, redraw: renderSpells, cap: list.length,
    tie: (a, b) => a.req - b.req || a.name.localeCompare(b.name),
    rowClass: sp => (level > 0 && level < sp.req ? 'locked' : ''),
  });

  const legend = el('div', 'hint legend');
  legend.textContent =
    'Numbers are for the level in the box, clamped into each spell’s own band: a spell ' +
    'never scales below its required level, and stops at its cap. Hover a spell name for its ' +
    'scaling rule, and a cast percentage for how it was worked out. Durations are in rounds. ' +
    'The +Spell Dmg bonus is applied to damage only — stock MajorMUD does not bonus heals.';
  box.append(legend);
}

/* ------------------------------------------------- browsing the database */
/* Six reference tabs over the same tables the optimizer reads: weapons,
 * armour, everything else, classes and races, the bestiary, and the shops.
 * They are all quoted for the character that is active, because almost nothing
 * here is an absolute -- what a weapon swings for, whether you may wear a
 * breastplate and what a shop charges all depend on who is asking. */

/* Aim the shared weapon context at the active character. The optimizer sets
 * this up for itself at the top of every run, so borrowing it between runs
 * costs nothing; what it buys is damage columns that describe the character
 * rather than a generic level-1 body. */
function ctxFromChar() {
  const c = clsByNum.get(S.cls);
  const race = D.races.find(r => r.n === S.race);
  const { t, enc } = totalsOf(Object.values(S.equipped));
  const str = (S.base.str || 0) + (t.str || 0);
  const agi = (S.base.agi || 0) + (t.agi || 0);
  const maxEnc = calcMaxEncum(str, t.encumPct || 0);

  WCTX.combat = c ? c.combat : 0;
  WCTX.level = S.level || 1;
  WCTX.str = str || 50;
  WCTX.agi = agi || 50;
  WCTX.encPct = maxEnc ? Math.min(100, Math.trunc((enc / maxEnc) * 100)) : 50;
  // Crits and +Max Damage from class, race and what is worn -- the same three
  // sources the optimizer sums, so a weapon reads the same on both tabs.
  WCTX.crit = (c ? sumAbil(c.abils, 58) : 0) + (race ? sumAbil(race.abils, 58) : 0) + (t.crits || 0);
  WCTX.plusMaxDmg = (c ? sumAbil(c.abils, 4) : 0) + (race ? sumAbil(race.abils, 4) : 0) + (t.maxdmg || 0);
  WCTX.refWeapon = S.equipped[16] || null;
  WCTX.margins = damageMargins();

  return { cls: c, race, str, agi, enc, maxEnc, known: !!c };
}

/* How the character is described in a tab's note line. */
function charNote(ctx) {
  if (!ctx.known) {
    return 'No class set, so these numbers assume a level 1 body with 50 Strength and ' +
           '50 Agility. Fill in the Character tab and they become yours.';
  }
  return `Quoted for ${S.name || 'your character'} — level ${WCTX.level} ` +
         `${ctx.cls.name}, Str ${WCTX.str}, Agi ${WCTX.agi}, ` +
         `${WCTX.encPct}% encumbered in what you are wearing.`;
}

/* Items point at spells the Spells tab never lists -- a scroll teaches a quest
 * spell, a sword procs a monster one -- so names are carried for the whole
 * table, not just the 256 a class can learn. */
function spellName(n) {
  const sp = spellByNum.get(n);
  return (sp && sp.name) || (D.spellNames || {})[n] || ('spell #' + n);
}

const listOfClasses = ns => (ns || []).map(n => (clsByNum.get(n) || {}).name || ('class ' + n)).join(', ');
const listOfRaces = ns => (ns || []).map(n => (D.races.find(r => r.n === n) || {}).name || ('race ' + n)).join(', ');

/* Everything that is not a weapon and not a wearable piece of armour: keys,
 * potions, scrolls, containers, light sources, quest junk. The handful of
 * type-0 rows with no wear location -- deeds, boxes, a bulletin board -- belong
 * here rather than on the armour tab, because you cannot put them on. */
const isSundry = it => !(it.type === 1 || (it.type === 0 && it.slot != null));

/* Everything that qualifies an item, as short tags under its name. */
function itemTags(it) {
  const out = [];
  if (it.type === 1 && (it.wtype === 1 || it.wtype === 3)) out.push(['', 'two-handed']);
  if (it.minLvl) out.push(['lim', `level ${it.minLvl}+`]);
  if (it.maxLvl) out.push(['lim', `to level ${it.maxLvl}`]);
  if (it.limit) out.push(['lim', `limited ${it.limit}`]);
  const f = it.flags || {};
  if (f.cursed) out.push(['curse', 'cursed']);
  if (f.loyal) out.push(['curse', 'loyal']);
  if (f.magical) out.push(['mag', 'magical']);
  if (f.alignOnly) out.push(['lim', f.alignOnly + ' only']);
  if (f.alignNot) out.push(['lim', 'not ' + [].concat(f.alignNot).join(' or ')]);
  if (it.classRest) out.push(['own', listOfClasses(it.classRest) + ' only']);
  if (it.classOk) out.push(['own', 'also ' + listOfClasses(it.classOk)]);
  if (it.raceRest) out.push(['own', listOfRaces(it.raceRest) + ' only']);
  for (const n of it.casts || []) out.push(['mag', 'casts ' + spellName(n)]);
  for (const n of it.learns || []) out.push(['mag', 'teaches ' + spellName(n)]);
  if (!it.inGame) out.push(['', 'not in game']);
  return out;
}

function itemNameCell(it) {
  const td = el('td');
  td.append(el('div', 'pick', it.name));
  const tags = itemTags(it);
  if (tags.length) {
    const sub = el('div', 'tags');
    for (const [k, text] of tags) sub.append(el('span', 'tag' + (k ? ' ' + k : ''), text));
    td.append(sub);
  }
  // Sundry is not gear, so the armour- and weapon-type rules do not apply to it;
  // only the restrictions that gate any item at all decide whether it is struck
  // through. Nothing is hidden here -- with "usable by me" off you are
  // deliberately looking at what you cannot have.
  const opt = { allowLimited: true, allowCursed: true };
  const ok = isSundry(it) ? passesRestrictions(it, opt) : isUsable(it, opt);
  if (S.cls && !ok) {
    td.classList.add('locked');
    td.title = 'Your class, race, level or alignment rules this one out.';
  }
  return td;
}

/* Where an item comes from, leading with the shop price when there is one --
 * that is the route you control -- and naming the best drop otherwise. An item
 * that is both sold and dropped keeps both tooltips. */
function sourceCell(it) {
  const td = el('td', 'bonus');
  const s = sourceText(it);
  let text = s.text;
  const tips = [];
  if ((activeBuy(it) || []).length) tips.push(shopTooltip(it));
  if (it.drop && it.drop.length) tips.push(dropTooltip(it));
  if (s.kind === 'none' && it.from) {
    // Not sold and not dropped, but the export still knows where it turned up:
    // a room, a text block, or inside another item.
    text = it.from.length > 44 ? it.from.slice(0, 44) + '…' : it.from;
    tips.push(it.from);
  }
  const span = el('span', 'src ' + s.kind, text);
  const tip = tips.filter(Boolean).join('\n\n');
  if (tip) { span.title = tip; span.classList.add('has-shop'); }
  td.append(span);
  return td;
}

/* The Sort dropdowns these tabs used to carry are gone -- the headings do that
 * job now -- so each note says so once. */
const SORT_HINT = ' Click a column heading to sort by it, and again to reverse it.';

/* The tie-break every table falls back on. */
const tieByName = (a, b) => (a.name || '').localeCompare(b.name || '');

/* One number that puts "where to get it" in a useful order: what you can buy
 * first and cheapest first, then what you have to hunt for with the best chance
 * first, and last the things with no known source at all. */
function sourceOrder(it) {
  const b = bestBuy(it);
  if (b) return b.cost;
  const d = bestDrop(it);
  if (d) return 1e12 + (100 - d.pct) * 1e6 + (d.mon.exp || 0);
  return 1e15;
}

/* An item's stat line as words, minus whatever the table already has a column
 * for. */
function effectBits(it, skip) {
  const bits = [];
  for (const k in it.stats) {
    if (!it.stats[k] || (skip && skip.has(k))) continue;
    bits.push(`${D.statLabels[k] || k} ${it.stats[k] > 0 ? '+' : ''}${fmt(it.stats[k])}`);
  }
  if (it.accy) bits.push(`Accuracy ${it.accy > 0 ? '+' : ''}${it.accy}`);
  // What a scroll teaches or a wand casts is a tag under the item's name, not a
  // stat, so it is deliberately not repeated here.
  return bits;
}

/* Which column each table is sorted by, and which way. Kept here rather than in
 * the DOM because every table is thrown away and rebuilt on each redraw, and
 * kept out of localStorage because a sort is a glance, not a setting. */
const sortState = {};

/* Order a table's rows by one column. A column whose key returns a string sorts
 * alphabetically and everything else numerically; comparing rather than
 * subtracting keeps an Infinity (the "no known source" end of a sort) sane. The
 * tie-break is deliberately not flipped along with the column, so names stay
 * A to Z whichever way you sort the damage beside them. */
function sortRows(list, col, dir, tie) {
  if (!col || !col.key) return list;
  const k = col.key;
  return list.slice().sort((a, b) => {
    const x = k(a), y = k(b);
    const c = (typeof x === 'string' || typeof y === 'string')
      ? String(x).localeCompare(String(y))
      : (x === y ? 0 : x < y ? -1 : 1);
    return c * dir || (tie ? tie(a, b) : 0);
  });
}

/* Every table on the page is built through here, and every column that has an
 * order worth having is clickable.
 *
 * `cols` describes the columns: `h` is the heading, `cell(row)` builds the td,
 * and `key(row)` is what the column sorts on -- a number sorts numerically, a
 * string alphabetically, and a column with no `key` is simply not clickable.
 * `dir` is the direction the first click uses, because the useful end differs
 * per column: -1 for damage (biggest first), +1 for a name.
 *
 * `opt.id` names the table's sort state, `opt.sort` is the column it starts on,
 * `opt.redraw` rebuilds the tab a click has resorted, `opt.tie` breaks ties, and
 * `opt.cap` stops a 1,000-row filter from locking the browser up. */
function tableInto(box, cols, list, opt) {
  const o = opt || {};
  const limit = o.cap || 400;
  const st = sortState[o.id] || (sortState[o.id] = null);
  const start = st || { col: o.sort == null ? -1 : o.sort, dir: 0 };
  if (start.dir === 0) start.dir = (cols[start.col] || {}).dir || 1;
  sortState[o.id] = start;

  const rows = sortRows(list, cols[start.col], start.dir, o.tie);

  const wrap = el('div', 'tablewrap');
  const tbl = el('table');
  const thead = el('thead');
  const htr = el('tr');
  cols.forEach((c, i) => {
    const th = el('th', c.cls || null, c.h);
    const tips = [];
    if (c.title) tips.push(c.title);
    if (c.key) {
      const isActive = i === start.col;
      th.classList.add('sortable');
      th.tabIndex = 0;
      th.setAttribute('role', 'button');
      th.setAttribute('aria-sort', isActive ? (start.dir < 0 ? 'descending' : 'ascending') : 'none');
      if (isActive) {
        th.classList.add('sorted');
        th.append(el('span', 'arrow', start.dir < 0 ? '▼' : '▲'));
      }
      tips.push(isActive ? 'Click to reverse the order.' : 'Click to sort by this column.');
      const go = () => {
        if (i === start.col) start.dir = -start.dir;
        else { start.col = i; start.dir = c.dir || 1; }
        o.redraw();
      };
      th.addEventListener('click', go);
      th.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
      });
    }
    if (tips.length) th.title = tips.join(' ');
    htr.append(th);
  });
  thead.append(htr); tbl.append(thead);

  const tb = el('tbody');
  for (const x of rows.slice(0, limit)) {
    const tr = el('tr');
    if (o.rowClass) { const rc = o.rowClass(x); if (rc) tr.className = rc; }
    for (const c of cols) tr.append(c.cell(x));
    tb.append(tr);
  }
  tbl.append(tb); wrap.append(tbl); box.append(wrap);
  if (rows.length > limit) {
    box.append(el('div', 'empty',
      `showing the first ${limit} of ${rows.length} — sort or filter to bring others into view`));
  }
}

/* ------------------------------------------------------------- weapons */

function renderWeapons() {
  const ctx = ctxFromChar();
  fightRounds = +($('#rounds') || {}).value || FIGHT_ROUNDS_DEFAULT;

  const q = $('#w-q').value.trim().toLowerCase();
  const wt = $('#w-type').value;
  const inGame = $('#w-ingame').checked;
  const opt = { requireInGame: inGame, allowLimited: true, allowCursed: true };

  let list = D.items.filter(i => i.type === 1);
  if (inGame) list = list.filter(i => i.inGame);
  if (q) list = list.filter(i => i.name.toLowerCase().includes(q));
  if (wt !== '') list = list.filter(i => String(i.wtype) === wt);
  if ($('#w-usable').checked && S.cls) list = list.filter(i => isUsable(i, opt));

  const prof = new Map(list.map(i => [i.n, weaponProfile(i)]));
  const p = it => prof.get(it.n);

  $('#w-note').textContent = charNote(ctx) +
    ` Swings and damage are what the weapon actually lands over ${fightRounds} rounds, ` +
    'carrying leftover energy from one round into the next — not a continuous rate. ' +
    `${list.length} weapon${list.length === 1 ? '' : 's'} shown.` + SORT_HINT;

  const box = $('#weapons'); box.innerHTML = '';
  if (!list.length) { box.append(el('div', 'empty', 'No weapons match.')); return; }

  tableInto(box, [
    { h: 'Weapon', key: it => it.name, cell: itemNameCell },
    { h: 'Type', key: it => D.weaponTypes[it.wtype] || '',
      cell: it => el('td', 'slotname', D.weaponTypes[it.wtype] || '—') },
    { h: 'Damage', cls: 'num', dir: -1, key: avgDmg,
      title: 'Sorts on the middle of the range.',
      cell: it => {
        const td = el('td', 'num', `${it.min}–${it.max}`);
        td.title = `average ${fmt(avgDmg(it))} on a normal hit, ` +
                   `${fmt(p(it).crit)} on a crit · ${fmt(p(it).critPct)}% crit chance ` +
                   `(${WCTX.crit} from class, race and gear, +${p(it).qnd} quick and deadly)`;
        return td;
      } },
    { h: 'Speed', cls: 'num', key: it => it.speed || 0,
      title: 'Lower is faster: it is the energy the weapon costs before your own numbers are applied.',
      cell: it => el('td', 'num', String(it.speed || 0)) },
    { h: 'Energy', cls: 'num', key: it => p(it).energy,
      title: 'What one swing costs you, out of the 1,000 energy a round hands you.',
      cell: it => el('td', 'num', String(Math.round(p(it).energy))) },
    { h: 'Swings', cls: 'num', dir: -1, key: it => p(it).swings,
      cell: it => {
        const td = el('td', 'num', String(p(it).swings));
        td.title = `round by round: ${p(it).schedule.join(', ')}`;
        return td;
      } },
    { h: 'Dmg/round', cls: 'num', dir: -1, key: it => p(it).perRound,
      cell: it => el('td', 'num', fmt(p(it).perRound)) },
    { h: 'Enc', cls: 'num', key: it => it.enc || 0,
      cell: it => el('td', 'num', (it.enc || 0).toLocaleString()) },
    { h: 'Str', cls: 'num', key: it => it.strReq || 0,
      cell: it => {
        const td = el('td', 'num', it.strReq ? String(it.strReq) : '—');
        if ((it.strReq || 0) > WCTX.str) {
          td.classList.add('down');
          td.title = `${it.strReq - WCTX.str} short. Being under a weapon's Strength ` +
                     'requirement does not stop you using it — it multiplies your energy ' +
                     'per swing, so you swing slower. That is already in the numbers here.';
        }
        return td;
      } },
    { h: 'Where to get it', key: sourceOrder, cell: sourceCell,
      title: 'Sorts what you can buy first, cheapest first, then what you have to hunt for.' },
  ], list, { id: 'weapons', sort: 6, redraw: renderWeapons, tie: tieByName });
}

/* -------------------------------------------------------------- armour */

function renderArmour() {
  const ctx = ctxFromChar();
  const q = $('#a-q').value.trim().toLowerCase();
  const pool = $('#a-slot').value;
  const at = $('#a-type').value;
  const inGame = $('#a-ingame').checked;
  const opt = { requireInGame: inGame, allowLimited: true, allowCursed: true };

  let list = D.items.filter(i => i.type === 0 && i.slot != null);
  if (inGame) list = list.filter(i => i.inGame);
  if (q) list = list.filter(i => i.name.toLowerCase().includes(q));
  if (pool) list = list.filter(i => slotPool(i.slot) === pool);
  if (at !== '') list = list.filter(i => String(i.atype || 0) === at);
  if ($('#a-usable').checked && S.cls) list = list.filter(i => isUsable(i, opt));

  const w = S.weights;
  const c = ctx.cls;
  $('#a-note').textContent =
    (c ? `${c.name} can wear up to ${D.armourTypes[c.armourType]}. ` : '') +
    'AC and DR are the real values — both columns are stored ×10 in the database and ' +
    'divided on export. Score is this item against your own weights from the Optimize tab. ' +
    `${list.length} piece${list.length === 1 ? '' : 's'} shown.` + SORT_HINT;

  const box = $('#armour'); box.innerHTML = '';
  if (!list.length) { box.append(el('div', 'empty', 'No armour matches.')); return; }

  const skip = new Set(['ac', 'dr']);
  tableInto(box, [
    { h: 'Armour', key: it => it.name, cell: itemNameCell },
    { h: 'Slot', key: it => SLOT.get(it.slot).name,
      cell: it => el('td', 'slotname', SLOT.get(it.slot).name.replace(/ \d$/, '')) },
    { h: 'Material', key: it => it.atype || 0,
      title: 'Sorts by weight of material, cloth to full plate.',
      cell: it => {
        const td = el('td', 'slotname', D.armourTypes[it.atype || 0] || '—');
        if (c && c.armourType < (it.atype || 0)) {
          td.classList.add('down');
          td.title = `Too heavy a material for a ${c.name}, who stops at ${D.armourTypes[c.armourType]}.`;
        }
        return td;
      } },
    { h: 'AC', cls: 'num', dir: -1, key: it => it.stats.ac || 0,
      cell: it => el('td', 'num', fmt(it.stats.ac || 0)) },
    { h: 'DR', cls: 'num', dir: -1, key: it => it.stats.dr || 0,
      cell: it => el('td', 'num', fmt(it.stats.dr || 0)) },
    { h: 'Enc', cls: 'num', key: it => it.enc || 0,
      cell: it => el('td', 'num', (it.enc || 0).toLocaleString()) },
    { h: 'Score', cls: 'num', dir: -1, key: it => scoreItem(it, w),
      title: 'This piece against your own weights from the Optimize tab.',
      cell: it => el('td', 'num', fmt(scoreItem(it, w))) },
    { h: 'Also gives', key: it => effectBits(it, skip).join(' · '),
      cell: it => el('td', 'bonus', effectBits(it, skip).join(' · ')) },
    { h: 'Where to get it', key: sourceOrder, cell: sourceCell,
      title: 'Sorts what you can buy first, cheapest first, then what you have to hunt for.' },
  ], list, { id: 'armour', sort: 3, redraw: renderArmour, tie: tieByName });
}

/* -------------------------------------------------------------- sundry */

const sundryValue = it => (it.price || 0) * (D.currencyInCopper[it.cur] || 1);

function renderSundry() {
  const q = $('#u-q').value.trim().toLowerCase();
  const kind = $('#u-type').value;
  const inGame = $('#u-ingame').checked;
  const opt = { requireInGame: inGame, allowLimited: true, allowCursed: true };

  let list = D.items.filter(isSundry);
  if (inGame) list = list.filter(i => i.inGame);
  if (q) list = list.filter(i => i.name.toLowerCase().includes(q));
  if (kind !== '') list = list.filter(i => String(i.type) === kind);
  if ($('#u-usable').checked && S.cls) list = list.filter(i => passesRestrictions(i, opt));

  $('#u-note').textContent =
    'Everything that is neither a weapon nor a wearable piece of armour. None of it is ' +
    'scored — the optimizer only picks gear you can equip — so this tab is here to look ' +
    'things up: what a scroll casts, what a key opens, what a shop wants for it. ' +
    `${list.length} item${list.length === 1 ? '' : 's'} shown.` + SORT_HINT;

  const box = $('#sundry'); box.innerHTML = '';
  if (!list.length) { box.append(el('div', 'empty', 'Nothing matches.')); return; }

  tableInto(box, [
    { h: 'Item', key: it => it.name, cell: itemNameCell },
    { h: 'Kind', key: it => D.itemTypes[it.type] || '',
      cell: it => el('td', 'slotname', D.itemTypes[it.type] || '—') },
    { h: 'Enc', cls: 'num', key: it => it.enc || 0,
      cell: it => el('td', 'num', (it.enc || 0).toLocaleString()) },
    { h: 'Base value', cls: 'num', dir: -1, key: sundryValue,
      title: 'The database value, before any shop markup or your Charm.',
      cell: it => {
        const v = sundryValue(it);
        const td = el('td', 'num', v ? copperToText(v) : 'free');
        td.title = 'The database value, before any shop markup or your Charm.';
        return td;
      } },
    { h: 'Effects', key: it => effectBits(it).join(' · '),
      cell: it => el('td', 'bonus', effectBits(it).join(' · ')) },
    { h: 'Where to get it', key: sourceOrder, cell: sourceCell,
      title: 'Sorts what you can buy first, cheapest first, then what you have to hunt for.' },
  ], list, { id: 'sundry', sort: 0, redraw: renderSundry, tie: tieByName, cap: 500 });
}

/* ---------------------------------------------------- classes and races */

/* Innate class or race abilities, in words. These are the same Abil/AbilVal
 * pairs items carry, so the value is only worth printing when it is not zero --
 * a great many of them are flags rather than amounts. */
function abilBits(abils) {
  return (abils || []).map(([code, val]) => {
    const name = D.abilityNames[code] || ('ability ' + code);
    return val ? `${name} ${val > 0 ? '+' : ''}${val}` : name;
  });
}

const RACE_STATS = [['int', 'Int'], ['wil', 'Wil'], ['str', 'Str'],
                    ['hea', 'Hea'], ['agi', 'Agi'], ['cha', 'Cha']];

function renderClassRace() {
  $('#cls-note').textContent =
    'Hit points per level are rolled between the minimum and maximum. Combat rating drives ' +
    'how much energy a swing costs, so it is why the same weapon is faster in some hands ' +
    'than others. Weapons and armour are the ceilings the eligibility rules enforce.' + SORT_HINT;

  const spellCount = c => (D.castable[c.n] || []).length;
  const nameCell = x => { const td = el('td'); td.append(el('div', 'pick', x.name)); return td; };

  const cbox = $('#classlist'); cbox.innerHTML = '';
  tableInto(cbox, [
    { h: 'Class', key: c => c.name, cell: nameCell },
    { h: 'Hits/level', cls: 'num', dir: -1, key: c => c.maxHits,
      title: 'Sorts on the top of the roll.',
      cell: c => el('td', 'num', `${c.minHits}–${c.maxHits}`) },
    { h: 'Combat', cls: 'num', dir: -1, key: c => c.combat,
      title: 'Drives how much energy a swing costs — higher swings faster.',
      cell: c => el('td', 'num', String(c.combat)) },
    { h: 'Weapons', key: c => D.classWeaponNames[c.weaponType] || '',
      cell: c => el('td', null, D.classWeaponNames[c.weaponType] || '—') },
    { h: 'Armour', key: c => c.armourType,
      title: 'Sorts by how heavy a material the class may wear.',
      cell: c => el('td', null, 'up to ' + (D.armourTypes[c.armourType] || '—')) },
    { h: 'Magery', key: c => (spellCount(c) ? c.magery * 100 + c.mageryLvl : -1),
      cell: c => el('td', null, spellCount(c)
        ? `${D.mageryNames[c.magery]} ${c.mageryLvl}` : 'none') },
    { h: 'Spells', cls: 'num', dir: -1, key: spellCount,
      cell: c => el('td', 'num', spellCount(c) ? String(spellCount(c)) : '—') },
    { h: 'Innate', key: c => abilBits(c.abils).join(' · '),
      cell: c => el('td', 'bonus', abilBits(c.abils).join(' · ')) },
  ], D.classes, {
    id: 'classes', sort: 0, redraw: renderClassRace, tie: tieByName,
    cap: D.classes.length, rowClass: c => (c.n === S.cls ? 'is-mine' : ''),
  });

  const rbox = $('#racelist'); rbox.innerHTML = '';
  tableInto(rbox, [
    { h: 'Race', key: r => r.name, cell: nameCell },
    ...RACE_STATS.map(([k, label]) => ({
      h: label, cls: 'num', dir: -1, key: r => r.max[k],
      title: 'Sorts on the top of the band — the ceiling is what you can train to.',
      cell: r => {
        const td = el('td', 'num', `${r.min[k]}–${r.max[k]}`);
        if (r.max[k] >= 110) td.classList.add('up');
        return td;
      },
    })),
    { h: 'HP/level', cls: 'num', dir: -1, key: r => r.hpPerLvl || 0,
      cell: r => el('td', 'num', r.hpPerLvl ? '+' + r.hpPerLvl : '—') },
    { h: 'Innate', key: r => abilBits(r.abils).join(' · '),
      cell: r => el('td', 'bonus', abilBits(r.abils).join(' · ')) },
  ], D.races, {
    id: 'races', sort: 0, redraw: renderClassRace, tie: tieByName,
    cap: D.races.length, rowClass: r => (r.n === S.race ? 'is-mine' : ''),
  });
}

/* ------------------------------------------------------------ monsters */

/* Items are the side of the drop table the export carries, so the bestiary's
 * own loot list is built by turning it around once. */
let dropIndex = null;
function dropsByMonster() {
  if (dropIndex) return dropIndex;
  dropIndex = new Map();
  for (const it of D.items) {
    for (const [mn, pct] of it.drop || []) {
      if (!dropIndex.has(mn)) dropIndex.set(mn, []);
      dropIndex.get(mn).push({ it, pct });
    }
  }
  for (const rows of dropIndex.values()) {
    rows.sort((a, b) => b.pct - a.pct || a.it.name.localeCompare(b.it.name));
  }
  return dropIndex;
}

function renderMonsters() {
  const drops = dropsByMonster();
  const q = $('#m-q').value.trim().toLowerCase();
  const mp = $('#m-map').value;

  let list = D.monsters || [];
  if ($('#m-ingame').checked) list = list.filter(m => m.inGame);
  if ($('#m-drops').checked) list = list.filter(m => drops.has(m.n));
  if (mp !== '') list = list.filter(m => (m.maps || []).includes(+mp));
  if (q) {
    // Searching an item name is the question you actually have here -- "what do
    // I have to kill for this" -- so the name matches the loot as well.
    list = list.filter(m => m.name.toLowerCase().includes(q) ||
      (drops.get(m.n) || []).some(d => d.it.name.toLowerCase().includes(q)));
  }

  const located = list.filter(m => m.maps && m.maps.length).length;
  $('#m-note').textContent =
    `${list.length} monster${list.length === 1 ? '' : 's'} shown, ${located} of them located. ` +
    'Whereabouts come from the room table — the monster fixed to a room, plus every lair ' +
    'list that names it — so a widely-lairing wanderer shows several regions and the rest ' +
    'say nothing rather than guess. Drop chances are the database’s own percentages.' + SORT_HINT;

  const box = $('#monsters'); box.innerHTML = '';
  if (!list.length) { box.append(el('div', 'empty', 'No monsters match.')); return; }

  // Where a monster lives sorts by region, hardest first, so the unlocated ones
  // fall to the bottom of the list rather than the top of it.
  const whereOrder = m => (m.maps && m.maps.length
    ? Math.max(...m.maps.map(n => TIER_ORDER.indexOf((mapByNum.get(n) || {}).tier) + 1))
    : -1);
  const mid = m => (m.dmg ? (m.dmg[0] + m.dmg[1]) / 2 : (m.avgDmg || 0));
  const loot = m => drops.get(m.n) || [];

  tableInto(box, [
    { h: 'Monster', key: m => m.name, cell: m => {
        const td = el('td');
        td.append(el('div', 'pick', m.name || 'monster #' + m.n));
        const tags = [];
        if (m.undead) tags.push(['mag', 'undead']);
        if (m.atts > 1) tags.push(['', `${m.atts} attacks`]);
        if (m.special) tags.push(['mag', `${m.special} special`]);
        if (!m.inGame) tags.push(['', 'not in game']);
        if (tags.length) {
          const sub = el('div', 'tags');
          for (const [k, t] of tags) sub.append(el('span', 'tag' + (k ? ' ' + k : ''), t));
          td.append(sub);
        }
        return td;
      } },
    { h: 'Exp', cls: 'num', dir: -1, key: m => m.exp || 0,
      cell: m => el('td', 'num', (m.exp || 0).toLocaleString()) },
    { h: 'HP', cls: 'num', dir: -1, key: m => m.hp || 0,
      cell: m => el('td', 'num', (m.hp || 0).toLocaleString()) },
    { h: 'AC', cls: 'num', dir: -1, key: m => m.ac || 0,
      cell: m => el('td', 'num', String(m.ac || 0)) },
    { h: 'MR', cls: 'num', dir: -1, key: m => m.mr || 0,
      cell: m => el('td', 'num', m.mr ? String(m.mr) : '—') },
    { h: 'Damage', cls: 'num', dir: -1, key: mid,
      title: 'Sorts on the middle of the spread, or on the game’s own average for a caster.',
      cell: m => {
        // The spread is its physical swings only. A spell or special attack
        // stores a flat 100 where the minimum should be, so those are counted as
        // tags instead and the game's own weighted average stands in for them.
        const td = el('td', 'num', m.dmg ? `${m.dmg[0]}–${m.dmg[1]}`
                                         : m.avgDmg ? `~${m.avgDmg}` : '—');
        if (m.dmg) {
          td.title = `the combined spread of its ${m.atts} physical ` +
                     `attack${m.atts === 1 ? '' : 's'}` +
                     (m.special ? `, plus ${m.special} special attack${m.special === 1 ? '' : 's'}` : '') +
                     (m.avgDmg ? `; the game’s own weighted average is ${m.avgDmg}` : '');
        } else if (m.avgDmg) {
          td.title = 'It has no ordinary swing — this is the game’s own average damage, ' +
                     'across attacks whose stored min/max are not damage values.';
        }
        return td;
      } },
    { h: 'Where', dir: -1, key: whereOrder,
      title: 'Sorts by the toughest region it is found in; unlocated monsters sort last.',
      cell: m => {
        const where = monLocText(m);
        const td = el('td', 'bonus', where || 'location unknown');
        if (!where) td.classList.add('imp-none');
        return td;
      } },
    { h: 'Drops', dir: -1, key: m => loot(m).length,
      title: 'Sorts by how much it carries.',
      cell: m => {
        const rows = loot(m);
        const td = el('td', 'bonus');
        if (!rows.length) { td.append(el('span', 'imp-none', '—')); return td; }
        const shown = rows.slice(0, 3).map(d => `${d.it.name} ${d.pct}%`).join(' · ');
        const span = el('span', null, shown + (rows.length > 3 ? ` · +${rows.length - 3} more` : ''));
        span.title = rows.map(d => `- ${d.it.name} (${d.pct}%)`).join('\n');
        span.classList.add('has-shop');
        td.append(span);
        return td;
      } },
  ], list, { id: 'monsters', sort: 1, redraw: renderMonsters, tie: tieByName });
}

/* --------------------------------------------------------------- shops */

/* Shops are stored on the item -- Items.buy is "which shops stock me" -- so the
 * stock list is the same turn-around the drop index does. */
let stockIndex = null;
function stockByShop() {
  if (stockIndex) return stockIndex;
  stockIndex = new Map();
  for (const it of D.items) {
    for (const [sn, max] of it.buy || []) {
      if (!stockIndex.has(sn)) stockIndex.set(sn, []);
      stockIndex.get(sn).push({ it, max });
    }
  }
  for (const rows of stockIndex.values()) rows.sort((a, b) => a.it.name.localeCompare(b.it.name));
  return stockIndex;
}

function renderShops() {
  const stock = stockByShop();
  const q = $('#sh-q').value.trim().toLowerCase();
  const tier = $('#sh-tier').value;
  const sort = $('#sh-sort').value;
  const charm = S.base.cha || 0;

  let list = D.shops.slice();
  if ($('#sh-on').checked) list = list.filter(sh => enabledShops.has(sh.n));
  if (tier) list = list.filter(sh => {
    const m = mapByNum.get(shopMap(sh));
    return m && m.tier === tier;
  });
  if (q) list = list.filter(sh =>
    (sh.name || '').toLowerCase().includes(q) ||
    (sh.locs || []).some(l => (l.name || '').toLowerCase().includes(q)) ||
    (stock.get(sh.n) || []).some(r => r.it.name.toLowerCase().includes(q)));

  const tierRank = sh => {
    const m = mapByNum.get(shopMap(sh));
    return m ? TIER_ORDER.indexOf(m.tier) : 99;
  };
  // Shops are cards rather than rows -- each one carries its own stock table --
  // so this select is the one sort control the tabs still need.
  const cmp = {
    tier: (a, b) => tierRank(a) - tierRank(b) || shopMap(a) - shopMap(b),
    name: (a, b) => (a.name || '').localeCompare(b.name || ''),
    stock: (a, b) => (stock.get(b.n) || []).length - (stock.get(a.n) || []).length,
    markup: (a, b) => a.markup - b.markup,
  }[sort];
  list = list.slice().sort((a, b) => cmp(a, b) || (a.name || '').localeCompare(b.name || ''));

  $('#sh-note').textContent =
    `${list.length} shop${list.length === 1 ? '' : 's'}. Prices are what you would pay: base ` +
    'value plus the shop’s markup, then scaled by your Charm' +
    (charm ? ` (${charm}, so ${charm >= 50 ? 'a discount' : 'a surcharge'})` : ' — which is unset, so no adjustment') +
    '. A shop is placed by region because there is no reachability field in the data; the ' +
    'Optimize tab is where you switch regions off, and this tab shows what that leaves out.' +
    ' Open a shop to see its stock, whose columns sort like every other table.';

  const box = $('#shops'); box.innerHTML = '';
  if (!list.length) { box.append(el('div', 'empty', 'No shops match.')); return; }

  for (const sh of list) {
    const rows = stock.get(sh.n) || [];
    const map = mapByNum.get(shopMap(sh));
    const card = el('div', 'shopgrp');

    const hdr = el('div', 'shophdr');
    hdr.append(el('strong', null, sh.name || 'Shop #' + sh.n));
    if (map) hdr.append(el('span', 'tier ' + map.tier, `map ${map.n} · ${map.tier}`));
    if (!enabledShops.has(sh.n)) {
      const off = el('span', 'tag lim', 'off in the optimizer');
      off.title = 'Turned off under “Shops to consider” on the Optimize tab, so its prices ' +
                  'are not quoted there.';
      hdr.append(off);
    }
    if (sh.classRest) hdr.append(el('span', 'tag own', listOfClasses([sh.classRest]) + ' only'));
    const meta = [];
    meta.push(shopLocText(sh) || 'location unknown');
    meta.push(`${sh.markup}% markup`);
    meta.push(`${rows.length} item${rows.length === 1 ? '' : 's'}`);
    hdr.append(el('span', 'meta', meta.join(' · ')));
    card.append(hdr);

    if (rows.length) {
      const det = el('details');
      det.append(el('summary', null, `what it stocks (${rows.length})`));
      const holder = el('div');
      const kindOf = it => it.type === 1 ? (D.weaponTypes[it.wtype] || 'Weapon')
        : it.type === 0 && it.slot != null ? SLOT.get(it.slot).name.replace(/ \d$/, '')
        : (D.itemTypes[it.type] || '—');
      const bitsOf = it => {
        const bits = effectBits(it);
        if (it.type === 1) bits.unshift(`${it.min}–${it.max} damage`);
        return bits;
      };
      // Each shop keeps its own sort, and redraws only its own table.
      const build = () => {
        holder.innerHTML = '';
        tableInto(holder, [
          { h: 'Item', key: r => r.it.name, cell: r => itemNameCell(r.it) },
          { h: 'Kind', key: r => kindOf(r.it), cell: r => el('td', 'slotname', kindOf(r.it)) },
          { h: 'Price here', cls: 'num', key: r => buyCost(r.it, sh.markup, charm),
            title: 'Base value plus this shop’s markup, scaled by your Charm.',
            cell: r => el('td', 'num', priceText(buyCost(r.it, sh.markup, charm))) },
          { h: 'In stock', cls: 'num', dir: -1, key: r => r.max,
            cell: r => el('td', 'num', String(r.max)) },
          { h: 'Enc', cls: 'num', key: r => r.it.enc || 0,
            cell: r => el('td', 'num', (r.it.enc || 0).toLocaleString()) },
          { h: 'Effects', key: r => bitsOf(r.it).join(' · '),
            cell: r => el('td', 'bonus', bitsOf(r.it).join(' · ')) },
        ], rows, {
          id: 'shop:' + sh.n, sort: 0, redraw: build, cap: rows.length,
          tie: (a, b) => a.it.name.localeCompare(b.it.name),
        });
      };
      // Built on first open: 87 shops' worth of stock tables up front is a lot
      // of DOM for something you look at one shop at a time.
      let built = false;
      det.addEventListener('toggle', () => {
        if (built || !det.open) return;
        built = true;
        build();
      });
      det.append(holder);
      card.append(det);
    }
    box.append(card);
  }
}

/* ----------------------------------------------------------------- wire */

const TAB_RENDER = {
  spells: renderSpells, weapons: renderWeapons, armour: renderArmour,
  sundry: renderSundry, classes: renderClassRace, monsters: renderMonsters,
  shops: renderShops,
};

/* Every reference tab is quoted for the active character, so switching roster
 * slots has to redraw whichever one is open. */
function refreshActiveTab() {
  const active = document.querySelector('.tab.is-active');
  const fn = active && TAB_RENDER[active.dataset.tab];
  if (fn) fn();
}


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
    const render = TAB_RENDER[b.dataset.tab];
    if (render) render();
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

  const wire = (ids, fn) => ids.forEach(id => $('#' + id).addEventListener('input', fn));
  wire(['w-q','w-type','w-usable','w-ingame'], renderWeapons);
  wire(['a-q','a-slot','a-type','a-usable','a-ingame'], renderArmour);
  wire(['u-q','u-type','u-usable','u-ingame'], renderSundry);
  wire(['m-q','m-map','m-drops','m-ingame'], renderMonsters);
  wire(['sh-q','sh-tier','sh-sort','sh-on'], renderShops);

  ['sp-q','sp-known']
    .forEach(id => $('#' + id).addEventListener('input', renderSpells));
  ['sp-class','sp-level','sp-sc','sp-bonus','sp-align'].forEach(id =>
    $('#' + id).addEventListener('input', () => { spellsOverridden = true; renderSpells(); }));
  $('#sp-fromchar').addEventListener('click', () => {
    spellsOverridden = false; spellPrefsFromChar(); renderSpells();
  });

  renderResults(null);
}

document.addEventListener('DOMContentLoaded', init);
