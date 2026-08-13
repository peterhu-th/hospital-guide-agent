import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadJson(path) { return JSON.parse(readFileSync(path, "utf8")); }
const NON_BOOKABLE_DIVISIONS = new Set(["行后职能科室", "医技部", "手麻平台部", "其他"]);
const NON_BOOKABLE_NAMES = new Set(["门诊部", "患者服务中心", "MDT平台中心", "超声医学科"]);

export class KnowledgeRepository {
  constructor(root) {
    this.departments = loadJson(resolve(root, "official/departments.json"));
    this.hospital = loadJson(resolve(root, "official/hospital.json"));
    this.insurance = loadJson(resolve(root, "official/insurance-reference.json"));
    this.locations = loadJson(resolve(root, "map/locations.json"));
    this.hospitalGeofence = loadJson(resolve(root, "map/hospital-geofence.json"));
    this.locationAliases = loadJson(resolve(root, "map/location-aliases.json"));
    this.departmentRouting = loadJson(resolve(root, "curated/department-routing-context.json")).departments;
    this.departmentAliases = loadJson(resolve(root, "curated/department-aliases.json")).departments;
    this.simulationManifest = loadJson(resolve(root, "simulation-manifest.json"));
    this.orderCatalog = loadJson(resolve(root, "demo/order-catalog.json"));
    this.doctorReferences = loadJson(resolve(root, "official/doctors-reference.json")).doctors;
    this.doctorScheduleReference = loadJson(resolve(root, "demo/doctor-schedule-reference.json"));
    const doctorReferenceIds = new Set(this.doctorReferences.map((item) => item.referenceId));
    for (const rule of this.doctorScheduleReference.rules) {
      if (!doctorReferenceIds.has(rule.doctorReferenceId)) throw new Error(`演示排班引用了未知医生：${rule.doctorReferenceId}`);
    }
    const locationIds = new Set(this.locations.map((item) => item.locationId));
    for (const item of [...this.orderCatalog.examinations, ...this.orderCatalog.medications]) {
      if (!locationIds.has(item.locationId)) throw new Error(`演示医嘱目录引用了未知地图地点：${item.locationId}`);
    }
  }

  seed(db) {
    db.transaction(() => {
      for (const department of this.departments) db.run(`INSERT INTO departments(department_id,name,display_name,division,summary,aliases_json)
        VALUES(:id,:name,:display,:division,:summary,:aliases) ON CONFLICT(department_id) DO UPDATE SET name=excluded.name,display_name=excluded.display_name,division=excluded.division,summary=excluded.summary,aliases_json=excluded.aliases_json`, {
        id: department.departmentId, name: department.name, display: department.displayName,
        division: department.division ?? null, summary: department.summary ?? "", aliases: JSON.stringify(department.aliases ?? []),
      });
    });
  }

  isBookingEligible(department) {
    return !NON_BOOKABLE_DIVISIONS.has(department.division) && !NON_BOOKABLE_NAMES.has(department.displayName);
  }

  listDepartments({ bookingOnly = false, query = "", limit = 100 } = {}) {
    const needle = String(query).trim().toLowerCase();
    return this.departments
      .filter((item) => !bookingOnly || this.isBookingEligible(item))
      .filter((item) => !needle || [item.displayName, item.name, ...(item.aliases ?? [])].some((value) => String(value ?? "").toLowerCase().includes(needle)))
      .slice(0, Math.min(Math.max(Number(limit) || 100, 1), 100))
      .map(({ departmentId, displayName, division, summary, ...department }) => ({ departmentId, displayName, division, summary, bookingEligible: this.isBookingEligible({ displayName, division, ...department }) }));
  }

  routingCandidates(expression, limit = 24) {
    const text = String(expression ?? "").toLowerCase();
    const aliases = new Map(this.departmentAliases.map((item) => [item.departmentId, item.aliases ?? []]));
    const eligibleIds = new Set(this.departments.filter((item) => this.isBookingEligible(item)).map((item) => item.departmentId));
    const scored = this.departmentRouting.filter((item) => eligibleIds.has(item.departmentId)).map((item) => {
      const terms = [item.name, item.displayName, ...(aliases.get(item.departmentId) ?? []), ...(item.routingHints ?? [])].filter(Boolean);
      const score = terms.reduce((total, term) => total + (text.includes(String(term).toLowerCase()) ? Math.max(2, String(term).length) : 0), 0);
      return { ...item, aliases: aliases.get(item.departmentId) ?? [], score };
    });
    const matched = scored.filter((item) => item.score > 0).sort((a, b) => b.score - a.score);
    const selected = matched.length ? matched.slice(0, limit) : scored;
    return selected.map(({ departmentId, displayName, division, summary, aliases: itemAliases, differentiationHints }) => ({ departmentId, name: displayName, division: division ?? "未分组", summary, aliases: itemAliases, differentiationHints: differentiationHints ?? [] }));
  }

  searchLocations(query) {
    const text = String(query ?? "").trim().toLowerCase();
    if (!text) return [];
    return this.locations.filter((location) => JSON.stringify(location).toLowerCase().includes(text)).slice(0, 6);
  }

  findLocation(locationId) { return this.locations.find((location) => location.locationId === locationId) ?? null; }

  orderCatalogForDoctor() {
    const publicItem = (item, orderType) => ({
      catalogItemId: item.catalogItemId, orderType, name: item.name, details: item.details,
      amountCents: item.amountCents, location: this.findLocation(item.locationId),
      dataOrigin: this.orderCatalog.dataOrigin,
    });
    return {
      version: this.orderCatalog.version, notice: this.orderCatalog.notice,
      examinations: this.orderCatalog.examinations.map((item) => publicItem(item, "EXAMINATION")),
      medications: this.orderCatalog.medications.map((item) => publicItem(item, "PRESCRIPTION")),
    };
  }

  findOrderCatalogItem(catalogItemId, orderType) {
    const source = orderType === "EXAMINATION" ? this.orderCatalog.examinations : this.orderCatalog.medications;
    return source.find((item) => item.catalogItemId === catalogItemId) ?? null;
  }

  locationsForDepartment(departmentId) {
    return this.locations.filter((location) => location.routeEnabled && (location.departmentIds ?? []).includes(departmentId));
  }

  staticRoute(startLocationId, endLocationId) {
    const start = this.findLocation(startLocationId);
    const end = this.findLocation(endLocationId);
    if (!start || !end) return { startLocationId, endLocationId, status: "UNAVAILABLE", steps: [], reason: "起点或终点不在地图索引中" };
    if (start.locationId === end.locationId) return { startLocationId, endLocationId, status: "UNAVAILABLE", steps: [], reason: "起点和终点不能相同" };
    if (!start.routeEnabled || !end.routeEnabled) return { startLocationId, endLocationId, status: "UNAVAILABLE", steps: [], reason: "该地点尚未确认可用于路线计算" };
    const steps = [`从${start.floorLabel ?? "当前楼层"}的“${start.mapLabel ?? start.canonicalName}”出发。`];
    if (start.floorId !== end.floorId) steps.push(`前往电梯或楼梯，到达${end.floorLabel}。`);
    steps.push(`在${end.floorLabel ?? "目标楼层"}按地图指示前往“${end.mapLabel ?? end.canonicalName}”。`);
    const publicLocation = (location) => ({
      locationId: location.locationId, mapFeatureId: location.mapFeatureId,
      canonicalName: location.canonicalName, mapLabel: location.mapLabel,
      floorId: location.floorId, floorLabel: location.floorLabel,
    });
    return {
      startLocationId, endLocationId, status: "AVAILABLE", steps,
      locations: { start: publicLocation(start), end: publicLocation(end) },
      reason: "地图路径计算不可用时显示简短的楼层指引。",
    };
  }
}
