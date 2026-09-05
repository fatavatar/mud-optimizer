#!/usr/bin/env python3
"""
Export a MajorMUD MegaMUD-format .mdb into a compact JS payload for the web tool.

Enum/ability semantics were reverse-engineered from the MMUD Explorer source
(github.com/syntax53/MMUD-Explorer): modMMudFunc.GetAbilityName,
modMain.GetAbilityStatSlot, frmMain.InvenAddEquip and frmMain.ItemIsUsableByChar.

Usage:  python3 build_db.py data-v1.11p.mdb  ->  data/gamedata.js
"""
import json, os, sys, re
from collections import defaultdict

from access_parser import AccessParser

# ---------------------------------------------------------------- enums

# Items.Worn -> equipment slot index (frmMain.InvenAddEquip)
WORN_TO_SLOT = {
    0: None,  # "Nowhere"
    1: 19,    # "Everywhere"
    2: 0,     # Head
    3: 8,     # Hands
    4: 9,     # Finger
    5: 13,    # Feet
    6: 5,     # Arms
    7: 3,     # Back
    8: 2,     # Neck
    9: 12,    # Legs
    10: 11,   # Waist
    11: 4,    # Torso
    12: 15,   # Off-Hand
    13: 10,   # Finger (2nd pool)
    14: 6,    # Wrist
    15: 1,    # Ears
    16: 14,   # "Worn" (trophies/emblems)
    18: 17,   # Eyes
    19: 18,   # Face
}

# Equipment slots. `pool` groups slots a single item type can fill (fingers/wrists),
# so a ring found for slot 9 is equally valid in slot 10.
SLOTS = [
    {"i": 0,  "name": "Head",      "pool": "head"},
    {"i": 1,  "name": "Ears",      "pool": "ears"},
    {"i": 17, "name": "Eyes",      "pool": "eyes"},
    {"i": 18, "name": "Face",      "pool": "face"},
    {"i": 2,  "name": "Neck",      "pool": "neck"},
    {"i": 3,  "name": "Back",      "pool": "back"},
    {"i": 4,  "name": "Torso",     "pool": "torso"},
    {"i": 5,  "name": "Arms",      "pool": "arms"},
    {"i": 6,  "name": "Wrist 1",   "pool": "wrist"},
    {"i": 7,  "name": "Wrist 2",   "pool": "wrist"},
    {"i": 8,  "name": "Hands",     "pool": "hands"},
    {"i": 9,  "name": "Finger 1",  "pool": "finger"},
    {"i": 10, "name": "Finger 2",  "pool": "finger"},
    {"i": 11, "name": "Waist",     "pool": "waist"},
    {"i": 12, "name": "Legs",      "pool": "legs"},
    {"i": 13, "name": "Feet",      "pool": "feet"},
    {"i": 14, "name": "Worn",      "pool": "worn"},
    {"i": 15, "name": "Off-Hand",  "pool": "offhand"},
    {"i": 16, "name": "Weapon",    "pool": "weapon"},
    {"i": 19, "name": "Everywhere","pool": "everywhere"},
]

ITEM_TYPES = {0: "Armour", 1: "Weapon", 2: "Projectile", 3: "Scenery", 4: "Food",
              5: "Drink", 6: "Light", 7: "Key", 8: "Container", 9: "Scroll", 10: "Misc"}

WEAPON_TYPES = {0: "1H Blunt", 1: "2H Blunt", 2: "1H Sharp", 3: "2H Sharp"}

# Classes.WeaponType -> which Items.WeaponType values are allowed
CLASS_WEAPON_OK = {
    0: [0], 1: [1], 2: [2], 3: [3],
    4: [0, 2], 5: [1, 3], 6: [2, 3], 7: [0, 1],
    8: [0, 1, 2, 3],          # All weapons
    9: [],                    # Staff -- only dagger(68)/quarterstaff(100) unless ClassOk
}
CLASS_WEAPON_NAMES = {0: "1H Blunt", 1: "2H Blunt", 2: "1H Sharp", 3: "2H Sharp",
                      4: "Any 1H", 5: "Any 2H", 6: "Any Sharp", 7: "Any Blunt",
                      8: "All Weapons", 9: "Staff"}
STAFF_CLASS_ITEM_EXCEPTIONS = [68, 100]   # dagger, quarterstaff (hardcoded in the game dll)

ARMOUR_TYPES = {0: "Cloth", 1: "Leather", 2: "Studded Leather", 3: "Chain",
                4: "Scale", 5: "Splint", 6: "Banded", 7: "Plate", 8: "Field Plate",
                9: "Full Plate"}

CURRENCY = {0: "Copper", 1: "Silver", 2: "Gold", 3: "Platinum", 4: "Runic"}
CURRENCY_IN_COPPER = {0: 1, 1: 10, 2: 100, 3: 10000, 4: 1000000}

# Ability code -> name (modMMudFunc.GetAbilityName, stock MajorMUD subset)
ABILITY_NAMES = {
    1:"Damage",2:"AC",3:"Resist-Cold",4:"MaxDamage",5:"Resist-Fire",6:"Enslave",7:"DR",
    8:"DrainLife",9:"Shadow",10:"AC Blur",11:"AlterEnergyLevel",12:"Summon",13:"Illu",
    14:"RoomIllu",15:"Alterhunger",16:"Alterthirst",17:"Damage(-MR)",18:"Heal",19:"Poison",
    20:"CurePoison",21:"ImmuPoison",22:"Accuracy",23:"AffectsUndeadOnly",24:"ProtEvil",
    25:"ProtGood",26:"DetectMagic",27:"Stealth",28:"Magical",29:"Punch",30:"Kick",31:"Bash",
    32:"Smash",33:"Killblow",34:"Dodge",35:"JumpKick",36:"M.R.",37:"Picklocks",38:"Tracking",
    39:"Thievery",40:"FindTraps",41:"DisarmTraps",42:"LearnSp",43:"CastsSp",44:"Intel",
    45:"Wisdom",46:"Strength",47:"Health",48:"Agility",49:"Charm",50:"MageBaneQuest",
    51:"AntiMagic",52:"EvilInCombat",53:"BlindingLight",54:"IlluTarget",55:"AlterLightDuration",
    56:"RechargeItem",57:"SeeHidden",58:"Crits",59:"ClassOk",60:"Fear",61:"AffectExit",
    62:"AlterEvilChance",63:"AlterExperience",64:"AddCP",65:"Resist-Stone",66:"Resist-Lightning",
    67:"Quickness",68:"Slowness",69:"MaxMana",70:"Spellcasting",71:"Confusion",72:"ShockShield",
    73:"DispellMagic",74:"HoldPerson",75:"Paralyze",76:"Mute",77:"Perception",78:"Animal",
    79:"MageBind",80:"AffectsAnimalsOnly",81:"Freedom",82:"Cursed",83:"CursedMajor",
    84:"RemoveCurse",85:"Shatter",86:"Quality",87:"Speed",88:"MaxHP",89:"PunchAcc",90:"KickAcc",
    91:"JumpKAcc",92:"PunchDmg",93:"KickDmg",94:"JumpKDmg",95:"Slay",96:"Encum%",97:"GoodOnly",
    98:"EvilOnly",99:"AlterDRpercent",100:"LoyalItem",101:"ConfuseMsg",102:"RaceStealth",
    103:"ClassStealth",104:"DefenseModifier",105:"Accuracy2",106:"Accuracy3",107:"BlindUser",
    108:"AffectsLivingOnly",109:"NonLiving",110:"NotGood",111:"NotEvil",112:"NeutralOnly",
    113:"NotNeutral",114:"%Spell",115:"DescMsg",116:"BSAccu",117:"BsMinDmg",118:"BsMaxDmg",
    119:"Del@Maint",120:"StartMsg",121:"Recharge",122:"RemovesSpell",123:"HPRegen",
    124:"NegateAbility",125:"IceSorcQuest",126:"GoodQuest",127:"NeutralQuest",128:"EvilQuest",
    129:"DarkDruidQuest",130:"BloodChampQuest",131:"SheDragonQuest",132:"WereratQuest",
    133:"PhoenixQuest",134:"DaoLordQuest",135:"MinLevel",136:"MaxLevel",137:"ShockMsg",
    138:"RoomVisible",139:"SpellImmu",140:"TeleportRoom",141:"TeleportMap",142:"HitMagic",
    143:"ClearItem",144:"NonMagicalSpell",145:"ManaRgn",146:"MonsGuards",147:"Resist-Water",
    148:"TextBlock",149:"Remove@Maint",150:"HealMana",151:"EndCast",152:"Rune",153:"KillSpell",
    154:"Visible@Maint",155:"DeathText",156:"QuestItem",157:"ScatterItems",158:"ReqToHit",
    159:"KaiBind",160:"GiveTempSpell",161:"OpenDoor",162:"Lore",163:"SpellComponent",
    164:"EndCast%",165:"AlterSpDmg",166:"AlterSpLength",167:"UnEquipItem",168:"EquipItem",
    169:"CannotWearLocation",170:"Sleep",171:"Invisibility",172:"SeeInvisible",173:"Scry",
    174:"StealMana",175:"StealHPtoMP",176:"StealMPtoHP",177:"SpellColours",178:"Shadowform",
    179:"FindTrapsValue",180:"PickLocksValue",181:"GHouseDeed",182:"GHouseTax",183:"GHouseItem",
    184:"GShopItem",185:"NoAttackIfItemNum",186:"PerfectStealth",187:"Meditate",
}

# Ability code -> character stat key (modMain.GetAbilityStatSlot)
ABILITY_TO_STAT = {
    2:"ac", 10:"ac", 7:"dr", 4:"maxdmg", 3:"resCold", 5:"resFire", 65:"resStone",
    66:"resLightning", 147:"resWater", 13:"illu", 14:"illu", 22:"accy", 105:"accy",
    106:"accy", 24:"protEvil", 25:"protGood", 27:"stealth", 34:"dodge", 36:"mr",
    37:"picklocks", 180:"picklocks", 40:"traps", 179:"traps", 44:"int", 45:"wil",
    46:"str", 47:"hea", 48:"agi", 49:"cha", 58:"crits", 67:"quickness", 69:"mana",
    70:"sc", 77:"perception", 88:"hp", 96:"encumPct", 116:"bsAccy", 117:"bsMinDmg",
    118:"bsMaxDmg", 123:"hpRegen", 142:"hitMagic", 145:"manaRegen", 165:"alterSpellDmg",
    29:"punchSkill", 30:"kickSkill", 35:"jumpkickSkill",
    89:"punchAccy", 90:"kickAccy", 91:"jumpkickAccy",
    92:"punchDmg", 93:"kickDmg", 94:"jumpkickDmg",
}
# Abilities stored x10 in the database (DR only; the AC ability is raw)
STAT_SCALE = {7: 0.1}
# Accuracy does not stack: only the single largest value across all gear applies.
NON_STACKING = {"accy"}

STAT_LABELS = {
    "ac":"AC","dr":"DR","maxdmg":"Max Dmg","str":"Strength","int":"Intellect","wil":"Willpower",
    "agi":"Agility","hea":"Health","cha":"Charm","hp":"Max HP","mana":"Max Mana","crits":"Crits",
    "dodge":"Dodge","sc":"Spellcasting","accy":"Accuracy","hitMagic":"Hit Magic",
    "bsAccy":"BS Accuracy","bsMinDmg":"BS Min Dmg","bsMaxDmg":"BS Max Dmg","hpRegen":"HP Regen",
    "manaRegen":"Mana Regen","perception":"Perception","stealth":"Stealth","protEvil":"Prot. Evil",
    "protGood":"Prot. Good","traps":"Traps","picklocks":"Picklocks","illu":"Illuminate",
    "mr":"Magic Resist","resStone":"Resist Stone","resWater":"Resist Water","resFire":"Resist Fire",
    "resCold":"Resist Cold","resLightning":"Resist Lightning","quickness":"Quickness",
    "encumPct":"Encum %","alterSpellDmg":"Spell Dmg","punchDmg":"Punch Dmg","kickDmg":"Kick Dmg",
    "jumpkickDmg":"Jumpkick Dmg","punchSkill":"Punch Skill","kickSkill":"Kick Skill",
    "jumpkickSkill":"Jumpkick Skill","punchAccy":"Punch Accy","kickAccy":"Kick Accy",
    "jumpkickAccy":"Jumpkick Accy",
}

ALIGN_ONLY = {97: "good", 98: "evil", 112: "neutral"}
ALIGN_NOT  = {110: "good", 111: "evil", 113: "neutral"}

JUNK = (8224,)   # 0x2020 -- unset padding in the AbilVal columns


def rows_of(db, table):
    tb = db.parse_table(table)
    cols = list(tb.keys())
    n = len(tb[cols[0]])
    return [{c: tb[c][i] for c in cols} for i in range(n)]


def num(v, default=0):
    return v if isinstance(v, (int, float)) else default


def build_item(r):
    abils = []
    for k in range(20):
        code = num(r.get(f"Abil-{k}"))
        val = num(r.get(f"AbilVal-{k}"))
        if not code or code in JUNK:
            continue
        abils.append((int(code), int(val)))

    stats, non_stacking, flags = {}, {}, {}
    min_level = max_level = None
    class_ok, casts, negates_ability = [], [], []

    for code, val in abils:
        key = ABILITY_TO_STAT.get(code)
        if key:
            scaled = val * STAT_SCALE.get(code, 1)
            if key in NON_STACKING:
                non_stacking[key] = max(non_stacking.get(key, 0), scaled)
            else:
                stats[key] = round(stats.get(key, 0) + scaled, 2)
        if code == 135: min_level = val
        elif code == 136: max_level = val
        elif code == 59 and val > 0: class_ok.append(val)
        elif code == 28: flags["magical"] = True
        elif code in (82, 83): flags["cursed"] = True
        elif code == 100: flags["loyal"] = True
        elif code == 156: flags["quest"] = True
        elif code == 43: casts.append(val)
        elif code == 124: negates_ability.append(val)
        elif code in ALIGN_ONLY: flags["alignOnly"] = ALIGN_ONLY[code]
        elif code in ALIGN_NOT: flags.setdefault("alignNot", []).append(ALIGN_NOT[code])

    # The item's own AC / DR columns stack on top of any AC/DR abilities. Both
    # columns are stored x10 (frmMain: nAC = ArmourClass / 10, nDR = DamageResist / 10).
    # Note the AC *ability* (code 2 / 10) is NOT scaled -- MME adds it raw.
    ac = num(r.get("ArmourClass")) / 10.0
    dr = num(r.get("DamageResist")) / 10.0
    if ac: stats["ac"] = round(stats.get("ac", 0) + ac, 2)
    if dr: stats["dr"] = round(stats.get("dr", 0) + dr, 2)

    worn = int(num(r.get("Worn")))
    itype = int(num(r.get("ItemType")))
    slot = WORN_TO_SLOT.get(worn) if itype == 0 else (16 if itype == 1 else None)

    it = {
        "n": int(num(r.get("Number"))),
        "name": str(r.get("Name") or "").strip(),
        "type": itype,
        "worn": worn,
        "slot": slot,
        "enc": int(num(r.get("Encum"))),
        "price": int(num(r.get("Price"))),
        "cur": int(num(r.get("Currency"))),
        "limit": int(num(r.get("Limit"))),
        "stats": stats,
        "inGame": bool(num(r.get("In Game"))),
    }
    if non_stacking: it["ns"] = non_stacking
    if itype == 1:
        it["min"] = int(num(r.get("Min")))
        it["max"] = int(num(r.get("Max")))
        it["wtype"] = int(num(r.get("WeaponType")))
        it["speed"] = int(num(r.get("Speed")))
        it["strReq"] = int(num(r.get("StrReq")))
    if itype == 0:
        it["atype"] = int(num(r.get("ArmourType")))
    accy = int(num(r.get("Accy")))
    if accy: it["accy"] = accy
    if min_level: it["minLvl"] = min_level
    if max_level: it["maxLvl"] = max_level
    if class_ok: it["classOk"] = class_ok
    if casts: it["casts"] = casts
    if flags: it["flags"] = flags

    cr = [int(num(r.get(f"ClassRest-{i}"))) for i in range(10)]
    cr = [c for c in cr if c]
    if cr: it["classRest"] = cr
    rr = [int(num(r.get(f"RaceRest-{i}"))) for i in range(10)]
    rr = [c for c in rr if c]
    if rr: it["raceRest"] = rr

    obtained = str(r.get("Obtained From") or "").strip()
    if obtained: it["from"] = obtained
    it["abils"] = abils
    return it


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else "data-v1.11p.mdb"
    outdir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
    os.makedirs(outdir, exist_ok=True)

    db = AccessParser(src)
    info = rows_of(db, "Info")[0]

    items = [build_item(r) for r in rows_of(db, "Items")]
    items = [i for i in items if i["name"]]

    classes = []
    for r in rows_of(db, "Classes"):
        abils = [(int(num(r.get(f"Abil-{k}"))), int(num(r.get(f"AbilVal-{k}"))))
                 for k in range(10) if num(r.get(f"Abil-{k}"))]
        classes.append({
            "n": int(num(r["Number"])), "name": str(r["Name"]).strip(),
            "minHits": int(num(r.get("MinHits"))), "maxHits": int(num(r.get("MaxHits"))),
            "magery": int(num(r.get("MageryType"))), "mageryLvl": int(num(r.get("MageryLVL"))),
            "weaponType": int(num(r.get("WeaponType"))),
            "armourType": int(num(r.get("ArmourType"))),
            # GetClassCombat subtracts 2 from the stored value
            "combat": int(num(r.get("CombatLVL"))) - 2,
            "abils": abils,
        })

    races = []
    for r in rows_of(db, "Races"):
        abils = [(int(num(r.get(f"Abil-{k}"))), int(num(r.get(f"AbilVal-{k}"))))
                 for k in range(10) if num(r.get(f"Abil-{k}"))]
        races.append({
            "n": int(num(r["Number"])), "name": str(r["Name"]).strip(),
            "min": {"int": int(num(r.get("mINT"))), "wil": int(num(r.get("mWIL"))),
                    "str": int(num(r.get("mSTR"))), "hea": int(num(r.get("mHEA"))),
                    "agi": int(num(r.get("mAGL"))), "cha": int(num(r.get("mCHM")))},
            "max": {"int": int(num(r.get("xINT"))), "wil": int(num(r.get("xWIL"))),
                    "str": int(num(r.get("xSTR"))), "hea": int(num(r.get("xHEA"))),
                    "agi": int(num(r.get("xAGL"))), "cha": int(num(r.get("xCHM")))},
            "hpPerLvl": int(num(r.get("HPPerLVL"))), "abils": abils,
        })

    # Room names, so a shop can be reported as a place rather than a number.
    room_name = {}
    rt = db.parse_table("Rooms")
    for i in range(len(rt["Map Number"])):
        nm = str(rt["Name"][i] or "").strip()
        if nm:
            room_name[(rt["Map Number"][i], rt["Room Number"][i])] = nm

    def locations(assigned):
        """'Room 1/334, Room 6/1334' -> [{'map':1,'room':334,'name':'General Store'}, ...]"""
        out = []
        for mp, rm in re.findall(r"Room\s+(\d+)\s*/\s*(\d+)", str(assigned or "")):
            mp, rm = int(mp), int(rm)
            loc = {"map": mp, "room": rm}
            nm = room_name.get((mp, rm))
            if nm:
                loc["name"] = nm
            out.append(loc)
        return out

    # Shops. A stock entry with Max == 0 is not for sale there -- that is the
    # recycler / sell-only case MME renders as "Shop(sell) #n".
    shops = []
    buy_at = {}       # item number -> [[shop number, max stock], ...]
    for r in rows_of(db, "Shops"):
        if not num(r.get("In Game")):
            continue
        snum = int(num(r["Number"]))
        markup = int(num(r.get("Markup%")))
        stocked = []
        for k in range(20):
            inum = int(num(r.get(f"Item-{k}")))
            mx = int(num(r.get(f"Max-{k}")))
            if inum and mx > 0:
                stocked.append(inum)
                buy_at.setdefault(inum, []).append([snum, mx])
        if not stocked:
            continue
        shop = {
            "n": snum,
            "name": str(r.get("Name") or "").strip(),
            "markup": markup,
            "classRest": int(num(r.get("ClassRest"))),
            "locs": locations(r.get("Assigned To")),
        }
        shops.append(shop)

    # Per-map difficulty hint, from the monsters actually placed in that map's
    # rooms. There is no "shop level" field in the data (Shops.MinLVL/MaxLVL is
    # the training range for trainers), so region is the only real proxy for
    # whether a low-level character can physically reach a shop.
    mon_exp = {}
    mtab = db.parse_table("Monsters")
    for i in range(len(mtab["Number"])):
        mon_exp[mtab["Number"][i]] = num(mtab["EXP"][i])

    map_rooms, map_mobs = defaultdict(int), defaultdict(list)
    for i in range(len(rt["Map Number"])):
        mp = rt["Map Number"][i]
        map_rooms[mp] += 1
        npc = rt["NPC"][i]
        if isinstance(npc, int) and npc and mon_exp.get(npc):
            map_mobs[mp].append(mon_exp[npc])

    def tier_of(exp):
        if exp < 100:   return "starter"
        if exp < 2000:  return "low"
        if exp < 10000: return "moderate"
        if exp < 25000: return "high"
        return "extreme"

    shop_markup = {s["n"]: s["markup"] for s in shops}
    for it in items:
        entries = buy_at.get(it["n"])
        if not entries:
            continue
        it["buy"] = entries
        # cheapest markup among the shops that actually stock it
        it["shopMarkup"] = min(shop_markup[e[0]] for e in entries)

    # Only describe maps that actually contain a shop.
    shop_maps = {l["map"] for s in shops for l in s["locs"]}
    maps = []
    for mp in sorted(shop_maps):
        exps = sorted(map_mobs.get(mp, []))
        med = exps[len(exps) // 2] if exps else 0
        maps.append({
            "n": mp,
            "rooms": map_rooms.get(mp, 0),
            "shops": sum(1 for s in shops if any(l["map"] == mp for l in s["locs"])),
            "mobSample": len(exps),
            "medExp": int(med),
            "tier": tier_of(med),
        })

    payload = {
        "meta": {
            "source": os.path.basename(src),
            "datVersion": str(info.get("Dat File Version") or "").strip(),
            "nmrVersion": str(info.get("NMR Version") or "").strip(),
            "itemCount": len(items),
        },
        "slots": SLOTS,
        "wornToSlot": {str(k): v for k, v in WORN_TO_SLOT.items()},
        "itemTypes": ITEM_TYPES,
        "weaponTypes": WEAPON_TYPES,
        "armourTypes": ARMOUR_TYPES,
        "classWeaponOk": CLASS_WEAPON_OK,
        "classWeaponNames": CLASS_WEAPON_NAMES,
        "staffExceptions": STAFF_CLASS_ITEM_EXCEPTIONS,
        "currency": CURRENCY,
        "currencyInCopper": CURRENCY_IN_COPPER,
        "abilityNames": ABILITY_NAMES,
        "statLabels": STAT_LABELS,
        "nonStacking": sorted(NON_STACKING),
        "classes": classes,
        "races": races,
        "items": items,
        "shops": shops,
        "maps": maps,
    }

    js = os.path.join(outdir, "gamedata.js")
    with open(js, "w") as f:
        f.write("// Generated by build_db.py -- do not edit by hand.\n")
        f.write("window.GAMEDATA = ")
        json.dump(payload, f, separators=(",", ":"))
        f.write(";\n")

    print(f"wrote {js}  ({os.path.getsize(js)/1024:.0f} KB)")
    print(f"  items={len(items)}  classes={len(classes)}  races={len(races)}  shops={len(shops)}")
    print(f"  dat version={payload['meta']['datVersion']}  nmr={payload['meta']['nmrVersion']}")


if __name__ == "__main__":
    main()
