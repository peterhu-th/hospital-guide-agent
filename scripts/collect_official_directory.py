"""Collect the hospital's public department landing pages into an offline snapshot."""

from __future__ import annotations

import concurrent.futures
import datetime as dt
import html
import json
import pathlib
import re
import sys
import urllib.parse
import urllib.request
from html.parser import HTMLParser


ROOT = pathlib.Path(__file__).resolve().parents[1]
CATALOG_PATH = ROOT / "knowledge/source/department-catalog.json"
OUTPUT_PATH = ROOT / "knowledge/source/official-directory-snapshot.json"
DIRECTORY_URL = "https://www.myszxyy.cn/departments/"
USER_AGENT = "HospitalGuideKnowledgeCollector/1.0"


def fetch(url: str) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=30) as response:
        raw = response.read()
    return raw.decode("utf-8", errors="replace")


class LinkParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.href: str | None = None
        self.text: list[str] = []
        self.links: list[tuple[str, str]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "a":
            self.href = dict(attrs).get("href")
            self.text = []

    def handle_data(self, data: str) -> None:
        if self.href is not None:
            self.text.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "a" and self.href is not None:
            self.links.append((" ".join("".join(self.text).split()), self.href))
            self.href = None
            self.text = []


class DepartmentPageParser(HTMLParser):
    def __init__(self, page_url: str) -> None:
        super().__init__()
        self.page_url = page_url
        self.intro_depth = 0
        self.intro_parts: list[str] = []
        self.expert_depth = 0
        self.current_expert: dict[str, str | None] | None = None
        self.experts: list[dict[str, str | None]] = []
        self.capture_name = False
        self.capture_title = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        classes = set((attributes.get("class") or "").split())
        if tag == "div" and "intro-txt" in classes and self.intro_depth == 0:
            self.intro_depth = 1
        elif self.intro_depth and tag == "div":
            self.intro_depth += 1

        if tag == "div" and "expert-info" in classes and self.expert_depth == 0:
            self.expert_depth = 1
            self.current_expert = {"name": None, "title": None, "profileUrl": None}
        elif self.expert_depth and tag == "div":
            self.expert_depth += 1

        if self.expert_depth and self.current_expert is not None:
            if tag == "a" and attributes.get("href"):
                self.current_expert["profileUrl"] = urllib.parse.urljoin(self.page_url, attributes["href"])
            elif tag == "strong":
                self.capture_name = True
            elif tag == "u":
                self.capture_title = True

    def handle_data(self, data: str) -> None:
        text = " ".join(html.unescape(data).split())
        if text and self.intro_depth:
            self.intro_parts.append(text)
        if text and self.current_expert is not None:
            if self.capture_name:
                self.current_expert["name"] = text
            elif self.capture_title:
                self.current_expert["title"] = text

    def handle_endtag(self, tag: str) -> None:
        if tag == "strong":
            self.capture_name = False
        elif tag == "u":
            self.capture_title = False

        if self.intro_depth and tag == "div":
            self.intro_depth -= 1
        if self.expert_depth and tag == "div":
            self.expert_depth -= 1
            if self.expert_depth == 0 and self.current_expert is not None:
                if self.current_expert.get("name"):
                    self.experts.append(self.current_expert)
                self.current_expert = None


def collect_department(entry: tuple[str, str, str]) -> dict[str, object]:
    name, division, detail_url = entry
    result: dict[str, object] = {
        "name": name,
        "division": division,
        "detailUrl": detail_url,
        "officialSummary": None,
        "summaryAvailability": "fetch_failed",
        "referenceDoctors": [],
        "collectionError": None,
    }
    try:
        parser = DepartmentPageParser(detail_url)
        parser.feed(fetch(detail_url))
        summary = re.sub(r"\s+", " ", " ".join(parser.intro_parts)).strip()
        summary = re.sub(r"\s*查看详细\s*$", "", summary).strip()
        result["officialSummary"] = summary or None
        result["summaryAvailability"] = "available" if summary else "not_published"
        result["referenceDoctors"] = parser.experts
    except Exception as exc:  # recorded rather than silently inventing data
        result["collectionError"] = f"{type(exc).__name__}: {exc}"
    return result


def main() -> int:
    catalog = json.loads(CATALOG_PATH.read_text(encoding="utf-8-sig"))
    names = {
        name: division
        for division, department_names in catalog["divisions"].items()
        for name in department_names
    }
    parser = LinkParser()
    parser.feed(fetch(DIRECTORY_URL))
    detail_urls: dict[str, str] = {}
    for text, href in parser.links:
        if text in names and "/departments_" in href:
            detail_urls.setdefault(text, urllib.parse.urljoin(DIRECTORY_URL, href))

    entries = [(name, division, detail_urls[name]) for name, division in names.items() if name in detail_urls]
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as executor:
        collected = list(executor.map(collect_department, entries))
    order = {name: index for index, name in enumerate(names)}
    collected.sort(key=lambda item: order[str(item["name"])])

    snapshot = {
        "sourceUrl": DIRECTORY_URL,
        "sourceTitle": "科室介绍-就医指南-绵阳市中心医院",
        "fetchedAt": dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).isoformat(),
        "dataOrigin": "official_public",
        "catalogDepartmentCount": len(names),
        "linkedDepartmentCount": len(entries),
        "departments": collected,
    }
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        f"Collected {len(collected)} departments; "
        f"{sum(bool(item['officialSummary']) for item in collected)} summaries; "
        f"{sum(len(item['referenceDoctors']) for item in collected)} doctor references."
    )
    return 0 if len(entries) == len(names) else 1


if __name__ == "__main__":
    sys.exit(main())
