"""Validate JSON contracts without third-party packages."""

from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parents[1]
SCHEMA_DIR = ROOT / "schemas"
EXAMPLE_DIR = ROOT / "examples"


class ValidationError(Exception):
    pass


def load_json(path: Path):
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


SCHEMAS = {path.name: load_json(path) for path in SCHEMA_DIR.glob("*.json")}


def resolve_pointer(document, pointer: str):
    if not pointer:
        return document
    if not pointer.startswith("/"):
        raise ValidationError(f"unsupported JSON pointer: {pointer}")
    current = document
    for token in pointer[1:].split("/"):
        token = token.replace("~1", "/").replace("~0", "~")
        current = current[token]
    return current


def resolve_ref(ref: str, current_schema_name: str):
    path_part, _, fragment = ref.partition("#")
    target_name = path_part or current_schema_name
    if target_name.startswith("https://hospital-guide.local/schemas/"):
        target_name = target_name.rsplit("/", 1)[-1]
    if target_name not in SCHEMAS:
        raise ValidationError(f"unresolved schema reference: {ref}")
    return resolve_pointer(SCHEMAS[target_name], f"/{fragment.lstrip('/')}" if fragment else ""), target_name


def type_matches(instance, expected: str) -> bool:
    return {
        "null": instance is None,
        "boolean": isinstance(instance, bool),
        "integer": isinstance(instance, int) and not isinstance(instance, bool),
        "number": isinstance(instance, (int, float)) and not isinstance(instance, bool),
        "string": isinstance(instance, str),
        "array": isinstance(instance, list),
        "object": isinstance(instance, dict),
    }[expected]


def check_format(value: str, fmt: str, path: str):
    try:
        if fmt == "date-time":
            datetime.fromisoformat(value.replace("Z", "+00:00"))
        elif fmt == "date":
            datetime.strptime(value, "%Y-%m-%d")
        elif fmt == "uri":
            parsed = urlparse(value)
            if not parsed.scheme or not parsed.netloc:
                raise ValueError
    except ValueError as exc:
        raise ValidationError(f"{path}: invalid {fmt}: {value!r}") from exc


def validate(instance, schema, schema_name: str, path: str = "$"):
    if isinstance(schema, bool):
        if not schema:
            raise ValidationError(f"{path}: rejected by false schema")
        return

    if "$ref" in schema:
        target, target_name = resolve_ref(schema["$ref"], schema_name)
        validate(instance, target, target_name, path)

    if "oneOf" in schema:
        matches = 0
        errors = []
        for candidate in schema["oneOf"]:
            try:
                validate(instance, candidate, schema_name, path)
                matches += 1
            except ValidationError as error:
                errors.append(str(error))
        if matches != 1:
            raise ValidationError(f"{path}: expected exactly one oneOf match, got {matches}; {errors[:2]}")

    for candidate in schema.get("allOf", []):
        validate(instance, candidate, schema_name, path)

    if "if" in schema:
        try:
            validate(instance, schema["if"], schema_name, path)
            condition = True
        except ValidationError:
            condition = False
        branch = schema.get("then") if condition else schema.get("else")
        if branch is not None:
            validate(instance, branch, schema_name, path)

    if "const" in schema and instance != schema["const"]:
        raise ValidationError(f"{path}: expected constant {schema['const']!r}, got {instance!r}")
    if "enum" in schema and instance not in schema["enum"]:
        raise ValidationError(f"{path}: {instance!r} is not in enum")

    expected_type = schema.get("type")
    if expected_type is not None:
        expected_types = [expected_type] if isinstance(expected_type, str) else expected_type
        if not any(type_matches(instance, item) for item in expected_types):
            raise ValidationError(f"{path}: expected type {expected_types}, got {type(instance).__name__}")

    if isinstance(instance, str):
        if len(instance) < schema.get("minLength", 0):
            raise ValidationError(f"{path}: string shorter than minLength")
        if "maxLength" in schema and len(instance) > schema["maxLength"]:
            raise ValidationError(f"{path}: string longer than maxLength")
        if "pattern" in schema and re.search(schema["pattern"], instance) is None:
            raise ValidationError(f"{path}: string does not match {schema['pattern']!r}")
        if "format" in schema:
            check_format(instance, schema["format"], path)

    if isinstance(instance, (int, float)) and not isinstance(instance, bool):
        if "minimum" in schema and instance < schema["minimum"]:
            raise ValidationError(f"{path}: number below minimum")
        if "maximum" in schema and instance > schema["maximum"]:
            raise ValidationError(f"{path}: number above maximum")

    if isinstance(instance, list):
        if len(instance) < schema.get("minItems", 0):
            raise ValidationError(f"{path}: array shorter than minItems")
        if "maxItems" in schema and len(instance) > schema["maxItems"]:
            raise ValidationError(f"{path}: array longer than maxItems")
        if schema.get("uniqueItems"):
            encoded = [json.dumps(item, ensure_ascii=False, sort_keys=True) for item in instance]
            if len(encoded) != len(set(encoded)):
                raise ValidationError(f"{path}: array items are not unique")
        if "items" in schema:
            for index, item in enumerate(instance):
                validate(item, schema["items"], schema_name, f"{path}[{index}]")

    if isinstance(instance, dict):
        for key in schema.get("required", []):
            if key not in instance:
                raise ValidationError(f"{path}: missing required property {key!r}")
        properties = schema.get("properties", {})
        for key, value in instance.items():
            if key in properties:
                validate(value, properties[key], schema_name, f"{path}.{key}")
            elif schema.get("additionalProperties") is False:
                raise ValidationError(f"{path}: unexpected property {key!r}")


def validate_schema_references():
    def walk(value, schema_name):
        if isinstance(value, dict):
            if "$ref" in value:
                resolve_ref(value["$ref"], schema_name)
            for nested in value.values():
                walk(nested, schema_name)
        elif isinstance(value, list):
            for nested in value:
                walk(nested, schema_name)

    for name, schema in SCHEMAS.items():
        if schema.get("$schema") != "https://json-schema.org/draft/2020-12/schema":
            raise ValidationError(f"{name}: must declare JSON Schema Draft 2020-12")
        walk(schema, name)


def check_department_allowlist(request, response):
    allowed = set(request["constraints"]["allowedDepartmentIds"])
    candidates = {item["departmentId"] for item in request["candidateDepartments"]}
    recommendations = {item["departmentId"] for item in response["recommendations"]}
    return recommendations <= allowed and recommendations <= candidates


def check_session_expiry(instance):
    last_active = datetime.fromisoformat(instance["lastActiveAt"])
    expires_at = datetime.fromisoformat(instance["expiresAt"])
    return expires_at == last_active + timedelta(hours=72)


def check_bill_arithmetic(instance):
    item_total = round(sum(item["amount"] for item in instance["items"]), 2)
    declared_total = round(instance["totalAmount"], 2)
    allocation_total = round(instance["insuranceAmount"] + instance["personalAmount"], 2)
    return item_total == declared_total == allocation_total


def main():
    manifest = load_json(EXAMPLE_DIR / "manifest.json")
    failures = []
    checks = 0

    try:
        validate_schema_references()
        print(f"PASS schema references ({len(SCHEMAS)} schemas)")
    except Exception as error:  # noqa: BLE001
        failures.append(f"schema references: {error}")

    for case in manifest["valid"]:
        checks += 1
        try:
            instance = load_json(EXAMPLE_DIR / case["instance"])
            validate(instance, SCHEMAS[case["schema"]], case["schema"])
            print(f"PASS valid   {case['instance']} -> {case['schema']}")
        except Exception as error:  # noqa: BLE001
            failures.append(f"valid {case['instance']}: {error}")

    for case in manifest["invalid"]:
        checks += 1
        try:
            instance = load_json(EXAMPLE_DIR / case["instance"])
            validate(instance, SCHEMAS[case["schema"]], case["schema"])
            failures.append(f"invalid {case['instance']}: unexpectedly passed")
        except ValidationError:
            print(f"PASS invalid {case['instance']} rejected by {case['schema']}")

    for case in manifest["semanticChecks"]:
        checks += 1
        if case["type"] == "departmentRoutingAllowlist":
            result = check_department_allowlist(
                load_json(EXAMPLE_DIR / case["request"]),
                load_json(EXAMPLE_DIR / case["response"]),
            )
        elif case["type"] == "sessionExpiry72Hours":
            result = check_session_expiry(load_json(EXAMPLE_DIR / case["instance"]))
        elif case["type"] == "billArithmetic":
            result = check_bill_arithmetic(load_json(EXAMPLE_DIR / case["instance"]))
        else:
            failures.append(f"unknown semantic check: {case['type']}")
            continue
        if result != case["expected"]:
            failures.append(f"semantic {case['type']}: expected {case['expected']}, got {result}")
        else:
            print(f"PASS semantic {case['type']} expected={case['expected']}")

    if failures:
        print("\nFAILED")
        for failure in failures:
            print(f"- {failure}")
        return 1

    print(f"\nAll contract checks passed: {checks} examples/semantic checks, {len(SCHEMAS)} schemas.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
