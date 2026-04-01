"""Service registration for Household Chores."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from typing import Any
from uuid import uuid4

import voluptuous as vol

from homeassistant.core import HomeAssistant, ServiceCall, ServiceResponse, SupportsResponse
from .board import BoardConflictError
from homeassistant.util import dt as dt_util

from .const import DOMAIN
from .stats import WEEKDAY_COLUMNS, person_week_stats

SERVICE_SAVE_BOARD = "save_board"
SERVICE_GET_PERSON_TASKS = "get_person_tasks"
SERVICE_GET_WEEK_SUMMARY = "get_week_summary"
SERVICE_CREATE_TASK = "create_task"
SERVICE_UPDATE_TASK = "update_task"
SERVICE_DELETE_TASK = "delete_task"
SERVICE_LIST_TASKS = "list_tasks"

_SAVE_SCHEMA = vol.Schema(
    {
        vol.Required("entry_id"): str,
        vol.Required("board"): dict,
        vol.Optional("expected_updated_at"): str,
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
        vol.Optional("entry_id"): str,
        vol.Required("title"): vol.All(str, vol.Length(min=1)),
        vol.Optional("date"): str,
        vol.Optional("slot"): vol.In(["am", "pm"]),
        vol.Optional("assignees"): [str],
        vol.Optional("assignee_names"): [str],
    }
)
_UPDATE_TASK_SCHEMA = vol.Schema(
    {
        vol.Optional("entry_id"): str,
        vol.Optional("task_id"): str,
        vol.Optional("title"): str,
        vol.Optional("date"): str,
        vol.Optional("assignees"): [str],
        vol.Optional("assignee_names"): [str],
        vol.Optional("new_title"): str,
        vol.Optional("new_date"): str,
        vol.Optional("new_slot"): vol.In(["am", "pm"]),
        vol.Optional("new_assignees"): [str],
        vol.Optional("new_assignee_names"): [str],
    }
)
_DELETE_TASK_SCHEMA = vol.Schema(
    {
        vol.Optional("entry_id"): str,
        vol.Optional("task_id"): str,
        vol.Optional("title"): str,
        vol.Optional("date"): str,
        vol.Optional("assignees"): [str],
        vol.Optional("assignee_names"): [str],
    }
)
_LIST_TASKS_SCHEMA = vol.Schema(
    {
        vol.Optional("entry_id"): str,
        vol.Optional("title"): str,
        vol.Optional("date"): str,
        vol.Optional("assignees"): [str],
        vol.Optional("assignee_names"): [str],
        vol.Optional("include_done", default=False): bool,
        vol.Optional("limit", default=50): vol.Coerce(int),
    }
)


async def async_register(hass: HomeAssistant) -> None:
    """Register integration services."""

    async def _async_save_board(call: ServiceCall) -> ServiceResponse:
        entry_id = call.data["entry_id"]
        board = call.data["board"]
        board_store = hass.data.get(DOMAIN, {}).get("boards", {}).get(entry_id)
        if board_store is None:
            return {"ok": False, "error": f"entry_not_found: {entry_id}"}
        try:
            saved = await board_store.async_save(
                board,
                expected_updated_at=call.data.get("expected_updated_at"),
            )
        except BoardConflictError as err:
            return {"ok": False, "error": f"conflict: {err}"}
        return {"ok": True, "entry_id": entry_id, "board": saved}

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
        entry_id = _resolve_entry_id(hass, call.data.get("entry_id"))
        if entry_id is None:
            return {"ok": False, "error": "entry_id_required_or_ambiguous"}
        board_store = hass.data.get(DOMAIN, {}).get("boards", {}).get(entry_id)
        if board_store is None:
            return {"ok": False, "error": f"entry_not_found: {entry_id}"}

        board = await board_store.async_load()
        people_by_id, people_name_map = _people_maps(board)

        title = str(call.data["title"]).strip()
        task_date = _parse_date(call.data.get("date")) or dt_util.as_local(dt_util.utcnow()).date()
        resolved_assignees, unknown_names = _resolve_assignees(
            people_by_id,
            people_name_map,
            call.data.get("assignees", []),
            call.data.get("assignee_names", []),
        )

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
            "slot": call.data.get("slot"),
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

        return {
            "ok": True,
            "entry_id": entry_id,
            "task": new_task,
            "resolved_assignees": resolved_assignees,
            "resolved_assignee_names": _assignee_names_from_ids(people_by_id, resolved_assignees),
            "unknown_assignee_names": unknown_names,
            "board_updated_at": saved.get("updated_at", created_at),
        }

    async def _async_update_task(call: ServiceCall) -> ServiceResponse:
        entry_id = _resolve_entry_id(hass, call.data.get("entry_id"))
        if entry_id is None:
            return {"ok": False, "error": "entry_id_required_or_ambiguous"}
        board_store = hass.data.get(DOMAIN, {}).get("boards", {}).get(entry_id)
        if board_store is None:
            return {"ok": False, "error": f"entry_not_found: {entry_id}"}

        board = await board_store.async_load()
        people_by_id, people_name_map = _people_maps(board)
        tasks = list(board.get("tasks", [])) if isinstance(board.get("tasks"), list) else []

        matched = _find_matching_tasks(
            tasks,
            people_by_id,
            people_name_map,
            task_id=call.data.get("task_id"),
            title=call.data.get("title"),
            task_date=call.data.get("date"),
            assignees=call.data.get("assignees", []),
            assignee_names=call.data.get("assignee_names", []),
        )
        if not matched:
            return {"ok": False, "error": "task_not_found"}
        if len(matched) > 1:
            return {"ok": False, "error": "task_ambiguous", "matches": matched}

        target = matched[0]
        task_index = next((idx for idx, task in enumerate(tasks) if str(task.get("id")) == str(target.get("id"))), None)
        if task_index is None:
            return {"ok": False, "error": "task_not_found"}

        new_title = str(call.data.get("new_title") or target.get("title") or "").strip() or str(target.get("title") or "")
        new_date = _parse_date(call.data.get("new_date")) or _parse_date(target.get("end_date")) or dt_util.as_local(dt_util.utcnow()).date()
        if "new_assignees" in call.data or "new_assignee_names" in call.data:
            resolved_assignees, unknown_names = _resolve_assignees(
                people_by_id,
                people_name_map,
                call.data.get("new_assignees", []),
                call.data.get("new_assignee_names", []),
            )
        else:
            resolved_assignees = [str(item) for item in target.get("assignees", [])]
            unknown_names = []

        column = WEEKDAY_COLUMNS[new_date.weekday()]
        week_start = _week_start_for_day(new_date)
        week_number = week_start.isocalendar().week

        updated_task = dict(target)
        updated_task.update(
            {
                "title": new_title,
                "assignees": resolved_assignees,
                "column": column,
                "slot": call.data.get("new_slot", target.get("slot")),
                "end_date": new_date.isoformat(),
                "week_start": week_start.isoformat(),
                "week_number": week_number,
            }
        )
        tasks[task_index] = updated_task
        _reindex_tasks(tasks)

        next_board = dict(board)
        next_board["tasks"] = tasks
        saved = await board_store.async_save(next_board)
        return {
            "ok": True,
            "entry_id": entry_id,
            "task": updated_task,
            "resolved_assignees": resolved_assignees,
            "resolved_assignee_names": _assignee_names_from_ids(people_by_id, resolved_assignees),
            "unknown_assignee_names": unknown_names,
            "board_updated_at": saved.get("updated_at", datetime.now(UTC).isoformat()),
        }

    async def _async_delete_task(call: ServiceCall) -> ServiceResponse:
        entry_id = _resolve_entry_id(hass, call.data.get("entry_id"))
        if entry_id is None:
            return {"ok": False, "error": "entry_id_required_or_ambiguous"}
        board_store = hass.data.get(DOMAIN, {}).get("boards", {}).get(entry_id)
        if board_store is None:
            return {"ok": False, "error": f"entry_not_found: {entry_id}"}

        board = await board_store.async_load()
        people_by_id, people_name_map = _people_maps(board)
        tasks = list(board.get("tasks", [])) if isinstance(board.get("tasks"), list) else []

        matched = _find_matching_tasks(
            tasks,
            people_by_id,
            people_name_map,
            task_id=call.data.get("task_id"),
            title=call.data.get("title"),
            task_date=call.data.get("date"),
            assignees=call.data.get("assignees", []),
            assignee_names=call.data.get("assignee_names", []),
        )
        if not matched:
            return {"ok": False, "error": "task_not_found"}
        if len(matched) > 1:
            return {"ok": False, "error": "task_ambiguous", "matches": matched}

        target = matched[0]
        next_tasks = [task for task in tasks if str(task.get("id")) != str(target.get("id"))]
        _reindex_tasks(next_tasks)

        next_board = dict(board)
        next_board["tasks"] = next_tasks
        saved = await board_store.async_save(next_board)
        return {
            "ok": True,
            "entry_id": entry_id,
            "deleted_task": target,
            "board_updated_at": saved.get("updated_at", datetime.now(UTC).isoformat()),
        }

    async def _async_list_tasks(call: ServiceCall) -> ServiceResponse:
        entry_id = _resolve_entry_id(hass, call.data.get("entry_id"))
        if entry_id is None:
            return {"ok": False, "error": "entry_id_required_or_ambiguous"}
        board_store = hass.data.get(DOMAIN, {}).get("boards", {}).get(entry_id)
        if board_store is None:
            return {"ok": False, "error": f"entry_not_found: {entry_id}"}

        board = await board_store.async_load()
        people_by_id, people_name_map = _people_maps(board)
        tasks = list(board.get("tasks", [])) if isinstance(board.get("tasks"), list) else []
        include_done = bool(call.data.get("include_done", False))
        limit = max(1, min(500, int(call.data.get("limit", 50))))

        matched = _find_matching_tasks(
            tasks,
            people_by_id,
            people_name_map,
            task_id=None,
            title=call.data.get("title"),
            task_date=call.data.get("date"),
            assignees=call.data.get("assignees", []),
            assignee_names=call.data.get("assignee_names", []),
        )
        if call.data.get("title") or call.data.get("date") or call.data.get("assignees") or call.data.get("assignee_names"):
            filtered = matched
        else:
            filtered = tasks

        if not include_done:
            filtered = [task for task in filtered if str(task.get("column") or "").lower() != "done"]

        filtered = filtered[:limit]
        payload = [_task_to_response(task, people_by_id) for task in filtered]
        return {
            "ok": True,
            "entry_id": entry_id,
            "count": len(payload),
            "tasks": payload,
        }

    if not hass.services.has_service(DOMAIN, SERVICE_SAVE_BOARD):
        hass.services.async_register(
            DOMAIN,
            SERVICE_SAVE_BOARD,
            _async_save_board,
            schema=_SAVE_SCHEMA,
            supports_response=SupportsResponse.ONLY,
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
    if not hass.services.has_service(DOMAIN, SERVICE_UPDATE_TASK):
        hass.services.async_register(
            DOMAIN,
            SERVICE_UPDATE_TASK,
            _async_update_task,
            schema=_UPDATE_TASK_SCHEMA,
            supports_response=SupportsResponse.ONLY,
        )
    if not hass.services.has_service(DOMAIN, SERVICE_DELETE_TASK):
        hass.services.async_register(
            DOMAIN,
            SERVICE_DELETE_TASK,
            _async_delete_task,
            schema=_DELETE_TASK_SCHEMA,
            supports_response=SupportsResponse.ONLY,
        )
    if not hass.services.has_service(DOMAIN, SERVICE_LIST_TASKS):
        hass.services.async_register(
            DOMAIN,
            SERVICE_LIST_TASKS,
            _async_list_tasks,
            schema=_LIST_TASKS_SCHEMA,
            supports_response=SupportsResponse.ONLY,
        )


def _people_maps(board: dict[str, Any]) -> tuple[dict[str, dict[str, Any]], dict[str, str]]:
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
    return people_by_id, people_name_map


def _resolve_assignees(
    people_by_id: dict[str, dict[str, Any]],
    people_name_map: dict[str, str],
    assignees: list[str] | None,
    assignee_names: list[str] | None,
) -> tuple[list[str], list[str]]:
    explicit_ids = [str(item).strip() for item in (assignees or []) if str(item).strip()]
    explicit_names = [str(item).strip() for item in (assignee_names or []) if str(item).strip()]

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
    return resolved_assignees, unknown_names


def _assignee_names_from_ids(people_by_id: dict[str, dict[str, Any]], assignee_ids: list[str]) -> list[str]:
    return [
        str(people_by_id[person_id].get("name") or person_id)
        for person_id in assignee_ids
        if person_id in people_by_id
    ]


def _find_matching_tasks(
    tasks: list[dict[str, Any]],
    people_by_id: dict[str, dict[str, Any]],
    people_name_map: dict[str, str],
    *,
    task_id: Any = None,
    title: Any = None,
    task_date: Any = None,
    assignees: list[str] | None = None,
    assignee_names: list[str] | None = None,
) -> list[dict[str, Any]]:
    if task_id is not None and str(task_id).strip():
        wanted_id = str(task_id).strip()
        return [task for task in tasks if str(task.get("id") or "") == wanted_id]

    wanted_title = str(title or "").strip().lower()
    wanted_date = _parse_date(task_date)
    resolved_assignees, _ = _resolve_assignees(people_by_id, people_name_map, assignees, assignee_names)
    wanted_assignees = set(resolved_assignees)

    matches: list[dict[str, Any]] = []
    for task in tasks:
        if wanted_title and str(task.get("title") or "").strip().lower() != wanted_title:
            continue
        if wanted_date is not None and _parse_date(task.get("end_date")) != wanted_date:
            continue
        if wanted_assignees and set(str(item) for item in task.get("assignees", [])) != wanted_assignees:
            continue
        if not wanted_title and wanted_date is None and not wanted_assignees:
            continue
        matches.append(task)
    return matches


def _task_to_response(task: dict[str, Any], people_by_id: dict[str, dict[str, Any]]) -> dict[str, Any]:
    assignee_ids = [str(item) for item in task.get("assignees", [])]
    return {
        "id": str(task.get("id") or ""),
        "title": str(task.get("title") or ""),
        "date": str(task.get("end_date") or ""),
        "column": str(task.get("column") or ""),
        "slot": task.get("slot"),
        "assignees": assignee_ids,
        "assignee_names": _assignee_names_from_ids(people_by_id, assignee_ids),
        "week_start": str(task.get("week_start") or ""),
        "week_number": task.get("week_number"),
        "fixed": bool(task.get("fixed", False)),
        "template_id": task.get("template_id"),
    }


def _reindex_tasks(tasks: list[dict[str, Any]]) -> None:
    columns = [*WEEKDAY_COLUMNS, "done"]
    for column in columns:
        column_items = [task for task in tasks if str(task.get("column") or "").lower() == column]
        column_items.sort(key=lambda item: int(item.get("order", 0)))
        for idx, task in enumerate(column_items):
            task["order"] = idx


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


def _resolve_entry_id(hass: HomeAssistant, entry_id: Any) -> str | None:
    """Resolve explicit entry_id or auto-select the only board entry."""
    if entry_id is not None:
        raw = str(entry_id).strip()
        if raw:
            return raw
    boards = hass.data.get(DOMAIN, {}).get("boards", {})
    if isinstance(boards, dict) and len(boards) == 1:
        return next(iter(boards))
    return None
