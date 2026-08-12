#!/usr/bin/env bash
set -euo pipefail

base_url="${1:-http://127.0.0.1:3000}"
credential_file="/root/hospital-guide-initial-admin.txt"
cookie_file="$(mktemp)"
trap 'rm -f "${cookie_file}"' EXIT

source "${credential_file}"
login_payload="$(printf '{\"employeeNumber\":\"%s\",\"password\":\"%s\"}' "${employeeNumber}" "${password}")"
login_response="$(curl --fail --silent --show-error --cookie-jar "${cookie_file}" --header 'Content-Type: application/json' --data-binary "${login_payload}" "${base_url}/api/administrators/login")"
csrf="$(node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).data.csrfToken))' <<<"${login_response}")"

doctor_payload='{"displayName":"部署验收医生","employeeNumber":"269999","password":"SmokeTest-2026"}'
register_response="$(curl --fail --silent --show-error --header 'Content-Type: application/json' --data-binary "${doctor_payload}" "${base_url}/api/doctors/register")"
doctor_id="$(node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).data.doctorId))' <<<"${register_response}")"

curl --fail --silent --show-error --cookie "${cookie_file}" --header "X-CSRF-Token: ${csrf}" --header 'Content-Type: application/json' --request PUT --data-binary '{"status":"ACTIVE"}' "${base_url}/api/administrators/doctors/${doctor_id}/status" >/dev/null
doctor_login="$(curl --fail --silent --show-error --header 'Content-Type: application/json' --data-binary '{"employeeNumber":"269999","password":"SmokeTest-2026"}' "${base_url}/api/doctors/login")"
node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{const p=JSON.parse(s);if(!p.success||p.data.doctor.accountStatus!=="ACTIVE")process.exit(1)})' <<<"${doctor_login}"

runuser -u hospital_app -- psql -v ON_ERROR_STOP=1 -d hospital_guide <<'SQL' >/dev/null
SET search_path TO runtime, public;
DELETE FROM doctors WHERE employee_number = '269999';
SQL

echo "PASS administrator login, doctor registration, administrator review, doctor login, PostgreSQL cleanup"
