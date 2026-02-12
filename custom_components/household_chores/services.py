"""Service registration for Household Chores."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.core import HomeAssistant, ServiceCall

from .const import DOMAIN

SERVICE_SAVE_BOARD = "save_board"

_SAVE_SCHEMA = vol.Schema(
    {
        vol.Required("entry_id"): str,
        vol.Required("board"): dict,
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

    if not hass.services.has_service(DOMAIN, SERVICE_SAVE_BOARD):
        hass.services.async_register(
            DOMAIN,
            SERVICE_SAVE_BOARD,
            _async_save_board,
            schema=_SAVE_SCHEMA,
        )
