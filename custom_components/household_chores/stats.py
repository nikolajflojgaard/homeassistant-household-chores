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


def _parse_iso_day(value: str) -> date | None:
    try:
        return date.fromisoformat(value)
    except (TypeError, ValueError):
        return None


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
    person_name_key = person_name.strip().lower()

    def _normalize_assignee(value: Any) -> str:
        if isinstance(value, dict):
            candidate = value.get("id", "") or value.get("person_id", "") or value.get("name", "")
            return str(candidate).strip()
        return str(value or "").strip()

    by_key: dict[str, dict[str, Any]] = {}
    for raw in tasks:
        if not isinstance(raw, dict):
            continue
        assignees = [_normalize_assignee(item) for item in raw.get("assignees", [])]
        assignees_lower = [item.lower() for item in assignees]
        if (
            str(person_id) not in assignees
            and person_name_key not in assignees_lower
        ):
            continue

        column = str(raw.get("column") or "monday").lower()
        task_week_start = str(raw.get("week_start") or selected_start_iso)
        task_week_day = _parse_iso_day(task_week_start)
        if task_week_day is None:
            normalized_task_start = selected_start
        else:
            normalized_task_start = _start_of_week(task_week_day, 0)
        if normalized_task_start != selected_start:
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


def next_three_tasks_summary(
    board: dict[str, Any],
    limit: int = 3,
    *,
    person_id: str | None = None,
) -> dict[str, Any]:
    """Return the next N open tasks from today and forward.

    If person_id is provided, only include tasks assigned to that person.
    Span (all-day multi-day) tasks are de-duplicated so they count once.
    """
    today = dt_util.as_local(dt_util.utcnow()).date()
    current_week_start = _start_of_week(today)
    people = board.get("people", []) if isinstance(board, dict) else []
    tasks = board.get("tasks", []) if isinstance(board, dict) else []
    people_by_id = {
        str(person.get("id", "")).strip(): str(person.get("name", "")).strip()
        for person in people
        if isinstance(person, dict) and str(person.get("id", "")).strip()
    }
    person_name_key = ""
    if person_id:
        person_name_key = str(people_by_id.get(str(person_id).strip(), "")).strip().lower()

    def _task_date(raw: dict[str, Any]) -> date | None:
        column = str(raw.get("column") or "").lower()
        if column not in WEEKDAY_INDEX:
            return None
        raw_week_start = str(raw.get("week_start") or current_week_start.isoformat())
        week_start_day = _parse_iso_day(raw_week_start)
        normalized_start = _start_of_week(week_start_day if week_start_day is not None else current_week_start)
        return normalized_start + timedelta(days=WEEKDAY_INDEX[column])

    # De-dupe span tasks so they count once. Keep min/max date.
    grouped: dict[str, dict[str, Any]] = {}
    for raw in tasks:
        if not isinstance(raw, dict):
            continue
        if str(raw.get("column") or "").lower() == "done":
            continue
        due_day = _task_date(raw)
        if due_day is None or due_day < today:
            continue
        assignee_ids = [str(item).strip() for item in raw.get("assignees", []) if str(item).strip()]
        if person_id:
            pid = str(person_id).strip()
            assignees_lower = [item.lower() for item in assignee_ids]
            if pid not in assignee_ids and person_name_key and person_name_key not in assignees_lower:
                continue
        assignee_names = [people_by_id.get(item, item) for item in assignee_ids]
        span_id = str(raw.get("span_id") or "").strip()
        raw_week_start = str(raw.get("week_start") or (due_day - timedelta(days=due_day.weekday())).isoformat())
        group_key = f"span:{span_id}:{raw_week_start}" if span_id else f"task:{str(raw.get('id') or '').strip()}"
        item = grouped.get(group_key)
        if item is None:
            item = {
                "id": str(raw.get("id") or ""),
                "title": str(raw.get("title") or "Untitled task"),
                "date": due_day.isoformat(),
                "start_date": due_day.isoformat(),
                "end_date": due_day.isoformat(),
                "column": str(raw.get("column") or "").lower(),
                "week_start": (due_day - timedelta(days=due_day.weekday())).isoformat(),
                "week_number": _week_number(due_day),
                "assignees": assignee_ids,
                "assignee_names": assignee_names,
                "span_id": span_id,
                "order": int(raw.get("order") or 0),
            }
            grouped[group_key] = item
        else:
            # Expand range for span tasks.
            if due_day.isoformat() < str(item.get("start_date") or item["date"]):
                item["start_date"] = due_day.isoformat()
                item["date"] = due_day.isoformat()
                item["column"] = str(raw.get("column") or "").lower()
            if due_day.isoformat() > str(item.get("end_date") or item["date"]):
                item["end_date"] = due_day.isoformat()

    rows = list(grouped.values())
    rows.sort(
        key=lambda item: (
            item["date"],
            int(item.get("order") or 0),
            item.get("title", ""),
        )
    )
    selected = rows[: max(0, int(limit))]
    return {
        "count": len(selected),
        "tasks": selected,
        "titles": [str(item.get("title") or "") for item in selected],
    }
