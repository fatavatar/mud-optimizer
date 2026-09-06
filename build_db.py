#!/usr/bin/env python3
"""
Export a MajorMUD MegaMUD-format .mdb into a compact JS payload for the web tool.

Enum/ability semantics were reverse-engineered from the MMUD Explorer source
(github.com/syntax53/MMUD-Explorer): modMMudFunc.GetAbilityName,
modMain.GetAbilityStatSlot, frmMain.InvenAddEquip and frmMain.ItemIsUsableByChar.

Usage:  python3 build_db.py data-v1.11p.mdb  ->  data/gamedata.js
"""
import json, os, sys, re
from collections import Counter, defaultdict

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


# ---------------------------------------------------------------- spells

# modMMudFunc.GetMageryEnum
MAGERY_NAMES = {0: "None", 1: "Mage", 2: "Priest", 3: "Druid", 4: "Bard", 5: "Kai"}

# modMain.AddSpell2LV (the Select Case over Targets)
SPELL_TARGETS = {
    0: "User", 1: "Self", 2: "Self or user", 3: "Divided area (not self)",
    4: "Monster", 5: "Divided area (incl. self)", 6: "Any", 7: "Item",
    8: "Monster or user", 9: "Divided attack area", 10: "Divided party area",
    11: "Full area", 12: "Full attack area", 13: "Full party area",
}

# modMMudFunc.SpellAttackTypeEnum
SPELL_ATT_TYPES = {
    0: "Cold", 1: "Fire", 2: "Stone", 3: "Lightning",
    4: "Normal", 5: "Water", 6: "Poison",
}

# modMain: TypeOfResists, nmr >= 1.8
SPELL_RESISTS = {
    0: "Cannot be fully resisted",
    1: "Fully resistable by anti-magic only",
    2: "Fully resistable by all",
}

# GetSpellMinDamage / GetSpellMaxDamage scan Abil-0..9 for these.
SPELL_DAMAGE_ABILS = {1, 8, 17}     # 1 damage, 8 drain life, 17 damage vs MR
SPELL_HEAL_ABILS = {8, 18}          # 8 drains into a heal, 18 heals outright
SPELL_ENDCAST_ABIL = 151            # chains into another spell

# SpellIsUsable: alignment gates carried as abilities.
SPELL_ALIGN_IS = {97: "good", 98: "evil", 112: "neutral"}
SPELL_ALIGN_NOT = {110: "good", 111: "evil", 113: "neutral"}


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
    class_ok, casts, learns, negates_ability = [], [], [], []

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
        elif code == 42: learns.append(val)      # LearnSp: a scroll or tome
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
    if learns: it["learns"] = learns
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


# ------------------------------------------------------------------- maps
#
# The rooms are a graph, not a picture: every room lists the room each of its
# ten exits leads to and nothing else. Coordinates have to be invented, which is
# what this does -- walk the graph and put each room one cell from its neighbour
# in the direction the exit points, so the result reads like the map you draw in
# your head while playing.
#
# Up and down get no cell of their own: they connect places that would sit on
# top of each other. They stay as links you click instead, which is also how a
# room reaches another map.

# Screen coordinates: y grows south, the way a canvas does.
PLANAR = [("N", 0, -1), ("S", 0, 1), ("E", 1, 0), ("W", -1, 0),
          ("NE", 1, -1), ("NW", -1, -1), ("SE", 1, 1), ("SW", -1, 1)]
DIR_NAMES = [d for d, _, _ in PLANAR] + ["U", "D"]
EXIT_RE = re.compile(r"^(\d+)/(\d+)\s*(.*)$")


def parse_exit(v):
    """'1/1381 (Door)' -> (1, 1381, '(Door)'); anything else -> None.

    A few exits are prefixed with the action that works them --
    "Action [on the E exit of this room]: use fork east ... (Item: 983)" --
    so the room/map pair is looked for anywhere in the string, not just at the
    front."""
    v = str(v or "").strip()
    if not v or v == "0":
        return None
    m = EXIT_RE.match(v)
    if m:
        return int(m.group(1)), int(m.group(2)), m.group(3).strip()
    m = re.search(r"(\d+)/(\d+)", v)
    if not m:
        return None
    return int(m.group(1)), int(m.group(2)), v.strip()


def layout_map(rooms, adj, nudge=0):
    """Turn the room graph into cells.

    Every room is placed exactly where its neighbour's exit says it goes. When
    that cell is already taken the room is left for later, because another of
    its exits may still place it correctly; and when nothing can place it, it
    starts a *new area* rather than being put somewhere approximate.

    That last part is the whole point. The world is not flat -- walk a loop that
    does not close and two rooms want the same cell -- and the obvious repair,
    dropping the room in the nearest free space, is what turns a map into soup:
    the sewers end up drawn through the streets above them and the forest
    through the town. Tearing instead keeps every area internally true, and the
    exits between areas become links you click, the same as a stair.

    Returns {room: (area, x, y)} and the list of areas as {room: (x, y)}."""
    placed, areas = {}, []
    left = set(rooms)
    nudged = 0
    while left:
        # grow each area from its busiest room: a hub lays out straighter than
        # a dead end does
        seed = max(sorted(left), key=lambda r: len(adj.get(r, ())))
        pos = {seed: (0, 0)}
        taken = {(0, 0): seed}
        queue = [seed]
        pending = set()
        while True:
            while queue:
                cur = queue.pop(0)
                cx, cy = pos[cur]
                for nb, dx, dy in adj.get(cur, ()):
                    if nb in pos or nb not in left:
                        continue
                    cell = (cx + dx, cy + dy)
                    if cell in taken:
                        pending.add(nb)
                        continue
                    pos[nb] = cell
                    taken[cell] = nb
                    queue.append(nb)
                    pending.discard(nb)
            # a room the wave passed over may fit now that more of its
            # neighbours are down
            again = False
            for r in sorted(pending):
                if r in pos:
                    continue
                for nb, dx, dy in adj.get(r, ()):
                    if nb not in pos:
                        continue
                    cell = (pos[nb][0] - dx, pos[nb][1] - dy)
                    if cell in taken:
                        continue
                    pos[r] = cell
                    taken[cell] = r
                    queue.append(r)
                    again = True
                    break
            if not again:
                break
        # A cell of give, off by default: a room a cell away from where its exit
        # says it is reads as a mistake, and the mistakes compound along a
        # corridor until the map is soup.
        if nudge:
            moving = True
            while moving:
                moving = False
                for r in sorted(pending):
                    if r in pos:
                        continue
                    best = None
                    for nb, dx, dy in adj.get(r, ()):
                        if nb not in pos:
                            continue
                        ix, iy = pos[nb][0] - dx, pos[nb][1] - dy
                        for ox in range(-nudge, nudge + 1):
                            for oy in range(-nudge, nudge + 1):
                                cell = (ix + ox, iy + oy)
                                if cell in taken:
                                    continue
                                d = abs(ox) + abs(oy)
                                if best is None or d < best[0]:
                                    best = (d, cell)
                    if best:
                        pos[r] = best[1]
                        taken[best[1]] = r
                        nudged += 1
                        moving = True
        for r in pos:
            left.discard(r)
        areas.append(pos)

    areas.sort(key=lambda a: (-len(a), min(a)))
    for i, pos in enumerate(areas):
        for r, (x, y) in pos.items():
            placed[r] = (i, x, y)
    return placed, areas, nudged


def pack(boxes, gap=4):
    """Shelf-pack the disconnected pieces of a map onto one plane, biggest
    first, so panning the map shows all of it rather than one piece at a time."""
    if not boxes:
        return []
    order = sorted(range(len(boxes)), key=lambda i: (-boxes[i][1] * boxes[i][0], i))
    total = sum(w * h for w, h in boxes)
    width = max(max(w for w, _ in boxes), int((total ** 0.5) * 1.6))
    out = [None] * len(boxes)
    x = y = row_h = 0
    for i in order:
        w, h = boxes[i]
        if x and x + w > width:
            x, y, row_h = 0, y + row_h + gap, 0
        out[i] = (x, y)
        x += w + gap
        row_h = max(row_h, h)
    return out


def export_maps(db, outdir, monsters_by_num, shops_by_num, spell_names, item_names):
    rt = db.parse_table("Rooms")
    tb = db.parse_table("TBInfo")
    actions = {tb["Number"][i]: str(tb["Action"][i] or "")
               for i in range(len(tb["Number"]))}

    n = len(rt["Room Number"])
    by_map = defaultdict(list)
    for i in range(n):
        by_map[int(num(rt["Map Number"][i]))].append(i)

    index, files = [], []
    for mp in sorted(by_map):
        idxs = by_map[mp]
        rows = {}
        for i in idxs:
            rows[int(num(rt["Room Number"][i]))] = i

        # Room names read "Slum Street, by the well", so the part before the
        # comma is the place the room is in.
        place = {rn: str(rt["Name"][i] or "").split(",")[0].strip().lower()
                 for rn, i in rows.items()}

        # Planar adjacency, this map only: up, down and cross-map exits are
        # links you click, not steps on the grid.
        #
        # A diagonal only lays out ground inside one place. Diagonals are how a
        # wood or a cave system is threaded together, so throwing them away
        # would shatter Darkwood Forest into four hundred pieces -- but a
        # diagonal that leaves a place is what welds the wood onto the town
        # beside it, and then the two are drawn through each other. Between
        # places, only a plain compass step lays out ground; anything else
        # becomes a different space you click into, the same as a stair.
        adj = defaultdict(list)
        for rn, i in rows.items():
            for d, dx, dy in PLANAR:
                ex = parse_exit(rt[d][i])
                if not (ex and ex[0] == mp and ex[1] in rows):
                    continue
                if len(d) == 2 and place[rn] != place[ex[1]]:
                    continue
                adj[rn].append((ex[1], dx, dy))
                adj[ex[1]].append((rn, -dx, -dy))

        order = sorted(rows)
        for rn in adj:
            adj[rn] = sorted(set(adj[rn]))
        placed_raw, area_pos, nudged = layout_map(order, adj, nudge=0)

        boxes, raw = [], []
        for pos in area_pos:
            xs = [p[0] for p in pos.values()]
            ys = [p[1] for p in pos.values()]
            x0, y0 = min(xs), min(ys)
            pos = {r: (x - x0, y - y0) for r, (x, y) in pos.items()}
            raw.append(pos)
            boxes.append((max(xs) - x0 + 1, max(ys) - y0 + 1))

        offsets = pack(boxes, gap=6)
        placed, areas = {}, []
        for pos, (w, h), (ox, oy) in zip(raw, boxes, offsets):
            ai = len(areas)
            for r, (x, y) in pos.items():
                placed[r] = (x + ox, y + oy, ai)
            # An area is named for the commonest thing its rooms are called:
            # room names read "Orc Barracks, Bunk Room", so the part before the
            # comma is the place.
            # A one- or two-room area is named for the room itself; a bigger one
            # for the commonest place among its rooms, since room names read
            # "Orc Barracks, Bunk Room".
            if len(pos) <= 2:
                label = str(rt["Name"][rows[min(pos)]] or "").strip()
            else:
                names = Counter(str(rt["Name"][rows[r]] or "").split(",")[0].strip()
                                for r in pos)
                top = names.most_common()
                label = top[0][0] if top else ""
                # A big area is often several places at once -- a town is a
                # dozen streets -- so when no one name covers it, name it after
                # the two biggest. The second has to say something the first
                # does not: "Slum Street / Street" reads like a bug.
                if len(top) > 1 and top[0][1] < 0.4 * len(pos):
                    other = next((n for n, _ in top[1:]
                                  if n.lower() not in label.lower()
                                  and label.lower() not in n.lower()), None)
                    if other:
                        label = f"{label} / {other}"
            areas.append({"label": label or f"area {ai + 1}", "x": ox, "y": oy,
                          "w": w, "h": h, "rooms": len(pos), "seed": min(pos)})

        # The map is named after its biggest area, before the areas that share a
        # name are numbered -- "Dragon's Teeth Hills", not "Dragon's Teeth Hills 1".
        map_label = max(areas, key=lambda a: a["rooms"])["label"] if areas else ""

        seen_labels = Counter()
        for a in areas:
            seen_labels[a["label"]] += 1
        used = Counter()
        for a in areas:
            if seen_labels[a["label"]] > 1:
                used[a["label"]] += 1
                a["label"] = f'{a["label"]} {used[a["label"]]}'

        name_ids, name_list = {}, []
        ann_ids, ann_list = {}, [""]
        ann_ids[""] = 0

        def name_id(s):
            if s not in name_ids:
                name_ids[s] = len(name_list)
                name_list.append(s)
            return name_ids[s]

        def ann_id(s):
            if s not in ann_ids:
                ann_ids[s] = len(ann_list)
                ann_list.append(s)
            return ann_ids[s]

        rooms_out, exits_out = [], []
        lair_out, item_out, spell_out, cmd_out = {}, {}, {}, {}
        for rn in order:
            i = rows[rn]
            x, y, ai = placed.get(rn, (0, 0, 0))
            light = int(num(rt["Light"][i]))
            shop = int(num(rt["Shop"][i]))
            npc = int(num(rt["NPC"][i]))
            spell = int(num(rt["Spell"][i]))
            cmd = int(num(rt["CMD"][i]))

            lair = [int(x_) for x_ in re.findall(r"\d+", str(rt["Lair"][i] or "").split("[")[0].split(":")[-1])]
            lair = [m for m in lair if m in monsters_by_num]
            if lair:
                lair_out[rn] = lair
            items = [int(x_) for x_ in re.findall(r"\d+", str(rt["Placed"][i] or ""))]
            items = [it for it in items if it in item_names]
            if items:
                item_out[rn] = items
            if spell:
                spell_out[rn] = spell
            if cmd and actions.get(cmd):
                # "go vortex:adddelay 5:minlevel 20 1220:message 1205" -- the
                # part before the first colon is what you actually type.
                cmds = []
                for line in actions[cmd].splitlines():
                    line = line.strip()
                    if line:
                        cmds.append(line.split(":")[0].strip())
                if cmds:
                    cmd_out[rn] = sorted(set(cmds))[:8]

            flags = 0
            if light < 0:
                flags |= 1
            if rn in lair_out:
                flags |= 2
            if rn in item_out:
                flags |= 4
            if rn in spell_out:
                flags |= 8
            if rn in cmd_out:
                flags |= 16

            for di, d in enumerate(DIR_NAMES):
                ex = parse_exit(rt[d][i])
                if not ex:
                    continue
                tm, tr, ann = ex
                exits_out.append([rn, di, tm, tr, ann_id(ann)])
                if d == "U":
                    flags |= 32
                elif d == "D":
                    flags |= 64
                if tm != mp:
                    flags |= 128

            rooms_out.append([rn, name_id(str(rt["Name"][i] or "").strip()),
                              x, y, ai, flags, shop if shop in shops_by_num else 0,
                              npc if npc in monsters_by_num else 0])

        # How many exits could be drawn as a neat one-cell step, out of the
        # planar ones inside this map -- a loop that does not close on a grid
        # cannot be, and is drawn as a stretched line instead.
        planar = seams = exact = 0
        for rn, di, tm, tr, _ in exits_out:
            if di >= 8 or tm != mp or tr not in placed:
                continue
            planar += 1
            ax, ay, aa = placed[rn]
            bx, by, ba = placed[tr]
            if aa != ba:
                seams += 1
            elif (bx - ax, by - ay) == PLANAR[di][1:]:
                exact += 1

        w = max((r[2] for r in rooms_out), default=0) + 1
        h = max((r[3] for r in rooms_out), default=0) + 1
        payload = {
            "n": mp, "w": w, "h": h,
            "names": name_list, "anns": ann_list, "areas": areas,
            "rooms": rooms_out, "exits": exits_out,
            "lair": lair_out, "items": item_out, "spell": spell_out, "cmd": cmd_out,
        }
        path = os.path.join(outdir, "maps", f"map-{mp}.js")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write("// Generated by build_db.py -- do not edit by hand.\n")
            f.write("window.MAPDATA = window.MAPDATA || {};\nwindow.MAPDATA[%d] = " % mp)
            json.dump(payload, f, separators=(",", ":"))
            f.write(";\n")
        files.append((mp, os.path.getsize(path)))
        index.append({
            "n": mp, "rooms": len(rooms_out), "areas": len(areas),
            "w": w, "h": h, "exits": len(exits_out),
            "exact": exact, "planar": planar, "seams": seams, "nudged": nudged,
            "label": map_label,
        })
    return index, files


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
    mrows = len(mtab["Number"])
    for i in range(mrows):
        mon_exp[mtab["Number"][i]] = num(mtab["EXP"][i])

    # Where a monster is found. Two different room columns say so, and they mean
    # different things, so they are used for different jobs:
    #
    #   Rooms.NPC   the one monster fixed to that room
    #   Rooms.Lair  "(Max 3): 827,925,926" -- everything that can lair there
    #
    # The map difficulty tier deliberately reads NPC only. Lair lists name every
    # wanderer that passes through, so folding them in drowns the median in
    # common trash: map 12 drops from a median of 45,000 exp to 55 and reads as
    # a starter zone, which it very much is not. For *locating* a monster the
    # lairs are exactly what you want, and they take the coverage from 336
    # monsters to 889.
    mon_maps = defaultdict(set)
    mon_room = {}
    map_rooms, map_mobs = defaultdict(int), defaultdict(list)
    for i in range(len(rt["Map Number"])):
        mp = rt["Map Number"][i]
        map_rooms[mp] += 1
        room_name = str(rt["Name"][i] or "").strip()

        npc = rt["NPC"][i]
        if isinstance(npc, int) and npc and mon_exp.get(npc):
            map_mobs[mp].append(mon_exp[npc])

        here = [npc] if isinstance(npc, int) and npc else []
        lair = str(rt["Lair"][i] or "")
        if lair:
            here += [int(x) for x in re.findall(r"\d+", lair.split(":", 1)[-1])]
        for mn_ in here:
            if mn_ in mon_exp:
                mon_maps[mn_].add(mp)
                mon_room.setdefault(mn_, room_name)

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

    # ------------------------------------------------------- monster drops
    #
    # Plenty of the best gear is never sold anywhere -- you take it off
    # something. Monsters.DropItem-0..9 is the drop table and DropItem%-N the
    # chance, as a plain percentage.
    drop_of = defaultdict(list)          # item number -> [[monster, pct], ...]
    for i in range(mrows):
        mnum = int(num(mtab["Number"][i]))
        for k in range(10):
            d = int(num(mtab[f"DropItem-{k}"][i]))
            pct = int(num(mtab[f"DropItem%-{k}"][i]))
            # A 0% row is a dead entry -- the monster is listed but never drops
            # it, so it is not a source. MME clamps the other end at 100.
            if d and pct > 0:
                drop_of[d].append([mnum, min(100, pct)])

    item_nums = {it["n"] for it in items}
    wanted_mons = set()
    for it in items:
        entries = drop_of.get(it["n"])
        if not entries:
            continue
        # Best chance first: that is the one worth hunting.
        entries.sort(key=lambda e: (-e[1], e[0]))
        it["drop"] = entries
        wanted_mons.update(e[0] for e in entries)

    # Every monster is exported, not just the ones carrying loot: the Monsters
    # tab is a bestiary, and "what else is in this room" is exactly the question
    # you have when a drop is 2%. `wanted_mons` still marks the droppers.
    monsters = []
    for i in range(mrows):
        mnum = int(num(mtab["Number"][i]))
        where = sorted(mon_maps.get(mnum, ()))
        # A monster swings with up to five different attacks. Only AttType 1 is
        # a physical swing whose AttMin/AttMax are damage: on an AttType 2
        # (a spell or special) AttMin is a flat 100 on all 507 such rows and
        # plainly means something else, so folding those in would report a
        # violet spore as hitting for "100-10". Their combined spread is the
        # honest damage range; AvgDmg is the game's own summary, which already
        # weights each attack by how often it is used. Two rows in the table
        # have the pair the wrong way round, hence the min/max on each row.
        lo, hi, atts, special = 0, 0, 0, 0
        for k in range(5):
            atype = int(num(mtab[f"AttType-{k}"][i]))
            amin = int(num(mtab[f"AttMin-{k}"][i]))
            amax = int(num(mtab[f"AttMax-{k}"][i]))
            if atype == 2 and (amin or amax):
                special += 1
                continue
            if atype != 1 or not amax:
                continue
            atts += 1
            lo = min(amin, amax) if not lo else min(lo, amin, amax)
            hi = max(hi, amin, amax)
        m = {
            "n": mnum,
            "name": str(mtab["Name"][i] or "").strip(),
            "exp": int(num(mtab["EXP"][i])),
            "hp": int(num(mtab["HP"][i])),
            "ac": int(num(mtab["ArmourClass"][i])),
            "mr": int(num(mtab["MagicRes"][i])),
            "maps": where,
            "room": mon_room.get(mnum, ""),
            "inGame": bool(num(mtab["In Game"][i])),
        }
        if atts:
            m["dmg"] = [lo, hi]
            m["atts"] = atts
        if special:
            m["special"] = special
        if num(mtab["AvgDmg"][i]):
            m["avgDmg"] = int(num(mtab["AvgDmg"][i]))
        if num(mtab["Undead"][i]):
            m["undead"] = True
        if num(mtab["MagicRes"][i]) == 0:
            m.pop("mr")
        monsters.append(m)
    monsters.sort(key=lambda m: m["n"])

    # ------------------------------------------------------------- spells
    #
    # Only spells a player class can actually learn and cast are exported. The
    # table also holds ~1,100 monster attacks and item procs; SpellIsUsable with
    # bAndLearnable is what separates them, and without it a Warrior "knows" 849
    # spells. Magery, learnability and the class-restriction string are settled
    # here; ReqLevel and alignment stay in the browser, where they depend on the
    # character rather than on the database.
    # "v1.8.3" -> 1.8. MME only ever compares against 1.7 and 1.8.
    m = re.search(r"(\d+)\.(\d+)", str(info.get("NMR Version") or "1.8"))
    nmr = float(f"{m.group(1)}.{m.group(2)}") if m else 1.8

    def spell_in_game(r):
        """modMMudFunc.SpellIsInGame."""
        if (num(r.get("Learnable")) == 0
                and len(str(r.get("Learned From") or "")) <= 1
                and len(str(r.get("Casted By") or "")) <= 1
                and (num(r.get("Magery")) != 5 or num(r.get("ReqLevel")) < 1)):
            return nmr >= 1.8 and len(str(r.get("Classes") or "")) > 1
        return True

    def spell_learnable(r):
        """SpellIsUsable's bAndLearnable branch. Kai autolearns at ReqLevel."""
        if (num(r.get("Learnable")) == 0
                and len(str(r.get("Learned From") or "")) < 5
                and (num(r.get("Magery")) != 5 or num(r.get("ReqLevel")) < 1)):
            return False
        return True

    def spell_usable_by(r, cnum, magery, magery_lvl):
        """SpellIsUsable, minus the ReqLevel and alignment tests."""
        if not spell_in_game(r) or not spell_learnable(r):
            return False
        if num(r.get("Magery")) != 0:
            if magery == 0 or magery != num(r.get("Magery")):
                return False
            if magery_lvl > 0 and magery_lvl < num(r.get("MageryLVL")):
                return False
            # Kai is the one school that grants spells without a teacher.
            if magery != 5 and num(r.get("Learnable")) == 0:
                return False
        cs = str(r.get("Classes") or "")
        if nmr >= 1.7 and len(cs) > 2 and cs != "(*)":
            if f"({cnum})" not in cs:
                return False
        return True

    spell_rows = [r for r in rows_of(db, "Spells") if str(r.get("Name") or "").strip()]
    castable = {c["n"]: [] for c in classes}
    for r in spell_rows:
        for c in classes:
            if spell_usable_by(r, c["n"], c["magery"], c["mageryLvl"]):
                castable[c["n"]].append(int(num(r["Number"])))

    # Items point at spells the Spells tab never lists -- a scroll teaches a
    # quest spell, a sword procs a monster one. Their numbers are meaningless on
    # their own, so carry a name for every row in the table; it is only a name,
    # and it keeps "casts spell #450" from reaching the page.
    spell_names = {}
    for r in spell_rows:
        nm = str(r.get("Name") or "").strip()
        if nm:
            spell_names[int(num(r["Number"]))] = nm

    keep = {n for lst in castable.values() for n in lst}
    spells = []
    for r in spell_rows:
        n = int(num(r["Number"]))
        if n not in keep:
            continue
        abils = [(int(num(r.get(f"Abil-{k}"))), int(num(r.get(f"AbilVal-{k}"))))
                 for k in range(10) if num(r.get(f"Abil-{k}"))]
        cs = str(r.get("Classes") or "")
        spells.append({
            "n": n,
            "name": str(r.get("Name") or "").strip(),
            "short": str(r.get("Short") or "").strip(),
            "req": int(num(r.get("ReqLevel"))),
            "mana": int(num(r.get("ManaCost"))),
            "energy": int(num(r.get("EnergyCost"))),
            "diff": int(num(r.get("Diff"))),
            "cap": int(num(r.get("Cap"))),
            # [base, increment, levels-per-increment]
            "min": [int(num(r.get("MinBase"))), int(num(r.get("MinInc"))), int(num(r.get("MinIncLVLs")))],
            "max": [int(num(r.get("MaxBase"))), int(num(r.get("MaxInc"))), int(num(r.get("MaxIncLVLs")))],
            "dur": [int(num(r.get("Dur"))), int(num(r.get("DurInc"))), int(num(r.get("DurIncLVLs")))],
            "magery": int(num(r.get("Magery"))),
            "mlvl": int(num(r.get("MageryLVL"))),
            "targets": int(num(r.get("Targets"))),
            "att": int(num(r.get("AttType"))),
            "res": int(num(r.get("TypeOfResists"))),
            "learnable": int(num(r.get("Learnable"))),
            "restrict": "*" if (cs == "(*)" or len(cs) <= 2) else [int(x) for x in re.findall(r"\d+", cs)],
            "from": str(r.get("Learned From") or "").strip(),
            "abils": abils,
        })
    spells.sort(key=lambda sp: (sp["req"], sp["n"]))

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
        "monsters": monsters,
        "spells": spells,
        "spellNames": {str(k): v for k, v in sorted(spell_names.items())},
        "castable": {str(k): v for k, v in castable.items() if v},
        "mageryNames": MAGERY_NAMES,
        "spellTargets": SPELL_TARGETS,
        "spellAttTypes": SPELL_ATT_TYPES,
        "spellResists": SPELL_RESISTS,
        "spellDamageAbils": sorted(SPELL_DAMAGE_ABILS),
        "spellHealAbils": sorted(SPELL_HEAL_ABILS),
        "spellEndcastAbil": SPELL_ENDCAST_ABIL,
        "spellAlignIs": SPELL_ALIGN_IS,
        "spellAlignNot": SPELL_ALIGN_NOT,
    }

    # ---------------------------------------------------------------- maps
    map_index, map_files = export_maps(
        db, outdir,
        {m["n"] for m in monsters},
        {sh["n"] for sh in shops},
        spell_names,
        {it["n"]: it["name"] for it in items},
    )
    payload["mapIndex"] = map_index
    payload["mapDirs"] = DIR_NAMES

    js = os.path.join(outdir, "gamedata.js")
    with open(js, "w") as f:
        f.write("// Generated by build_db.py -- do not edit by hand.\n")
        f.write("window.GAMEDATA = ")
        json.dump(payload, f, separators=(",", ":"))
        f.write(";\n")

    print(f"wrote {js}  ({os.path.getsize(js)/1024:.0f} KB)")
    map_kb = sum(sz for _, sz in map_files) / 1024
    laid = sum(m["rooms"] for m in map_index)
    exact = sum(m["exact"] for m in map_index)
    planar = sum(m["planar"] for m in map_index)
    seams = sum(m["seams"] for m in map_index)
    print(f"  maps={len(map_index)}  rooms={laid}  areas={sum(m['areas'] for m in map_index)}  "
          f"({100 * exact / max(1, planar - seams):.1f}% of exits inside an area land one cell "
          f"away in their own direction; {seams} cross between areas)")
    print(f"  wrote data/maps/*.js ({map_kb:.0f} KB across {len(map_files)} files)")
    print(f"  items={len(items)}  classes={len(classes)}  races={len(races)}  shops={len(shops)}")
    dropped = sum(1 for it in items if it.get("drop"))
    print(f"  monsters={len(monsters)}, {len(wanted_mons)} of them dropping something; "
          f"{dropped} items have a drop source, "
          f"{sum(1 for it in items if it.get('drop') and it['type'] == 1)} of them weapons")
    print(f"  spells={len(spells)} castable by a class "
          f"(of {len(spell_rows)} in the table; the rest are monster/item spells)")
    print(f"  dat version={payload['meta']['datVersion']}  nmr={payload['meta']['nmrVersion']}")


if __name__ == "__main__":
    main()
