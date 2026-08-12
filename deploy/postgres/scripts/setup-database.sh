#!/usr/bin/env bash
set -euo pipefail
cd /

if ! getent passwd hospital_app >/dev/null; then
    useradd --system \
        --home-dir /opt/hospital-guide \
        --create-home \
        --shell /sbin/nologin \
        hospital_app
fi

if [[ "$(runuser -u postgres -- psql --tuples-only --no-align --command="SELECT 1 FROM pg_roles WHERE rolname = 'hospital_app'")" != "1" ]]; then
    runuser -u postgres -- createuser --login hospital_app
fi

if [[ "$(runuser -u postgres -- psql --tuples-only --no-align --command="SELECT 1 FROM pg_database WHERE datname = 'hospital_guide'")" != "1" ]]; then
    runuser -u postgres -- createdb \
        --owner=hospital_app \
        --encoding=UTF8 \
        --template=template0 \
        --locale=C.UTF-8 \
        hospital_guide
fi

runuser -u hospital_app -- psql \
    --dbname=hospital_guide \
    --tuples-only \
    --no-align \
    --command='SELECT current_user, current_database();'
