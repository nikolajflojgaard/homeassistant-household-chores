"""Config flow for Household Chores."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.const import CONF_NAME
from homeassistant.core import callback

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
)

WEEKDAY_CHOICES = {
    "0": "Monday",
    "1": "Tuesday",
    "2": "Wednesday",
    "3": "Thursday",
    "4": "Friday",
    "5": "Saturday",
    "6": "Sunday",
}


def _csv_default(values: list[str]) -> str:
    return ", ".join(values)


def _parse_csv(raw: str) -> list[str]:
    return [item.strip() for item in raw.split(",") if item.strip()]


class HouseholdChoresConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for Household Chores."""

    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None):
        errors: dict[str, str] = {}

        if user_input is not None:
            members = _parse_csv(user_input[CONF_MEMBERS])
            chores = _parse_csv(user_input[CONF_CHORES])

            if not members:
                errors[CONF_MEMBERS] = "members_required"
            if not chores:
                errors[CONF_CHORES] = "chores_required"

            if not errors:
                await self.async_set_unique_id(user_input[CONF_NAME].strip().lower())
                self._abort_if_unique_id_configured()
                return self.async_create_entry(
                    title=user_input[CONF_NAME].strip(),
                    data={
                        CONF_NAME: user_input[CONF_NAME].strip(),
                        CONF_MEMBERS: members,
                        CONF_CHORES: chores,
                        CONF_REFRESH_WEEKDAY: int(user_input[CONF_REFRESH_WEEKDAY]),
                        CONF_REFRESH_HOUR: int(user_input[CONF_REFRESH_HOUR]),
                        CONF_REFRESH_MINUTE: int(user_input[CONF_REFRESH_MINUTE]),
                    },
                )

        schema = vol.Schema(
            {
                vol.Required(CONF_NAME, default=DEFAULT_NAME): str,
                vol.Required(CONF_MEMBERS, default=_csv_default(DEFAULT_MEMBERS)): str,
                vol.Required(CONF_CHORES, default=_csv_default(DEFAULT_CHORES)): str,
                vol.Required(CONF_REFRESH_WEEKDAY, default=str(DEFAULT_REFRESH_WEEKDAY)): vol.In(WEEKDAY_CHOICES),
                vol.Required(CONF_REFRESH_HOUR, default=DEFAULT_REFRESH_HOUR): vol.All(
                    vol.Coerce(int),
                    vol.Range(min=0, max=23),
                ),
                vol.Required(CONF_REFRESH_MINUTE, default=DEFAULT_REFRESH_MINUTE): vol.All(
                    vol.Coerce(int),
                    vol.Range(min=0, max=59),
                ),
            }
        )

        return self.async_show_form(step_id="user", data_schema=schema, errors=errors)

    @staticmethod
    @callback
    def async_get_options_flow(config_entry):
        """Return the options flow handler."""
        return HouseholdChoresOptionsFlow(config_entry)


class HouseholdChoresOptionsFlow(config_entries.OptionsFlow):
    """Handle options for Household Chores."""

    def __init__(self, config_entry) -> None:
        self.config_entry = config_entry

    async def async_step_init(self, user_input: dict[str, Any] | None = None):
        errors: dict[str, str] = {}

        if user_input is not None:
            members = _parse_csv(user_input[CONF_MEMBERS])
            chores = _parse_csv(user_input[CONF_CHORES])

            if not members:
                errors[CONF_MEMBERS] = "members_required"
            if not chores:
                errors[CONF_CHORES] = "chores_required"

            if not errors:
                return self.async_create_entry(
                    title="",
                    data={
                        CONF_NAME: user_input[CONF_NAME].strip(),
                        CONF_MEMBERS: members,
                        CONF_CHORES: chores,
                        CONF_REFRESH_WEEKDAY: int(user_input[CONF_REFRESH_WEEKDAY]),
                        CONF_REFRESH_HOUR: int(user_input[CONF_REFRESH_HOUR]),
                        CONF_REFRESH_MINUTE: int(user_input[CONF_REFRESH_MINUTE]),
                    },
                )

        current_name = self.config_entry.options.get(
            CONF_NAME,
            self.config_entry.data.get(CONF_NAME, DEFAULT_NAME),
        )
        current_members = self.config_entry.options.get(
            CONF_MEMBERS,
            self.config_entry.data.get(CONF_MEMBERS, DEFAULT_MEMBERS),
        )
        current_chores = self.config_entry.options.get(
            CONF_CHORES,
            self.config_entry.data.get(CONF_CHORES, DEFAULT_CHORES),
        )
        current_refresh_weekday = int(
            self.config_entry.options.get(
                CONF_REFRESH_WEEKDAY,
                self.config_entry.data.get(CONF_REFRESH_WEEKDAY, DEFAULT_REFRESH_WEEKDAY),
            )
        )
        current_refresh_hour = int(
            self.config_entry.options.get(
                CONF_REFRESH_HOUR,
                self.config_entry.data.get(CONF_REFRESH_HOUR, DEFAULT_REFRESH_HOUR),
            )
        )
        current_refresh_minute = int(
            self.config_entry.options.get(
                CONF_REFRESH_MINUTE,
                self.config_entry.data.get(CONF_REFRESH_MINUTE, DEFAULT_REFRESH_MINUTE),
            )
        )

        schema = vol.Schema(
            {
                vol.Required(CONF_NAME, default=current_name): str,
                vol.Required(CONF_MEMBERS, default=_csv_default(current_members)): str,
                vol.Required(CONF_CHORES, default=_csv_default(current_chores)): str,
                vol.Required(CONF_REFRESH_WEEKDAY, default=str(current_refresh_weekday)): vol.In(WEEKDAY_CHOICES),
                vol.Required(CONF_REFRESH_HOUR, default=current_refresh_hour): vol.All(
                    vol.Coerce(int),
                    vol.Range(min=0, max=23),
                ),
                vol.Required(CONF_REFRESH_MINUTE, default=current_refresh_minute): vol.All(
                    vol.Coerce(int),
                    vol.Range(min=0, max=59),
                ),
            }
        )

        return self.async_show_form(step_id="init", data_schema=schema, errors=errors)
