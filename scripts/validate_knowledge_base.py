"""Validate knowledge completeness, provenance and cross-file references."""

from __future__ import annotations

import json
import pathlib
import sys

from validate_contracts import SCHEMAS, ValidationError, validate


ROOT = pathlib.Path(__file__).resolve().parents[1]
KNOWLEDGE = ROOT / "knowledge"
EXPECTED_FILES = [
    "official/hospital.json",
    "official/departments.json",
    "official/doctors-reference.json",
    "official/service-contacts.json",
    "official/visit-guides.json",
    "official/insurance-reference.json",
    "official/source-registry.json",
    "official/unresolved-official-data.json",
    "curated/department-aliases.json",
    "curated/department-routing-context.json",
    "map/floors.json",
    "map/locations.json",
    "map/location-aliases.json",
    "map/department-location-mapping.json",
    "map/source-conflicts.json",
    "demo/order-catalog.json",
    "demo/doctor-schedule-reference.json",
]


def load(relative_path: str):
    with (KNOWLEDGE / relative_path).open("r", encoding="utf-8") as handle:
        return json.load(handle)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> int:
    failures: list[str] = []
    for relative_path in EXPECTED_FILES:
        if not (KNOWLEDGE / relative_path).is_file():
            failures.append(f"missing deliverable: knowledge/{relative_path}")
    if failures:
        print("\n".join(failures))
        return 1

    try:
        catalog = load("source/department-catalog.json")
        official_snapshot = load("source/official-directory-snapshot.json")
        hospital = load("official/hospital.json")
        departments = load("official/departments.json")
        doctors = load("official/doctors-reference.json")
        sources = load("official/source-registry.json")
        unresolved = load("official/unresolved-official-data.json")
        aliases = load("curated/department-aliases.json")
        routing = load("curated/department-routing-context.json")
        floors = load("map/floors.json")
        locations = load("map/locations.json")
        mappings = load("map/department-location-mapping.json")
        insurance = load("official/insurance-reference.json")
        simulation_manifest = load("simulation-manifest.json")
        schedule_reference = load("demo/doctor-schedule-reference.json")

        catalog_names = [name for division in catalog["divisions"].values() for name in division]
        require(len(catalog_names) == 92, f"official catalog count changed: {len(catalog_names)}")
        require(len(set(catalog_names)) == len(catalog_names), "official catalog contains duplicate names")
        require(official_snapshot["linkedDepartmentCount"] == 92, "not every official department has a detail page")

        validate(hospital, SCHEMAS["hospital.schema.json"], "hospital.schema.json")
        for index, department in enumerate(departments):
            validate(department, SCHEMAS["department.schema.json"], "department.schema.json", f"departments[{index}]")
        for index, location in enumerate(locations):
            validate(location, SCHEMAS["location.schema.json"], "location.schema.json", f"locations[{index}]")

        department_names = [item["name"] for item in departments]
        department_ids = {item["departmentId"] for item in departments}
        location_ids = {item["locationId"] for item in locations}
        require(department_names == catalog_names, "structured departments differ from official catalog/order")
        require(len(department_ids) == 92, "department IDs are not unique")
        require(all(item["summary"].strip() for item in departments), "every department needs a model-ready summary")
        require(next(item for item in departments if item["name"] == "医保科")["displayName"] == "医保部", "insurance department display name must be 医保部")
        require(hospital["name"] == "绵阳市中心医院", "hospital display name must be 绵阳市中心医院")
        require(sum(item["officialSummaryAvailability"] == "available" for item in departments) == 59, "official summary coverage changed")
        require(all((item["officialSummary"] is not None) == (item["officialSummaryAvailability"] == "available") for item in departments), "official summary availability mismatch")
        require(all(item["sources"] for item in departments), "every department needs sources")
        require(all(item["routingReviewStatus"] for item in departments), "every department needs routing review status")

        for department in departments:
            require(set(department["locationIds"]) <= location_ids, f"unknown location on {department['name']}")
        for location in locations:
            require(set(location.get("departmentIds", [])) <= department_ids, f"unknown department on {location['locationId']}")
        require(len(locations) == 624, f"expected 624 searchable map POIs, got {len(locations)}")
        require([item["floorId"] for item in floors["floors"]] == ["B1", "F1", "F2", "F3", "F4"], "floor set/order changed")
        require(sum(item["poiCount"] for item in floors["floors"]) == len(locations), "floor POI counts do not add up")
        require({item["mapId"] for item in locations} == {"90872"}, "unexpected map ID")

        common_terms = ["挂号", "收费", "医保", "洗手间", "电梯", "放射", "检查", "药"]
        searchable = " ".join(
            [item["canonicalName"] for item in locations]
            + [alias for item in locations for alias in item["aliases"]]
        )
        require(all(term in searchable for term in common_terms), "common hospital place vocabulary is incomplete")

        require(doctors["count"] == len(doctors["doctors"]) == 641, "doctor reference count mismatch")
        require(all(item["availability"] == "unknown_not_realtime" for item in doctors["doctors"]), "doctor references must not imply availability")
        require(all(item["dataOrigin"] == "official_public" for item in doctors["doctors"]), "doctor origin mismatch")
        doctor_reference_ids = {item["referenceId"] for item in doctors["doctors"]}
        require(schedule_reference["dataOrigin"] == "project_demo_reference", "doctor schedule reference must be marked as demo")
        require(all(rule["doctorReferenceId"] in doctor_reference_ids for rule in schedule_reference["rules"]), "doctor schedule references unknown doctor")
        require("不是医院官方排班" in schedule_reference["notice"], "doctor schedule simulation notice is incomplete")
        require(len(sources["sources"]) >= 102, "source registry is incomplete")
        registered_source_ids = {item["sourceId"] for item in sources["sources"]}
        referenced_official_ids = {ref["sourceId"] for item in departments for ref in item["sources"] if ref["dataOrigin"] == "official_public"}
        require(referenced_official_ids <= registered_source_ids, "a department source is missing from source registry")
        require(any(item["freshness"] == "volatile" for item in sources["sources"]), "volatile sources are not marked")
        require(unresolved["items"], "unresolved official data must be explicit")
        require(len(aliases["departments"]) == len(routing["departments"]) == 92, "curated department coverage mismatch")
        require(len(mappings["mappings"]) == 92, "department-map coverage mismatch")
        require(next(item for item in mappings["mappings"] if item["departmentName"] == "医保科")["departmentDisplayName"] == "医保部", "map mapping display name must be 医保部")
        require(all(item["mapStatus"] in {"mapped", "not_found"} for item in mappings["mappings"]), "invalid map status")
        require(insurance["publishedAt"] == "2022-07-27", "insurance reference date must be 2022-07-27")
        require(insurance["confirmationDestination"] == "医保部", "insurance confirmation destination must be 医保部")
        require(not simulation_manifest["instances"], "no simulated instances may be preloaded")
        forbidden_simulated = set(simulation_manifest["forbiddenSimulatedEntities"])
        require({"patient", "doctor", "appointment_slot", "appointment", "medical_record"} <= forbidden_simulated, "simulation forbidden list is incomplete")
        demo_catalog = load("demo/order-catalog.json")
        require(demo_catalog["dataOrigin"] == "project_demo_catalog", "order catalog must be explicitly marked as demo data")
        require(all(item["locationId"] in location_ids for item in demo_catalog["examinations"] + demo_catalog["medications"]), "demo order catalog contains unknown map locations")
        virtual_fixture = next(item for item in simulation_manifest["testingFixtures"] if item["fixtureId"] == "virtual-patient-male-65")
        require(virtual_fixture["retentionHours"] == 72 and "显式按钮" in virtual_fixture["activationRule"], "virtual patient fixture policy is incomplete")

        forbidden = {"simulated", "演示数据"}
        official_documents = [hospital, departments, doctors, load("official/service-contacts.json"), load("official/insurance-reference.json")]
        official_text = json.dumps(official_documents, ensure_ascii=False)
        require("dataOrigin\": \"simulated" not in official_text, "simulated data leaked into official artifacts")
        require(all(token not in hospital["name"] for token in forbidden), "hospital identity is simulated")
    except (AssertionError, KeyError, TypeError, ValidationError, json.JSONDecodeError) as error:
        failures.append(str(error))

    if failures:
        print("FAILED knowledge validation")
        for failure in failures:
            print(f"- {failure}")
        return 1

    mapped = sum(item["mapStatus"] == "mapped" for item in mappings["mappings"])
    print("PASS 16 knowledge deliverables present")
    print("PASS 92/92 official departments structured and sourced")
    print("PASS 92/92 departments have model-ready routing context")
    print("PASS 641 official doctor references marked non-realtime")
    print("PASS 5 floors and 624/624 map POIs indexed")
    print(f"PASS department-map mapping explicit: {mapped} mapped, {92 - mapped} not_found")
    print("PASS unresolved, volatile and project-curated data are explicitly marked")
    return 0


if __name__ == "__main__":
    sys.exit(main())
