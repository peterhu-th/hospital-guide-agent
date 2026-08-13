"""Build offline knowledge artifacts from traceable source snapshots."""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import pathlib
import re
from collections import Counter, defaultdict


ROOT = pathlib.Path(__file__).resolve().parents[1]
KNOWLEDGE = ROOT / "knowledge"
HOSPITAL_ID = "hospital-mianyang-central"
MAP_ID = "90872"
NOW = dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).replace(microsecond=0).isoformat()


def read_json(path: pathlib.Path) -> object:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(relative_path: str, value: object) -> None:
    path = KNOWLEDGE / relative_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def stable_id(prefix: str, value: str, length: int = 12) -> str:
    digest = hashlib.sha1(value.encode("utf-8")).hexdigest()[:length]
    return f"{prefix}-{digest}"


def source_ref(
    source_id: str,
    origin: str,
    url: str | None = None,
    *,
    published_at: str | None = None,
    freshness: str = "stable",
    review_status: str = "official_public",
) -> dict[str, object]:
    result: dict[str, object] = {
        "sourceId": source_id,
        "dataOrigin": origin,
        "fetchedAt": NOW,
        "freshness": freshness,
        "reviewStatus": review_status,
    }
    if url:
        result["url"] = url
    if published_at:
        result["publishedAt"] = published_at
    return result


OFFICIAL_SOURCES = [
    {
        "sourceId": "official-hospital-introduction",
        "title": "医院简介-医院概况-绵阳市中心医院",
        "url": "https://www.myszxyy.cn/into_hos/",
        "publishedAt": None,
        "fetchedAt": NOW,
        "authority": "hospital_official",
        "freshness": "periodic",
        "usage": ["hospital_profile", "address"],
        "notes": "官网当前医院简介；组织规模等数字会变化，运行时仅作离线参考。",
    },
    {
        "sourceId": "official-department-directory",
        "title": "科室介绍-就医指南-绵阳市中心医院",
        "url": "https://www.myszxyy.cn/departments/",
        "publishedAt": None,
        "fetchedAt": NOW,
        "authority": "hospital_official",
        "freshness": "periodic",
        "usage": ["department_catalog", "department_introduction", "doctor_reference"],
        "notes": "采集时官网列出 92 个科室；医生信息不代表实时排班。",
    },
    {
        "sourceId": "official-guider-index",
        "title": "就医指南-绵阳市中心医院",
        "url": "https://www.myszxyy.cn/guider/",
        "publishedAt": None,
        "fetchedAt": NOW,
        "authority": "hospital_official",
        "freshness": "periodic",
        "usage": ["guide_index", "service_entry"],
        "notes": "离线知识入口，不在运行时联网读取。",
    },
    {
        "sourceId": "official-patient-flow",
        "title": "流程须知-就医指南-绵阳市中心医院",
        "url": "https://www.myszxyy.cn/patient_flow/",
        "publishedAt": None,
        "fetchedAt": NOW,
        "authority": "hospital_official",
        "freshness": "periodic",
        "usage": ["visit_process"],
        "notes": "栏目公开条目有限；缺失流程已记录为未确认。",
    },
    {
        "sourceId": "official-outpatient-schedule",
        "title": "门诊时间-就医指南-绵阳市中心医院",
        "url": "https://www.myszxyy.cn/guider_mzsj_/",
        "publishedAt": None,
        "fetchedAt": NOW,
        "authority": "hospital_official",
        "freshness": "volatile",
        "usage": ["outpatient_schedule_reference"],
        "notes": "主要以图片发布，不能作为实时出诊或号源依据。",
    },
    {
        "sourceId": "official-campus-navigation",
        "title": "交通导航-院区分布-绵阳市中心医院",
        "url": "https://www.myszxyy.cn/guider_jtdh_yqfb/",
        "publishedAt": None,
        "fetchedAt": NOW,
        "authority": "hospital_official",
        "freshness": "periodic",
        "usage": ["campus", "building_reference"],
        "notes": "室内地点与楼层冲突时以 90872 地图数据为准。",
    },
    {
        "sourceId": "official-patient-service-center",
        "title": "科室简介-患者服务中心-绵阳市中心医院",
        "url": "https://www.myszxyy.cn/departments_cryfwzxa0_ksjj/",
        "publishedAt": None,
        "fetchedAt": NOW,
        "authority": "hospital_official",
        "freshness": "periodic",
        "usage": ["patient_service", "manual_fallback"],
        "notes": "包含咨询、求助、投诉和入出院一站式服务职责。",
    },
    {
        "sourceId": "official-insurance-2022",
        "title": "绵阳市中心医院医保病人住院政策指南",
        "url": "https://www.myszxyy.cn/patient_insurance/2022/qaQn6qbn.html",
        "publishedAt": "2022-07-27",
        "fetchedAt": NOW,
        "authority": "hospital_official",
        "freshness": "volatile",
        "usage": ["insurance_reference", "historical_inpatient_process"],
        "notes": "历史政策材料；比例、窗口、材料和电话均需当前确认。",
    },
    {
        "sourceId": "map-90872",
        "title": "assets/maps/90872.fmap 室内地图包",
        "url": None,
        "publishedAt": None,
        "fetchedAt": NOW,
        "authority": "provided_map",
        "freshness": "unknown",
        "usage": ["floor", "poi", "indoor_navigation"],
        "notes": "用户指定地图；地点和楼层冲突以此数据为准。",
    },
    {
        "sourceId": "project-department-curation",
        "title": "项目导诊增强数据",
        "url": None,
        "publishedAt": None,
        "fetchedAt": NOW,
        "authority": "project_curated",
        "freshness": "periodic",
        "usage": ["aliases", "routing_context", "clarifying_questions"],
        "notes": "项目整理，不是医院发布的诊断或分科规则。",
    },
]


def category_for(label: str) -> str:
    if any(token in label for token in ("挂号", "报到", "分诊")):
        return "registration"
    if any(token in label for token in ("收费", "缴费", "结算")):
        return "payment"
    if "医保" in label:
        return "insurance"
    if any(token in label for token in ("药房", "取药", "配药")):
        return "pharmacy"
    if any(token in label for token in ("检查", "检验", "采血", "抽血", "CT", "磁共振", "放射", "超声", "病理", "心电", "内镜")):
        return "examination"
    if "停车" in label:
        return "parking"
    if "出入口" in label or label.endswith("入口") or label.endswith("出口"):
        return "entrance"
    if "直升电梯" in label or label == "电梯":
        return "elevator"
    if "手扶电梯" in label or "扶梯" in label:
        return "escalator"
    if "步行梯" in label or label == "楼梯":
        return "stairs"
    if "洗手间" in label or "卫生间" in label:
        return "restroom"
    if any(token in label for token in ("科", "门诊", "中心", "ICU", "重症监护")):
        return "department"
    if any(token in label for token in ("服务", "咨询", "导医", "护士站", "休息", "饮水")):
        return "service"
    return "other"


COMMON_LOCATION_ALIASES = {
    "挂号": ["挂号处", "办号"],
    "挂号收费": ["挂号处", "收费处", "缴费窗口", "交钱的地方"],
    "收费科": ["收费处", "缴费窗口", "交钱的地方"],
    "采血处": ["抽血处", "验血的地方"],
    "医学检验科": ["检验科", "化验室", "验血的地方"],
    "放射科": ["影像科", "拍片的地方", "CT室"],
    "超声科": ["B超室", "彩超室", "做B超的地方"],
    "药房": ["取药处", "拿药的地方"],
    "西药房": ["取西药", "拿药的地方"],
    "中药房": ["取中药"],
    "医保部": ["医保科", "医保窗口", "医保咨询"],
    "患者服务中心": ["服务台", "咨询处", "导医台", "人工服务"],
    "男洗手间": ["男卫生间", "男厕所"],
    "女洗手间": ["女卫生间", "女厕所"],
    "洗手间": ["卫生间", "厕所"],
    "直升电梯": ["电梯", "升降梯"],
    "手扶电梯": ["扶梯"],
    "步行梯": ["楼梯"],
}


def build() -> None:
    catalog = read_json(KNOWLEDGE / "source/department-catalog.json")
    snapshot = read_json(KNOWLEDGE / "source/official-directory-snapshot.json")
    curation = read_json(KNOWLEDGE / "source/department-curation.json")
    map_index = read_json(KNOWLEDGE / "map/raw-index.json")

    snapshot_by_name = {item["name"]: item for item in snapshot["departments"]}
    department_names = [name for names in catalog["divisions"].values() for name in names]
    department_ids = {name: stable_id("dept", name) for name in department_names}

    map_locations: list[dict[str, object]] = []
    label_to_locations: defaultdict[str, list[str]] = defaultdict(list)
    for poi in map_index["pois"]:
        label = poi["mapLabel"].strip()
        location_id = f"location-map-{poi['mapFeatureId']}"
        aliases = list(dict.fromkeys(COMMON_LOCATION_ALIASES.get(label, [])))
        location = {
            "locationId": location_id,
            "hospitalId": HOSPITAL_ID,
            "mapId": MAP_ID,
            "mapFeatureId": poi["mapFeatureId"],
            "canonicalName": label,
            "mapLabel": label,
            "aliases": aliases,
            "building": None,
            "floorId": poi["floorId"],
            "floorLabel": poi["floorLabel"],
            "category": category_for(label),
            "departmentIds": [],
            "routeEnabled": True,
            "mapStatus": "mapped",
            "coordinates": None,
            "sources": [source_ref("map-90872", "map_data", freshness="unknown", review_status="project_reviewed")],
            "dataOrigin": "map_data",
        }
        map_locations.append(location)
        label_to_locations[label].append(location_id)

    curated_departments = curation["departments"]
    service_aliases = curation.get("serviceAliases", {})
    routing_disabled_divisions = set(curation["routingDisabledDivisions"])
    routing_disabled_departments = set(curation["routingDisabledDepartments"])
    location_by_id = {item["locationId"]: item for item in map_locations}
    mapping_records: list[dict[str, object]] = []
    departments: list[dict[str, object]] = []
    aliases_artifact: list[dict[str, object]] = []
    routing_artifact: list[dict[str, object]] = []

    for division, names in catalog["divisions"].items():
        for name in names:
            official = snapshot_by_name[name]
            curated = curated_departments.get(name, {})
            aliases = list(dict.fromkeys(curated.get("aliases", []) + service_aliases.get(name, [])))
            match_labels: list[str] = []
            for candidate in [name, *aliases]:
                if candidate in label_to_locations:
                    match_labels.append(candidate)
            location_ids = list(dict.fromkeys(location_id for label in match_labels for location_id in label_to_locations[label]))
            for location_id in location_ids:
                location_by_id[location_id]["departmentIds"].append(department_ids[name])

            official_source = source_ref(
                f"official-department-{department_ids[name].removeprefix('dept-')}",
                "official_public",
                official["detailUrl"],
                freshness="periodic",
            )
            routing_enabled = division not in routing_disabled_divisions and name not in routing_disabled_departments
            summary = curated.get("summary") or f"医院官网列出的{name}，官网当前未发布可提取的科室简介。"
            hints = curated.get("routingHints", [f"用户明确询问{name}时可作为信息或流程候选"])
            differentiation = curated.get("differentiationHints", ["信息不足时不据此直接判断症状归属"])
            questions = curated.get("clarifyingQuestions", curation["defaultClarifyingQuestions"])
            departments.append(
                {
                    "departmentId": department_ids[name],
                    "hospitalId": HOSPITAL_ID,
                    "name": name,
                    "displayName": "医保部" if name == "医保科" else name,
                    "division": division,
                    "aliases": aliases,
                    "summary": summary,
                    "officialSummary": official["officialSummary"],
                    "officialSummaryAvailability": official["summaryAvailability"],
                    "routingHints": hints,
                    "differentiationHints": differentiation,
                    "clarifyingQuestions": questions,
                    "routingEnabled": routing_enabled,
                    "locationIds": location_ids,
                    "sources": [official_source, source_ref("project-department-curation", "project_curated", freshness="periodic", review_status="project_reviewed")],
                    "dataOrigin": "project_curated",
                    "routingReviewStatus": "project_reviewed" if name in curated_departments else "unreviewed",
                }
            )
            aliases_artifact.append(
                {
                    "departmentId": department_ids[name],
                    "officialName": name,
                    "displayName": "医保部" if name == "医保科" else name,
                    "aliases": aliases,
                    "dataOrigin": "project_curated" if aliases else "official_public",
                }
            )
            routing_artifact.append(
                {
                    "departmentId": department_ids[name],
                    "name": name,
                    "displayName": "医保部" if name == "医保科" else name,
                    "division": division,
                    "routingEnabled": routing_enabled,
                    "summary": summary,
                    "routingHints": hints,
                    "differentiationHints": differentiation,
                    "clarifyingQuestions": questions,
                    "routingReviewStatus": "project_reviewed" if name in curated_departments else "unreviewed",
                    "dataOrigin": "project_curated",
                }
            )
            mapping_records.append(
                {
                    "departmentId": department_ids[name],
                    "departmentName": name,
                    "departmentDisplayName": "医保部" if name == "医保科" else name,
                    "locationIds": location_ids,
                    "matchedMapLabels": match_labels,
                    "mapStatus": "mapped" if location_ids else "not_found",
                    "matchingRule": "exact_official_name_or_curated_alias",
                    "conflictRule": "地点或楼层冲突时以地图 90872 为准",
                }
            )

    doctors: list[dict[str, object]] = []
    for department in snapshot["departments"]:
        department_id = department_ids[department["name"]]
        for doctor in department["referenceDoctors"]:
            identity = doctor.get("profileUrl") or f"{department['name']}:{doctor['name']}:{doctor.get('title')}"
            doctors.append(
                {
                    "referenceId": stable_id("doctorref", identity),
                    "displayName": doctor["name"],
                    "professionalTitle": doctor.get("title"),
                    "departmentId": department_id,
                    "departmentName": department["name"],
                    "profileUrl": doctor.get("profileUrl"),
                    "availability": "unknown_not_realtime",
                    "usageRestriction": "仅作官网公开人员参考，不作为实时出诊、号源或模拟业务医生对象",
                    "sourceId": "official-department-directory",
                    "dataOrigin": "official_public",
                }
            )

    official_summary_missing = [item["name"] for item in snapshot["departments"] if not item["officialSummary"]]
    unreviewed_routing = [item["name"] for item in departments if item["routingReviewStatus"] == "unreviewed"]
    unmapped_departments = [item["departmentName"] for item in mapping_records if item["mapStatus"] == "not_found"]
    label_counts = Counter(item["canonicalName"] for item in map_locations)

    hospital = {
        "hospitalId": HOSPITAL_ID,
        "mapId": MAP_ID,
        "name": "绵阳市中心医院",
        "type": "三级甲等综合医院",
        "address": "四川省绵阳市警钟街常家巷12号",
        "contacts": [
            {"type": "service", "label": "服务热线", "value": "0816-2222821"},
            {"type": "emergency", "label": "医院急诊", "value": "0816-2231777"},
            {"type": "complaint", "label": "医院纪委", "value": "0816-2237353"},
        ],
        "campuses": [
            {
                "campusId": "campus-main",
                "name": "主院区",
                "buildings": ["门诊", "第一住院大楼", "第二住院大楼", "紫荆楼"],
            },
            {
                "campusId": "campus-jingkai",
                "name": "经开院区（经开分院）",
                "buildings": [],
            },
        ],
        "sources": [source_ref("official-hospital-introduction", "official_public", "https://www.myszxyy.cn/into_hos/", freshness="periodic")],
        "dataOrigin": "official_public",
        "version": "knowledge-2026-08-12",
    }

    contacts = {
        "hospitalId": HOSPITAL_ID,
        "notice": "以下为官网公开联系方式；非紧急场景由 Agent 提供导诊，紧急情况由医院工作人员处理。",
        "contacts": [
            {"contactId": "contact-service", "label": "服务热线", "value": "0816-2222821", "freshness": "periodic", "sourceId": "official-hospital-introduction"},
            {"contactId": "contact-emergency", "label": "医院急诊", "value": "0816-2231777", "freshness": "periodic", "sourceId": "official-hospital-introduction"},
            {"contactId": "contact-discipline", "label": "医院纪委", "value": "0816-2237353", "freshness": "periodic", "sourceId": "official-hospital-introduction"},
            {"contactId": "contact-insurance-window", "label": "医保政策综合服务窗口（历史公开）", "value": "0816-2230063", "freshness": "volatile", "sourceId": "official-insurance-2022", "requiresCurrentConfirmation": True},
        ],
        "dataOrigin": "official_public",
    }

    visit_guides = {
        "hospitalId": HOSPITAL_ID,
        "runtimeRule": "只使用离线整理数据；具体门诊时间、窗口、预约渠道和号源须由模拟系统或医院实时系统确认。",
        "guides": [
            {
                "guideId": "guide-outpatient-overview",
                "title": "门诊就医总览",
                "steps": ["选择或推荐科室", "模拟查询号源", "模拟挂号", "到地图地点报到", "就诊后查看模拟医嘱", "按医嘱完成检查、取药或缴费"],
                "dataOrigin": "project_curated",
                "simulationNotice": "流程骨架为项目整理；挂号和缴费业务结果均为演示系统数据",
                "sourceIds": ["official-guider-index", "official-patient-flow"],
            },
            {
                "guideId": "guide-patient-service",
                "title": "患者服务中心公开职责",
                "steps": ["咨询、建议、投诉和求助协调", "入出院手续指导", "医保审核手续指导", "院前检查一站式服务", "双向转诊接待协调"],
                "dataOrigin": "official_public",
                "sourceIds": ["official-patient-service-center"],
            },
            {
                "guideId": "guide-indoor-place-search",
                "title": "院内地点搜索",
                "steps": ["从用户表达识别地点别名", "返回地图中的标准标签和楼层", "地图与官网不一致时采用地图结果", "当前不提供实时定位和动态导航"],
                "dataOrigin": "project_curated",
                "sourceIds": ["map-90872"],
            },
        ],
    }

    insurance = {
        "hospitalId": HOSPITAL_ID,
        "notice": "本文件是 2022-07-27 官网文章的历史参考，不作为 2026 年实时医保政策或结算承诺。",
        "displayNotice": "信息发布时间：2022-07-27。仅作历史参考，当前政策、比例、材料、窗口和办理时限请向医保部确认。",
        "confirmationDestination": "医保部",
        "publishedAt": "2022-07-27",
        "freshness": "volatile",
        "requiresCurrentConfirmation": True,
        "historicalReference": {
            "topics": ["住院登记", "医保结算", "异地就医", "医保政策咨询"],
            "locationReferences": ["负一楼收费科", "医保政策咨询窗口", "第一住院大楼负一楼医保结算中心"],
            "excludedFromAgentCommitments": ["报销比例", "起付线", "封顶线", "窗口编号", "办理时限", "材料清单"],
        },
        "sourceId": "official-insurance-2022",
        "dataOrigin": "official_public",
    }

    unresolved = {
        "generatedAt": NOW,
        "rule": "无可靠公开来源的信息不得静默模拟为官方事实。",
        "items": [
            {
                "itemId": "unresolved-department-introductions",
                "topic": "官网未发布科室简介",
                "status": "partially_available",
                "affectedCount": len(official_summary_missing),
                "affectedDepartments": official_summary_missing,
                "fallback": "使用明确标记为 project_curated 的通俗摘要，不冒充官方简介",
            },
            {
                "itemId": "unresolved-outpatient-schedule",
                "topic": "门诊时间与医生出诊",
                "status": "volatile_image_only",
                "fallback": "不写入实时号源结论；运行时使用明确声明的演示医生和号源",
            },
            {
                "itemId": "unresolved-complete-public-processes",
                "topic": "完整门诊、检查检验、入出院流程",
                "status": "not_fully_published_as_structured_text",
                "fallback": "只保存官网已公开职责与历史参考；流程骨架标记为 project_curated",
            },
            {
                "itemId": "unresolved-current-insurance",
                "topic": "当前医保政策、材料、窗口和结算规则",
                "status": "requires_current_confirmation",
                "fallback": "保留 2022 历史文章并明确禁止作为实时承诺",
            },
            {
                "itemId": "unresolved-routing-review",
                "topic": "尚未人工细化的非临床科室导诊上下文",
                "status": "not_required_for_symptom_routing",
                "affectedCount": len(unreviewed_routing),
                "affectedDepartments": unreviewed_routing,
                "fallback": "保留在全科室目录中，但 routingEnabled=false，不用于症状推荐",
            },
            {
                "itemId": "unresolved-map-department-match",
                "topic": "官网科室在地图中未找到同名或已整理别名 POI",
                "status": "not_found",
                "affectedCount": len(unmapped_departments),
                "affectedDepartments": unmapped_departments,
                "fallback": "设置 mapStatus=not_found，不推断楼层；仍可完成科室召回",
            },
            {
                "itemId": "unresolved-map-age",
                "topic": "90872.fmap 的发布时间与更新频率",
                "status": "unknown",
                "fallback": "按用户指定作为地点与楼层优先来源，并在部署前做现场核对",
            },
        ],
    }

    floors = {
        "hospitalId": HOSPITAL_ID,
        "hospitalDisplayName": "绵阳市中心医院",
        "mapId": MAP_ID,
        "mapName": map_index["mapName"],
        "floors": [
            {
                **floor,
                "poiCount": sum(1 for item in map_locations if item["floorId"] == floor["floorId"]),
                "sourceId": "map-90872",
                "dataOrigin": "map_data",
            }
            for floor in map_index["floors"]
        ],
    }

    location_aliases = {
        "mapId": MAP_ID,
        "notice": "别名为项目整理数据；标准地点与楼层来自地图。",
        "aliases": [
            {"alias": alias, "locationId": item["locationId"], "canonicalName": item["canonicalName"], "dataOrigin": "project_curated"}
            for item in map_locations
            for alias in item["aliases"]
        ],
    }

    source_conflicts = {
        "rule": "地点名称和楼层冲突时以地图 90872 为准；地图没有的地点不得猜测楼层。",
        "conflicts": [
            {
                "conflictId": "conflict-hospital-name",
                "field": "hospitalName",
                "officialValue": "绵阳市中心医院",
                "mapValue": "绵阳中心医院",
                "resolution": "医院展示名采用官网名称；地图调用使用 mapId=90872 和地图原名",
                "winner": "official_for_identity_map_for_navigation",
            },
            {
                "conflictId": "conflict-insurance-office-name",
                "field": "locationName",
                "officialValue": "医保科/医保政策咨询窗口",
                "mapValue": "医保部",
                "resolution": "地点搜索映射为地图标签“医保部”及其楼层",
                "winner": "map-90872",
            },
            {
                "conflictId": "conflict-official-department-map-coverage",
                "field": "departmentLocation",
                "officialValue": f"官网科室 {len(department_names)} 个",
                "mapValue": f"自动精确映射 {len(department_names) - len(unmapped_departments)} 个",
                "resolution": "未匹配科室统一标记 not_found；后续需现场或院方确认，不自动猜测",
                "winner": "map-90872",
            },
        ],
        "ambiguousMapLabels": [
            {"mapLabel": label, "occurrences": count}
            for label, count in sorted(label_counts.items())
            if count > 1
        ],
    }

    write_json("official/hospital.json", hospital)
    write_json("official/departments.json", departments)
    write_json("official/doctors-reference.json", {"notice": "官网公开参考资料，不等同于实时出诊或号源", "count": len(doctors), "doctors": doctors})
    write_json("official/service-contacts.json", contacts)
    write_json("official/visit-guides.json", visit_guides)
    write_json("official/insurance-reference.json", insurance)
    department_sources = [
        {
            "sourceId": f"official-department-{department_ids[item['name']].removeprefix('dept-')}",
            "title": f"{item['name']}-科室介绍-绵阳市中心医院",
            "url": item["detailUrl"],
            "publishedAt": None,
            "fetchedAt": snapshot["fetchedAt"],
            "authority": "hospital_official",
            "freshness": "periodic",
            "usage": ["department_introduction", "doctor_reference"],
            "notes": "官网科室详情页；医生信息不代表实时排班。",
        }
        for item in snapshot["departments"]
    ]
    write_json("official/source-registry.json", {"generatedAt": NOW, "sources": [*OFFICIAL_SOURCES, *department_sources]})
    write_json("official/unresolved-official-data.json", unresolved)
    write_json("curated/department-aliases.json", {"notice": curation["notice"], "departments": aliases_artifact})
    write_json("curated/department-routing-context.json", {"notice": curation["notice"], "departments": routing_artifact})
    write_json("map/floors.json", floors)
    write_json("map/locations.json", map_locations)
    write_json("map/location-aliases.json", location_aliases)
    write_json("map/department-location-mapping.json", {"mapId": MAP_ID, "rule": "地图优先；未找到不猜测", "mappings": mapping_records})
    write_json("map/source-conflicts.json", source_conflicts)

    print(
        f"Built knowledge base: {len(departments)} departments, {len(doctors)} doctor references, "
        f"{len(map_locations)} POIs, {len(department_names) - len(unmapped_departments)} mapped departments."
    )


if __name__ == "__main__":
    build()
