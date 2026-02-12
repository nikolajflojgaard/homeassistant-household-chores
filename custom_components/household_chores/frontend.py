"""Frontend asset registration for Household Chores card."""

from __future__ import annotations

from pathlib import Path

from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant

CARD_URL = "/household_chores_files/household-chores-card.js"


async def async_register_card(hass: HomeAssistant) -> None:
    """Register the custom card static path and JS resource."""
    card_path = Path(__file__).parent / "frontend" / "household-chores-card.js"
    await hass.http.async_register_static_paths(
        [
            StaticPathConfig(
                CARD_URL,
                str(card_path),
                cache_headers=False,
            )
        ]
    )
    add_extra_js_url(hass, CARD_URL)
