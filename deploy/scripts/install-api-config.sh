#!/usr/bin/env bash
set -euo pipefail

source_file="${1:-/tmp/hospital-guide-APIConfigs.txt}"
expected_sha256="${2:-}"
target_file="/etc/hospital-guide/APIConfigs.txt"
environment_file="/etc/hospital-guide/agent.env"

if [[ ! -s "${source_file}" ]]; then
    echo "API configuration source is missing or empty: ${source_file}" >&2
    exit 1
fi

if [[ -n "${expected_sha256}" ]]; then
    actual_sha256="$(sha256sum "${source_file}" | awk '{print toupper($1)}')"
    if [[ "${actual_sha256}" != "${expected_sha256^^}" ]]; then
        echo "API configuration checksum mismatch; refusing to install." >&2
        exit 1
    fi
fi

install -o root -g hospital_app -m 0640 "${source_file}" "${target_file}.new"
mv -f "${target_file}.new" "${target_file}"

temporary_environment="$(mktemp)"
trap 'rm -f "${temporary_environment}"' EXIT
grep -v '^API_CONFIG_PATH=' "${environment_file}" > "${temporary_environment}" || true
printf 'API_CONFIG_PATH=%s\n' "${target_file}" >> "${temporary_environment}"
install -o root -g hospital_app -m 0640 "${temporary_environment}" "${environment_file}"

rm -f "${source_file}"
systemctl restart hospital-guide.service
for attempt in {1..20}; do
    if systemctl is-active --quiet hospital-guide.service \
        && curl --fail --silent http://127.0.0.1:3000/api/health >/dev/null; then
        echo "API configuration installed and hospital-guide restarted successfully."
        exit 0
    fi
    sleep 1
done

echo "hospital-guide did not become ready within 20 seconds." >&2
systemctl status hospital-guide.service --no-pager >&2 || true
exit 1
