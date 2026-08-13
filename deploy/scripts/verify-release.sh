#!/usr/bin/env bash
set -euo pipefail
cd /

verify_dir="$(mktemp -d)"
trap 'rm -rf -- "${verify_dir}"' EXIT
fetch_and_require() {
  local url="$1" needle="$2" name="$3"
  local target="${verify_dir}/${name}"
  curl --fail --silent "${url}" --output "${target}"
  grep --fixed-strings --quiet -- "${needle}" "${target}"
  echo "VERIFY_${name}=ok"
}

echo "CURRENT_RELEASE=$(readlink -f /opt/hospital-guide/current)"
echo "SERVICE=$(systemctl is-active hospital-guide.service)"
echo "MIGRATION=$(runuser -u hospital_app -- psql -d hospital_guide -Atc "SELECT version FROM app.schema_migrations WHERE version='006_conversation_and_simulated_payment'")"
echo "WORKFLOW_MIGRATION=$(runuser -u hospital_app -- psql -d hospital_guide -Atc "SELECT version FROM app.schema_migrations WHERE version='007_workflow_and_confirmed_facts'")"
echo "QUERY_CLEANUP_MIGRATION=$(runuser -u hospital_app -- psql -d hospital_guide -Atc "SELECT version FROM app.schema_migrations WHERE version='008_cleanup_legacy_patient_queries'")"
echo "ASSISTANT_ACTIONS_MIGRATION=$(runuser -u hospital_app -- psql -d hospital_guide -Atc "SELECT version FROM app.schema_migrations WHERE version='009_persist_assistant_actions'")"
echo "LEGACY_PATIENT_STATEMENTS=$(runuser -u hospital_app -- psql -d hospital_guide -Atc "SELECT to_regclass('runtime.patient_statements')")"
echo "PROACTIVE_TABLE=$(runuser -u hospital_app -- psql -d hospital_guide -Atc "SELECT to_regclass('runtime.proactive_agent_events')")"
echo "DOCTOR_CONTACT_COLUMNS=$(runuser -u hospital_app -- psql -d hospital_guide -Atc "SELECT count(*) FROM information_schema.columns WHERE table_schema='runtime' AND table_name='doctors' AND column_name='contact_encrypted'")"

curl --fail --silent http://127.0.0.1:3000/api/health
echo
curl --fail --silent http://127.0.0.1:3000/api/patient/me
echo
fetch_and_require http://127.0.0.1:3000/user 'id="chatMessages"' local_user.html
fetch_and_require http://127.0.0.1:3000/map 'id="view-map"' local_map.html
echo "ANALYSER_HTTP=$(curl --fail --silent --output /dev/null --write-out '%{http_code}:%{size_download}' http://127.0.0.1:3000/vendor/fengmap/fengmap.analyser.min.js)"
echo "NAVI_HTTP=$(curl --fail --silent --output /dev/null --write-out '%{http_code}:%{size_download}' http://127.0.0.1:3000/vendor/fengmap/fengmap.plugin.navi.min.js)"
fetch_and_require https://langain.xyz/map 'id="view-map"' public_map.html
grep --fixed-strings --quiet -- 'id="exitMap"' "${verify_dir}/public_map.html"
fetch_and_require https://langain.xyz/doctor 'id="doctorDepartmentDivision"' public_doctor.html
grep --fixed-strings --quiet -- 'id="recordForm"' "${verify_dir}/public_doctor.html"
fetch_and_require https://langain.xyz/admin 'id="adminLoginForm"' public_admin.html
fetch_and_require https://langain.xyz/user 'id="chatMessages"' public_user.html
grep --fixed-strings --quiet -- 'data-portal="map"' "${verify_dir}/public_map.html"
grep --fixed-strings --quiet -- 'href="/favicon.svg"' "${verify_dir}/public_map.html"
curl --fail --silent --output /dev/null https://langain.xyz/favicon.svg
fetch_and_require https://langain.xyz/styles.css 'body.map-mode' public_styles.css
fetch_and_require https://langain.xyz/app.js 'initializeDoctorDepartmentIndex' public_app.js
grep --fixed-strings --quiet -- 'FMViewMode.MODE_2D' "${verify_dir}/public_app.js"
grep --fixed-strings --quiet -- 'interactions.enableTilt = false' "${verify_dir}/public_app.js"
grep --fixed-strings --quiet -- 'viewModeControl: false' "${verify_dir}/public_app.js"
grep --fixed-strings --quiet -- 'XfyunTranscriber' "${verify_dir}/public_app.js"
grep --fixed-strings --quiet -- 'bindEvent("#recordForm", "submit"' "${verify_dir}/public_app.js"
fetch_and_require https://langain.xyz/speech.js 'TARGET_SAMPLE_RATE = 16_000' public_speech.js
grep --fixed-strings --quiet -- 'ltc: 1' "${verify_dir}/public_speech.js"
if grep --fixed-strings --quiet -- 'ltc: 0' "${verify_dir}/public_speech.js"; then exit 1; fi
fetch_and_require https://langain.xyz/api/config '"transcription":true' public_config.json
grep --fixed-strings --quiet -- '"synthesis":true' "${verify_dir}/public_config.json"
curl --fail --silent --dump-header "${verify_dir}/public_headers.txt" --output /dev/null https://langain.xyz/user
grep --fixed-strings --quiet -- 'microphone=(self)' "${verify_dir}/public_headers.txt"
echo "PUBLIC_MAP=200"
journalctl -u hospital-guide.service -n 20 --no-pager
