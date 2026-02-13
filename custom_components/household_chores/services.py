"""Service registration for Household Chores."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.core import HomeAssistant, ServiceCall, ServiceResponse, SupportsResponse

from .const import DOMAIN
from .stats import person_week_stats

SERVICE_SAVE_BOARD = "save_board"
SERVICE_GET_PERSON_TASKS = "get_person_tasks"
SERVICE_GET_WEEK_SUMMARY = "get_week_summary"

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
