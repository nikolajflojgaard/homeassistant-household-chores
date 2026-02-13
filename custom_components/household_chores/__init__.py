"""Household Chores integration."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_NAME, EVENT_STATE_CHANGED, SERVICE_RESTART, STATE_OFF, STATE_ON
from homeassistant.core import HomeAssistant, callback
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
    domain_data.setdefault("restart_watcher_unsub", None)
    domain_data.setdefault("restart_pending", False)
    if not domain_data.get("ws_registered"):
        _try_register_ws(hass, domain_data)
    if not domain_data.get("card_registered"):
        await async_register_card(hass)
        domain_data["card_registered"] = True
    if not domain_data.get("services_registered"):
        await async_register_services(hass)
        domain_data["services_registered"] = True
    _ensure_auto_restart_watcher(hass, domain_data)
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


def _try_register_ws(hass: HomeAssistant, domain_data: dict[str, Any]) -> None:
    """Try websocket registration but keep integration running on failure."""
    try:
        async_register_ws(hass)
        domain_data["ws_registered"] = True
    except Exception as err:  # noqa: BLE001
        _LOGGER.warning("Websocket registration failed, using fallback paths: %s", err)


def _is_household_update_entity(entity_id: str, state_obj: Any) -> bool:
    if not entity_id.startswith("update."):
        return False
    if "household_chores" in entity_id or "household-chores" in entity_id:
        return True
    attrs = getattr(state_obj, "attributes", {}) or {}
    title = str(attrs.get("title", "")).lower()
    friendly_name = str(attrs.get("friendly_name", "")).lower()
    return "household chores" in title or "household chores" in friendly_name


def _ensure_auto_restart_watcher(hass: HomeAssistant, domain_data: dict[str, Any]) -> None:
    if domain_data.get("restart_watcher_unsub"):
        return

    @callback
    def _handle_update_install(event) -> None:
        if domain_data.get("restart_pending"):
            return
        entity_id = str(event.data.get("entity_id", ""))
        old_state = event.data.get("old_state")
        new_state = event.data.get("new_state")
        if new_state is None:
            return
        if not _is_household_update_entity(entity_id, new_state):
            return
        old_value = old_state.state if old_state is not None else None
        new_value = new_state.state
        # React when update finishes installing and returns to OFF/Up-to-date.
        # This covers ON->OFF and unavailable->OFF style transitions.
        if new_value != STATE_OFF:
            return
        if old_value == STATE_OFF:
            return

        domain_data["restart_pending"] = True
        _LOGGER.info("Detected Household Chores update installation. Scheduling Home Assistant restart.")

        async def _restart_later() -> None:
            await asyncio.sleep(8)
            try:
                await hass.services.async_call(
                    "homeassistant",
                    SERVICE_RESTART,
                    {},
                    blocking=True,
                )
            except Exception as err:  # noqa: BLE001
                _LOGGER.warning("Automatic restart after update failed: %s", err)
            finally:
                domain_data["restart_pending"] = False

        hass.async_create_task(_restart_later())

    domain_data["restart_watcher_unsub"] = hass.bus.async_listen(EVENT_STATE_CHANGED, _handle_update_install)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Household Chores from a config entry."""
    domain_data = hass.data.setdefault(DOMAIN, {})
    domain_data.setdefault("logger", _LOGGER)
    domain_data.setdefault("boards", {})
    domain_data.setdefault("entry_unsubs", {})
    domain_data.setdefault("restart_watcher_unsub", None)
    domain_data.setdefault("restart_pending", False)
    if not domain_data.get("ws_registered"):
        _try_register_ws(hass, domain_data)
    if not domain_data.get("card_registered"):
        await async_register_card(hass)
        domain_data["card_registered"] = True
    if not domain_data.get("services_registered"):
        await async_register_services(hass)
        domain_data["services_registered"] = True
    _ensure_auto_restart_watcher(hass, domain_data)

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
        if not hass.data[DOMAIN].get("boards"):
            restart_unsub = hass.data[DOMAIN].pop("restart_watcher_unsub", None)
            if restart_unsub:
                restart_unsub()
            hass.data[DOMAIN]["restart_pending"] = False
    return unload_ok


async def async_reload_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Handle options update by reloading the entry."""
    await hass.config_entries.async_reload(entry.entry_id)
