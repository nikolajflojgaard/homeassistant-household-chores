"""Sensor platform for Household Chores."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_NAME
from homeassistant.core import HomeAssistant
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity
from homeassistant.util import slugify

from .const import DEFAULT_NAME, DOMAIN, SIGNAL_BOARD_UPDATED
from .coordinator import HouseholdChoresCoordinator
from .stats import next_three_tasks_summary, person_week_stats


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
    ]

    board = await board_store.async_load()
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
                "updated_at": board.get("updated_at", ""),
            },
        }


class PersonWeekTasksSensor(SensorEntity):
    """Sensor exposing one person's selected-week task summary."""

    _attr_icon = "mdi:account-check"
    _attr_has_entity_name = False
    _attr_should_poll = True

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
        self.hass.async_create_task(self._async_refresh_and_write())

    async def _async_refresh_and_write(self) -> None:
        await self.async_update()
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
    _attr_should_poll = True

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
        self.hass.async_create_task(self._async_refresh_and_write())

    async def _async_refresh_and_write(self) -> None:
        await self.async_update()
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
    _attr_should_poll = True

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
        self.hass.async_create_task(self._async_refresh_and_write())

    async def _async_refresh_and_write(self) -> None:
        await self.async_update()
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
