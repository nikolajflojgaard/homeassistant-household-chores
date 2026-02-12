"""Board models and storage for Household Chores."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from homeassistant.helpers.storage import Store

from .const import DOMAIN

WEEKDAY_COLUMNS = [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
]

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


class HouseholdBoardStore:
    """Persistent board state for one config entry."""

    def __init__(self, hass, entry_id: str, members: list[str], chores: list[str]) -> None:
        self._hass = hass
        self._entry_id = entry_id
        self._members = members
        self._chores = chores
        self._store: Store[dict[str, Any]] = Store(hass, 1, f"{DOMAIN}_board_{entry_id}")
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
        return self._data

    def _default_board(self) -> dict[str, Any]:
        people = [
            Person(id=f"person_{index}", name=name, color=DEFAULT_COLORS[index % len(DEFAULT_COLORS)])
            for index, name in enumerate(self._members)
        ]

        created = datetime.now(UTC).isoformat()
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
                )
            )

        return {
            "people": [asdict(person) for person in people],
            "tasks": [asdict(task) for task in tasks],
            "updated_at": created,
        }

    def _normalize_board(self, board: dict[str, Any]) -> dict[str, Any]:
        people = board.get("people", []) if isinstance(board, dict) else []
        tasks = board.get("tasks", []) if isinstance(board, dict) else []

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

            normalized_tasks.append(
                {
                    "id": task_id,
                    "title": title,
                    "assignees": assignees,
                    "column": column,
                    "order": order,
                    "created_at": created_at,
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
            "updated_at": datetime.now(UTC).isoformat(),
        }
