import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadJson(path) { return JSON.parse(readFileSync(path, "utf8")); }

export class KnowledgeRepository {
  constructor(root) {
    this.departments = loadJson(resolve(root, "official/departments.json"));
    this.hospital = loadJson(resolve(root, "official/hospital.json"));
    this.insurance = loadJson(resolve(root, "official/insurance-reference.json"));
    this.locations = loadJson(resolve(root, "map/locations.json"));
    this.locationAliases = loadJson(resolve(root, "map/location-aliases.json"));
    this.departmentRouting = loadJson(resolve(root, "curated/department-routing-context.json")).departments;
    this.departmentAliases = loadJson(resolve(root, "curated/department-aliases.json")).departments;
    this.simulationManifest = loadJson(resolve(root, "simulation-manifest.json"));
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

  listDepartments() {
    return this.departments.map(({ departmentId, displayName, division, summary }) => ({ departmentId, displayName, division, summary }));
  }

  routingCandidates(expression, limit = 24) {
    const text = String(expression ?? "").toLowerCase();
    const aliases = new Map(this.departmentAliases.map((item) => [item.departmentId, item.aliases ?? []]));
    const scored = this.departmentRouting.map((item) => {
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
    return this.locations.filter((location) => JSON.stringify(location).toLowerCase().includes(text)).slice(0, 30);
  }

  findLocation(locationId) { return this.locations.find((location) => location.locationId === locationId) ?? null; }

  staticRoute(startLocationId, endLocationId) {
    const start = this.findLocation(startLocationId);
    const end = this.findLocation(endLocationId);
    if (!start || !end) return { startLocationId, endLocationId, status: "UNAVAILABLE", steps: [], reason: "起点或终点不在地图索引中" };
    if (!start.routeEnabled || !end.routeEnabled) return { startLocationId, endLocationId, status: "UNAVAILABLE", steps: [], reason: "该地点尚未确认可用于路线计算" };
    const steps = [`从${start.floorLabel ?? "当前楼层"}的“${start.mapLabel ?? start.canonicalName}”出发。`];
    if (start.floorId !== end.floorId) steps.push(`前往电梯或楼梯，到达${end.floorLabel}。`);
    steps.push(`在${end.floorLabel ?? "目标楼层"}按地图指示前往“${end.mapLabel ?? end.canonicalName}”。`);
    return { startLocationId, endLocationId, status: "AVAILABLE", steps, reason: "静态文字路线依据地图楼层和POI生成；暂不包含实时定位和精确路径线。" };
  }
}
