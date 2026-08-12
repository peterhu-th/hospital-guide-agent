#!/usr/bin/env bash
set -euo pipefail

migration_dir="${1:-/opt/hospital-guide/migrations}"
database_name="${DATABASE_NAME:-hospital_guide}"
database_user="${DATABASE_USER:-hospital_app}"

if [[ ! -d "${migration_dir}" ]]; then
    echo "Migration directory does not exist: ${migration_dir}" >&2
    exit 1
fi

for migration in "${migration_dir}"/*.sql; do
    [[ -e "${migration}" ]] || continue
    version="$(basename "${migration}" .sql)"
    applied="$(runuser -u "${database_user}" -- psql \
        --dbname="${database_name}" \
        --tuples-only \
        --no-align \
        --command="SELECT 1 FROM app.schema_migrations WHERE version = '${version}'" 2>/dev/null || true)"

    if [[ "${applied}" == "1" ]]; then
        echo "SKIP ${version} (already applied)"
        continue
    fi

    echo "APPLY ${version}"
    runuser -u "${database_user}" -- psql \
        --dbname="${database_name}" \
        --set=ON_ERROR_STOP=1 \
        --file="${migration}"
done
