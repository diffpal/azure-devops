#!/usr/bin/env bash
set -euo pipefail

diffpal_bin="${DIFFPAL_BIN:?DIFFPAL_BIN is required}"
help="$($diffpal_bin review ado --help)"

for flag in \
  --base \
  --head \
  --profile \
  --block-on \
  --gate \
  --feedback \
  --summary-overview \
  --out \
  --repo \
  --review-id \
  --language \
  --instructions \
  --instructions-file; do
  if ! grep -Fq -- "$flag" <<<"$help"; then
    echo "DiffPal CLI contract is missing $flag" >&2
    exit 1
  fi
done

echo "DiffPal CLI v1 contract passed"
