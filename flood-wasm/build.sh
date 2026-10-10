#!/bin/sh
# Builds the WASM module into web/pkg (ES module + .wasm, committed so the site stays static).
set -e
cd "$(dirname "$0")"
wasm-pack build --release --target web --no-pack --out-dir ../web/pkg
rm -f ../web/pkg/.gitignore
