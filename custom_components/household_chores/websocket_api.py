"""Websocket commands for Household Chores board."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant

from .const import DOMAIN


@websocket_api.websocket_command(
    {
        vol.Required("type"): "household_chores/get_board",
        vol.Required("entry_id"): str,
    }
)
@websocket_api.async_response
async def ws_get_board(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Return full board payload for an entry."""
    entry_id = msg["entry_id"]
    board_store = hass.data.get(DOMAIN, {}).get("boards", {}).get(entry_id)
    if board_store is None:
        connection.send_error(msg["id"], "entry_not_found", f"No board found for entry_id={entry_id}")
        return

    board = await board_store.async_load()
    connection.send_result(msg["id"], {"entry_id": entry_id, "board": board})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "household_chores/save_board",
        vol.Required("entry_id"): str,
        vol.Required("board"): dict,
    }
)
@websocket_api.async_response
async def ws_save_board(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Save board payload for an entry."""
    entry_id = msg["entry_id"]
    board_store = hass.data.get(DOMAIN, {}).get("boards", {}).get(entry_id)
    if board_store is None:
        connection.send_error(msg["id"], "entry_not_found", f"No board found for entry_id={entry_id}")
        return

    board = await board_store.async_save(msg["board"])
    connection.send_result(msg["id"], {"entry_id": entry_id, "board": board})


def async_register(hass: HomeAssistant) -> None:
    """Register websocket API commands."""
    websocket_api.async_register_command(hass, ws_get_board)
    websocket_api.async_register_command(hass, ws_save_board)
    websocket_api.async_register_command(hass, ws_list_entries)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "household_chores/list_entries",
    }
)
@websocket_api.async_response
async def ws_list_entries(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Return all Household Chores config entries."""
    entries = hass.config_entries.async_entries(DOMAIN)
    payload = [
        {
            "entry_id": entry.entry_id,
            "title": entry.title,
        }
        for entry in entries
    ]
    connection.send_result(msg["id"], {"entries": payload})
