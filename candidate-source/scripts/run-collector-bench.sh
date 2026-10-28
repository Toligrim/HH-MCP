#!/usr/bin/env bash
set -euo pipefail

size=${1:?size must be 5000 or 20000}
persistence=${2:?persistence must be on or off}
tag=${3:?provide a run tag}
case_dir=/tmp/hh-collector-bench/runs
mkdir -p "$case_dir"
stdout_log="$case_dir/${size}-${persistence}-${tag}.stdout.log"
time_log="$case_dir/${size}-${persistence}-${tag}.time.log"
limit=240s
if [[ "$size" == "20000" ]]; then limit=300s; fi

run_status=0
if /usr/bin/time -o "$time_log" -v timeout "$limit" node --import tsx scripts/collector-bench.mjs "$size" "$persistence" "$tag" >"$stdout_log" 2>&1; then
  run_status=0
else
  run_status=$?
fi

cat "$stdout_log"
cat "$time_log"
exit "$run_status"
