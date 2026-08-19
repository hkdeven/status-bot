#!/bin/zsh
# Wrapper so launchd gets an absolute node path and a sane working directory.
cd "$(dirname "$0")"
/usr/local/bin/node src/index.js --write-state --quiet >> digests/run.log 2>&1
