#!/usr/bin/env bash
set -euo pipefail

pnpm --filter iwer run build
pnpm --filter @iwer/devui run build
pnpm --filter @iwer/sem run build
pnpm --filter @iwer/extension-bridge run build

rm -f ./*.tgz

cd packages/iwer && pnpm pack && mv ./*.tgz ../../
cd ../devui && pnpm pack && mv ./*.tgz ../../
cd ../sem && pnpm pack && mv ./*.tgz ../../
cd ../extension-bridge && pnpm pack && mv ./*.tgz ../../

echo "All packages packed successfully."
