"""Constants for Household Chores."""

from datetime import time

from homeassistant.const import Platform

DOMAIN = "household_chores"
PLATFORMS: list[Platform] = [Platform.CALENDAR, Platform.SENSOR]

CONF_MEMBERS = "members"
CONF_CHORES = "chores"
CONF_REFRESH_WEEKDAY = "refresh_weekday"
CONF_REFRESH_HOUR = "refresh_hour"
CONF_REFRESH_MINUTE = "refresh_minute"

DEFAULT_NAME = "Household Chores"
DEFAULT_MEMBERS = ["Alex", "Sam"]
DEFAULT_CHORES = [
    "Take out trash",
    "Vacuum living room",
    "Clean kitchen",
    "Laundry",
]

DEFAULT_CHORE_TIME = time(hour=18, minute=0)
DEFAULT_REFRESH_WEEKDAY = 6
DEFAULT_REFRESH_HOUR = 0
DEFAULT_REFRESH_MINUTE = 30
