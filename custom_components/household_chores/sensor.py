"""Sensor platform for Household Chores."""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_NAME
from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity
from homeassistant.util import slugify

from .const import DEFAULT_NAME, DOMAIN, SIGNAL_BOARD_UPDATED
from .coordinator import HouseholdChoresCoordinator
from .stats import next_three_tasks_summary, person_week_stats

_LOGGER = logging.getLogger(__name__)


def _ensure_unique_entity_id(registry: er.EntityRegistry, wanted: str, current: str) -> str:
    """Return a unique entity_id (sensor.<object_id>) in the registry."""
    if wanted == current:
        return current
    if registry.async_get(wanted) is None:
        return wanted
    base = wanted
    if "_" in base:
        base = base
    idx = 2
    while True:
        candidate = f"{base}_{idx}"
        if registry.async_get(candidate) is None:
            return candidate
        idx += 1


async def _async_migrate_entity_ids(hass: HomeAssistant, entry: ConfigEntry, board: dict[str, Any]) -> None:
    """Migrate legacy sensor entity_ids to the documented household_chores_* names.

    This runs best-effort and logs what it changes.
    """
    domain_data = hass.data.setdefault(DOMAIN, {})
    done: set[str] = domain_data.setdefault("entity_migrations_done", set())
    if entry.entry_id in done:
        return

    registry = er.async_get(hass)
    reg_entries = er.async_entries_for_config_entry(registry, entry.entry_id)
    if not reg_entries:
        done.add(entry.entry_id)
        return

    people = board.get("people", []) if isinstance(board, dict) else []
    name_by_id = {
        str(person.get("id", "")).strip(): str(person.get("name", "")).strip()
        for person in people
        if isinstance(person, dict) and str(person.get("id", "")).strip()
    }

    migrations: list[tuple[str, str]] = []
    stale_entity_ids: list[str] = []
    for reg_entry in reg_entries:
        if reg_entry.domain != "sensor":
            continue
        unique_id = str(reg_entry.unique_id or "")
        current_entity_id = reg_entry.entity_id

        wanted: str | None = None

        if unique_id == f"{entry.entry_id}_next_chore":
            wanted = "sensor.household_chores_next_chore"
        elif unique_id == f"{entry.entry_id}_board_state":
            wanted = "sensor.household_chores_board_state"
        elif unique_id == f"{entry.entry_id}_next_three_tasks":
            wanted = "sensor.household_chores_next_3_tasks"
        elif unique_id.startswith(f"{entry.entry_id}_person_week_"):
            person_id = unique_id.removeprefix(f"{entry.entry_id}_person_week_")
            person_name = name_by_id.get(person_id, "").strip()
            if person_name:
                wanted = f"sensor.household_chores_{slugify(person_name)}_tasks"
            else:
                stale_entity_ids.append(current_entity_id)
        elif unique_id.startswith(f"{entry.entry_id}_next_three_tasks_"):
            person_id = unique_id.removeprefix(f"{entry.entry_id}_next_three_tasks_")
            person_name = name_by_id.get(person_id, "").strip()
            if person_name:
                wanted = f"sensor.household_chores_{slugify(person_name)}_next_3_tasks"
            else:
                stale_entity_ids.append(current_entity_id)

        if not wanted:
            continue
        if current_entity_id == wanted:
            continue
        # Skip if current already has the desired prefix and looks fine.
        if current_entity_id.startswith("sensor.household_chores_") and wanted.startswith("sensor.household_chores_"):
            continue

        wanted_unique = _ensure_unique_entity_id(registry, wanted, current_entity_id)
        if wanted_unique != current_entity_id:
            try:
                registry.async_update_entity(current_entity_id, new_entity_id=wanted_unique)
                migrations.append((current_entity_id, wanted_unique))
            except Exception as err:  # noqa: BLE001
                _LOGGER.warning("Entity migration failed for %s -> %s: %s", current_entity_id, wanted_unique, err)

    for entity_id in stale_entity_ids:
        try:
            registry.async_remove(entity_id)
        except Exception as err:  # noqa: BLE001
            _LOGGER.warning("Stale entity cleanup failed for %s: %s", entity_id, err)

    if stale_entity_ids:
        for reg_entry in er.async_entries_for_config_entry(registry, entry.entry_id):
            if reg_entry.domain != "sensor":
                continue
            unique_id = str(reg_entry.unique_id or "")
            current_entity_id = reg_entry.entity_id
            wanted = None
            if unique_id.startswith(f"{entry.entry_id}_person_week_"):
                person_id = unique_id.removeprefix(f"{entry.entry_id}_person_week_")
                person_name = name_by_id.get(person_id, "").strip()
                if person_name:
                    wanted = f"sensor.household_chores_{slugify(person_name)}_tasks"
            elif unique_id.startswith(f"{entry.entry_id}_next_three_tasks_"):
                person_id = unique_id.removeprefix(f"{entry.entry_id}_next_three_tasks_")
                person_name = name_by_id.get(person_id, "").strip()
                if person_name:
                    wanted = f"sensor.household_chores_{slugify(person_name)}_next_3_tasks"
            if not wanted or current_entity_id == wanted or registry.async_get(wanted) is not None:
                continue
            try:
                registry.async_update_entity(current_entity_id, new_entity_id=wanted)
                migrations.append((current_entity_id, wanted))
            except Exception as err:  # noqa: BLE001
                _LOGGER.warning("Entity migration failed for %s -> %s: %s", current_entity_id, wanted, err)

    if migrations:
        _LOGGER.info("Household Chores migrated %d sensor entity_id(s): %s", len(migrations), migrations)
    if stale_entity_ids:
        _LOGGER.info("Household Chores removed %d stale sensor entity_id(s): %s", len(stale_entity_ids), stale_entity_ids)

    done.add(entry.entry_id)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up Household Chores sensors from a config entry."""
    coordinator: HouseholdChoresCoordinator = hass.data[DOMAIN][entry.entry_id]
    board_store = hass.data[DOMAIN]["boards"][entry.entry_id]
    entities: list[SensorEntity] = [
        NextChoreSensor(entry, coordinator),
        BoardStateSensor(entry, board_store),
        NextThreeTasksSensor(entry, board_store),
        TodayTasksSensor(entry, board_store),
    ]

    board = await board_store.async_load()
    await _async_migrate_entity_ids(hass, entry, board)
    for person in board.get("people", []):
        person_id = str(person.get("id") or "").strip()
        if not person_id:
            continue
        entities.append(PersonWeekTasksSensor(entry, board_store, person_id))
        entities.append(NextThreeTasksPersonSensor(entry, board_store, person_id))

    async_add_entities(entities)

    known_ids: set[str] = {
        entity.person_id
        for entity in entities
        if isinstance(entity, PersonWeekTasksSensor)
    }

    def _handle_board_changed() -> None:
        current_board = getattr(board_store, "_data", None) or {}
        people = current_board.get("people", []) if isinstance(current_board, dict) else []
        missing_ids: list[str] = []
        for person in people:
            person_id = str(person.get("id") or "").strip()
            if not person_id or person_id in known_ids:
                continue
            known_ids.add(person_id)
            missing_ids.append(person_id)
        if missing_ids:
            async_add_entities(
                [
                    *[PersonWeekTasksSensor(entry, board_store, person_id) for person_id in missing_ids],
                    *[NextThreeTasksPersonSensor(entry, board_store, person_id) for person_id in missing_ids],
                ]
            )

    entry.async_on_unload(
        async_dispatcher_connect(
            hass,
            f"{SIGNAL_BOARD_UPDATED}_{entry.entry_id}",
            _handle_board_changed,
        )
    )


class NextChoreSensor(CoordinatorEntity[HouseholdChoresCoordinator], SensorEntity):
    """Sensor showing the next scheduled chore assignment."""

    _attr_has_entity_name = True
    _attr_name = "Next chore"
    _attr_icon = "mdi:broom"
    _attr_translation_key = "next_chore"

    def __init__(self, entry: ConfigEntry, coordinator: HouseholdChoresCoordinator) -> None:
        super().__init__(coordinator)
        configured_name = entry.options.get(CONF_NAME, entry.data.get(CONF_NAME, DEFAULT_NAME))
        self._attr_unique_id = f"{entry.entry_id}_next_chore"
        self._attr_extra_state_attributes = {"household": configured_name}

    @property
    def suggested_object_id(self) -> str | None:
        return "household_chores_next_chore"

    @property
    def native_value(self) -> str | None:
        """Return summary for the next upcoming chore."""
        now = datetime.now().astimezone()
        for event in self.coordinator.data:
            if event.end >= now:
                return event.summary
        return None

    @property
    def extra_state_attributes(self) -> dict[str, str] | None:
        """Return details for the next upcoming chore."""
        now = datetime.now().astimezone()
        for event in self.coordinator.data:
            if event.end >= now:
                return {
                    "chore": event.chore,
                    "member": event.member,
                    "start": event.start.isoformat(),
                    "end": event.end.isoformat(),
                }
        return None


class BoardStateSensor(SensorEntity):
    """Sensor exposing board data for fallback UI loading."""

    _attr_has_entity_name = True
    _attr_name = "Board state"
    _attr_icon = "mdi:view-kanban"

    def __init__(self, entry: ConfigEntry, board_store: Any) -> None:
        self._entry = entry
        self._board_store = board_store
        self._attr_unique_id = f"{entry.entry_id}_board_state"
        self._unsub_dispatcher = None

    @property
    def suggested_object_id(self) -> str | None:
        return "household_chores_board_state"

    async def async_added_to_hass(self) -> None:
        """Subscribe to board update events."""
        self._unsub_dispatcher = async_dispatcher_connect(
            self.hass,
            f"{SIGNAL_BOARD_UPDATED}_{self._entry.entry_id}",
            self._handle_board_updated,
        )

    async def async_will_remove_from_hass(self) -> None:
        """Unsubscribe from events."""
        if self._unsub_dispatcher:
            self._unsub_dispatcher()
            self._unsub_dispatcher = None

    def _handle_board_updated(self) -> None:
        """Handle board updates from store."""
        self.async_write_ha_state()

    @property
    def native_value(self) -> str | None:
        """Return last update timestamp."""
        board = getattr(self._board_store, "_data", None)
        if isinstance(board, dict):
            return str(board.get("updated_at") or "")
        return None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Return complete board payload attributes."""
        board = getattr(self._board_store, "_data", None) or {}
        return {
            "entry_id": self._entry.entry_id,
            "board": {
                "people": board.get("people", []),
                "tasks": board.get("tasks", []),
                "templates": board.get("templates", []),
                "history": board.get("history", []),
                "settings": board.get("settings", {}),
                "updated_at": board.get("updated_at", ""),
            },
        }


class PersonWeekTasksSensor(SensorEntity):
    """Sensor exposing one person's selected-week task summary."""

    _attr_icon = "mdi:account-check"
    _attr_has_entity_name = False
    _attr_should_poll = False

    def __init__(self, entry: ConfigEntry, board_store: Any, person_id: str) -> None:
        self._entry = entry
        self._board_store = board_store
        self.person_id = str(person_id)
        self._unsub_dispatcher = None
        self._stats: dict[str, Any] = {}
        self._person_name = self.person_id
        self._person_color = ""
        self._person_role = "adult"
        self._refresh_from_board()
        self._attr_unique_id = f"{entry.entry_id}_person_week_{self.person_id}"

    async def async_added_to_hass(self) -> None:
        """Subscribe to board update events."""
        self._unsub_dispatcher = async_dispatcher_connect(
            self.hass,
            f"{SIGNAL_BOARD_UPDATED}_{self._entry.entry_id}",
            self._handle_board_updated,
        )
        await self.async_update()

    async def async_will_remove_from_hass(self) -> None:
        """Unsubscribe from events."""
        if self._unsub_dispatcher:
            self._unsub_dispatcher()
            self._unsub_dispatcher = None

    @property
    def name(self) -> str:
        """Return full entity name."""
        return f"Household Chores {self._person_name} tasks"

    @property
    def suggested_object_id(self) -> str | None:
        # Gives stable, predictable entity_id on first creation.
        return f"household_chores_{slugify(self._person_name)}_tasks"

    @property
    def available(self) -> bool:
        """Only available while person exists on board."""
        board = getattr(self._board_store, "_data", None) or {}
        people = board.get("people", []) if isinstance(board, dict) else []
        return any(str(person.get("id", "")) == self.person_id for person in people)

    @property
    def native_value(self) -> int:
        """State is the number of remaining tasks this week."""
        return int(self._stats.get("remaining") or 0)

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Expose detailed summary and task payload."""
        attrs = dict(self._stats)
        attrs["entry_id"] = self._entry.entry_id
        attrs["person_id"] = self.person_id
        attrs["person_name"] = self._person_name
        attrs["person_color"] = self._person_color
        attrs["person_role"] = self._person_role
        return attrs

    def _handle_board_updated(self) -> None:
        """Handle board updates from store."""
        self._refresh_from_board()
        self.async_write_ha_state()

    async def async_update(self) -> None:
        """Refresh from the latest persisted board."""
        try:
            board = await self._board_store.async_load()
        except Exception:  # noqa: BLE001
            board = getattr(self._board_store, "_data", None) or {}
        self._refresh_from_board(board)

    def _refresh_from_board(self, board: dict[str, Any] | None = None) -> None:
        board = board or getattr(self._board_store, "_data", None) or {}
        stats = person_week_stats(board, self.person_id, week_offset=0)
        self._stats = stats
        people = board.get("people", []) if isinstance(board, dict) else []
        person = next((item for item in people if str(item.get("id", "")) == self.person_id), None)
        if isinstance(person, dict):
            name = str(person.get("name") or "").strip()
            self._person_name = name or self.person_id
            self._person_color = str(person.get("color") or "")
            role_raw = str(person.get("role") or "adult").lower()
            self._person_role = role_raw if role_raw in {"adult", "child"} else "adult"


class NextThreeTasksSensor(SensorEntity):
    """Sensor exposing the next three upcoming open tasks."""

    _attr_has_entity_name = True
    _attr_name = "Next 3 tasks"
    _attr_icon = "mdi:format-list-checks"
    _attr_should_poll = False

    def __init__(self, entry: ConfigEntry, board_store: Any) -> None:
        self._entry = entry
        self._board_store = board_store
        self._unsub_dispatcher = None
        self._summary: dict[str, Any] = {"count": 0, "tasks": [], "titles": []}
        self._attr_unique_id = f"{entry.entry_id}_next_three_tasks"

    @property
    def suggested_object_id(self) -> str | None:
        return "household_chores_next_3_tasks"

    async def async_added_to_hass(self) -> None:
        """Subscribe to board update events."""
        self._unsub_dispatcher = async_dispatcher_connect(
            self.hass,
            f"{SIGNAL_BOARD_UPDATED}_{self._entry.entry_id}",
            self._handle_board_updated,
        )
        await self.async_update()

    async def async_will_remove_from_hass(self) -> None:
        """Unsubscribe from events."""
        if self._unsub_dispatcher:
            self._unsub_dispatcher()
            self._unsub_dispatcher = None

    @property
    def native_value(self) -> int:
        """Return number of available upcoming tasks (0..3)."""
        return int(self._summary.get("count") or 0)

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Return upcoming task payload."""
        return {
            "entry_id": self._entry.entry_id,
            "titles": list(self._summary.get("titles") or []),
            "tasks": list(self._summary.get("tasks") or []),
        }

    def _handle_board_updated(self) -> None:
        """Handle board updates from store."""
        board = getattr(self._board_store, "_data", None) or {}
        self._summary = next_three_tasks_summary(board, limit=3)
        self.async_write_ha_state()

    async def async_update(self) -> None:
        """Refresh from latest persisted board."""
        try:
            board = await self._board_store.async_load()
        except Exception:  # noqa: BLE001
            board = getattr(self._board_store, "_data", None) or {}
        self._summary = next_three_tasks_summary(board, limit=3)


class NextThreeTasksPersonSensor(SensorEntity):
    """Sensor exposing the next three upcoming open tasks for a single person."""

    _attr_has_entity_name = False
    _attr_icon = "mdi:format-list-checks"
    _attr_should_poll = False

    def __init__(self, entry: ConfigEntry, board_store: Any, person_id: str) -> None:
        self._entry = entry
        self._board_store = board_store
        self.person_id = str(person_id)
        self._unsub_dispatcher = None
        self._summary: dict[str, Any] = {"count": 0, "tasks": [], "titles": []}
        self._person_name = self.person_id
        self._attr_unique_id = f"{entry.entry_id}_next_three_tasks_{self.person_id}"
        self._refresh_person_fields(getattr(self._board_store, "_data", None) or {})

    async def async_added_to_hass(self) -> None:
        """Subscribe to board update events."""
        self._unsub_dispatcher = async_dispatcher_connect(
            self.hass,
            f"{SIGNAL_BOARD_UPDATED}_{self._entry.entry_id}",
            self._handle_board_updated,
        )
        await self.async_update()

    async def async_will_remove_from_hass(self) -> None:
        """Unsubscribe from events."""
        if self._unsub_dispatcher:
            self._unsub_dispatcher()
            self._unsub_dispatcher = None

    @property
    def name(self) -> str:
        return f"Household Chores {self._person_name} next 3 tasks"

    @property
    def suggested_object_id(self) -> str | None:
        return f"household_chores_{slugify(self._person_name)}_next_3_tasks"

    @property
    def available(self) -> bool:
        board = getattr(self._board_store, "_data", None) or {}
        people = board.get("people", []) if isinstance(board, dict) else []
        return any(str(person.get("id", "")) == self.person_id for person in people)

    @property
    def native_value(self) -> int:
        return int(self._summary.get("count") or 0)

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return {
            "entry_id": self._entry.entry_id,
            "person_id": self.person_id,
            "person_name": self._person_name,
            "titles": list(self._summary.get("titles") or []),
            "tasks": list(self._summary.get("tasks") or []),
        }

    def _handle_board_updated(self) -> None:
        board = getattr(self._board_store, "_data", None) or {}
        self._refresh_person_fields(board)
        self._summary = next_three_tasks_summary(board, limit=3, person_id=self.person_id)
        self.async_write_ha_state()

    async def async_update(self) -> None:
        try:
            board = await self._board_store.async_load()
        except Exception:  # noqa: BLE001
            board = getattr(self._board_store, "_data", None) or {}
        self._refresh_person_fields(board)
        self._summary = next_three_tasks_summary(board, limit=3, person_id=self.person_id)

    def _refresh_person_fields(self, board: dict[str, Any]) -> None:
        people = board.get("people", []) if isinstance(board, dict) else []
        person = next((item for item in people if str(item.get("id", "")) == self.person_id), None)
        if isinstance(person, dict):
            name = str(person.get("name") or "").strip()
            self._person_name = name or self.person_id


class TodayTasksSensor(SensorEntity):
    """Sensor exposing today's tasks for all people."""

    _attr_has_entity_name = True
    _attr_name = "Today's tasks"
    _attr_icon = "mdi:calendar-today"
    _attr_should_poll = False

    def __init__(self, entry: ConfigEntry, board_store: Any) -> None:
        self._entry = entry
        self._board_store = board_store
        self._unsub_dispatcher = None
        self._today_stats: dict[str, Any] = {"count": 0, "tasks": []}
        self._attr_unique_id = f"{entry.entry_id}_today_tasks"

    @property
    def suggested_object_id(self) -> str | None:
        return "household_chores_today_tasks"

    async def async_added_to_hass(self) -> None:
        """Subscribe to board update events."""
        self._unsub_dispatcher = async_dispatcher_connect(
            self.hass,
            f"{SIGNAL_BOARD_UPDATED}_{self._entry.entry_id}",
            self._handle_board_updated,
        )
        await self.async_update()

    async def async_will_remove_from_hass(self) -> None:
        """Unsubscribe from events."""
        if self._unsub_dispatcher:
            self._unsub_dispatcher()
            self._unsub_dispatcher = None

    @property
    def native_value(self) -> int:
        """Return number of today's tasks."""
        return int(self._today_stats.get("count") or 0)

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Return today's task payload."""
        return {
            "entry_id": self._entry.entry_id,
            "tasks": list(self._today_stats.get("tasks", [])),
        }

    def _handle_board_updated(self) -> None:
        """Handle board updates from store."""
        board = getattr(self._board_store, "_data", None) or {}
        self._today_stats = self._compute_today_tasks(board)
        self.async_write_ha_state()

    async def async_update(self) -> None:
        """Refresh from latest persisted board."""
        try:
            board = await self._board_store.async_load()
        except Exception:  # noqa: BLE001
            board = getattr(self._board_store, "_data", None) or {}
        self._today_stats = self._compute_today_tasks(board)

    def _compute_today_tasks(self, board: dict[str, Any]) -> dict[str, Any]:
        """Compute today's tasks from board."""
        from homeassistant.util import dt as dt_util
        from .stats import WEEKDAY_COLUMNS, WEEKDAY_INDEX, _start_of_week, _parse_iso_day

        today = dt_util.as_local(dt_util.utcnow()).date()
        today_key = WEEKDAY_COLUMNS[today.weekday()]
        current_week_start = _start_of_week(today)
        
        people = board.get("people", []) if isinstance(board, dict) else []
        tasks = board.get("tasks", []) if isinstance(board, dict) else []
        
        people_by_id = {
            str(person.get("id", "")).strip(): str(person.get("name", "")).strip()
            for person in people
            if isinstance(person, dict) and str(person.get("id", "")).strip()
        }

        today_tasks = []
        for raw in tasks:
            if not isinstance(raw, dict):
                continue
            if str(raw.get("column") or "").lower() == "done":
                continue
                
            column = str(raw.get("column") or "").lower()
            if column != today_key:
                continue
                
            raw_week_start = str(raw.get("week_start") or current_week_start.isoformat())
            week_start_day = _parse_iso_day(raw_week_start)
            normalized_start = _start_of_week(week_start_day if week_start_day is not None else current_week_start)
            
            if normalized_start != current_week_start:
                continue
            
            assignees = raw.get("assignees", [])
            assignee_names = [people_by_id.get(str(a), str(a)) for a in assignees]
            
            today_tasks.append({
                "id": str(raw.get("id") or ""),
                "title": str(raw.get("title") or "Untitled task"),
                "assignees": assignee_names,
                "column": column,
            })

        return {
            "count": len(today_tasks),
            "tasks": today_tasks,
            "day": today_key,
            "date": today.isoformat(),
        }
