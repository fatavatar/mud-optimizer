#!/usr/bin/env bash
#
# One-shot setup: fetch the MegaMUD database this tool reads, and generate the
# data file the page loads. Safe to re-run; it skips work that is already done.
#
#   ./init.sh              fetch if missing, then build
#   ./init.sh --force      re-download even if the file is already here
#   ./init.sh path/to.mdb  build from an .mdb you already have
#   ./init.sh --serve      build, then serve on http://localhost:8000
#
set -euo pipefail
cd "$(dirname "$0")"

MDB_URL="https://github.com/Tehshortbus/Majormud_MDB_Repo/raw/refs/heads/main/data-v1.11p.mdb"
MDB_FILE="data-v1.11p.mdb"
# The build this repo's data/gamedata.js was generated from. A mismatch is not
# an error -- you may deliberately want a different dat version -- but you
# should know when you are looking at something other than v1.11p.
MDB_SHA256="eba20f06af8dc08df755eb6dcd9763b023794f12e809cbab6762236d64d7345f"

FORCE=0
SERVE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --serve) SERVE=1 ;;
    -h|--help) sed -n '3,9p' "$0" | sed 's/^# \?//'; exit 0 ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    *)  MDB_FILE="$arg" ;;
  esac
done

say() { printf '\033[33m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

command -v python3 >/dev/null || die "python3 is required."

# ---------------------------------------------------------------- the database
if [ "$FORCE" = 1 ] || [ ! -f "$MDB_FILE" ]; then
  [ "$MDB_FILE" = "data-v1.11p.mdb" ] || die "$MDB_FILE not found."
  say "Downloading $MDB_FILE (about 12 MB)"
  if command -v curl >/dev/null; then
    curl -fL --progress-bar -o "$MDB_FILE.part" "$MDB_URL"
  elif command -v wget >/dev/null; then
    wget -q --show-progress -O "$MDB_FILE.part" "$MDB_URL"
  else
    die "need curl or wget to download the database."
  fi
  mv "$MDB_FILE.part" "$MDB_FILE"
else
  say "Using the $MDB_FILE already here (--force to re-download)"
fi

if command -v sha256sum >/dev/null; then GOT=$(sha256sum "$MDB_FILE" | cut -d' ' -f1)
elif command -v shasum   >/dev/null; then GOT=$(shasum -a 256 "$MDB_FILE" | cut -d' ' -f1)
else GOT=""; fi
if [ -n "$GOT" ] && [ "$GOT" != "$MDB_SHA256" ]; then
  say "note: this is not the v1.11p build the shipped data came from."
  say "      that is fine -- the export will just describe your file instead."
fi

# ------------------------------------------------------------------- the parser
# access-parser is the only dependency. Use it wherever it already is; failing
# that, put it in a local .venv rather than in the system python.
PY=python3
if ! "$PY" -c 'import access_parser' 2>/dev/null; then
  if [ -x .venv/bin/python ] && .venv/bin/python -c 'import access_parser' 2>/dev/null; then
    PY=.venv/bin/python
  else
    say "Installing access-parser into ./.venv"
    "$PY" -m venv .venv 2>/dev/null || die "python3-venv is missing (apt install python3-venv)."
    .venv/bin/pip install --quiet --upgrade pip
    .venv/bin/pip install --quiet access-parser || die "could not install access-parser."
    PY=.venv/bin/python
  fi
fi

# --------------------------------------------------------------------- the data
say "Building data/gamedata.js from $MDB_FILE"
"$PY" build_db.py "$MDB_FILE"

if command -v node >/dev/null; then
  say "Running the test suite"
  node test/run.js | tail -1
else
  say "node not found -- skipping the test suite (it is optional)."
fi

echo
say "Ready. Open index.html directly, or serve it:"
echo "      python3 -m http.server 8000    # then http://localhost:8000"

if [ "$SERVE" = 1 ]; then
  echo
  say "Serving on http://localhost:8000 (ctrl-c to stop)"
  exec python3 -m http.server 8000
fi
