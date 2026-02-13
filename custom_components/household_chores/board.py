"""Board models and storage for Household Chores."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Any
from uuid import uuid4

from homeassistant.helpers.storage import Store
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.util import dt as dt_util

from .const import DOMAIN, SIGNAL_BOARD_UPDATED

WEEKDAY_COLUMNS = [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
]
WEEKDAY_INDEX = {column: index for index, column in enumerate(WEEKDAY_COLUMNS)}

ALL_COLUMNS = ["backlog", *WEEKDAY_COLUMNS, "done"]
DEFAULT_COLORS = [
    "#E11D48",
    "#2563EB",
    "#059669",
    "#D97706",
    "#7C3AED",
    "#0E7490",
    "#BE123C",
    "#4F46E5",
    "#15803D",
]


@dataclass(slots=True)
class Person:
    """One household person shown in task chips."""

    id: str
    name: str
    color: str


@dataclass(slots=True)
class Task:
    """One task on the weekly board."""

    id: str
    title: str
    assignees: list[str]
    column: str
    order: int
    created_at: str
    end_date: str | None = None
    template_id: str | None = None
    fixed: bool = False
    week_start: str | None = None


class HouseholdBoardStore:
    """Persistent board state for one config entry."""

    def __init__(self, hass, entry_id: str, members: list[str], chores: list[str]) -> None:
        self._hass = hass
        self._entry_id = entry_id
        self._members = members
        self._chores = chores
        self._store: Store[dict[str, Any]] = Store(hass, 2, f"{DOMAIN}_board_{entry_id}")
        self._data: dict[str, Any] | None = None

    async def async_load(self) -> dict[str, Any]:
        """Load board state from storage, creating defaults when empty."""
        if self._data is not None:
            return self._data

        loaded = await self._store.async_load()
        if loaded:
            self._data = self._normalize_board(loaded)
            return self._data

        self._data = self._default_board()
        await self._store.async_save(self._data)
        return self._data

    async def async_save(self, board: dict[str, Any]) -> dict[str, Any]:
        """Persist normalized board state."""
        self._data = self._normalize_board(board)
        await self._store.async_save(self._data)
        async_dispatcher_send(self._hass, f"{SIGNAL_BOARD_UPDATED}_{self._entry_id}")
        return self._data

    async def async_remove_done_tasks(self) -> int:
        """Remove all tasks in the done column and persist if changed."""
        board = await self.async_load()
        tasks = board.get("tasks", [])
        remaining_tasks = [task for task in tasks if task.get("column") != "done"]
        removed_count = len(tasks) - len(remaining_tasks)
        if removed_count == 0:
            return 0

        board["tasks"] = remaining_tasks
        await self.async_save(board)
        return removed_count

    async def async_weekly_refresh(self) -> int:
        """Sunday 00:30 refresh.

        Keeps only tasks with an end date, drops done/expired items,
        and rebuilds fixed weekly tasks from templates for the new week.
        """
        board = await self.async_load()
        today = dt_util.as_local(dt_util.utcnow()).date()
        current_monday = _week_start_for_day(today)

        templates = board.get("templates", [])
        active_templates: list[dict[str, Any]] = []
        for template in templates:
            end_date = _parse_date(template.get("end_date"))
            if end_date is None or end_date < today:
                continue
            weekdays = [day for day in template.get("weekdays", []) if day in WEEKDAY_INDEX]
            if not weekdays:
                continue
            active_templates.append(
                {
                    "id": str(template.get("id") or f"tpl_{uuid4().hex[:10]}"),
                    "title": str(template.get("title") or "Untitled task"),
                    "assignees": [str(item) for item in template.get("assignees", [])],
                    "end_date": end_date.isoformat(),
                    "weekdays": weekdays,
                    "created_at": str(template.get("created_at") or datetime.now(UTC).isoformat()),
                }
            )

        kept_tasks: list[dict[str, Any]] = []
        for task in board.get("tasks", []):
            column = str(task.get("column") or "backlog")
            if column == "done":
                continue

            end_date = _parse_date(task.get("end_date"))
            if end_date is not None and end_date < today:
                continue

            week_start = _parse_date(task.get("week_start"))
            if column in WEEKDAY_INDEX:
                if week_start is None:
                    week_start = current_monday
                # Weekly reset clears only the weeks behind us.
                if week_start < current_monday:
                    continue

            # Fixed tasks are regenerated from template on refresh.
            if task.get("template_id"):
                continue

            normalized_task = dict(task)
            normalized_task["week_start"] = week_start.isoformat() if week_start else None
            kept_tasks.append(normalized_task)

        refreshed_tasks = kept_tasks + self._build_week_tasks_from_templates(active_templates, current_monday)
        board["templates"] = active_templates
        board["tasks"] = refreshed_tasks
        await self.async_save(board)
        return len(refreshed_tasks)

    def _build_week_tasks_from_templates(
        self,
        templates: list[dict[str, Any]],
        start_monday: date,
    ) -> list[dict[str, Any]]:
        generated: list[dict[str, Any]] = []
        # Keep current week plus 3 weeks ahead pre-generated.
        week_starts = [start_monday + timedelta(days=offset * 7) for offset in range(0, 4)]
        for template in templates:
            end_date = _parse_date(template["end_date"])
            if end_date is None:
                continue

            for week_start in week_starts:
                for weekday in template["weekdays"]:
                    day_date = week_start + timedelta(days=WEEKDAY_INDEX[weekday])
                    if day_date > end_date:
                        continue

                    generated.append(
                        asdict(
                            Task(
                                id=f"task_{uuid4().hex[:12]}",
                                title=template["title"],
                                assignees=template["assignees"],
                                column=weekday,
                                order=0,
                                created_at=datetime.now(UTC).isoformat(),
                                end_date=end_date.isoformat(),
                                template_id=template["id"],
                                fixed=True,
                                week_start=week_start.isoformat(),
                            )
                        )
                    )

        return generated

    def _default_board(self) -> dict[str, Any]:
        people = [
            Person(id=f"person_{index}", name=name, color=DEFAULT_COLORS[index % len(DEFAULT_COLORS)])
            for index, name in enumerate(self._members)
        ]

        created = datetime.now(UTC).isoformat()
        current_monday = _week_start_for_day(dt_util.as_local(dt_util.utcnow()).date()).isoformat()
        tasks: list[Task] = []
        for index, title in enumerate(self._chores):
            assignees = [people[index % len(people)].id] if people else []
            tasks.append(
                Task(
                    id=f"task_{uuid4().hex[:12]}",
                    title=title,
                    assignees=assignees,
                    column=WEEKDAY_COLUMNS[index % len(WEEKDAY_COLUMNS)],
                    order=index,
                    created_at=created,
                    week_start=current_monday,
                )
            )

        return {
            "people": [asdict(person) for person in people],
            "tasks": [asdict(task) for task in tasks],
            "templates": [],
            "updated_at": created,
        }

    def _normalize_board(self, board: dict[str, Any]) -> dict[str, Any]:
        people = board.get("people", []) if isinstance(board, dict) else []
        tasks = board.get("tasks", []) if isinstance(board, dict) else []
        templates = board.get("templates", []) if isinstance(board, dict) else []

        normalized_people: list[dict[str, Any]] = []
        known_person_ids: set[str] = set()

        for person in people:
            if not isinstance(person, dict):
                continue
            person_id = str(person.get("id") or f"person_{uuid4().hex[:10]}")
            if person_id in known_person_ids:
                continue
            known_person_ids.add(person_id)
            name = str(person.get("name") or "Person").strip() or "Person"
            color = str(person.get("color") or DEFAULT_COLORS[len(normalized_people) % len(DEFAULT_COLORS)])
            normalized_people.append({"id": person_id, "name": name, "color": color})

        normalized_templates: list[dict[str, Any]] = []
        for template in templates:
            if not isinstance(template, dict):
                continue
            title = str(template.get("title") or "Untitled task").strip()
            if not title:
                continue

            template_id = str(template.get("id") or f"tpl_{uuid4().hex[:10]}")
            assignees = [str(item) for item in template.get("assignees", []) if str(item) in known_person_ids]
            end_date = _parse_date(template.get("end_date"))
            weekdays = [day for day in template.get("weekdays", []) if day in WEEKDAY_INDEX]
            if end_date is None or not weekdays:
                continue

            normalized_templates.append(
                {
                    "id": template_id,
                    "title": title,
                    "assignees": assignees,
                    "end_date": end_date.isoformat(),
                    "weekdays": weekdays,
                    "created_at": str(template.get("created_at") or datetime.now(UTC).isoformat()),
                }
            )

        normalized_tasks: list[dict[str, Any]] = []
        for index, task in enumerate(tasks):
            if not isinstance(task, dict):
                continue
            title = str(task.get("title") or "Untitled task").strip()
            if not title:
                continue

            column = str(task.get("column") or "backlog").lower()
            if column not in ALL_COLUMNS:
                column = "backlog"

            task_id = str(task.get("id") or f"task_{uuid4().hex[:12]}")
            assignees_raw = task.get("assignees", [])
            if isinstance(assignees_raw, list):
                assignees = [str(item) for item in assignees_raw if str(item) in known_person_ids]
            else:
                assignees = []

            order = int(task.get("order", index))
            created_at = str(task.get("created_at") or datetime.now(UTC).isoformat())
            end_date = _parse_date(task.get("end_date"))
            template_id = str(task.get("template_id")) if task.get("template_id") else None
            fixed = bool(task.get("fixed", False))
            week_start = _parse_date(task.get("week_start"))
            if column in WEEKDAY_INDEX and week_start is None:
                week_start = _week_start_for_day(dt_util.as_local(dt_util.utcnow()).date())

            normalized_tasks.append(
                {
                    "id": task_id,
                    "title": title,
                    "assignees": assignees,
                    "column": column,
                    "order": order,
                    "created_at": created_at,
                    "end_date": end_date.isoformat() if end_date else None,
                    "template_id": template_id,
                    "fixed": fixed,
                    "week_start": week_start.isoformat() if week_start else None,
                }
            )

        normalized_tasks.sort(key=lambda item: (ALL_COLUMNS.index(item["column"]), item["order"]))

        # Reassign stable order values by column after drag-and-drop writes.
        for column in ALL_COLUMNS:
            column_items = [item for item in normalized_tasks if item["column"] == column]
            for order, item in enumerate(column_items):
                item["order"] = order

        return {
            "people": normalized_people,
            "tasks": normalized_tasks,
            "templates": normalized_templates,
            "updated_at": datetime.now(UTC).isoformat(),
        }


def _parse_date(value: Any) -> date | None:
    """Parse date input from UI/state into a date."""
    if value is None:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    try:
        return date.fromisoformat(raw)
    except ValueError:
        return None


def _week_start_for_day(day_value: date) -> date:
    """Return Monday date for ISO week containing the given date."""
    return day_value - timedelta(days=day_value.weekday())
