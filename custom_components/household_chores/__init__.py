"""Household Chores integration."""

from __future__ import annotations

import logging
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_NAME
from homeassistant.core import HomeAssistant
from homeassistant.helpers.event import async_track_time_change

from .board import HouseholdBoardStore
from .const import (
    CONF_CHORES,
    CONF_MEMBERS,
    CONF_REFRESH_HOUR,
    CONF_REFRESH_MINUTE,
    CONF_REFRESH_WEEKDAY,
    DEFAULT_CHORES,
    DEFAULT_MEMBERS,
    DEFAULT_NAME,
    DEFAULT_REFRESH_HOUR,
    DEFAULT_REFRESH_MINUTE,
    DEFAULT_REFRESH_WEEKDAY,
    DOMAIN,
    PLATFORMS,
)
from .coordinator import HouseholdChoresCoordinator
from .frontend import async_register_card
from .services import async_register as async_register_services
from .websocket_api import async_register as async_register_ws

_LOGGER = logging.getLogger(__name__)


async def async_setup(hass: HomeAssistant, _config: dict[str, Any]) -> bool:
    """Set up Household Chores domain-level resources."""
    domain_data = hass.data.setdefault(DOMAIN, {})
    domain_data.setdefault("logger", _LOGGER)
    domain_data.setdefault("boards", {})
    domain_data.setdefault("entry_unsubs", {})
    if not domain_data.get("ws_registered"):
        async_register_ws(hass)
        domain_data["ws_registered"] = True
    if not domain_data.get("card_registered"):
        await async_register_card(hass)
        domain_data["card_registered"] = True
    if not domain_data.get("services_registered"):
        await async_register_services(hass)
        domain_data["services_registered"] = True
    return True


def _as_list(raw: Any, fallback: list[str]) -> list[str]:
    """Normalize raw config value to a list of non-empty strings."""
    if isinstance(raw, list):
        cleaned = [str(item).strip() for item in raw if str(item).strip()]
        return cleaned or fallback
    if isinstance(raw, str):
        cleaned = [part.strip() for part in raw.split(",") if part.strip()]
        return cleaned or fallback
    return fallback


def _as_int(raw: Any, fallback: int) -> int:
    """Normalize config value to int."""
    try:
        return int(raw)
    except (TypeError, ValueError):
        return fallback


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Household Chores from a config entry."""
    domain_data = hass.data.setdefault(DOMAIN, {})
    domain_data.setdefault("logger", _LOGGER)
    domain_data.setdefault("boards", {})
    domain_data.setdefault("entry_unsubs", {})
    if not domain_data.get("ws_registered"):
        async_register_ws(hass)
        domain_data["ws_registered"] = True
    if not domain_data.get("card_registered"):
        await async_register_card(hass)
        domain_data["card_registered"] = True
    if not domain_data.get("services_registered"):
        await async_register_services(hass)
        domain_data["services_registered"] = True

    name = entry.options.get(CONF_NAME, entry.data.get(CONF_NAME, DEFAULT_NAME))
    members = _as_list(entry.options.get(CONF_MEMBERS, entry.data.get(CONF_MEMBERS)), DEFAULT_MEMBERS)
    chores = _as_list(entry.options.get(CONF_CHORES, entry.data.get(CONF_CHORES)), DEFAULT_CHORES)
    refresh_weekday = _as_int(
        entry.options.get(CONF_REFRESH_WEEKDAY, entry.data.get(CONF_REFRESH_WEEKDAY, DEFAULT_REFRESH_WEEKDAY)),
        DEFAULT_REFRESH_WEEKDAY,
    )
    refresh_hour = _as_int(
        entry.options.get(CONF_REFRESH_HOUR, entry.data.get(CONF_REFRESH_HOUR, DEFAULT_REFRESH_HOUR)),
        DEFAULT_REFRESH_HOUR,
    )
    refresh_minute = _as_int(
        entry.options.get(CONF_REFRESH_MINUTE, entry.data.get(CONF_REFRESH_MINUTE, DEFAULT_REFRESH_MINUTE)),
        DEFAULT_REFRESH_MINUTE,
    )

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

    async def _async_cleanup_done_tasks(_now) -> None:
        removed = await board_store.async_remove_done_tasks()
        if removed:
            _LOGGER.info("Nightly cleanup removed %s done tasks for entry %s", removed, entry.entry_id)

    async def _async_weekly_refresh(now) -> None:
        if now.weekday() != refresh_weekday:
            return
        refreshed = await board_store.async_weekly_refresh()
        _LOGGER.info("Weekly refresh rebuilt %s tasks for entry %s", refreshed, entry.entry_id)

    cleanup_unsub = async_track_time_change(
        hass,
        _async_cleanup_done_tasks,
        hour=3,
        minute=0,
        second=0,
    )
    weekly_unsub = async_track_time_change(
        hass,
        _async_weekly_refresh,
        hour=refresh_hour,
        minute=refresh_minute,
        second=0,
    )
    domain_data["entry_unsubs"][entry.entry_id] = [cleanup_unsub, weekly_unsub]

    entry.async_on_unload(entry.add_update_listener(async_reload_entry))

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        for unsub in hass.data[DOMAIN].get("entry_unsubs", {}).pop(entry.entry_id, []):
            unsub()
        hass.data[DOMAIN]["boards"].pop(entry.entry_id, None)
        hass.data[DOMAIN].pop(entry.entry_id, None)
    return unload_ok


async def async_reload_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Handle options update by reloading the entry."""
    await hass.config_entries.async_reload(entry.entry_id)
