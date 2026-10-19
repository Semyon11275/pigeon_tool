#!/bin/bash
set -e
cd "$(dirname "$0")/.."
# Delegate to the maintained Windows build; --output must name a new directory.
node scripts/build-win.cjs "$@"
