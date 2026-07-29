"""Calendar platform for Household Chores."""

from __future__ import annotations

from datetime import datetime

from homeassistant.components.calendar import CalendarEntity, CalendarEvent
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_NAME
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DEFAULT_NAME, DOMAIN
from .coordinator import ChoreEvent, HouseholdChoresCoordinator


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up Household Chores calendar from a config entry."""
    coordinator: HouseholdChoresCoordinator = hass.data[DOMAIN][entry.entry_id]
    registry = er.async_get(hass)
    current = registry.async_get_entity_id("calendar", DOMAIN, f"{entry.entry_id}_calendar")
    if current and current != "calendar.household_chores_schedule" and registry.async_get("calendar.household_chores_schedule") is None:
        registry.async_update_entity(current, new_entity_id="calendar.household_chores_schedule")
    async_add_entities([HouseholdChoresCalendar(entry, coordinator)])


class HouseholdChoresCalendar(CoordinatorEntity[HouseholdChoresCoordinator], CalendarEntity):
    """Calendar entity for weekly household chores."""

    _attr_has_entity_name = True

    def __init__(self, entry: ConfigEntry, coordinator: HouseholdChoresCoordinator) -> None:
        super().__init__(coordinator)
        configured_name = entry.options.get(CONF_NAME, entry.data.get(CONF_NAME, DEFAULT_NAME))
        self._attr_name = "Schedule"
        self._attr_unique_id = f"{entry.entry_id}_calendar"
        self._attr_translation_key = "schedule"
        self._attr_extra_state_attributes = {
            "household": configured_name,
            "members": coordinator.members,
            "chores": coordinator.chores,
        }

    @property
    def suggested_object_id(self) -> str | None:
        return "household_chores_schedule"

    @property
    def event(self) -> CalendarEvent | None:
        """Return the next upcoming chore event."""
        now = datetime.now().astimezone()
        for event in self.coordinator.data:
            if event.end >= now:
                return self._to_calendar_event(event)
        return None

    async def async_get_events(
        self,
        hass: HomeAssistant,
        start_date: datetime,
        end_date: datetime,
    ) -> list[CalendarEvent]:
        """Return chore events within a datetime range."""
        events: list[CalendarEvent] = []
        for event in self.coordinator.data:
            if event.start <= end_date and event.end >= start_date:
                events.append(self._to_calendar_event(event))
        return events

    @staticmethod
    def _to_calendar_event(event: ChoreEvent) -> CalendarEvent:
        return CalendarEvent(
            summary=event.summary,
            start=event.start,
            end=event.end,
            description=f"Chore: {event.chore}\\nAssigned to: {event.member}",
            location="Home",
        )
