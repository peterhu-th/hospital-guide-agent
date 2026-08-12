"""Read visible metadata from a FengMap .fmap protobuf container.

This extractor intentionally treats the binary format as an offline indexing aid,
not as the runtime map API. The browser must still load the original file through
the supported FengMap JavaScript SDK.
"""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator


CHINESE_RE = re.compile(r"[\u4e00-\u9fff]")
NOISE_PREFIXES = ("MULTIPOLYGON", "POINT(", "LINESTRING")


@dataclass(frozen=True)
class Field:
    number: int
    wire_type: int
    value: int | bytes


def read_varint(data: bytes, offset: int) -> tuple[int, int]:
    value = 0
    shift = 0
    while offset < len(data) and shift <= 63:
        byte = data[offset]
        offset += 1
        value |= (byte & 0x7F) << shift
        if byte < 0x80:
            return value, offset
        shift += 7
    raise ValueError("invalid protobuf varint")


def parse_fields(data: bytes) -> list[Field]:
    fields: list[Field] = []
    offset = 0
    while offset < len(data):
        key, offset = read_varint(data, offset)
        number, wire_type = key >> 3, key & 0x07
        if number == 0:
            raise ValueError("invalid protobuf field number")
        if wire_type == 0:
            value, offset = read_varint(data, offset)
        elif wire_type == 1:
            if offset + 8 > len(data):
                raise ValueError("truncated fixed64")
            value = data[offset : offset + 8]
            offset += 8
        elif wire_type == 2:
            length, offset = read_varint(data, offset)
            if offset + length > len(data):
                raise ValueError("truncated length-delimited field")
            value = data[offset : offset + length]
            offset += length
        elif wire_type == 5:
            if offset + 4 > len(data):
                raise ValueError("truncated fixed32")
            value = data[offset : offset + 4]
            offset += 4
        else:
            raise ValueError(f"unsupported protobuf wire type: {wire_type}")
        fields.append(Field(number, wire_type, value))
    return fields


def decode_text(value: bytes) -> str | None:
    try:
        text = value.decode("utf-8").strip("\x00\r\n\t ")
    except UnicodeDecodeError:
        return None
    if not text or text.startswith(NOISE_PREFIXES):
        return None
    if CHINESE_RE.search(text) or (text.isprintable() and len(text) <= 120):
        return text
    return None


def nested_fields(value: bytes) -> list[Field] | None:
    try:
        fields = parse_fields(value)
    except (ValueError, IndexError):
        return None
    return fields if fields else None


def walk_texts(data: bytes, path: tuple[int, ...] = (), depth: int = 0) -> Iterator[tuple[tuple[int, ...], str]]:
    if depth > 12:
        return
    for field in parse_fields(data):
        if field.wire_type != 2 or not isinstance(field.value, bytes):
            continue
        field_path = (*path, field.number)
        text = decode_text(field.value)
        if text is not None:
            yield field_path, text
            continue
        nested = nested_fields(field.value)
        if nested is not None:
            yield from walk_texts(field.value, field_path, depth + 1)


def normalize_label(text: str) -> str:
    return re.sub(r"\d+[A-Za-z]*$", "", text).strip()


def extract_metadata(map_path: Path) -> dict:
    data = map_path.read_bytes()
    root = parse_fields(data)
    root_strings = {
        field.number: decode_text(field.value)
        for field in root
        if field.wire_type == 2 and isinstance(field.value, bytes) and decode_text(field.value)
    }
    paths = list(walk_texts(data))
    texts = []
    seen = set()
    for path, raw_text in paths:
        text = normalize_label(raw_text)
        if not text or text in seen:
            continue
        if len(text) > 80 or text.startswith(("extent_", "path_", "store_", "poi_", "lift_", "stair_", "escalator_")):
            continue
        seen.add(text)
        texts.append({"protobufPath": ".".join(map(str, path)), "label": text, "rawLabel": raw_text})

    floors = []
    for floor_id, floor_label in (("B1", "地下1层"), ("F1", "1层"), ("F2", "2层"), ("F3", "3层"), ("F4", "4层")):
        if any(item["label"] == floor_label for item in texts):
            floors.append({"floorId": floor_id, "floorLabel": floor_label})

    return {
        "mapId": root_strings.get(1),
        "mapName": root_strings.get(4),
        "fileName": map_path.name,
        "fileSize": len(data),
        "floors": floors,
        "visibleLabels": texts,
        "notice": "离线索引辅助结果；运行时地图必须通过蜂鸟 JavaScript SDK 加载原始 .fmap 文件。",
    }


def field_value(fields: list[Field], number: int):
    for field in fields:
        if field.number == number:
            return field.value
    return None


def extract_floor_pois(map_path: Path) -> list[dict]:
    """Extract named POI records grouped by floor.

    The root contains five repeating groups for B1/F1/F2/F3/F4. In each group,
    the POI attribute block is the length-delimited root field 10 whose nested
    field 3 equals 3. Named records are nested field 5 -> repeated field 4.
    """

    floor_by_index = {1: ("B1", "地下1层"), 2: ("F1", "1层"), 3: ("F2", "2层"), 4: ("F3", "3层"), 5: ("F4", "4层")}
    pois: list[dict] = []
    data = map_path.read_bytes()
    for block in (field.value for field in parse_fields(data) if field.number == 10 and isinstance(field.value, bytes)):
        try:
            block_fields = parse_fields(block)
        except ValueError:
            continue
        floor_index = field_value(block_fields, 1)
        layer_type = field_value(block_fields, 3)
        payload = field_value(block_fields, 5)
        if floor_index not in floor_by_index or layer_type != 3 or not isinstance(payload, bytes):
            continue
        floor_id, floor_label = floor_by_index[int(floor_index)]
        try:
            payload_fields = parse_fields(payload)
        except ValueError:
            continue
        for repeated in payload_fields:
            if repeated.number != 4 or not isinstance(repeated.value, bytes):
                continue
            try:
                record = parse_fields(repeated.value)
            except ValueError:
                continue
            raw_id = field_value(record, 2)
            raw_label = field_value(record, 4)
            if not isinstance(raw_id, bytes) or not isinstance(raw_label, bytes):
                continue
            feature_id = decode_text(raw_id)
            label = decode_text(raw_label)
            if not feature_id or not label or not CHINESE_RE.search(label):
                continue
            pois.append(
                {
                    "mapFeatureId": feature_id,
                    "mapLabel": label,
                    "floorId": floor_id,
                    "floorLabel": floor_label,
                }
            )
    return pois


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("map_path", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    result = extract_metadata(args.map_path)
    result["pois"] = extract_floor_pois(args.map_path)
    serialized = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(serialized + "\n", encoding="utf-8")
    else:
        print(serialized)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
