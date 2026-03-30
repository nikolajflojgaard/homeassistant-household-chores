"""Service registration for Household Chores."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from typing import Any
from uuid import uuid4

import voluptuous as vol

from homeassistant.core import HomeAssistant, ServiceCall, ServiceResponse, SupportsResponse
from homeassistant.util import dt as dt_util

from .const import DOMAIN
from .stats import WEEKDAY_COLUMNS, person_week_stats

SERVICE_SAVE_BOARD = "save_board"
SERVICE_GET_PERSON_TASKS = "get_person_tasks"
SERVICE_GET_WEEK_SUMMARY = "get_week_summary"
SERVICE_CREATE_TASK = "create_task"

_SAVE_SCHEMA = vol.Schema(
    {
        vol.Required("entry_id"): str,
        vol.Required("board"): dict,
    }
)
_GET_PERSON_TASKS_SCHEMA = vol.Schema(
    {
        vol.Required("entry_id"): str,
        vol.Required("person_id"): str,
        vol.Optional("week_offset", default=0): vol.Coerce(int),
    }
)
_GET_WEEK_SUMMARY_SCHEMA = vol.Schema(
    {
        vol.Required("entry_id"): str,
        vol.Optional("week_offset", default=0): vol.Coerce(int),
    }
)
_CREATE_TASK_SCHEMA = vol.Schema(
    {
        vol.Required("entry_id"): str,
        vol.Required("title"): vol.All(str, vol.Length(min=1)),
        vol.Optional("date"): str,
        vol.Optional("assignees"): [str],
        vol.Optional("assignee_names"): [str],
    }
)


async def async_register(hass: HomeAssistant) -> None:
    """Register integration services."""

    async def _async_save_board(call: ServiceCall) -> None:
        entry_id = call.data["entry_id"]
        board = call.data["board"]
        board_store = hass.data.get(DOMAIN, {}).get("boards", {}).get(entry_id)
        if board_store is None:
            return
        await board_store.async_save(board)

    async def _async_get_person_tasks(call: ServiceCall) -> ServiceResponse:
        entry_id = call.data["entry_id"]
        person_id = str(call.data["person_id"])
        week_offset = int(call.data.get("week_offset", 0))
        board_store = hass.data.get(DOMAIN, {}).get("boards", {}).get(entry_id)
        if board_store is None:
            return {"ok": False, "error": f"entry_not_found: {entry_id}"}
        board = await board_store.async_load()
        return {"ok": True, "entry_id": entry_id, **person_week_stats(board, person_id, week_offset)}

    async def _async_get_week_summary(call: ServiceCall) -> ServiceResponse:
        entry_id = call.data["entry_id"]
        week_offset = int(call.data.get("week_offset", 0))
        board_store = hass.data.get(DOMAIN, {}).get("boards", {}).get(entry_id)
        if board_store is None:
            return {"ok": False, "error": f"entry_not_found: {entry_id}"}
        board = await board_store.async_load()
        people = board.get("people", []) if isinstance(board, dict) else []
        summaries = [
            person_week_stats(board, str(person.get("id", "")), week_offset)
            for person in people
            if str(person.get("id", "")).strip()
        ]
        return {
            "ok": True,
            "entry_id": entry_id,
            "week_offset": week_offset,
            "people": summaries,
            "totals": {
                "total": sum(int(item.get("total") or 0) for item in summaries),
                "done": sum(int(item.get("done") or 0) for item in summaries),
                "remaining": sum(int(item.get("remaining") or 0) for item in summaries),
            },
        }

    async def _async_create_task(call: ServiceCall) -> ServiceResponse:
        entry_id = call.data["entry_id"]
        board_store = hass.data.get(DOMAIN, {}).get("boards", {}).get(entry_id)
        if board_store is None:
            return {"ok": False, "error": f"entry_not_found: {entry_id}"}

        board = await board_store.async_load()
        people = board.get("people", []) if isinstance(board, dict) else []
        people_by_id = {
            str(person.get("id", "")).strip(): person
            for person in people
            if isinstance(person, dict) and str(person.get("id", "")).strip()
        }
        people_name_map = {
            str(person.get("name", "")).strip().lower(): str(person.get("id", "")).strip()
            for person in people
            if isinstance(person, dict)
            and str(person.get("id", "")).strip()
            and str(person.get("name", "")).strip()
        }

        title = str(call.data["title"]).strip()
        task_date = _parse_date(call.data.get("date")) or dt_util.as_local(dt_util.utcnow()).date()

        explicit_ids = [str(item).strip() for item in call.data.get("assignees", []) if str(item).strip()]
        explicit_names = [str(item).strip() for item in call.data.get("assignee_names", []) if str(item).strip()]

        resolved_assignees: list[str] = []
        unknown_names: list[str] = []
        for person_id in explicit_ids:
            if person_id in people_by_id and person_id not in resolved_assignees:
                resolved_assignees.append(person_id)
        for name in explicit_names:
            person_id = people_name_map.get(name.lower())
            if person_id:
                if person_id not in resolved_assignees:
                    resolved_assignees.append(person_id)
            else:
                unknown_names.append(name)

        column = WEEKDAY_COLUMNS[task_date.weekday()]
        week_start = _week_start_for_day(task_date)
        week_number = week_start.isocalendar().week

        tasks = list(board.get("tasks", [])) if isinstance(board.get("tasks"), list) else []
        order = sum(1 for task in tasks if str(task.get("column") or "").lower() == column)
        created_at = datetime.now(UTC).isoformat()
        new_task = {
            "id": f"task_{uuid4().hex[:12]}",
            "title": title,
            "assignees": resolved_assignees,
            "column": column,
            "order": order,
            "created_at": created_at,
            "end_date": task_date.isoformat(),
            "template_id": None,
            "fixed": False,
            "span_id": None,
            "span_index": 0,
            "span_total": 0,
            "week_start": week_start.isoformat(),
            "week_number": week_number,
        }

        next_board = dict(board)
        next_board["tasks"] = [*tasks, new_task]
        saved = await board_store.async_save(next_board)

        resolved_names = [
            str(people_by_id[person_id].get("name") or person_id)
            for person_id in resolved_assignees
            if person_id in people_by_id
        ]
        return {
            "ok": True,
            "entry_id": entry_id,
            "task": new_task,
            "resolved_assignees": resolved_assignees,
            "resolved_assignee_names": resolved_names,
            "unknown_assignee_names": unknown_names,
            "board_updated_at": saved.get("updated_at", created_at),
        }

    if not hass.services.has_service(DOMAIN, SERVICE_SAVE_BOARD):
        hass.services.async_register(
            DOMAIN,
            SERVICE_SAVE_BOARD,
            _async_save_board,
            schema=_SAVE_SCHEMA,
        )
    if not hass.services.has_service(DOMAIN, SERVICE_GET_PERSON_TASKS):
        hass.services.async_register(
            DOMAIN,
            SERVICE_GET_PERSON_TASKS,
            _async_get_person_tasks,
            schema=_GET_PERSON_TASKS_SCHEMA,
            supports_response=SupportsResponse.ONLY,
        )
    if not hass.services.has_service(DOMAIN, SERVICE_GET_WEEK_SUMMARY):
        hass.services.async_register(
            DOMAIN,
            SERVICE_GET_WEEK_SUMMARY,
            _async_get_week_summary,
            schema=_GET_WEEK_SUMMARY_SCHEMA,
            supports_response=SupportsResponse.ONLY,
        )
    if not hass.services.has_service(DOMAIN, SERVICE_CREATE_TASK):
        hass.services.async_register(
            DOMAIN,
            SERVICE_CREATE_TASK,
            _async_create_task,
            schema=_CREATE_TASK_SCHEMA,
            supports_response=SupportsResponse.ONLY,
        )


def _parse_date(value: Any) -> date | None:
    """Parse date input into a local date."""
    if value is None:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    try:
        return date.fromisoformat(raw)
    except ValueError:
        return None


def _week_start_for_day(day_value: date) -> date:
    """Return Monday date for ISO week containing the given date."""
    return day_value - timedelta(days=day_value.weekday())
