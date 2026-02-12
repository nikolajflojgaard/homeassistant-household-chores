"""Household Chores integration."""

from __future__ import annotations

import logging
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_NAME
from homeassistant.core import HomeAssistant

from .board import HouseholdBoardStore
from .const import CONF_CHORES, CONF_MEMBERS, DEFAULT_CHORES, DEFAULT_MEMBERS, DEFAULT_NAME, DOMAIN, PLATFORMS
from .coordinator import HouseholdChoresCoordinator
from .frontend import async_register_card
from .websocket_api import async_register as async_register_ws

_LOGGER = logging.getLogger(__name__)


def _as_list(raw: Any, fallback: list[str]) -> list[str]:
    """Normalize raw config value to a list of non-empty strings."""
    if isinstance(raw, list):
        cleaned = [str(item).strip() for item in raw if str(item).strip()]
        return cleaned or fallback
    if isinstance(raw, str):
        cleaned = [part.strip() for part in raw.split(",") if part.strip()]
        return cleaned or fallback
    return fallback


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Household Chores from a config entry."""
    domain_data = hass.data.setdefault(DOMAIN, {})
    domain_data.setdefault("logger", _LOGGER)
    domain_data.setdefault("boards", {})
    if not domain_data.get("ws_registered"):
        async_register_ws(hass)
        domain_data["ws_registered"] = True
    if not domain_data.get("card_registered"):
        await async_register_card(hass)
        domain_data["card_registered"] = True

    name = entry.options.get(CONF_NAME, entry.data.get(CONF_NAME, DEFAULT_NAME))
    members = _as_list(entry.options.get(CONF_MEMBERS, entry.data.get(CONF_MEMBERS)), DEFAULT_MEMBERS)
    chores = _as_list(entry.options.get(CONF_CHORES, entry.data.get(CONF_CHORES)), DEFAULT_CHORES)

    board_store = HouseholdBoardStore(hass, entry.entry_id, members, chores)
    await board_store.async_load()
    domain_data["boards"][entry.entry_id] = board_store

    coordinator = HouseholdChoresCoordinator(
        hass,
        entry_id=entry.entry_id,
        name=name,
        members=members,
        chores=chores,
    )
    await coordinator.async_config_entry_first_refresh()

    domain_data[entry.entry_id] = coordinator

    entry.async_on_unload(entry.add_update_listener(async_reload_entry))

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        hass.data[DOMAIN]["boards"].pop(entry.entry_id, None)
        hass.data[DOMAIN].pop(entry.entry_id, None)
    return unload_ok


async def async_reload_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Handle options update by reloading the entry."""
    await hass.config_entries.async_reload(entry.entry_id)
