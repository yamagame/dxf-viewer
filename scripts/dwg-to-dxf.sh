#!/bin/sh
set -eu

usage() {
  cat <<'USAGE'
Usage: scripts/dwg-to-dxf.sh INPUT.dwg [OUTPUT.dxf]

Convert one DWG file to ASCII DXF using GNU LibreDWG in Docker.
If OUTPUT.dxf is omitted, the DXF is written beside the input file.
USAGE
}

fail() {
  printf '%s\n' "Error: $*" >&2
  exit 1
}

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  usage >&2
  exit 2
fi

input=$1
case "$input" in
  *.[dD][wW][gG]) ;;
  *) fail "input must have a .dwg extension: $input" ;;
esac
[ -f "$input" ] || fail "input file not found: $input"

input_dir=$(CDPATH= cd -- "$(dirname -- "$input")" && pwd -P)
input_name=$(basename -- "$input")

if [ "$#" -eq 2 ]; then
  output=$2
else
  output="${input%.*}.dxf"
fi
case "$output" in
  *.[dD][xX][fF]) ;;
  *) fail "output must have a .dxf extension: $output" ;;
esac

output_dir=$(dirname -- "$output")
mkdir -p "$output_dir"
output_dir=$(CDPATH= cd -- "$output_dir" && pwd -P)
output_name=$(basename -- "$output")
output_path="$output_dir/$output_name"
[ ! -e "$output_path" ] || fail "output already exists: $output_path"

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
image=${DWG_CONVERTER_IMAGE:-dxf-loader-dwg-converter:0.13.4}

if ! docker image inspect "$image" >/dev/null 2>&1; then
  docker build -f "$project_root/tools/dwg-converter/Dockerfile" -t "$image" "$project_root/tools/dwg-converter"
fi

docker run --rm \
  --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$input_dir,dst=/input,readonly" \
  --mount "type=bind,src=$output_dir,dst=/output" \
  "$image" \
  -O DXF -o "/output/$output_name" "/input/$input_name"

printf 'Created %s\n' "$output_path"
