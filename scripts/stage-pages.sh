#!/usr/bin/env bash
set -euo pipefail
# Copy the existing Pages tree, excluding the Git database and test-only prototype.
mkdir -p "$2"
rsync -a --exclude='/.git/' --exclude='/prototype/' "$1"/ "$2"/
