#!/bin/sh
# Enforces design-token usage in TS/TSX under src/components and src/app
# (CSS is out of scope, so src/app/globals.css is never scanned):
#   1. no Tailwind arbitrary-value utilities, e.g. bg-[#fff], p-[13px], w-[calc(...)]
#   2. no raw hex colours, e.g. "#1c1917"
#   3. no default-palette colour utilities, e.g. bg-gray-100, hover:text-blue-500,
#      text-white (the palette is removed in globals.css, so they silently do nothing)
#   4. no removed radii/shadows, e.g. rounded-2xl, shadow-xl (defined: rounded-sm|md|lg|xl
#      plus built-in rounded-none|full; shadow-sm|md|lg plus built-in shadow-none)
# Prints a one-line explanation plus file:line:match per rule and exits 1;
# exits 0 when clean. POSIX sh + find + grep -E only. Run: bun run check:tokens
set -u

cd "$(dirname "$0")/.." || exit 2

DIRS="src/components src/app"

# Start of a utility: line start or any char that can't be part of a class
# name. Variant prefixes (hover:, md:, dark:, group-hover:, [&>*]:) end in ':'
# which is itself a boundary, so they are covered without listing them.
B='(^|[^a-zA-Z0-9_-])'
# End of a utility: line end or a non-class char (/ for opacity, ! for important).
E='([^a-zA-Z0-9_-]|$)'

# A utility (optionally variant-prefixed, e.g. md:hover:) ending in -[...].
# Also catches arbitrary properties like [mask-type:luminance].
ARBITRARY='(^|[[:space:]"'"'"'`{(])([a-z0-9-]+:)*!?-?[a-z][a-z0-9-]*-\[[^]]+\]|(^|[[:space:]"'"'"'`])\[[a-z-]+:[^] ]+\]'
# #rgb, #rgba, #rrggbb, #rrggbbaa not followed by another word character.
HEX='#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})([^0-9a-zA-Z_]|$)'
COLOR_PREFIX='(bg|text|border|ring|outline|fill|stroke|divide|decoration|placeholder|from|via|to|accent|caret|shadow)'
PALETTE="$B$COLOR_PREFIX-((slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-[0-9]{2,3}|white|black)$E"
# rounded, rounded-t, rounded-tl, rounded-ss ... with a removed size.
RADIUS="${B}rounded(-(t|r|b|l|s|e|ss|se|es|ee|tl|tr|br|bl))?-(xs|2xl|3xl|4xl)$E"
SHADOW="${B}shadow-(xs|xl|2xl|inner)$E"

# shellcheck disable=SC2086 # DIRS is intentionally word-split
find_ts() {
  find $DIRS -type f \( -name '*.ts' -o -name '*.tsx' \) ! -path '*/node_modules/*' "$@" 2>/dev/null
}

files=$(find_ts)
if [ -z "$files" ]; then
  echo "check:tokens: no TS/TSX files found in $DIRS"
  exit 0
fi

status=0
# rule <explanation> <extended regex>
rule() {
  hits=$(find_ts -exec grep -nE "$2" /dev/null {} +)
  if [ -n "$hits" ]; then
    echo "check:tokens: $1"
    printf '%s\n' "$hits"
    status=1
  fi
}

rule "Tailwind arbitrary values are not allowed; use a token utility:" "$ARBITRARY"
rule "raw hex colours are not allowed in TS/TSX; use a colour token:" "$HEX"
rule "default palette colours (gray-100, blue-500, white, black...) are removed and generate nothing; use a role colour (bg-surface-*, text-text-*, bg-accent, text-danger...):" "$PALETTE"
rule "rounded-xs/2xl/3xl/4xl are removed and generate nothing; use rounded-sm|md|lg|xl|full|none:" "$RADIUS"
rule "shadow-xs/xl/2xl/inner are removed and generate nothing; use shadow-sm|md|lg|none:" "$SHADOW"

if [ "$status" -eq 0 ]; then
  echo "check:tokens: OK ($(printf '%s\n' "$files" | wc -l | tr -d ' ') files scanned)"
fi
exit "$status"
