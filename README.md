# homeassistant-household-chores

Household Chores is a HACS-installable custom integration for a weekly household task planner in Home Assistant.

## What you get

- Main week row: Monday to Sunday
- Weekday columns are compressed to fit screen width (no horizontal week scroll)
- Secondary row: Backlog + Done in a 2-column grid below the week
- On compact/mobile screens, Backlog/Done tasks switch to a responsive card grid (no forced overflow cards)
- People with unique colored circular badges and first-letter initials
- Compact mobile-first actions: `People` and `Add task` buttons open modal forms
- Click any task to edit title/assignees/day/end date in modal
- Delete task directly from the edit modal
- Drag people badges directly onto tasks to assign quickly
- Optional fixed recurring tasks with:
  - end date
  - weekday selection (`M T W T F S S`)
- Weekday selection is always available in task modal; selecting weekdays hides single-column (`Backlog/day`) selector
- Drag-and-drop tasks between backlog, weekdays, and done
- Persistent board data stored in Home Assistant (`.storage`)

## Install (HACS)

1. In Home Assistant, open HACS -> Integrations -> three dots -> Custom repositories.
2. Add this repository URL and select category `Integration`.
3. Install `Household Chores`.
4. Restart Home Assistant.
5. Go to Settings -> Devices & Services -> Add Integration -> `Household Chores`.

## Add the card

1. Open your dashboard and edit it.
2. Add a Manual card.
3. Use this config:

```yaml
type: custom:household-chores-card
title: Household Chores
```

If you have multiple `Household Chores` config entries, include `entry_id`:

```yaml
type: custom:household-chores-card
title: Family Week
entry_id: 0123456789abcdef0123456789abcdef
```

## Configure Weekly Refresh

In Home Assistant:

1. `Settings -> Devices & Services`
2. Open `Household Chores`
3. `Configure`
4. Set:
   - `Weekly refresh day`
   - `Weekly refresh hour`
   - `Weekly refresh minute`

## Screenshots

The screenshots below are updated with each UI/layout release.

### Tablet overview
![Tablet weekly board](docs/screenshots/weekly-board-tablet.png)

### Drag and drop between days
![Drag and drop state](docs/screenshots/weekly-board-drag-drop.png)

## Notes

- The custom card JavaScript is auto-registered by the integration at startup.
- JS resource is auto versioned (`?v=<manifest version>`) to reduce browser cache issues after updates.
- If you update from older versions, restart Home Assistant to reload websocket commands/resources.
- Save operations now include a fallback service (`household_chores.save_board`) if websocket save command is unavailable in runtime.
- Load operations include a fallback via `sensor.*_board_state` attributes if websocket load command is unavailable.
- If `entry_id` is missing/invalid and exactly one board-state sensor exists, the card auto-resolves to that entry.
- `People` and board data are persisted in Home Assistant storage and shared across clients/devices.
- Default chores/members entered during integration setup are used as starter board data.
- The card layout is optimized for tablet-sized dashboards (including iPad-width screens).
- Tasks moved to `Done` are automatically deleted nightly at `03:00` (Home Assistant local time).
- Weekly board refresh time is configurable in integration options (`day`, `hour`, `minute`).
- On weekly refresh:
  - tasks without an `end date` are removed
  - expired tasks are removed
  - fixed recurring tasks are rebuilt for the upcoming Monday-Sunday week (until their end date)
