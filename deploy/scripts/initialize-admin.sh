#!/usr/bin/env bash
set -euo pipefail

credential_file="/root/hospital-guide-initial-admin.txt"
if [[ -e "${credential_file}" ]]; then
    echo "Initial administrator credential file already exists; refusing to overwrite." >&2
    exit 1
fi

password="$(openssl rand -base64 24 | tr -d '\n')"
payload="$(printf '{\"displayName\":\"系统管理员\",\"employeeNumber\":\"260001\",\"password\":\"%s\"}' "${password}")"
curl --fail --silent --show-error \
    --header 'Content-Type: application/json' \
    --data-binary "${payload}" \
    http://127.0.0.1:3000/api/administrators/setup >/dev/null

umask 077
printf 'employeeNumber=260001\npassword=%s\n' "${password}" > "${credential_file}"
unset password payload
echo "Initial administrator created. Credentials are stored in ${credential_file} (mode 600)."
