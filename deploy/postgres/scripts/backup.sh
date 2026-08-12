#!/usr/bin/env bash
set -euo pipefail

backup_dir=/var/backups/hospital-guide
timestamp=$(date +%Y%m%d-%H%M%S)
temporary_file="${backup_dir}/hospital_guide-${timestamp}.dump.tmp"
final_file="${backup_dir}/hospital_guide-${timestamp}.dump"

umask 077
mkdir -p "$backup_dir"
pg_dump --dbname=hospital_guide --format=custom --file="$temporary_file"
mv "$temporary_file" "$final_file"
find "$backup_dir" -type f -name 'hospital_guide-*.dump' -mtime +7 -delete
