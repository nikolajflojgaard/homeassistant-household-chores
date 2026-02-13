"""Board stats helpers for sensors/services."""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from homeassistant.util import dt as dt_util

WEEKDAY_COLUMNS = [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
]
WEEKDAY_INDEX = {day: idx for idx, day in enumerate(WEEKDAY_COLUMNS)}


def _start_of_week(day_value: date, offset: int = 0) -> date:
    start = day_value - timedelta(days=day_value.weekday())
    if offset:
        start = start + timedelta(days=offset * 7)
    return start


def _week_number(day_value: date) -> int:
    return int(day_value.isocalendar()[1])


def week_bounds(offset: int = 0) -> tuple[str, str, int]:
    """Return selected week start/end iso + week number."""
    today = dt_util.as_local(dt_util.utcnow()).date()
    start = _start_of_week(today, offset)
    end = start + timedelta(days=6)
    return start.isoformat(), end.isoformat(), _week_number(start)


def person_week_stats(board: dict[str, Any], person_id: str, week_offset: int = 0) -> dict[str, Any]:
    """Build per-person task stats for one week."""
    today = dt_util.as_local(dt_util.utcnow()).date()
    selected_start = _start_of_week(today, week_offset)
    selected_start_iso = selected_start.isoformat()
    selected_end_iso = (selected_start + timedelta(days=6)).isoformat()
    selected_week_number = _week_number(selected_start)
    today_key = WEEKDAY_COLUMNS[today.weekday()]
    people = board.get("people", []) if isinstance(board, dict) else []
    tasks = board.get("tasks", []) if isinstance(board, dict) else []

    person_name = ""
    for person in people:
        if str(person.get("id", "")) == str(person_id):
            person_name = str(person.get("name", "")).strip()
            break

    by_key: dict[str, dict[str, Any]] = {}
    for raw in tasks:
        if not isinstance(raw, dict):
            continue
        assignees = [str(item) for item in raw.get("assignees", [])]
        if str(person_id) not in assignees:
            continue

        column = str(raw.get("column") or "monday").lower()
        task_week_start = str(raw.get("week_start") or selected_start_iso)
        if task_week_start != selected_start_iso:
            continue
        if column not in WEEKDAY_INDEX and column != "done":
            continue

        task_id = str(raw.get("id") or "")
        span_id = str(raw.get("span_id") or "")
        key = f"span:{span_id}:{task_week_start}" if span_id else (task_id or f"row:{len(by_key)}")
        item = by_key.get(key)
        if item is None:
            item = {
                "id": task_id,
                "title": str(raw.get("title") or "Untitled task"),
                "done": False,
                "fixed": bool(raw.get("fixed", False)),
                "template_id": str(raw.get("template_id") or ""),
                "end_date": str(raw.get("end_date") or ""),
                "days": [],
            }
            by_key[key] = item
        if column == "done":
            item["done"] = True
        elif column in WEEKDAY_INDEX and column not in item["days"]:
            item["days"].append(column)

    rows = list(by_key.values())
    for row in rows:
        row["days"] = sorted(row["days"], key=lambda day: WEEKDAY_INDEX.get(day, 99))
        if row["days"]:
            row["day"] = row["days"][0]
        else:
            row["day"] = "done" if row["done"] else ""
        row["state"] = "done" if row["done"] else "open"

    total = len(rows)
    done = sum(1 for row in rows if row["done"])
    remaining = total - done
    today_count = 0
    upcoming_count = 0
    if week_offset == 0:
        for row in rows:
            if row["done"]:
                continue
            day_keys = row["days"] or []
            if today_key in day_keys:
                today_count += 1
            elif any(WEEKDAY_INDEX.get(day, -1) > WEEKDAY_INDEX.get(today_key, -1) for day in day_keys):
                upcoming_count += 1

    return {
        "person_id": str(person_id),
        "person_name": person_name,
        "week_offset": int(week_offset),
        "week_start": selected_start_iso,
        "week_end": selected_end_iso,
        "week_number": selected_week_number,
        "total": total,
        "done": done,
        "remaining": remaining,
        "today": today_count,
        "upcoming": upcoming_count,
        "tasks": rows,
    }

