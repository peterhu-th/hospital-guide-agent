#!/usr/bin/env bash
set -euo pipefail

release_id="${1:?release id is required}"
staging_dir="${2:-/tmp/hospital-guide-release}"
release_root=/opt/hospital-guide/releases
current_link=/opt/hospital-guide/current
migrations_dir=/opt/hospital-guide/migrations
new_release="${release_root}/${release_id}"
previous_release="$(readlink -f "${current_link}")"

required_files=(
  apps/server/config.js apps/server/database.js apps/server/deepseek.js
  apps/server/http.js apps/server/knowledge.js apps/server/service.js
  apps/server/main.js apps/server/speech.js
  apps/server/agent/tool-registry.js
  apps/server/domain/doctor-directory.js apps/server/domain/patient-journey.js
  apps/server/domain/safety-guard.js apps/server/domain/task-manager.js
  apps/web/app.js apps/web/speech.js apps/web/index.html apps/web/doctor.html
  apps/web/admin.html apps/web/map.html apps/web/styles.css apps/web/record.css apps/web/favicon.svg
  deploy/postgres/migrations/006_conversation_and_simulated_payment.sql
  deploy/postgres/migrations/007_workflow_and_confirmed_facts.sql
  deploy/postgres/migrations/008_cleanup_legacy_patient_queries.sql
  deploy/postgres/migrations/009_persist_assistant_actions.sql
  knowledge/official/departments.json knowledge/official/hospital.json
  knowledge/official/insurance-reference.json knowledge/map/locations.json
  knowledge/map/hospital-geofence.json knowledge/map/location-aliases.json
  knowledge/curated/department-routing-context.json knowledge/curated/department-aliases.json
  knowledge/demo/doctor-schedule-reference.json knowledge/simulation-manifest.json
)
for file in "${required_files[@]}"; do test -s "${staging_dir}/${file}"; done
test ! -e "${new_release}"

cp -a "${previous_release}" "${new_release}"
for file in "${required_files[@]}"; do
  if [[ "${file}" == deploy/postgres/migrations/* ]]; then continue; fi
  mkdir -p "$(dirname "${new_release}/${file}")"
  install -o hospital_app -g hospital_app -m 0644 "${staging_dir}/${file}" "${new_release}/${file}"
done
install -o root -g root -m 0644 "${staging_dir}/deploy/postgres/migrations/006_conversation_and_simulated_payment.sql" "${migrations_dir}/006_conversation_and_simulated_payment.sql"
install -o root -g root -m 0644 "${staging_dir}/deploy/postgres/migrations/007_workflow_and_confirmed_facts.sql" "${migrations_dir}/007_workflow_and_confirmed_facts.sql"
install -o root -g root -m 0644 "${staging_dir}/deploy/postgres/migrations/008_cleanup_legacy_patient_queries.sql" "${migrations_dir}/008_cleanup_legacy_patient_queries.sql"
install -o root -g root -m 0644 "${staging_dir}/deploy/postgres/migrations/009_persist_assistant_actions.sql" "${migrations_dir}/009_persist_assistant_actions.sql"

/usr/local/bin/node --check "${new_release}/apps/web/app.js"
/usr/local/bin/node --check "${new_release}/apps/server/http.js"

bash /opt/hospital-guide/current/deploy/postgres/scripts/apply-migrations.sh "${migrations_dir}"
ln -s "${new_release}" "${current_link}.new"
mv -Tf "${current_link}.new" "${current_link}"
systemctl restart hospital-guide.service

for attempt in {1..30}; do
  if systemctl is-active --quiet hospital-guide.service \
    && curl --fail --silent http://127.0.0.1:3000/api/health >/dev/null \
    && curl --fail --silent http://127.0.0.1:3000/api/patient/me >/dev/null \
    && curl --fail --silent http://127.0.0.1:3000/map >/dev/null; then
    rm -rf -- "${staging_dir}"
    echo "RELEASE=${new_release}"
    exit 0
  fi
  sleep 1
done

ln -s "${previous_release}" "${current_link}.rollback"
mv -Tf "${current_link}.rollback" "${current_link}"
systemctl restart hospital-guide.service
rm -rf -- "${staging_dir}"
echo "Deployment failed and rolled back to ${previous_release}." >&2
exit 1
