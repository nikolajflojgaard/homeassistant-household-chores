class HouseholdChoresCard extends HTMLElement {
  static getConfigElement() {
    // Keep HA card editor happy and avoid configuration errors in some builds.
    return document.createElement("ha-form");
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._config = null;
    this._loadedOnce = false;

    this._board = { people: [], tasks: [], templates: [], settings: this._defaultSettings() };
    this._loading = true;
    this._saving = false;
    this._error = "";

    this._newPersonName = "";
    this._newPersonRole = "adult";
    this._newPersonColor = "#2563eb";
    this._showPeopleModal = false;
    this._showTaskModal = false;
    this._showSettingsModal = false;
    this._draggingTask = false;
    this._weekOffset = 0;
    this._maxWeekOffset = 3;
    this._swipeStartX = null;
    this._taskSwipe = null;
    this._blockWeekSwipeUntil = 0;
    this._suppressTaskClickUntil = 0;
    this._taskFormOriginal = null;
    this._taskFormDirty = false;
    this._personFilter = "all";
    this._personFilterSelection = "";
    this._undoState = null;
    this._undoTimer = null;
    this._dataExportText = "";
    this._dataImportText = "";
    this._dataImportError = "";
    this._lastSyncedBoard = null;
    this._newQuickTemplateName = "";
    this._personColorSaveTimer = null;

    this._taskForm = this._emptyTaskForm("add");
    this._settingsForm = this._emptySettingsForm();
  }

  static getStubConfig() {
    return { type: "custom:household-chores-card", title: "Household Chores" };
  }

  setConfig(config) {
    if (!config || typeof config !== "object") {
      throw new Error("Invalid card configuration");
    }
    this._config = {
      title: config.title || "Household Chores",
      entry_id: config.entry_id || "",
      view: config.view || "board", // "board" | "next_up"
    };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._loadedOnce && this._config) {
      this._loadedOnce = true;
      this._loadBoard();
    }
    this._render();
  }

  getCardSize() {
    return 8;
  }

  _nextUpItems(limit = 3) {
    const todayIso = this._todayIsoDate();
    const tasks = this._tasksVisibleByFilter(this._board.tasks || [])
      .filter((task) => String(task.column || "").toLowerCase() !== "done")
      .filter((task) => !task.span_id || Number(task.span_index || 0) === 0);

    const byKey = new Map();
    for (const task of tasks) {
      const occurrence = this._taskOccurrenceDate(task);
      if (!occurrence) continue;
      if (occurrence < todayIso) continue;
      const key = task.span_id ? `span:${task.span_id}:${task.week_start || ""}` : `task:${task.id}`;
      if (!byKey.has(key)) {
        byKey.set(key, { task, occurrence, order: Number(task.order || 0) });
      }
    }

    return [...byKey.values()]
      .sort((a, b) => {
        if (a.occurrence !== b.occurrence) return a.occurrence < b.occurrence ? -1 : 1;
        if (a.order !== b.order) return a.order - b.order;
        return String(a.task.title || "").localeCompare(String(b.task.title || ""));
      })
      .slice(0, Math.max(0, Number(limit) || 0));
  }

  _renderNextUpStrip() {
    const items = this._nextUpItems(3);
    if (!items.length) return "";
    return `
      <div class="nextup-strip" role="note" aria-label="Next up tasks">
        <span class="nextup-label">Next up</span>
        ${items
          .map(({ task, occurrence }) => {
            const people = (task.assignees || [])
              .map((personId) => this._board.people.find((person) => person.id === personId))
              .filter(Boolean);
            const maxDots = 4;
            const dots = people
              .slice(0, maxDots)
              .map((person) => `<span class="nextup-dot" style="background:${person.color}" title="${this._escape(person.name)}"></span>`)
              .join("");
            const remaining = Math.max(0, people.length - maxDots);
            const dateLabel = occurrence ? `<span class="nextup-date">${this._escape(occurrence.slice(5).replace("-", "."))}</span>` : "";
            return `
              <button type="button" class="nextup-pill" data-nextup-task-id="${this._escape(task.id)}" title="${this._escape(task.title)}">
                ${dateLabel}
                <span class="nextup-title">${this._escape(task.title)}</span>
                ${dots ? `<span class="nextup-dots">${dots}${remaining ? `<span class="nextup-more">+${remaining}</span>` : ""}</span>` : ""}
              </button>
            `;
          })
          .join("")}
      </div>
    `;
  }

  _columns() {
    return [
      { key: "monday", label: "Mon" },
      { key: "tuesday", label: "Tue" },
      { key: "wednesday", label: "Wed" },
      { key: "thursday", label: "Thu" },
      { key: "friday", label: "Fri" },
      { key: "saturday", label: "Sat" },
      { key: "sunday", label: "Sun" },
      { key: "done", label: "Completed" },
    ];
  }

  _weekColumns() {
    return this._columns().filter((col) => col.key !== "done");
  }

  _weekdayKeys() {
    return [
      { key: "monday", short: "M" },
      { key: "tuesday", short: "T" },
      { key: "wednesday", short: "W" },
      { key: "thursday", short: "T" },
      { key: "friday", short: "F" },
      { key: "saturday", short: "S" },
      { key: "sunday", short: "S" },
    ];
  }

  _emptyTaskForm(mode = "add") {
    return {
      mode,
      taskId: "",
      templateId: "",
      spanId: "",
      title: "",
      fixed: false,
      allDaySpan: false,
      endDate: "",
      column: "monday",
      weekdays: [],
      assignees: [],
      occurrenceDate: "",
      deleteSeries: false,
    };
  }

  _defaultSettings() {
    return {
      title: this._config?.title || "Household Chores",
      theme: "light",
      compact_mode: false,
      show_next_up: false,
      labels: {
        done: "Completed",
        monday: "Mon",
        tuesday: "Tue",
        wednesday: "Wed",
        thursday: "Thu",
        friday: "Fri",
        saturday: "Sat",
        sunday: "Sun",
      },
      weekly_refresh: { weekday: 6, hour: 0, minute: 30 },
      quick_templates: [],
      gestures: { swipe_complete: true, swipe_delete: false },
      onboarding_dismissed: false,
    };
  }

  _emptySettingsForm() {
    const settings = this._board?.settings || this._defaultSettings();
    return JSON.parse(JSON.stringify(settings));
  }

  _labelForColumn(columnKey) {
    return this._board?.settings?.labels?.[columnKey] || this._columns().find((c) => c.key === columnKey)?.label || columnKey;
  }

  _boardTitle() {
    return this._board?.settings?.title || this._config?.title || "Household Chores";
  }

  _themeVars() {
    const theme = this._board?.settings?.theme || "light";
    if (theme === "dark") {
      return {
        bg: "linear-gradient(145deg,#0f172a 0%,#1e293b 100%)",
        text: "#e2e8f0",
        muted: "#94a3b8",
        border: "#334155",
        card: "#111827",
        accent: "#2563eb",
      };
    }
    if (theme === "colorful") {
      return {
        bg: "linear-gradient(135deg,#ecfeff 0%,#eef2ff 45%,#fff7ed 100%)",
        text: "#0f172a",
        muted: "#64748b",
        border: "#cbd5e1",
        card: "#ffffff",
        accent: "#0ea5e9",
      };
    }
    return {
      bg: "linear-gradient(145deg,#f8fafc 0%,#eef2ff 100%)",
      text: "#0f172a",
      muted: "#64748b",
      border: "#dbe3ef",
      card: "#fff",
      accent: "#2563eb",
    };
  }

  _escape(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  _personInitial(name) {
    return (name || "?").trim().charAt(0).toUpperCase() || "?";
  }

  _autoColor(index) {
    const hue = (index * 47) % 360;
    return `hsl(${hue} 72% 42%)`;
  }

  _personColorPresets() {
    return ["#e11d48", "#2563eb", "#059669", "#d97706", "#9333ea", "#0891b2", "#16a34a", "#f59e0b"];
  }

  _normalizeHexColor(value, fallback = "#2563eb") {
    const raw = String(value || "").trim();
    return /^#[0-9a-fA-F]{6}$/.test(raw) ? raw.toLowerCase() : fallback;
  }

  _hexToRgba(hex, alpha = 1) {
    const raw = String(hex || "").trim();
    if (!/^#[0-9a-fA-F]{6}$/.test(raw)) return "";
    const r = Number.parseInt(raw.slice(1, 3), 16);
    const g = Number.parseInt(raw.slice(3, 5), 16);
    const b = Number.parseInt(raw.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  _spanBarColors(assignees) {
    const fallback = {
      bg: "#e8f7ef",
      border: "#b9e7ce",
      text: "#0f172a",
    };
    const ids = Array.isArray(assignees) ? assignees : [];
    if (ids.length !== 1) return fallback;
    const person = this._board.people.find((p) => p.id === ids[0]);
    if (!person?.color) return fallback;
    const border = String(person.color).trim();
    const bg = this._hexToRgba(border, 0.14);
    if (!bg) return fallback;
    return { bg, border, text: "#0f172a" };
  }

  _taskCardColors(task) {
    const fallback = task.fixed
      ? { bg: "#ecf3ff", border: "#b7cdf3", text: "#0f172a", accent: "#3b82f6" }
      : { bg: "#f8fafc", border: "#e2e8f0", text: "#0f172a", accent: "#94a3b8" };
    const ids = Array.isArray(task?.assignees) ? task.assignees : [];
    if (ids.length !== 1) return fallback;
    const person = this._board.people.find((p) => p.id === ids[0]);
    if (!person?.color) return fallback;
    const border = String(person.color).trim();
    const bg = this._hexToRgba(border, task.fixed ? 0.18 : 0.13);
    if (!bg) return fallback;
    return { bg, border, text: "#0f172a", accent: border };
  }

  _suggestPersonColor() {
    const taken = new Set(this._board.people.map((p) => this._normalizeHexColor(p.color, "")));
    for (const color of this._personColorPresets()) {
      if (!taken.has(color)) return color;
    }
    return this._personColorPresets()[this._board.people.length % this._personColorPresets().length];
  }

  _todayIsoDate() {
    return new Date().toISOString().slice(0, 10);
  }

  _startOfWeek(baseDate = new Date(), weekOffset = 0) {
    const d = new Date(baseDate);
    const day = d.getDay();
    const diff = (day + 6) % 7;
    d.setDate(d.getDate() - diff + weekOffset * 7);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  _weekdayDateForWeek(weekdayKey, weekOffset = 0) {
    const weekStart = this._startOfWeek(new Date(), weekOffset);
    const idx = this._weekdayKeys().findIndex((d) => d.key === weekdayKey);
    if (idx < 0) return null;
    const d = new Date(weekStart);
    d.setDate(d.getDate() + idx);
    return d;
  }

  _weekdayDateForCurrentWeek(weekdayKey) {
    return this._weekdayDateForWeek(weekdayKey, 0);
  }

  _toIsoDate(dateObj) {
    const year = dateObj.getFullYear();
    const month = String(dateObj.getMonth() + 1).padStart(2, "0");
    const day = String(dateObj.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  _weekStartIso(offset = this._weekOffset) {
    return this._toIsoDate(this._startOfWeek(new Date(), offset));
  }

  _isoWeekNumber(dateObj) {
    const d = new Date(Date.UTC(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate()));
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  }

  _weekNumberForOffset(offset = this._weekOffset) {
    return this._isoWeekNumber(this._startOfWeek(new Date(), offset));
  }

  _weekRangeLabel(offset = this._weekOffset) {
    const start = this._startOfWeek(new Date(), offset);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    const fmt = new Intl.DateTimeFormat(undefined, { day: "2-digit", month: "2-digit" });
    return `${fmt.format(start)} - ${fmt.format(end)}`;
  }

  _formatWeekdayDate(weekdayKey, offset = this._weekOffset) {
    const date = this._weekdayDateForWeek(weekdayKey, offset);
    if (!date) return "";
    return new Intl.DateTimeFormat(undefined, { day: "2-digit", month: "2-digit" }).format(date);
  }

  _formatWeekdayDateCompact(weekdayKey, offset = this._weekOffset) {
    const date = this._weekdayDateForWeek(weekdayKey, offset);
    if (!date) return "";
    const day = String(date.getDate()).padStart(2, "0");
    const month = String(date.getMonth() + 1).padStart(2, "0");
    return `${day}-${month}`;
  }

  _todayWeekdayKey() {
    const day = new Date().getDay(); // Sun=0..Sat=6
    const idx = (day + 6) % 7; // Mon=0..Sun=6
    return this._weekdayKeys()[idx]?.key || "monday";
  }

  _weekdayNameFromIndex(index) {
    const names = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    const safe = Number.isFinite(Number(index)) ? Number(index) : 6;
    return names[Math.max(0, Math.min(6, safe))];
  }

  _formatClock(hour, minute) {
    const h = Math.max(0, Math.min(23, Number.isFinite(Number(hour)) ? Number(hour) : 0));
    const m = Math.max(0, Math.min(59, Number.isFinite(Number(minute)) ? Number(minute) : 0));
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  _isReadOnlyWeekView() {
    return this._weekOffset !== 0;
  }

  _shiftWeek(delta) {
    this._weekOffset = Math.min(this._maxWeekOffset, Math.max(0, this._weekOffset + delta));
    this._render();
  }

  _onWeekTouchStart(ev) {
    if (!ev.touches || ev.touches.length !== 1) return;
    if (Date.now() < this._blockWeekSwipeUntil) return;
    if (ev.target?.closest?.(".task")) return;
    this._swipeStartX = ev.touches[0].clientX;
  }

  _onWeekTouchEnd(ev) {
    if (this._swipeStartX === null || !ev.changedTouches || !ev.changedTouches.length) return;
    if (Date.now() < this._blockWeekSwipeUntil) {
      this._swipeStartX = null;
      return;
    }
    if (ev.target?.closest?.(".task")) {
      this._swipeStartX = null;
      return;
    }
    const delta = ev.changedTouches[0].clientX - this._swipeStartX;
    this._swipeStartX = null;
    if (Math.abs(delta) < 40) return;
    if (delta < 0) this._shiftWeek(1);
    else this._shiftWeek(-1);
  }

  _normalizeBoard(board) {
    const people = Array.isArray(board.people) ? board.people : [];
    const tasks = Array.isArray(board.tasks) ? board.tasks : [];
    const templates = Array.isArray(board.templates) ? board.templates : [];
    const settings = board && typeof board === "object" && board.settings ? board.settings : {};
    const validColumns = this._columns().map((c) => c.key);

    const currentWeekStart = this._weekStartIso(0);
    const normalizedPeople = people.map((p, i) => ({
        id: String(p.id || `person_${i}`),
        name: (p.name || "Person").trim() || "Person",
        color: p.color || this._autoColor(i),
        role: p.role === "child" ? "child" : "adult",
      }));
    const knownPersonIds = new Set(normalizedPeople.map((p) => String(p.id)));
    const personIdByName = new Map(normalizedPeople.map((p) => [p.name.trim().toLowerCase(), String(p.id)]));
    const normalizeAssignees = (items) => {
      if (!Array.isArray(items)) return [];
      const mapped = items
        .map((item) => String(item || "").trim())
        .map((item) => {
          if (!item) return "";
          if (knownPersonIds.has(item)) return item;
          return personIdByName.get(item.toLowerCase()) || "";
        })
        .filter(Boolean);
      return [...new Set(mapped)];
    };

    return {
      people: normalizedPeople,
      tasks: tasks
        .map((t, i) => {
          const column = validColumns.includes(t.column) ? t.column : "monday";
          const isWeekday = this._weekdayKeys().some((day) => day.key === column);
          return {
          id: String(t.id || `task_${i}`),
          title: (t.title || "").trim(),
          assignees: normalizeAssignees(t.assignees),
          column,
          order: Number.isFinite(t.order) ? t.order : i,
          created_at: t.created_at || new Date().toISOString(),
          end_date: t.end_date || "",
          template_id: String(t.template_id || ""),
          fixed: Boolean(t.fixed),
          span_id: String(t.span_id || ""),
          span_index: Number.isFinite(t.span_index) ? t.span_index : 0,
          span_total: Number.isFinite(t.span_total) ? t.span_total : 0,
          week_start: isWeekday ? (t.week_start || currentWeekStart) : "",
          week_number: Number.isFinite(t.week_number) ? t.week_number : this._weekNumberForOffset(0),
        };
        })
        .filter((t) => t.title),
      templates: templates
        .map((tpl, i) => ({
          id: String(tpl.id || `tpl_${i}`),
          title: (tpl.title || "").trim(),
          assignees: normalizeAssignees(tpl.assignees),
          end_date: tpl.end_date || "",
          weekdays: Array.isArray(tpl.weekdays) ? tpl.weekdays : [],
          excluded_dates: Array.isArray(tpl.excluded_dates) ? tpl.excluded_dates : [],
          created_at: tpl.created_at || new Date().toISOString(),
        }))
        .filter((tpl) => tpl.title),
      settings: {
        ...this._defaultSettings(),
        ...settings,
        labels: {
          ...this._defaultSettings().labels,
          ...(settings.labels || {}),
        },
        weekly_refresh: {
          ...this._defaultSettings().weekly_refresh,
          ...(settings.weekly_refresh || {}),
        },
        quick_templates: Array.isArray(settings.quick_templates)
          ? [...new Set(settings.quick_templates.map((item) => String(item || "").trim()).filter(Boolean))].slice(0, 24)
          : [...this._defaultSettings().quick_templates],
        gestures: {
          ...this._defaultSettings().gestures,
          ...(settings.gestures || {}),
        },
        onboarding_dismissed: Boolean(settings.onboarding_dismissed),
        show_next_up: Boolean(settings.show_next_up),
      },
      updated_at: String(board?.updated_at || ""),
    };
  }

  _snapshotBoard() {
    return JSON.parse(JSON.stringify(this._board || { people: [], tasks: [], templates: [], settings: this._defaultSettings() }));
  }

  _deepEqual(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  _mapById(items) {
    const map = new Map();
    (Array.isArray(items) ? items : []).forEach((item) => {
      if (!item || typeof item !== "object") return;
      const id = String(item.id || "");
      if (!id) return;
      map.set(id, item);
    });
    return map;
  }

  _mergeCollectionById(remoteItems, localItems, baseItems) {
    const remoteMap = this._mapById(remoteItems);
    const localMap = this._mapById(localItems);
    const baseMap = this._mapById(baseItems);
    const ids = new Set([...remoteMap.keys(), ...localMap.keys(), ...baseMap.keys()]);
    const out = [];
    for (const id of ids) {
      const remoteItem = remoteMap.get(id);
      const localItem = localMap.get(id);
      const baseItem = baseMap.get(id);

      const remoteDeleted = Boolean(baseItem) && !remoteItem;
      const localDeleted = Boolean(baseItem) && !localItem;
      if (remoteDeleted || localDeleted) continue;

      if (remoteItem && !localItem) {
        out.push(remoteItem);
        continue;
      }
      if (localItem && !remoteItem) {
        out.push(localItem);
        continue;
      }
      if (!localItem && !remoteItem) continue;

      const localChanged = !this._deepEqual(localItem, baseItem);
      const remoteChanged = !this._deepEqual(remoteItem, baseItem);
      if (localChanged && !remoteChanged) out.push(localItem);
      else if (remoteChanged && !localChanged) out.push(remoteItem);
      else out.push(localItem || remoteItem);
    }
    return out;
  }

  _mergeBoardsForConflict(remoteBoardRaw, localBoardRaw, baseBoardRaw) {
    const remote = this._normalizeBoard(remoteBoardRaw || {});
    const local = this._normalizeBoard(localBoardRaw || {});
    const base = this._normalizeBoard(baseBoardRaw || {});

    const merged = this._normalizeBoard({
      people: this._mergeCollectionById(remote.people, local.people, base.people),
      tasks: this._mergeCollectionById(remote.tasks, local.tasks, base.tasks),
      templates: this._mergeCollectionById(remote.templates, local.templates, base.templates),
      settings: this._deepEqual(local.settings, base.settings) ? remote.settings : local.settings,
      updated_at: remote.updated_at,
    });
    merged.updated_at = remote.updated_at;
    return merged;
  }

  _setUndo(label, snapshot) {
    if (this._undoTimer) {
      clearTimeout(this._undoTimer);
      this._undoTimer = null;
    }
    this._undoState = { label, snapshot };
    this._undoTimer = setTimeout(() => {
      this._undoState = null;
      this._undoTimer = null;
      this._render();
    }, 10000);
  }

  _clearUndo() {
    if (this._undoTimer) {
      clearTimeout(this._undoTimer);
      this._undoTimer = null;
    }
    this._undoState = null;
  }

  async _undoLastAction() {
    if (!this._undoState?.snapshot) return;
    this._board = this._normalizeBoard(this._undoState.snapshot);
    this._clearUndo();
    this._render();
    await this._saveBoard();
  }

  _setPersonFilter(filterValue) {
    const value = String(filterValue || "all");
    if (value === "all" || value === "adults" || value === "children") {
      this._personFilter = value;
      return;
    }
    if (value.startsWith("person:")) {
      const personId = value.slice("person:".length);
      if (this._board.people.some((p) => String(p.id) === personId)) {
        this._personFilter = value;
        this._personFilterSelection = personId;
        return;
      }
    }
    this._personFilter = "all";
  }

  _tasksVisibleByFilter(tasks) {
    if (this._personFilter === "all") return tasks;
    const roleById = new Map(this._board.people.map((person) => [String(person.id), person.role === "child" ? "child" : "adult"]));
    if (this._personFilter === "adults" || this._personFilter === "children") {
      const wanted = this._personFilter === "children" ? "child" : "adult";
      return tasks.filter((task) => Array.isArray(task.assignees) && task.assignees.some((id) => roleById.get(String(id)) === wanted));
    }
    if (this._personFilter.startsWith("person:")) {
      const personId = this._personFilter.slice("person:".length);
      return tasks.filter((task) => Array.isArray(task.assignees) && task.assignees.includes(personId));
    }
    return tasks;
  }

  async _resolveEntryId() {
    if (!this._hass || this._config.entry_id) return;
    try {
      const result = await this._hass.callWS({ type: "household_chores/list_entries" });
      const entries = result?.entries || [];
      if (entries.length === 1) this._config.entry_id = entries[0].entry_id;
    } catch (_err) {
      // fallback below
    }

    if (!this._config.entry_id) {
      const stateEntity = this._findBoardStateEntity();
      if (stateEntity?.attributes?.entry_id) {
        this._config.entry_id = stateEntity.attributes.entry_id;
      }
    }
  }

  async _callBoardWs(payload) {
    try {
      return await this._hass.callWS(payload);
    } catch (err) {
      const msg = String(err?.message || err || "");
      if (msg.toLowerCase().includes("unknown command")) {
        throw new Error("Unknown command. Update integration + restart Home Assistant.");
      }
      throw err;
    }
  }

  async _loadBoard() {
    if (!this._hass || !this._config) return;
    if (!this._config.entry_id) {
      await this._resolveEntryId();
      if (!this._config.entry_id) {
        this._error = "Set entry_id or keep only one Household Chores integration entry.";
        this._loading = false;
        this._render();
        return;
      }
    }

    this._loading = true;
    this._error = "";
    this._render();

    try {
      const result = await this._callBoardWs({ type: "household_chores/get_board", entry_id: this._config.entry_id });
      this._board = this._normalizeBoard(result.board || { people: [], tasks: [], templates: [] });
      this._lastSyncedBoard = this._snapshotBoard();
      this._setPersonFilter(this._personFilter);
      this._error = "";
    } catch (err) {
      const message = String(err?.message || err || "");
      if (message.toLowerCase().includes("unknown command")) {
        const fallbackBoard = this._loadBoardFromStateEntity();
        if (fallbackBoard) {
          this._board = this._normalizeBoard(fallbackBoard);
          this._lastSyncedBoard = this._snapshotBoard();
          this._setPersonFilter(this._personFilter);
          this._error = "";
        } else {
          this._error = "Failed to load board: backend command unavailable and no board state entity found.";
        }
      } else {
        this._error = `Failed to load board: ${message}`;
      }
    } finally {
      this._loading = false;
      this._render();
    }
  }

  _findBoardStateEntity() {
    if (!this._hass || !this._hass.states) return null;
    const entries = Object.entries(this._hass.states).filter(([entityId]) => entityId.startsWith("sensor.") && entityId.endsWith("_board_state"));
    if (!entries.length) return null;

    if (this._config?.entry_id) {
      for (const [, state] of entries) {
        const attrs = state?.attributes || {};
        if (attrs.entry_id === this._config.entry_id) return state;
      }
    }

    if (entries.length === 1) return entries[0][1];
    return null;
  }

  _loadBoardFromStateEntity() {
    const state = this._findBoardStateEntity();
    if (!state) return null;
    const attrs = state.attributes || {};
    if (!this._config.entry_id && attrs.entry_id) {
      this._config.entry_id = attrs.entry_id;
    }
    const board = attrs.board;
    if (!board || typeof board !== "object") return null;
    return board;
  }

  async _saveBoard() {
    if (!this._hass || !this._config?.entry_id) return;
    this._saving = true;
    this._render();
    try {
      const expectedUpdatedAt = String(this._lastSyncedBoard?.updated_at || this._board?.updated_at || "");
      const result = await this._callBoardWs({
        type: "household_chores/save_board",
        entry_id: this._config.entry_id,
        board: this._board,
        expected_updated_at: expectedUpdatedAt,
      });
      this._board = this._normalizeBoard(result.board || this._board);
      this._lastSyncedBoard = this._snapshotBoard();
      this._setPersonFilter(this._personFilter);
      this._error = "";
    } catch (err) {
      const message = String(err?.message || err || "");
      if (message.toLowerCase().includes("conflict")) {
        try {
          const latest = await this._callBoardWs({ type: "household_chores/get_board", entry_id: this._config.entry_id });
          const latestBoard = this._normalizeBoard(latest.board || {});
          const mergedBoard = this._mergeBoardsForConflict(latestBoard, this._board, this._lastSyncedBoard || latestBoard);
          const retry = await this._callBoardWs({
            type: "household_chores/save_board",
            entry_id: this._config.entry_id,
            board: mergedBoard,
            expected_updated_at: String(latestBoard.updated_at || ""),
          });
          this._board = this._normalizeBoard(retry.board || mergedBoard);
          this._lastSyncedBoard = this._snapshotBoard();
          this._setPersonFilter(this._personFilter);
          this._error = "";
        } catch (mergeErr) {
          this._error = `Failed to save board after merge: ${mergeErr?.message || mergeErr}`;
        }
      } else if (message.toLowerCase().includes("unknown command")) {
        try {
          await this._hass.callService("household_chores", "save_board", {
            entry_id: this._config.entry_id,
            board: this._board,
          });
          this._lastSyncedBoard = this._snapshotBoard();
          this._error = "";
        } catch (serviceErr) {
          this._error = `Failed to save board: ${serviceErr?.message || serviceErr}`;
        }
      } else {
        this._error = `Failed to save board: ${message}`;
      }
    } finally {
      this._saving = false;
      this._render();
    }
  }

  _tasksForColumn(column, weekOffset = this._weekOffset) {
    const isWeekdayColumn = this._weekdayKeys().some((day) => day.key === column);
    const selectedWeekStart = this._weekStartIso(weekOffset);
    const currentWeekStart = this._weekStartIso(0);
    const stored = this._board.tasks
      .filter((t) => t.column === column)
      .filter((t) => (t.week_start || currentWeekStart) === selectedWeekStart)
      .sort((a, b) => a.order - b.order || a.created_at.localeCompare(b.created_at));

    if (isWeekdayColumn && weekOffset > 0) {
      const projected = this._projectedTasksForFutureWeekday(column, weekOffset).filter(
        (task) => !stored.some((item) => item.template_id && item.template_id === task.template_id)
      );
      return [...stored, ...projected];
    }
    return stored;
  }

  _projectedTasksForFutureWeekday(weekdayKey, weekOffset) {
    const dayDate = this._weekdayDateForWeek(weekdayKey, weekOffset);
    if (!dayDate) return [];
    const dayIso = this._toIsoDate(dayDate);

    return this._board.templates
      .filter((tpl) => Array.isArray(tpl.weekdays) && tpl.weekdays.includes(weekdayKey) && tpl.end_date && dayIso <= tpl.end_date)
      .filter((tpl) => !(Array.isArray(tpl.excluded_dates) && tpl.excluded_dates.includes(dayIso)))
      .map((tpl, idx) => ({
        id: `virtual_${tpl.id}_${weekdayKey}_${weekOffset}_${idx}`,
        title: tpl.title,
        assignees: [...(tpl.assignees || [])],
        column: weekdayKey,
        order: idx,
        created_at: tpl.created_at || "",
        end_date: tpl.end_date,
        template_id: tpl.id,
        fixed: true,
        week_start: this._weekStartIso(weekOffset),
        week_number: this._weekNumberForOffset(weekOffset),
        virtual: true,
      }))
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  _reindexAllColumns() {
    for (const col of this._columns().map((c) => c.key)) {
      const items = this._tasksForColumn(col);
      items.forEach((task, i) => {
        task.order = i;
      });
    }
  }

  _openPeopleModal() {
    this._newPersonColor = this._suggestPersonColor();
    this._showPeopleModal = true;
    this._render();
  }

  _closePeopleModal() {
    this._showPeopleModal = false;
    this._render();
    this._flushQueuedPersonColorSave();
  }

  _openAddTaskModal() {
    this._taskForm = this._emptyTaskForm("add");
    this._taskFormOriginal = this._cloneTaskForm(this._taskForm);
    this._taskFormDirty = false;
    this._showTaskModal = true;
    this._render();
  }

  _openAddTaskModalForColumn(columnKey) {
    const next = this._emptyTaskForm("add");
    const isWeekday = this._weekdayKeys().some((item) => item.key === columnKey);
    if (isWeekday) {
      next.weekdays = [columnKey];
    } else {
      next.column = columnKey;
    }
    this._taskForm = next;
    this._taskFormOriginal = this._cloneTaskForm(this._taskForm);
    this._taskFormDirty = false;
    this._showTaskModal = true;
    this._render();
  }

  _openEditTaskModal(taskId) {
    const task = this._board.tasks.find((t) => t.id === taskId);
    if (!task) return;
    const knownPersonIds = new Set(this._board.people.map((person) => person.id));

    const tpl = task.template_id ? this._board.templates.find((x) => x.id === task.template_id) : null;
    const sanitizedTaskAssignees = Array.isArray(task.assignees) ? task.assignees.filter((id) => knownPersonIds.has(id)) : [];
    const sanitizedTplAssignees = tpl && Array.isArray(tpl.assignees) ? tpl.assignees.filter((id) => knownPersonIds.has(id)) : [];
    const nextAssignees = tpl ? [...sanitizedTplAssignees] : [...sanitizedTaskAssignees];

    if (Array.isArray(task.assignees) && task.assignees.length !== sanitizedTaskAssignees.length) {
      task.assignees = [...sanitizedTaskAssignees];
      if (task.template_id) {
        this._board.tasks.forEach((item) => {
          if (item.template_id === task.template_id) item.assignees = [...sanitizedTaskAssignees];
        });
      }
    }
    if (tpl && Array.isArray(tpl.assignees) && tpl.assignees.length !== sanitizedTplAssignees.length) {
      tpl.assignees = [...sanitizedTplAssignees];
    }

    const spanGroup = this._taskSpanGroup(task);
    const spanWeekdays = this._sortedWeekdays(
      spanGroup
        .map((item) => item.column)
        .filter((dayKey) => this._weekdayKeys().some((d) => d.key === dayKey))
    );
    const weekdays = tpl?.weekdays?.length
      ? [...tpl.weekdays]
      : spanWeekdays.length
        ? spanWeekdays
        : this._weekdayKeys().some((d) => d.key === task.column)
          ? [task.column]
          : [];
    const occurrenceDate = this._taskOccurrenceDate(task);

    this._taskForm = {
      mode: "edit",
      taskId: task.id,
      templateId: task.template_id || "",
      spanId: task.span_id || "",
      title: task.title,
      fixed: Boolean(task.fixed),
      allDaySpan: Boolean(task.span_id),
      endDate: task.end_date || tpl?.end_date || "",
      column: task.column || "monday",
      weekdays,
      assignees: nextAssignees,
      occurrenceDate,
      deleteSeries: false,
    };

    this._taskFormOriginal = this._cloneTaskForm(this._taskForm);
    this._taskFormDirty = false;
    this._showTaskModal = true;
    this._render();
  }

  _openEditTemplateModal(templateId, fallbackColumn = "monday", weekStartIso = "") {
    const tpl = this._board.templates.find((item) => item.id === templateId);
    if (!tpl) return;
    const knownPersonIds = new Set(this._board.people.map((person) => person.id));
    const assignees = Array.isArray(tpl.assignees) ? tpl.assignees.filter((id) => knownPersonIds.has(id)) : [];
    if (Array.isArray(tpl.assignees) && tpl.assignees.length !== assignees.length) {
      tpl.assignees = [...assignees];
    }

    const occurrenceDate = this._dateForWeekStartAndColumn(weekStartIso || this._weekStartIso(this._weekOffset), fallbackColumn);
    this._taskForm = {
      mode: "edit",
      taskId: "",
      templateId: tpl.id,
      spanId: "",
      title: tpl.title || "",
      fixed: true,
      allDaySpan: false,
      endDate: tpl.end_date || "",
      column: fallbackColumn || "monday",
      weekdays: Array.isArray(tpl.weekdays) ? [...tpl.weekdays] : [],
      assignees,
      occurrenceDate,
      deleteSeries: false,
    };

    this._taskFormOriginal = this._cloneTaskForm(this._taskForm);
    this._taskFormDirty = false;
    this._showTaskModal = true;
    this._render();
  }

  _closeTaskModal() {
    this._showTaskModal = false;
    this._taskForm = this._emptyTaskForm("add");
    this._taskFormOriginal = null;
    this._taskFormDirty = false;
    this._render();
  }

  _dateForWeekStartAndColumn(weekStartIso, column) {
    if (!weekStartIso || !this._weekdayKeys().some((day) => day.key === column)) return "";
    const start = new Date(`${weekStartIso}T00:00:00`);
    if (Number.isNaN(start.getTime())) return "";
    const idx = this._weekdayKeys().findIndex((day) => day.key === column);
    if (idx < 0) return "";
    start.setDate(start.getDate() + idx);
    return this._toIsoDate(start);
  }

  _taskOccurrenceDate(task) {
    if (!task) return "";
    if (task.week_start && this._weekdayKeys().some((day) => day.key === task.column)) {
      return this._dateForWeekStartAndColumn(task.week_start, task.column);
    }
    return "";
  }

  _openSettingsModal() {
    this._settingsForm = this._emptySettingsForm();
    this._newQuickTemplateName = "";
    this._dataExportText = JSON.stringify(this._board, null, 2);
    this._dataImportText = "";
    this._dataImportError = "";
    this._showSettingsModal = true;
    this._render();
  }

  _closeSettingsModal() {
    this._showSettingsModal = false;
    this._settingsForm = this._emptySettingsForm();
    this._newQuickTemplateName = "";
    this._render();
  }

  _onSettingsFieldInput(path, value) {
    const next = JSON.parse(JSON.stringify(this._settingsForm || this._defaultSettings()));
    let node = next;
    for (let i = 0; i < path.length - 1; i += 1) {
      node[path[i]] = node[path[i]] || {};
      node = node[path[i]];
    }
    node[path[path.length - 1]] = value;
    this._settingsForm = next;
  }

  _onQuickTemplateInput(value) {
    this._newQuickTemplateName = String(value || "");
    this._render();
  }

  _canAddQuickTemplate() {
    const name = String(this._newQuickTemplateName || "").trim();
    if (!name) return false;
    const existing = Array.isArray(this._settingsForm?.quick_templates) ? this._settingsForm.quick_templates : [];
    return !existing.some((item) => String(item).toLowerCase() === name.toLowerCase());
  }

  _onAddQuickTemplate() {
    if (!this._canAddQuickTemplate()) return;
    const next = JSON.parse(JSON.stringify(this._settingsForm || this._defaultSettings()));
    const name = String(this._newQuickTemplateName || "").trim();
    const current = Array.isArray(next.quick_templates) ? next.quick_templates : [];
    next.quick_templates = [...current, name].slice(0, 24);
    this._settingsForm = next;
    this._newQuickTemplateName = "";
    this._render();
  }

  _onRemoveQuickTemplate(index) {
    const next = JSON.parse(JSON.stringify(this._settingsForm || this._defaultSettings()));
    const current = Array.isArray(next.quick_templates) ? next.quick_templates : [];
    next.quick_templates = current.filter((_, idx) => idx !== index);
    this._settingsForm = next;
    this._render();
  }

  _openAddTaskFromQuickTemplate(templateName) {
    const title = String(templateName || "").trim();
    if (!title) return;
    this._taskForm = {
      ...this._emptyTaskForm("add"),
      title,
      column: "monday",
      allDaySpan: false,
    };
    this._taskFormOriginal = null;
    this._taskFormDirty = false;
    this._showTaskModal = true;
    this._render();
  }

  async _quickMoveTaskToCompleted(taskId) {
    const task = this._board.tasks.find((item) => item.id === taskId);
    if (!task || task.virtual || task.column === "done") return;
    const snapshot = this._snapshotBoard();
    const targets = this._taskSpanGroup(task);
    for (const item of targets) {
      item.column = "done";
      item.week_start = this._weekStartIso(this._weekOffset);
      item.week_number = this._weekNumberForOffset(this._weekOffset);
    }
    this._reindexAllColumns();
    this._setUndo(targets.length > 1 ? "All-day task moved to Completed" : "Task moved to Completed", snapshot);
    this._render();
    await this._saveBoard();
  }

  async _quickDeleteTask(taskId, { viaSwipe = false } = {}) {
    const task = this._board.tasks.find((item) => item.id === taskId);
    if (!task || task.virtual) return;
    if (viaSwipe && task.span_id) {
      const ok = window.confirm("Delete this all-day task across selected days?");
      if (!ok) return;
    }
    if (viaSwipe && (task.fixed || task.template_id)) {
      const ok = window.confirm("Delete this fixed occurrence only? Use edit modal to delete full series.");
      if (!ok) return;
    }
    const snapshot = this._snapshotBoard();
    const templateId = task.template_id || "";
    if (templateId) {
      const occurrenceDate = this._taskOccurrenceDate(task);
      this._board.templates = this._board.templates.map((tpl) => {
        if (tpl.id !== templateId) return tpl;
        const excluded = new Set(Array.isArray(tpl.excluded_dates) ? tpl.excluded_dates : []);
        if (occurrenceDate) excluded.add(occurrenceDate);
        return { ...tpl, excluded_dates: [...excluded].sort() };
      });
      this._board.tasks = this._board.tasks.filter((t) => {
        if (t.template_id !== templateId) return true;
        if (!occurrenceDate) return false;
        return this._taskOccurrenceDate(t) !== occurrenceDate;
      });
    } else if (task.span_id) {
      const group = this._taskSpanGroup(task);
      const ids = new Set(group.map((item) => item.id));
      this._board.tasks = this._board.tasks.filter((t) => !ids.has(t.id));
    } else {
      this._board.tasks = this._board.tasks.filter((t) => t.id !== task.id);
    }
    this._reindexAllColumns();
    this._setUndo(task.span_id ? "All-day task deleted" : "Task deleted", snapshot);
    this._render();
    await this._saveBoard();
  }

  async _dismissOnboardingTips() {
    if (this._board?.settings?.onboarding_dismissed) return;
    const nextSettings = JSON.parse(JSON.stringify(this._board.settings || this._defaultSettings()));
    nextSettings.onboarding_dismissed = true;
    this._board.settings = nextSettings;
    this._render();
    await this._saveBoard();
  }

  async _onSaveTaskTitleAsQuickTemplate() {
    const title = String(this._taskForm?.title || "").trim();
    if (!title) return;
    const nextSettings = JSON.parse(JSON.stringify(this._board.settings || this._defaultSettings()));
    const current = Array.isArray(nextSettings.quick_templates) ? nextSettings.quick_templates : [];
    if (!current.some((item) => String(item).toLowerCase() === title.toLowerCase())) {
      nextSettings.quick_templates = [...current, title].slice(0, 24);
      this._board.settings = nextSettings;
      this._render();
      await this._saveBoard();
    }
  }

  _onTaskTouchStart(taskEl, ev) {
    if (!ev.touches || ev.touches.length !== 1) return;
    const isVirtual = taskEl.dataset.virtual === "1";
    if (isVirtual) return;
    this._blockWeekSwipeUntil = Date.now() + 900;
    taskEl.classList.remove("swipe-complete-preview", "swipe-delete-preview");
    this._taskSwipe = {
      taskId: taskEl.dataset.taskId || "",
      startX: ev.touches[0].clientX,
      startY: ev.touches[0].clientY,
      startAt: Date.now(),
      active: true,
      moved: false,
    };
  }

  _onTaskTouchMove(taskEl, ev) {
    if (!this._taskSwipe?.active || !ev.touches || ev.touches.length !== 1) return;
    const dx = ev.touches[0].clientX - this._taskSwipe.startX;
    const dy = ev.touches[0].clientY - this._taskSwipe.startY;
    const gestures = this._board?.settings?.gestures || {};
    const completeEnabled = gestures.swipe_complete !== false;
    const deleteEnabled = Boolean(gestures.swipe_delete);
    const horizontalEnough = Math.abs(dx) > Math.abs(dy) * 1.2;
    const completeReady = completeEnabled && dx > 58 && horizontalEnough;
    const deleteReady = deleteEnabled && dx < -58 && horizontalEnough;
    taskEl.classList.toggle("swipe-complete-preview", completeReady);
    taskEl.classList.toggle("swipe-delete-preview", deleteReady);
    if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
    this._taskSwipe.moved = true;
    if (Math.abs(dx) > Math.abs(dy)) {
      ev.preventDefault();
      if (dx > 0) taskEl.style.transform = `translateX(${Math.min(56, dx)}px)`;
      else taskEl.style.transform = `translateX(${Math.max(-56, dx)}px)`;
      taskEl.style.transition = "transform 80ms linear";
    }
  }

  async _onTaskTouchEnd(taskEl, ev) {
    if (!this._taskSwipe?.active) return;
    this._blockWeekSwipeUntil = Date.now() + 900;
    const swipe = this._taskSwipe;
    this._taskSwipe = null;
    taskEl.style.transform = "";
    taskEl.style.transition = "";
    taskEl.classList.remove("swipe-complete-preview", "swipe-delete-preview");
    if (!ev.changedTouches || !ev.changedTouches.length) return;
    const endX = ev.changedTouches[0].clientX;
    const endY = ev.changedTouches[0].clientY;
    const dx = endX - swipe.startX;
    const dy = endY - swipe.startY;
    const gestures = this._board?.settings?.gestures || {};
    const completeEnabled = gestures.swipe_complete !== false;
    const deleteEnabled = Boolean(gestures.swipe_delete);
    const horizontalEnough = Math.abs(dx) > Math.abs(dy) * 1.2;
    const gestureAge = Date.now() - (swipe.startAt || Date.now());
    if (dx > 76 && horizontalEnough && swipe.taskId && completeEnabled && gestureAge > 60) {
      this._suppressTaskClickUntil = Date.now() + 500;
      await this._quickMoveTaskToCompleted(swipe.taskId);
    } else if (dx < -76 && horizontalEnough && swipe.taskId && deleteEnabled && gestureAge > 60) {
      this._suppressTaskClickUntil = Date.now() + 500;
      await this._quickDeleteTask(swipe.taskId, { viaSwipe: true });
    }
  }

  async _onSubmitSettings(ev) {
    ev.preventDefault();
    const next = JSON.parse(JSON.stringify(this._settingsForm || this._defaultSettings()));
    next.theme = ["light", "dark", "colorful"].includes(next.theme) ? next.theme : "light";
    next.compact_mode = Boolean(next.compact_mode);
    next.show_next_up = Boolean(next.show_next_up);
    next.quick_templates = Array.isArray(next.quick_templates)
      ? [...new Set(next.quick_templates.map((item) => String(item || "").trim()).filter(Boolean))].slice(0, 24)
      : [];
    next.gestures = {
      swipe_complete: Boolean(next.gestures?.swipe_complete ?? true),
      swipe_delete: Boolean(next.gestures?.swipe_delete ?? false),
    };
    next.onboarding_dismissed = Boolean(next.onboarding_dismissed);
    this._board.settings = next;
    this._showSettingsModal = false;
    this._render();
    await this._saveBoard();
  }

  _onImportBoardInput(ev) {
    this._dataImportText = ev.target.value || "";
    this._dataImportError = "";
  }

  _canImportBoard() {
    return Boolean((this._dataImportText || "").trim());
  }

  async _onImportBoard(ev) {
    ev.preventDefault();
    const raw = (this._dataImportText || "").trim();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") {
        this._dataImportError = "Import must be a JSON object.";
        this._render();
        return;
      }
      this._board = this._normalizeBoard(parsed);
      this._setPersonFilter(this._personFilter);
      this._clearUndo();
      this._dataExportText = JSON.stringify(this._board, null, 2);
      this._dataImportText = "";
      this._dataImportError = "";
      this._render();
      await this._saveBoard();
    } catch (_err) {
      this._dataImportError = "Invalid JSON import payload.";
      this._render();
    }
  }

  async _onCopyExportJson() {
    const text = this._dataExportText || JSON.stringify(this._board, null, 2);
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        this._dataImportError = "";
      } else {
        this._dataImportError = "Clipboard API unavailable in this browser.";
      }
    } catch (_err) {
      this._dataImportError = "Unable to copy export JSON.";
    }
    this._render();
  }

  _onPersonNameInput(ev) {
    this._newPersonName = ev.target.value;
    this._updateSubmitButtons();
  }

  _onPersonRoleInput(ev) {
    this._newPersonRole = ev.target.value === "child" ? "child" : "adult";
  }

  _onPersonColorInput(ev) {
    this._newPersonColor = this._normalizeHexColor(ev.target.value, this._suggestPersonColor());
  }

  async _onAddPerson(ev) {
    ev.preventDefault();
    const name = this._newPersonName.trim();
    if (!name) return;

    const color = this._normalizeHexColor(this._newPersonColor, this._suggestPersonColor());

    this._board.people = [
      ...this._board.people,
      { id: `person_${Math.random().toString(36).slice(2, 10)}`, name, color, role: this._newPersonRole === "child" ? "child" : "adult" },
    ];
    this._newPersonName = "";
    this._newPersonRole = "adult";
    this._newPersonColor = this._suggestPersonColor();
    this._closePeopleModal();
    await this._saveBoard();
  }

  async _onChangePersonRole(personId, role) {
    const nextRole = role === "child" ? "child" : "adult";
    let changed = false;
    this._board.people = this._board.people.map((person) => {
      if (person.id !== personId) return person;
      if ((person.role || "adult") === nextRole) return person;
      changed = true;
      return { ...person, role: nextRole };
    });
    if (!changed) return;
    this._queuePersonColorSave();
  }

  _queuePersonColorSave() {
    if (this._personColorSaveTimer) clearTimeout(this._personColorSaveTimer);
    this._personColorSaveTimer = setTimeout(async () => {
      this._personColorSaveTimer = null;
      try {
        await this._saveBoard();
      } catch (_err) {
        // _saveBoard already handles and surfaces errors.
      }
    }, 260);
  }

  _flushQueuedPersonColorSave() {
    if (!this._personColorSaveTimer) return;
    clearTimeout(this._personColorSaveTimer);
    this._personColorSaveTimer = null;
    void this._saveBoard();
  }

  _onChangePersonColor(personId, color, { commit = false } = {}) {
    const nextColor = this._normalizeHexColor(color);
    let changed = false;
    this._board.people = this._board.people.map((person) => {
      if (person.id !== personId) return person;
      const currentColor = this._normalizeHexColor(person.color, nextColor);
      if (currentColor === nextColor) return person;
      changed = true;
      return { ...person, color: nextColor };
    });
    if (!changed) return;
    if (commit) this._queuePersonColorSave();
  }

  _personRoleLabel(role) {
    return role === "child" ? "C" : "A";
  }

  _personRoleTitle(role) {
    return role === "child" ? "Child" : "Adult";
  }

  async _onDeletePerson(personId) {
    const snapshot = this._snapshotBoard();
    this._board.people = this._board.people.filter((person) => person.id !== personId);
    this._setPersonFilter(this._personFilter);
    this._board.tasks = this._board.tasks.map((task) => ({
      ...task,
      assignees: task.assignees.filter((id) => id !== personId),
    }));
    this._board.templates = this._board.templates.map((tpl) => ({
      ...tpl,
      assignees: tpl.assignees.filter((id) => id !== personId),
    }));
    this._setUndo("Person deleted", snapshot);
    this._render();
    await this._saveBoard();
  }

  _onTaskFieldInput(field, value) {
    const next = { ...this._taskForm, [field]: value };
    if (field === "fixed" && value) {
      next.allDaySpan = false;
    }
    if (field === "allDaySpan" && value && (!Array.isArray(next.weekdays) || !next.weekdays.length)) {
      if (this._weekdayKeys().some((day) => day.key === next.column)) next.weekdays = [next.column];
    }
    this._taskForm = next;
    this._recalcTaskFormDirty();
    this._updateSubmitButtons();
  }

  _onTaskDeleteSeriesInput(checked) {
    this._taskForm = { ...this._taskForm, deleteSeries: Boolean(checked) };
    this._recalcTaskFormDirty();
    this._render();
  }

  _cloneTaskForm(form) {
    return {
      ...form,
      weekdays: [...(form.weekdays || [])],
      assignees: [...(form.assignees || [])],
    };
  }

  _normalizedTaskForm(form) {
    return {
      title: (form.title || "").trim(),
      fixed: Boolean(form.fixed),
      allDaySpan: Boolean(form.allDaySpan),
      endDate: form.endDate || "",
      column: form.column || "monday",
      weekdays: [...(form.weekdays || [])].sort(),
      assignees: [...(form.assignees || [])].sort(),
      deleteSeries: Boolean(form.deleteSeries),
    };
  }

  _isTaskFormDirty() {
    if (this._taskForm.mode !== "edit" || !this._taskFormOriginal) return false;
    return JSON.stringify(this._normalizedTaskForm(this._taskForm)) !== JSON.stringify(this._normalizedTaskForm(this._taskFormOriginal));
  }

  _recalcTaskFormDirty() {
    this._taskFormDirty = this._isTaskFormDirty();
  }

  _canSubmitPersonForm() {
    return Boolean(this._newPersonName.trim());
  }

  _canSubmitTaskForm() {
    if (this._saving) return false;
    if (!this._taskForm.title || !this._taskForm.title.trim()) return false;
    if (this._taskForm.mode === "edit") return this._taskFormDirty;
    return true;
  }

  _updateSubmitButtons() {
    const personSubmit = this.shadowRoot?.querySelector("#person-submit");
    if (personSubmit) personSubmit.disabled = !this._canSubmitPersonForm();

    const taskSubmit = this.shadowRoot?.querySelector("#task-submit");
    if (taskSubmit) taskSubmit.disabled = !this._canSubmitTaskForm();

    const saveTemplateBtn = this.shadowRoot?.querySelector("#save-task-as-template");
    if (saveTemplateBtn) {
      const title = String(this._taskForm?.title || "").trim();
      saveTemplateBtn.disabled = !title;
    }
  }

  _captureFocusState() {
    const active = this.shadowRoot?.activeElement;
    if (!active) return null;

    const key = active.id || active.getAttribute?.("data-focus-key") || "";
    if (!key) return null;

    const state = { key };
    if (typeof active.selectionStart === "number" && typeof active.selectionEnd === "number") {
      state.selectionStart = active.selectionStart;
      state.selectionEnd = active.selectionEnd;
    }
    return state;
  }

  _restoreFocusState(state) {
    if (!state?.key || !this.shadowRoot) return;
    const el = state.key.includes("#")
      ? this.shadowRoot.querySelector(state.key)
      : this.shadowRoot.querySelector(`#${state.key}`) || this.shadowRoot.querySelector(`[data-focus-key="${state.key}"]`);
    if (!el || typeof el.focus !== "function") return;

    el.focus({ preventScroll: true });
    if (typeof state.selectionStart === "number" && typeof state.selectionEnd === "number" && typeof el.setSelectionRange === "function") {
      try {
        el.setSelectionRange(state.selectionStart, state.selectionEnd);
      } catch (_err) {
        // Ignore unsupported input types (for example date inputs).
      }
    }
  }

  _toggleTaskAssignee(personId) {
    const set = new Set(this._taskForm.assignees);
    if (set.has(personId)) set.delete(personId);
    else set.add(personId);
    this._taskForm = { ...this._taskForm, assignees: [...set] };
    this._recalcTaskFormDirty();
    this._render();
  }

  _toggleTaskWeekday(dayKey) {
    const set = new Set(this._taskForm.weekdays);
    if (set.has(dayKey)) set.delete(dayKey);
    else set.add(dayKey);
    this._taskForm = { ...this._taskForm, weekdays: this._sortedWeekdays([...set]) };
    this._recalcTaskFormDirty();
    this._render();
  }

  _sortedWeekdays(days) {
    const dayOrder = new Map(this._weekdayKeys().map((day, index) => [day.key, index]));
    return [...new Set(days.filter((day) => dayOrder.has(day)))].sort((a, b) => dayOrder.get(a) - dayOrder.get(b));
  }

  _areContiguousWeekdays(days) {
    const sorted = this._sortedWeekdays(days);
    if (sorted.length < 2) return false;
    const dayOrder = new Map(this._weekdayKeys().map((day, index) => [day.key, index]));
    for (let i = 1; i < sorted.length; i += 1) {
      if (dayOrder.get(sorted[i]) !== dayOrder.get(sorted[i - 1]) + 1) return false;
    }
    return true;
  }

  _taskSpanGroup(task) {
    if (!task?.span_id) return task ? [task] : [];
    return this._board.tasks.filter(
      (item) =>
        item.span_id === task.span_id &&
        String(item.week_start || "") === String(task.week_start || "")
    );
  }

  _buildFixedInstancesForCurrentWeek(template, title, assignees) {
    const todayIso = this._todayIsoDate();
    const weekStart = this._weekStartIso(0);
    const weekNumber = this._weekNumberForOffset(0);
    const items = [];
    for (const dayKey of template.weekdays) {
      const dayDate = this._weekdayDateForCurrentWeek(dayKey);
      if (!dayDate) continue;
      const dayIso = this._toIsoDate(dayDate);
      if (dayIso < todayIso) continue;
      if (dayIso > template.end_date) continue;
      if (Array.isArray(template.excluded_dates) && template.excluded_dates.includes(dayIso)) continue;
      items.push({
        id: `task_${Math.random().toString(36).slice(2, 10)}`,
        title,
        assignees: [...assignees],
        column: dayKey,
        order: 0,
        created_at: new Date().toISOString(),
        end_date: template.end_date,
        template_id: template.id,
        fixed: true,
        span_id: "",
        span_index: 0,
        span_total: 0,
        week_start: weekStart,
        week_number: weekNumber,
      });
    }
    return items;
  }

  _buildOneOffWeekdayInstances(
    title,
    assignees,
    weekdays,
    endDate = "",
    weekStart = this._weekStartIso(this._weekOffset),
    weekNumber = this._weekNumberForOffset(this._weekOffset)
  ) {
    const items = [];
    for (const dayKey of weekdays) {
      items.push({
        id: `task_${Math.random().toString(36).slice(2, 10)}`,
        title: title.trim(),
        assignees: [...assignees],
        column: dayKey,
        order: 0,
        created_at: new Date().toISOString(),
        end_date: endDate || "",
        template_id: "",
        fixed: false,
        span_id: "",
        span_index: 0,
        span_total: 0,
        week_start: weekStart,
        week_number: weekNumber,
      });
    }
    return items;
  }

  _buildAllDaySpanInstances(
    title,
    assignees,
    weekdays,
    endDate = "",
    weekStart = this._weekStartIso(this._weekOffset),
    weekNumber = this._weekNumberForOffset(this._weekOffset),
    spanId = `span_${Math.random().toString(36).slice(2, 10)}`
  ) {
    const sorted = this._sortedWeekdays(weekdays);
    const total = sorted.length;
    return sorted.map((dayKey, index) => ({
      id: `task_${Math.random().toString(36).slice(2, 10)}`,
      title: title.trim(),
      assignees: [...assignees],
      column: dayKey,
      order: 0,
      created_at: new Date().toISOString(),
      end_date: endDate || "",
      template_id: "",
      fixed: false,
      span_id: spanId,
      span_index: index,
      span_total: total,
      week_start: weekStart,
      week_number: weekNumber,
    }));
  }

  async _createTaskFromForm() {
    const form = this._taskForm;
    if (!form.title.trim()) return;
    const effectiveFixed = form.fixed;

    if (effectiveFixed) {
      if (!form.endDate) {
        this._error = "Fixed tasks require an end date.";
        this._render();
        return;
      }
      if (!form.weekdays.length) {
        this._error = "Select at least one weekday for fixed tasks.";
        this._render();
        return;
      }

      const template = {
        id: `tpl_${Math.random().toString(36).slice(2, 10)}`,
        title: form.title.trim(),
        assignees: [...form.assignees],
        end_date: form.endDate,
        weekdays: [...form.weekdays],
        excluded_dates: [],
        created_at: new Date().toISOString(),
      };
      const instances = this._buildFixedInstancesForCurrentWeek(template, template.title, template.assignees);
      this._board.templates = [...this._board.templates, template];
      this._board.tasks = [...this._board.tasks, ...instances];
    } else if (form.allDaySpan) {
      const weekdays = this._sortedWeekdays(form.weekdays);
      if (weekdays.length < 2) {
        this._error = "All-day tasks require at least two selected days.";
        this._render();
        return;
      }
      if (!this._areContiguousWeekdays(weekdays)) {
        this._error = "All-day tasks must use consecutive days.";
        this._render();
        return;
      }
      const allDayInstances = this._buildAllDaySpanInstances(form.title, form.assignees, weekdays, form.endDate || "");
      this._board.tasks = [...this._board.tasks, ...allDayInstances];
    } else if (form.weekdays.length > 0) {
      const oneOffInstances = this._buildOneOffWeekdayInstances(form.title, form.assignees, form.weekdays, form.endDate || "");
      this._board.tasks = [...this._board.tasks, ...oneOffInstances];
    } else {
      this._board.tasks = [
        ...this._board.tasks,
        {
          id: `task_${Math.random().toString(36).slice(2, 10)}`,
          title: form.title.trim(),
          assignees: [...form.assignees],
          column: form.column,
          order: this._tasksForColumn(form.column).length,
          created_at: new Date().toISOString(),
        end_date: form.endDate || "",
        template_id: "",
        fixed: false,
        span_id: "",
        span_index: 0,
        span_total: 0,
        week_start: this._weekStartIso(this._weekOffset),
        week_number: this._weekNumberForOffset(this._weekOffset),
      },
      ];
    }

    this._reindexAllColumns();
    this._closeTaskModal();
    await this._saveBoard();
  }

  async _updateTaskFromForm() {
    const form = this._taskForm;
    const original = this._board.tasks.find((t) => t.id === form.taskId);
    const templateRef = form.templateId ? this._board.templates.find((tpl) => tpl.id === form.templateId) : null;
    if (!original && !templateRef) return;
    const effectiveFixed = form.fixed;
    const baseTemplateId = original?.template_id || templateRef?.id || "";
    const originalCreatedAt = original?.created_at || templateRef?.created_at || new Date().toISOString();
    const originalWeekNumber = original?.week_number || this._weekNumberForOffset(this._weekOffset);
    const existingExcludedDates = Array.isArray(templateRef?.excluded_dates) ? [...templateRef.excluded_dates] : [];
    const editSpanId = original?.span_id || form.spanId || "";
    const originalSpanWeekStart = original?.week_start || this._weekStartIso(this._weekOffset);

    if (effectiveFixed) {
      if (!form.endDate || !form.weekdays.length) {
        this._error = "Fixed task requires end date and weekdays.";
        this._render();
        return;
      }

      const templateId = baseTemplateId || `tpl_${Math.random().toString(36).slice(2, 10)}`;

      // Remove old instances for same template (or this single task if converting).
      if (baseTemplateId) {
        this._board.tasks = this._board.tasks.filter((t) => t.template_id !== baseTemplateId);
      } else if (original) {
        this._board.tasks = this._board.tasks.filter((t) => t.id !== original.id);
      }

      // Remove old template if present.
      if (baseTemplateId) {
        this._board.templates = this._board.templates.filter((tpl) => tpl.id !== baseTemplateId);
      }

      const template = {
        id: templateId,
        title: form.title.trim(),
        assignees: [...form.assignees],
        end_date: form.endDate,
        weekdays: [...form.weekdays],
        excluded_dates: existingExcludedDates,
        created_at: new Date().toISOString(),
      };
      const instances = this._buildFixedInstancesForCurrentWeek(template, template.title, template.assignees);
      this._board.templates = [...this._board.templates, template];
      this._board.tasks = [...this._board.tasks, ...instances];
    } else {
      // If converting from fixed -> single task, remove template + template instances first.
      if (baseTemplateId) {
        this._board.templates = this._board.templates.filter((tpl) => tpl.id !== baseTemplateId);
        this._board.tasks = this._board.tasks.filter((t) => t.template_id !== baseTemplateId);
      } else if (original) {
        if (editSpanId) {
          this._board.tasks = this._board.tasks.filter(
            (t) => !(t.span_id === editSpanId && String(t.week_start || "") === String(originalSpanWeekStart || ""))
          );
        } else {
          this._board.tasks = this._board.tasks.filter((t) => t.id !== original.id);
        }
      }

      if (form.allDaySpan) {
        const weekdays = this._sortedWeekdays(form.weekdays);
        if (weekdays.length < 2) {
          this._error = "All-day tasks require at least two selected days.";
          this._render();
          return;
        }
        if (!this._areContiguousWeekdays(weekdays)) {
          this._error = "All-day tasks must use consecutive days.";
          this._render();
          return;
        }
        const allDayInstances = this._buildAllDaySpanInstances(
          form.title,
          form.assignees,
          weekdays,
          form.endDate || "",
          this._weekStartIso(this._weekOffset),
          this._weekNumberForOffset(this._weekOffset),
          editSpanId || undefined
        );
        this._board.tasks.push(...allDayInstances);
      } else if (form.weekdays.length > 0) {
        const oneOffInstances = this._buildOneOffWeekdayInstances(form.title, form.assignees, form.weekdays, form.endDate || "");
        this._board.tasks.push(...oneOffInstances);
      } else {
        this._board.tasks.push({
          id: original?.id || `task_${Math.random().toString(36).slice(2, 10)}`,
          title: form.title.trim(),
          assignees: [...form.assignees],
          column: form.column,
          order: this._tasksForColumn(form.column).length,
          created_at: originalCreatedAt,
          end_date: form.endDate || "",
          template_id: "",
          fixed: false,
          span_id: "",
          span_index: 0,
          span_total: 0,
          week_start: this._weekStartIso(this._weekOffset),
          week_number: originalWeekNumber,
        });
      }
    }

    this._reindexAllColumns();
    this._closeTaskModal();
    await this._saveBoard();
  }

  async _onSubmitTaskForm(ev) {
    ev.preventDefault();
    if (!this._canSubmitTaskForm()) return;
    this._error = "";
    if (this._taskForm.mode === "edit") await this._updateTaskFromForm();
    else await this._createTaskFromForm();
  }

  async _onDeleteTask() {
    const snapshot = this._snapshotBoard();
    const form = this._taskForm;
    const task = this._board.tasks.find((t) => t.id === form.taskId);
    if (!task && !form.templateId) return;

    const templateId = task?.template_id || form.templateId || "";
    if (templateId) {
      if (form.deleteSeries) {
        this._board.templates = this._board.templates.filter((tpl) => tpl.id !== templateId);
        this._board.tasks = this._board.tasks.filter((t) => t.template_id !== templateId);
      } else {
        const occurrenceDate = form.occurrenceDate || this._taskOccurrenceDate(task);
        this._board.templates = this._board.templates.map((tpl) => {
          if (tpl.id !== templateId) return tpl;
          const excluded = new Set(Array.isArray(tpl.excluded_dates) ? tpl.excluded_dates : []);
          if (occurrenceDate) excluded.add(occurrenceDate);
          return { ...tpl, excluded_dates: [...excluded].sort() };
        });
        this._board.tasks = this._board.tasks.filter((t) => {
          if (t.template_id !== templateId) return true;
          if (!occurrenceDate) return false;
          return this._taskOccurrenceDate(t) !== occurrenceDate;
        });
      }
    } else {
      if (task.span_id) {
        const spanWeekStart = task.week_start || this._weekStartIso(this._weekOffset);
        this._board.tasks = this._board.tasks.filter(
          (t) => !(t.span_id === task.span_id && String(t.week_start || "") === String(spanWeekStart || ""))
        );
      } else {
        this._board.tasks = this._board.tasks.filter((t) => t.id !== task.id);
      }
    }

    this._reindexAllColumns();
    this._closeTaskModal();
    this._setUndo(task?.span_id ? "All-day task deleted" : "Task deleted", snapshot);
    await this._saveBoard();
  }

  _assigneeChips(task) {
    const draggable = !task.virtual;
    return task.assignees
      .map((personId) => this._board.people.find((p) => p.id === personId))
      .filter(Boolean)
      .map(
        (person) =>
          `<span class="assignee-chip-wrap">
            <span class="chip" draggable="${draggable ? "true" : "false"}" data-person-id="${person.id}" ${draggable ? `data-source-task-id="${task.id}"` : ""} style="background:${person.color}" title="${this._escape(person.name)}">${this._personInitial(person.name)}</span>
            <span class="role-badge ${person.role === "child" ? "child" : "adult"}" title="${this._personRoleTitle(person.role)}">${this._personRoleLabel(person.role)}</span>
          </span>`
      )
      .join("");
  }

  _removeAssigneeFromTask(taskId, personId) {
    const sourceTask = this._board.tasks.find((task) => task.id === taskId);
    if (!sourceTask) return;

    if (sourceTask.template_id) {
      const tpl = this._board.templates.find((item) => item.id === sourceTask.template_id);
      if (tpl) tpl.assignees = tpl.assignees.filter((id) => id !== personId);
      this._board.tasks.forEach((task) => {
        if (task.template_id === sourceTask.template_id) {
          task.assignees = task.assignees.filter((id) => id !== personId);
        }
      });
      return;
    }

    if (sourceTask.span_id) {
      const spanGroup = this._taskSpanGroup(sourceTask);
      spanGroup.forEach((task) => {
        task.assignees = task.assignees.filter((id) => id !== personId);
      });
      return;
    }
    sourceTask.assignees = sourceTask.assignees.filter((id) => id !== personId);
  }

  _assignAssigneeToTask(taskId, personId) {
    const targetTask = this._board.tasks.find((task) => task.id === taskId);
    if (!targetTask) return;

    if (targetTask.template_id) {
      const tpl = this._board.templates.find((item) => item.id === targetTask.template_id);
      if (tpl && !tpl.assignees.includes(personId)) tpl.assignees.push(personId);
      this._board.tasks.forEach((task) => {
        if (task.template_id === targetTask.template_id && !task.assignees.includes(personId)) {
          task.assignees.push(personId);
        }
      });
      return;
    }

    if (targetTask.span_id) {
      const spanGroup = this._taskSpanGroup(targetTask);
      spanGroup.forEach((task) => {
        if (!task.assignees.includes(personId)) task.assignees.push(personId);
      });
      return;
    }
    if (!targetTask.assignees.includes(personId)) targetTask.assignees.push(personId);
  }

  _taskMetaLine(task) {
    if (task.fixed || task.span_id) return "";
    const bits = [];
    if (task.end_date) bits.push(`until ${task.end_date}`);
    return bits.length ? `<div class="task-sub">${this._escape(bits.join(" • "))}</div>` : "";
  }

  _renderTaskCard(task) {
    const draggable = !task.virtual && !task.span_id;
    const isSpan = Boolean(task.span_id);
    const isSpanStart = isSpan && Number(task.span_index) === 0;
    const isSpanEnd = isSpan && Number(task.span_total) > 0 && Number(task.span_index) === Number(task.span_total) - 1;
    const showContent = !isSpan || isSpanStart;
    const spanClass = task.span_id
      ? ` span-task ${isSpanStart ? "span-start" : ""} ${isSpanEnd ? "span-end" : ""} ${!isSpanStart && !isSpanEnd ? "span-mid" : ""}`
      : "";
    const cardColors = isSpan ? null : this._taskCardColors(task);
    const cardStyle = isSpan
      ? ""
      : ` style="--task-bg:${cardColors.bg};--task-border:${cardColors.border};--task-text:${cardColors.text};--task-accent:${cardColors.accent};"`;
    return `
      <article class="task ${task.virtual ? "virtual-task" : ""} ${task.fixed ? "fixed-task" : ""}${spanClass}" draggable="${draggable ? "true" : "false"}" data-task-id="${task.id}" data-template-id="${task.template_id || ""}" data-column="${task.column || ""}" data-virtual="${task.virtual ? "1" : "0"}"${cardStyle}>
        <div class="task-head">
          <div class="task-title">${showContent ? this._escape(task.title) : "&nbsp;"}</div>
        </div>
        ${showContent ? this._taskMetaLine(task) : ""}
        ${showContent ? `<div class="task-meta">${this._assigneeChips(task)}</div>` : ""}
      </article>
    `;
  }

  _weekdayIndex(dayKey) {
    return this._weekdayKeys().findIndex((day) => day.key === dayKey);
  }

  _buildWeekSpanLayout() {
    const weekStart = this._weekStartIso(this._weekOffset);
    const candidates = this._tasksVisibleByFilter(this._board.tasks).filter(
      (task) =>
        Boolean(task.span_id) &&
        this._weekdayKeys().some((day) => day.key === task.column) &&
        String(task.week_start || "") === String(weekStart || "")
    );
    if (!candidates.length) return { bars: [], dayRows: {}, rowCount: 0 };

    const groups = new Map();
    for (const task of candidates) {
      const key = `${task.span_id}|${task.week_start}`;
      const list = groups.get(key) || [];
      list.push(task);
      groups.set(key, list);
    }

    const preliminaryBars = [...groups.values()]
      .map((items) => {
        const sorted = [...items].sort((a, b) => {
          const aIndex = this._weekdayIndex(a.column);
          const bIndex = this._weekdayIndex(b.column);
          if (aIndex !== bIndex) return aIndex - bIndex;
          return (a.order || 0) - (b.order || 0);
        });
        const dayIndexes = sorted.map((task) => this._weekdayIndex(task.column)).filter((idx) => idx >= 0);
        if (!dayIndexes.length) return null;
        const start = Math.min(...dayIndexes);
        const end = Math.max(...dayIndexes);
        const lead = sorted[0];
        return {
          taskId: lead.id,
          title: lead.title,
          assignees: lead.assignees || [],
          start,
          end,
        };
      })
      .filter(Boolean);

    if (!preliminaryBars.length) return { bars: [], dayRows: {}, rowCount: 0 };
    preliminaryBars.sort((a, b) => (a.start - b.start) || (a.end - b.end));

    const rowEndByIndex = [];
    const dayRows = {};
    const bars = preliminaryBars.map((bar) => {
      let row = rowEndByIndex.findIndex((end) => bar.start > end);
      if (row === -1) row = rowEndByIndex.length;
      rowEndByIndex[row] = bar.end;
      for (let idx = bar.start; idx <= bar.end; idx += 1) {
        const dayKey = this._weekdayKeys()[idx]?.key;
        if (!dayKey) continue;
        dayRows[dayKey] = Math.max(dayRows[dayKey] || 0, row + 1);
      }
      return {
        ...bar,
        row,
        columnStart: bar.start + 1,
        columnEnd: bar.end + 2,
      };
    });
    return { bars, dayRows, rowCount: rowEndByIndex.length };
  }

  _renderWeekSpanOverlay() {
    const layout = this._spanLayoutCache || { bars: [], rowCount: 0 };
    if (!layout.bars.length) return "";
    return `
      <div class="week-span-overlay" style="--span-rows:${layout.rowCount};">
          ${layout.bars
            .map(
              (bar) => {
                const colors = this._spanBarColors(bar.assignees);
                return `
                <article class="task week-span-bar span-task span-start span-end" draggable="false" data-task-id="${bar.taskId}" data-template-id="" data-column="" data-virtual="0" style="grid-column:${bar.columnStart} / ${bar.columnEnd};grid-row:${bar.row + 1};--span-bg:${colors.bg};--span-border:${colors.border};--span-text:${colors.text};">
                  <div class="task-head">
                    <div class="task-title">${this._escape(bar.title)}</div>
                  </div>
                  <div class="task-meta">
                    ${bar.assignees
                      .map((personId) => this._board.people.find((person) => person.id === personId))
                      .filter(Boolean)
                      .map(
                        (person) => `<span class="assignee-chip-wrap">
                          <span class="chip" style="background:${person.color}">${this._personInitial(person.name)}</span>
                          <span class="role-badge ${person.role === "child" ? "child" : "adult"}">${this._personRoleLabel(person.role)}</span>
                        </span>`
                      )
                      .join("")}
                  </div>
                </article>
              `;
              }
            )
            .join("")}
      </div>
    `;
  }

  _renderColumn(column) {
    let tasks = this._tasksVisibleByFilter(this._tasksForColumn(column.key));
    if (column.key !== "done") tasks = tasks.filter((task) => !task.span_id);
    const isSideLane = column.key === "done";
    const isWeekday = this._weekdayKeys().some((day) => day.key === column.key);
    const isTodayColumn = isWeekday && this._weekOffset === 0 && column.key === this._todayWeekdayKey();
    const weekdayDate = isWeekday ? this._formatWeekdayDateCompact(column.key) : "";
    const daySpanRows = isWeekday ? (this._spanLayoutCache?.dayRows?.[column.key] || 0) : 0;
    const daySpanPad = daySpanRows > 0 ? `<div class="span-day-pad" style="height:${daySpanRows * 56 + 6}px"></div>` : "";
    const emptyTitle = isWeekday ? "Tap to add" : "Drop completed";
    const emptySub = isWeekday ? "Drop here or swipe tasks" : "Tap to add or drop task";
    const emptyContent = `
      <div class="empty-wrap ${isSideLane ? "side-empty" : "week-empty"}">
        <div class="empty"><div class="empty-title">${emptyTitle}</div><div class="empty-sub">${emptySub}</div></div>
      </div>
    `;
    return `
      <section class="column ${isSideLane ? "side-lane" : "week-lane"} ${isTodayColumn ? "today-col" : ""}" data-column="${column.key}">
        <header class="column-head">
          <div class="column-title-row">
            <h3>${this._escape(this._labelForColumn(column.key))}</h3>
            <span class="column-meta">${isTodayColumn ? '<span class="today-pill">Today</span>' : ""}<span class="col-count">${tasks.length}</span></span>
          </div>
          ${weekdayDate ? `<div class="col-date">${this._escape(weekdayDate)}</div>` : ""}
        </header>
        <div class="tasks">
          ${daySpanPad}
          ${tasks.length ? tasks.map((task) => this._renderTaskCard(task)).join("") : emptyContent}
        </div>
      </section>
    `;
  }

  _renderPeopleLegend() {
    if (!this._board.people.length) return `<div class="empty-mini">No people yet</div>`;
    return `
      <div class="legend-list">
        ${this._board.people
          .map(
            (person) =>
              `<div class="legend-item">
                <div class="legend-top">
                  <span class="chip-wrap">
                    <span class="chip" draggable="true" data-person-id="${person.id}" style="background:${person.color}">${this._personInitial(person.name)}</span>
                    <span class="role-badge ${person.role === "child" ? "child" : "adult"}">${this._personRoleLabel(person.role)}</span>
                  </span>
                  <span class="legend-name">${this._escape(person.name)}</span>
                </div>
                <div class="legend-controls">
                  <select class="person-role-select" data-person-role-id="${person.id}">
                    <option value="adult" ${person.role !== "child" ? "selected" : ""}>Adult</option>
                    <option value="child" ${person.role === "child" ? "selected" : ""}>Child</option>
                  </select>
                  <input class="person-color-input" data-person-color-id="${person.id}" data-focus-key="person-color-${person.id}" type="color" value="${this._normalizeHexColor(person.color, this._suggestPersonColor())}" title="Choose color" />
                  <button type="button" class="person-delete" data-delete-person-id="${person.id}" title="Delete person">Delete</button>
                </div>
              </div>`
          )
          .join("")}
      </div>
    `;
  }

  _renderAssigneeFilter() {
    const selectedPersonId = this._personFilter.startsWith("person:") ? this._personFilter.slice("person:".length) : this._personFilterSelection;
    return `
      <div class="assignee-filter">
        <label>Focus</label>
        <div class="focus-segments" role="tablist" aria-label="Task focus">
          <button type="button" class="focus-segment ${this._personFilter === "all" ? "active" : ""}" data-focus-filter="all">All</button>
          <button type="button" class="focus-segment ${this._personFilter === "adults" ? "active" : ""}" data-focus-filter="adults">Adults</button>
          <button type="button" class="focus-segment ${this._personFilter === "children" ? "active" : ""}" data-focus-filter="children">Children</button>
          <button type="button" class="focus-segment ${this._personFilter.startsWith("person:") ? "active" : ""}" data-focus-filter="person">Person</button>
        </div>
        <select id="person-focus-select" ${this._personFilter.startsWith("person:") ? "" : "hidden"}>
          <option value="">Select person</option>
          ${this._board.people.map((person) => `<option value="${this._escape(String(person.id))}" ${selectedPersonId === String(person.id) ? "selected" : ""}>${this._escape(person.name)}</option>`).join("")}
        </select>
      </div>
    `;
  }

  _renderActiveFilterChip() {
    if (this._personFilter === "all") return "";
    if (this._personFilter === "adults") {
      return `<button class="filter-chip" type="button" id="clear-filter" title="Clear filter"><span>Adults</span><span class="clear-mark">x</span></button>`;
    }
    if (this._personFilter === "children") {
      return `<button class="filter-chip" type="button" id="clear-filter" title="Clear filter"><span>Children</span><span class="clear-mark">x</span></button>`;
    }
    const personId = this._personFilter.startsWith("person:") ? this._personFilter.slice("person:".length) : "";
    const person = this._board.people.find((p) => String(p.id) === personId);
    if (!person) return `<button class="filter-chip" type="button" id="clear-filter" title="Clear filter"><span>Person</span><span class="clear-mark">x</span></button>`;
    return `
      <button class="filter-chip" type="button" id="clear-filter" title="Clear filter">
        <span class="chip" style="background:${person.color}">${this._personInitial(person.name)}</span>
        <span>${this._escape(person.name)}</span>
        <span class="clear-mark">x</span>
      </button>
    `;
  }

  _renderUpcomingStrip() {
    const nextOffset = this._weekOffset + 1;
    if (nextOffset > this._maxWeekOffset) return "";
    const candidateDays = ["monday", "tuesday"];
    let firstItem = null;
    for (const dayKey of candidateDays) {
      const dayTasks = this._tasksVisibleByFilter(this._tasksForColumn(dayKey, nextOffset))
        .filter((task) => task.column !== "done")
        .filter((task) => !task.span_id || Number(task.span_index || 0) === 0)
        .sort((a, b) => (Number(a.order || 0) - Number(b.order || 0)) || String(a.title || "").localeCompare(String(b.title || "")));
      if (dayTasks.length) {
        firstItem = { dayKey, task: dayTasks[0] };
        break;
      }
    }
    if (!firstItem) return "";
    return `
      <div class="upcoming-strip" role="note">
        <span class="upcoming-label">Upcoming</span>
        ${
          (() => {
            const item = firstItem;
            const people = (item.task.assignees || [])
              .map((personId) => this._board.people.find((person) => person.id === personId))
              .filter(Boolean);
            const maxDots = 4;
            const dots = people
              .slice(0, maxDots)
              .map((person) => `<span class="upcoming-dot" style="background:${person.color}" title="${this._escape(person.name)}"></span>`)
              .join("");
            const remaining = Math.max(0, people.length - maxDots);
            return `<span class="upcoming-pill"><strong>${this._escape(this._labelForColumn(item.dayKey))}</strong><span class="upcoming-title">${this._escape(item.task.title)}</span>${dots ? `<span class="upcoming-dots">${dots}${remaining ? `<span class="upcoming-more">+${remaining}</span>` : ""}</span>` : ""}</span>`;
          })()
        }
      </div>
    `;
  }

  _renderQuickTemplatesBar() {
    const templates = Array.isArray(this._board?.settings?.quick_templates) ? this._board.settings.quick_templates : [];
    if (!templates.length) return "";
    return `
      <div class="quick-templates" aria-label="Quick templates">
        <span class="quick-label">Quick add</span>
        ${templates.map((name) => `<button type="button" class="quick-template-btn" data-quick-template="${this._escape(name)}">${this._escape(name)}</button>`).join("")}
      </div>
    `;
  }

  _renderOnboardingBanner() {
    if (this._board?.settings?.onboarding_dismissed) return "";
    const gestures = this._board?.settings?.gestures || {};
    const deleteHint = gestures.swipe_delete ? "Swipe left to delete." : "Swipe left delete is off (can be enabled in Settings).";
    return `
      <div class="onboarding-tip" role="note">
        <span>Tip: tap empty day space to add tasks, swipe right to complete. ${this._escape(deleteHint)}</span>
        <button type="button" id="dismiss-onboarding" title="Dismiss tips">x</button>
      </div>
    `;
  }

  _renderWeekdaySelector(selected) {
    return `
      <div class="weekday-picks">
        ${this._weekdayKeys()
          .map((day) => `<button type="button" class="weekday-dot ${selected.includes(day.key) ? "sel" : ""}" data-weekday="${day.key}">${day.short}</button>`)
          .join("")}
      </div>
    `;
  }

  _renderTaskModal() {
    if (!this._showTaskModal) return "";
    const form = this._taskForm;
    const showWeekdayMode = form.fixed || form.allDaySpan || form.weekdays.length > 0;
    return `
      <div class="modal-backdrop" id="task-backdrop">
        <div class="modal">
          <div class="modal-head">
            <h3>${form.mode === "edit" ? "Edit task" : "Add task"}</h3>
            <button type="button" class="close-btn" id="close-task">X</button>
          </div>
          <form class="task-form" id="task-form">
            <input id="task-title" type="text" placeholder="Task title" value="${this._escape(form.title)}" />
            <div class="toggle-row">
              <label class="settings-switch"><input id="task-fixed" type="checkbox" ${form.fixed ? "checked" : ""} /><span>Fixed until date</span></label>
              ${form.fixed ? "" : `<label class="settings-switch"><input id="task-all-day-span" type="checkbox" ${form.allDaySpan ? "checked" : ""} /><span>All-day across selected days</span></label>`}
              <input id="task-end-date" type="date" value="${this._escape(form.endDate)}" />
            </div>
            ${this._renderWeekdaySelector(form.weekdays)}
            ${showWeekdayMode ? "" : `<select id="task-column">${this._columns().map((c) => `<option value="${c.key}" ${form.column === c.key ? "selected" : ""}>${this._escape(this._labelForColumn(c.key))}</option>`).join("")}</select>`}
            <div class="assignees">
              ${this._board.people
                .map(
                  (person) => `<label><input type="checkbox" name="assignee" value="${person.id}" ${form.assignees.includes(person.id) ? "checked" : ""} /><span class="chip" style="background:${person.color}">${this._personInitial(person.name)}</span></label>`
                )
                .join("")}
            </div>
            <div class="small">Without fixed: selected weekdays create one-off tasks for this week. Enable All-day for a continuous multi-day block (e.g. course/travel).</div>
            ${form.mode === "edit" && form.templateId ? `<label class="delete-series"><input id="task-delete-series" type="checkbox" ${form.deleteSeries ? "checked" : ""} /> Delete entire fixed series</label><div class="small">Unchecked = delete only this week occurrence.</div>` : ""}
            ${form.mode === "add" ? `<div class="settings-inline"><button type="button" id="save-task-as-template" ${form.title.trim() ? "" : "disabled"}>Save title as quick template</button></div>` : ""}
            <div class="modal-actions">
              ${form.mode === "edit" ? '<button type="button" class="danger" id="delete-task">Delete</button>' : ""}
              <button id="task-submit" type="submit" ${this._canSubmitTaskForm() ? "" : "disabled"}>${this._saving ? "Saving..." : form.mode === "edit" ? "Save" : "Create"}</button>
            </div>
          </form>
        </div>
      </div>
    `;
  }

  _renderPeopleModal() {
    if (!this._showPeopleModal) return "";
    return `
      <div class="modal-backdrop" id="people-backdrop">
        <div class="modal">
          <div class="modal-head">
            <h3>People</h3>
            <button type="button" class="close-btn" id="close-people">X</button>
          </div>
          <form class="row" id="person-form">
            <input id="person-name" type="text" placeholder="Add person" value="${this._escape(this._newPersonName)}" />
            <select id="person-role">
              <option value="adult" ${this._newPersonRole !== "child" ? "selected" : ""}>Adult</option>
              <option value="child" ${this._newPersonRole === "child" ? "selected" : ""}>Child</option>
            </select>
            <input id="person-color" data-focus-key="person-color-new" type="color" value="${this._normalizeHexColor(this._newPersonColor, this._suggestPersonColor())}" title="Choose color" />
            <button id="person-submit" type="submit" ${this._canSubmitPersonForm() ? "" : "disabled"}>Add</button>
          </form>
          <div class="small">Tip: drag a person badge onto any task to assign.</div>
          <div style="margin-top:8px;">${this._renderPeopleLegend()}</div>
        </div>
      </div>
    `;
  }

  _renderSettingsModal() {
    if (!this._showSettingsModal) return "";
    const form = this._settingsForm || this._defaultSettings();
    return `
      <div class="modal-backdrop" id="settings-backdrop">
        <div class="modal settings-modal">
          <div class="modal-head">
            <h3>Board Settings</h3>
            <button type="button" class="close-btn" id="close-settings">X</button>
          </div>
          <form class="task-form settings-form" id="settings-form">
            <section class="settings-section settings-grid two-col">
              <label class="settings-field">
                <span>Board title</span>
                <input id="settings-title" data-focus-key="settings-title" type="text" placeholder="Board title" value="${this._escape(form.title || "")}" />
              </label>
              <label class="settings-field">
                <span>Theme</span>
                <select id="settings-theme">
                  <option value="light" ${form.theme === "light" ? "selected" : ""}>Light</option>
                  <option value="dark" ${form.theme === "dark" ? "selected" : ""}>Dark</option>
                  <option value="colorful" ${form.theme === "colorful" ? "selected" : ""}>Colorful</option>
                </select>
              </label>
              <label class="settings-switch">
                <input id="settings-compact-mode" type="checkbox" ${form.compact_mode ? "checked" : ""} />
                <span>Compact mode</span>
              </label>
            </section>

            <section class="settings-section">
              <h4>Labels</h4>
              <div class="settings-grid labels-grid compact">
                ${this._columns().map((col) => `<label class="settings-field"><span>${this._escape(col.label)}</span><input data-label-key="${col.key}" data-focus-key="label-${col.key}" type="text" value="${this._escape(form.labels?.[col.key] || this._labelForColumn(col.key))}" /></label>`).join("")}
              </div>
            </section>

            <section class="settings-section">
              <h4>Quick Templates</h4>
              <div class="settings-inline">
                <input id="settings-quick-template-input" data-focus-key="settings-quick-template-input" type="text" placeholder="Template name" value="${this._escape(this._newQuickTemplateName)}" />
                <button type="button" id="settings-add-quick-template" ${this._canAddQuickTemplate() ? "" : "disabled"}>Add</button>
              </div>
              <div class="quick-template-list">
                ${(Array.isArray(form.quick_templates) ? form.quick_templates : []).map((item, index) => `
                  <span class="quick-template-pill">
                    <span>${this._escape(item)}</span>
                    <button type="button" data-remove-quick-template="${index}" title="Remove template">x</button>
                  </span>
                `).join("") || '<span class="small">No quick templates yet.</span>'}
              </div>
            </section>

            <section class="settings-section settings-grid two-col">
              <label class="settings-switch">
                <input id="settings-swipe-complete" type="checkbox" ${form.gestures?.swipe_complete !== false ? "checked" : ""} />
                <span>Swipe right to Completed</span>
              </label>
              <label class="settings-switch">
                <input id="settings-swipe-delete" type="checkbox" ${form.gestures?.swipe_delete ? "checked" : ""} />
                <span>Swipe left to Delete</span>
              </label>
              <label class="settings-switch">
                <input id="settings-show-next-up" type="checkbox" ${form.show_next_up ? "checked" : ""} />
                <span>Show Next up badges</span>
              </label>
              <label class="settings-switch">
                <input id="settings-show-onboarding" type="checkbox" ${form.onboarding_dismissed ? "" : "checked"} />
                <span>Show onboarding tips</span>
              </label>
            </section>

            <section class="settings-section">
              <h4>Weekly Reset</h4>
              <div class="settings-inline">
                <select id="settings-weekday">
                <option value="0" ${String(form.weekly_refresh?.weekday) === "0" ? "selected" : ""}>Mon</option>
                <option value="1" ${String(form.weekly_refresh?.weekday) === "1" ? "selected" : ""}>Tue</option>
                <option value="2" ${String(form.weekly_refresh?.weekday) === "2" ? "selected" : ""}>Wed</option>
                <option value="3" ${String(form.weekly_refresh?.weekday) === "3" ? "selected" : ""}>Thu</option>
                <option value="4" ${String(form.weekly_refresh?.weekday) === "4" ? "selected" : ""}>Fri</option>
                <option value="5" ${String(form.weekly_refresh?.weekday) === "5" ? "selected" : ""}>Sat</option>
                <option value="6" ${String(form.weekly_refresh?.weekday) === "6" ? "selected" : ""}>Sun</option>
                </select>
                <input id="settings-refresh-hour" data-focus-key="settings-refresh-hour" type="number" min="0" max="23" value="${this._escape(form.weekly_refresh?.hour ?? 0)}" />
                <span>:</span>
                <input id="settings-refresh-minute" data-focus-key="settings-refresh-minute" type="number" min="0" max="59" value="${this._escape(form.weekly_refresh?.minute ?? 30)}" />
              </div>
            </section>

            <section class="settings-section">
              <h4>Automation Schedule</h4>
              <div class="schedule-list">
                <div class="schedule-row">
                  <span class="schedule-label">Weekly reset</span>
                  <span class="schedule-value">${this._escape(this._weekdayNameFromIndex(form.weekly_refresh?.weekday))} ${this._escape(this._formatClock(form.weekly_refresh?.hour, form.weekly_refresh?.minute))}</span>
                </div>
                <div class="schedule-row">
                  <span class="schedule-label">Completed cleanup</span>
                  <span class="schedule-value">Weekly with board reset</span>
                </div>
              </div>
            </section>

            <details class="settings-advanced">
              <summary>Advanced data tools</summary>
              <section class="settings-section">
                <label class="settings-field">
                  <span>Export JSON</span>
                  <textarea id="settings-export-json" readonly rows="6">${this._escape(this._dataExportText || JSON.stringify(this._board, null, 2))}</textarea>
                </label>
                <div class="settings-inline">
                  <button type="button" id="copy-export-json">Copy export</button>
                </div>
                <label class="settings-field">
                  <span>Import JSON</span>
                  <textarea id="settings-import-json" rows="6" placeholder="Paste board JSON here">${this._escape(this._dataImportText || "")}</textarea>
                </label>
                ${this._dataImportError ? `<div class="error">${this._escape(this._dataImportError)}</div>` : ""}
                <div class="settings-inline">
                  <button type="button" id="import-board-json" ${this._canImportBoard() ? "" : "disabled"}>Import board</button>
                </div>
              </section>
            </details>
            <div class="modal-actions">
              <button type="submit" id="settings-submit">Save settings</button>
            </div>
          </form>
        </div>
      </div>
    `;
  }

  _render() {
    if (!this.shadowRoot || !this._config) return;
    const focusState = this._captureFocusState();
    const loadingHtml = this._loading ? `<div class="loading">Loading board...</div>` : "";
    const errorHtml = this._error ? `<div class="error">${this._escape(this._error)}</div>` : "";
    const undoHtml = this._undoState ? `<div class="undo-bar"><span>${this._escape(this._undoState.label)}</span><button id="undo-action-btn" type="button">Undo</button></div>` : "";
    const upcomingHtml = this._renderUpcomingStrip();
    const nextUpEnabled = Boolean(this._board?.settings?.show_next_up);
    const nextUpHtml = nextUpEnabled ? this._renderNextUpStrip() : "";
    const theme = this._themeVars();
    const compactMode = Boolean(this._board?.settings?.compact_mode);
    const weekLaneHeight = compactMode ? 320 : 360;
    const weekTaskAreaHeight = compactMode ? 260 : 300;
    const sideLaneHeight = compactMode ? 128 : 156;
    this._spanLayoutCache = this._buildWeekSpanLayout();

    const viewMode = String(this._config?.view || "board");

    this.shadowRoot.innerHTML = `
      <style>
        :host{--hc-bg:${theme.bg};--hc-text:${theme.text};--hc-muted:${theme.muted};--hc-border:${theme.border};--hc-card:${theme.card};--hc-accent:${theme.accent};display:block}
        ha-card{background:var(--hc-bg);color:var(--hc-text);border-radius:18px;border:1px solid var(--hc-border);overflow:hidden}
        .wrap{display:grid;gap:8px;padding:8px 12px 12px}
        .board-title{margin:0;padding:0;font-size:1.55rem;line-height:1.1;font-weight:600;letter-spacing:-.01em;color:var(--hc-text)}
        .panel{background:var(--hc-card);border:1px solid var(--hc-border);border-radius:14px;padding:10px}
        .top-row{display:grid;grid-template-columns:1fr auto;align-items:center;gap:8px}
        .top-row.has-upcoming{grid-template-columns:auto minmax(240px,1fr) auto}
        .assignee-filter{display:flex;align-items:center;gap:6px}
        .assignee-filter label{font-size:.74rem;color:#64748b;font-weight:600}
        .assignee-filter select{padding:6px 8px;min-width:120px;height:34px}
        .focus-segments{display:inline-flex;align-items:center;gap:4px;background:#f1f5f9;border:1px solid #dbe3ef;border-radius:999px;padding:3px}
        .focus-segment{height:28px;padding:0 10px;border:0;background:transparent;border-radius:999px;font-size:.74rem;color:#475569;cursor:pointer}
        .focus-segment.active{background:#2563eb;color:#fff;font-weight:700}
        .filter-chip{display:inline-flex;align-items:center;gap:6px;height:34px;padding:0 10px 0 6px;border-radius:999px;background:#eff6ff;border:1px solid #bfdbfe;color:#1e3a8a;font-size:.76rem;font-weight:600}
        .filter-chip .chip{width:18px;height:18px;font-size:.62rem}
        .filter-chip .clear-mark{font-weight:700;color:#334155}
        .undo-bar{display:flex;align-items:center;justify-content:space-between;gap:8px;background:#eff6ff;border:1px solid #bfdbfe;color:#1e3a8a;padding:8px 10px;border-radius:9px;font-size:.82rem}
        #undo-action-btn{background:#dbeafe;border-color:#93c5fd;color:#1e40af;padding:6px 10px;font-weight:700}
        .week-nav{display:flex;align-items:center;gap:10px}
        .week-nav-btn{border:1px solid #c6d3e8;background:#fff;color:#0f172a;border-radius:10px;padding:6px 10px;font-weight:700;cursor:pointer;height:34px}
        .week-label{font-weight:700;font-size:.9rem}
        .week-sub{font-size:.74rem;color:var(--hc-muted)}
        .swipe-hint{font-size:.72rem;color:var(--hc-muted)}
        .header-actions{display:flex;align-items:center;gap:8px}
        #open-settings{width:34px;padding:0;display:inline-flex;align-items:center;justify-content:center}
        .people-strip{margin-top:10px;display:flex;gap:6px;flex-wrap:wrap;align-items:center;border:1px dashed #cbd5e1;border-radius:10px;padding:6px 8px;cursor:pointer;background:#f8fafc;min-height:38px}
        .people-strip:focus-visible{outline:2px solid #2563eb;outline-offset:2px}
        .people-strip-label{font-size:.76rem;font-weight:700;color:#334155;margin-right:2px}
        .people-strip-empty{font-size:.78rem;color:#64748b}
        .upcoming-strip{display:flex;align-items:center;gap:6px;flex-wrap:wrap;background:#f8fafc;border:1px dashed #cbd5e1;border-radius:10px;padding:6px 10px;min-height:34px;height:34px;overflow:hidden}
        .upcoming-label{font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.03em;color:#64748b}
        .upcoming-pill{display:inline-flex;align-items:center;gap:6px;background:#fff;border:1px solid #dbe3ef;border-radius:999px;padding:3px 8px;font-size:.75rem;color:#334155;max-height:26px}
        .upcoming-pill strong{font-size:.72rem;color:#475569}
        .upcoming-title{max-width:140px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .upcoming-dots{display:inline-flex;align-items:center;gap:3px;margin-left:2px}
        .upcoming-dot{width:8px;height:8px;border-radius:999px;display:inline-block;box-shadow:inset 0 -1px 0 rgba(0,0,0,.15)}
        .upcoming-more{font-size:.68rem;color:#64748b;font-weight:700}
        .nextup-strip{margin-top:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;background:#f8fafc;border:1px dashed #cbd5e1;border-radius:12px;padding:8px 10px}
        .nextup-label{font-size:.72rem;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:#64748b}
        .nextup-pill{display:inline-flex;align-items:center;gap:8px;background:#fff;border:1px solid #dbe3ef;border-radius:999px;padding:6px 10px;font-size:.78rem;color:#0f172a;cursor:pointer;max-width:100%}
        .nextup-pill:active{transform:translateY(1px)}
        .nextup-date{font-size:.72rem;font-weight:800;color:#475569;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:999px;padding:2px 6px}
        .nextup-title{max-width:240px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:700}
        .nextup-dots{display:inline-flex;align-items:center;gap:3px;margin-left:2px}
        .nextup-dot{width:8px;height:8px;border-radius:999px;display:inline-block;box-shadow:inset 0 -1px 0 rgba(0,0,0,.15)}
        .nextup-more{font-size:.68rem;color:#64748b;font-weight:800}
        .quick-templates{margin-top:8px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
        .quick-label{font-size:.72rem;color:#64748b;font-weight:700;text-transform:uppercase;letter-spacing:.03em}
        .quick-template-btn{height:28px;padding:0 10px;border-radius:999px;border:1px solid #cbd5e1;background:#fff;color:#334155;font-size:.74rem}
        .onboarding-tip{margin-top:8px;display:flex;align-items:center;justify-content:space-between;gap:8px;background:#eff6ff;border:1px solid #bfdbfe;color:#1e3a8a;border-radius:10px;padding:7px 9px;font-size:.76rem}
        .onboarding-tip button{height:24px;min-width:24px;padding:0;border-radius:999px;border:1px solid #93c5fd;background:#dbeafe;color:#1e40af}
        button:disabled{background:#e2e8f0 !important;color:#64748b !important;border-color:#cbd5e1 !important;cursor:not-allowed;opacity:1}
        #person-submit,#task-submit{background:#2563eb;color:#fff;border-color:#1d4ed8;font-weight:700}
        #person-submit:not(:disabled):hover,#task-submit:not(:disabled):hover{background:#1d4ed8}
        .person-pill{display:flex;align-items:center;gap:6px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:999px;padding:3px 8px 3px 4px;font-size:.78rem;color:#334155}
        .chip-wrap{position:relative;display:inline-flex;align-items:center;justify-content:center}
        .person-delete{margin-left:auto;background:#fee2e2;color:#991b1b;border:1px solid #fecaca;border-radius:8px;padding:4px 8px;font-size:.72rem;cursor:pointer}
        .chip{width:22px;height:22px;border-radius:999px;color:#fff;font-weight:700;font-size:.75rem;display:inline-flex;align-items:center;justify-content:center;box-shadow:inset 0 -1px 0 rgba(0,0,0,.2)}
        .assignee-chip-wrap{position:relative;display:inline-flex;align-items:center;justify-content:center;margin-right:4px}
        .role-badge{position:absolute;right:-5px;bottom:-5px;width:12px;height:12px;border-radius:999px;border:1px solid #fff;display:inline-flex;align-items:center;justify-content:center;font-size:8px;font-weight:800;line-height:1}
        .role-badge.adult{background:#1d4ed8;color:#fff}
        .role-badge.child{background:#f59e0b;color:#111827}
        .small{font-size:.8rem;color:var(--hc-muted);margin-top:6px}
        .columns-wrap{display:grid;gap:10px}
        .week-grid-wrap{position:relative;--week-head-offset:58px}
        .week-span-overlay{
          position:absolute;
          top:var(--week-head-offset);
          left:0;
          right:0;
          display:grid;
          grid-template-columns:repeat(7,minmax(0,1fr));
          gap:8px;
          align-items:start;
          pointer-events:none;
          z-index:2;
          grid-auto-rows:42px;
          grid-auto-rows:56px;
          min-height:calc(var(--span-rows, 0) * 56px);
        }
        .week-span-bar{pointer-events:auto;margin-inline:8px}
        .week-scroll{overflow-x:hidden}
        .week-columns{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:8px;min-width:0}
        .side-columns{display:grid;grid-template-columns:1fr;gap:8px}
        .column{background:var(--hc-card);border:1px solid var(--hc-border);border-radius:12px;padding:8px;display:grid;grid-template-rows:auto 1fr;min-height:220px}
        .week-columns .column.week-lane{min-height:${weekLaneHeight}px;max-height:${weekLaneHeight}px}
        .week-columns .column.week-lane .tasks{max-height:${weekTaskAreaHeight}px;overflow-y:auto;overflow-x:hidden;padding-right:2px}
        .side-columns .column.side-lane{min-height:${sideLaneHeight}px;max-height:${sideLaneHeight}px}
        .side-columns .column.side-lane .tasks{display:flex;flex-direction:row;align-items:flex-start;overflow-x:auto;overflow-y:hidden;gap:6px;padding-bottom:3px}
        .side-columns .column.side-lane .task{min-width:180px;flex:0 0 180px}
        .column.drag-over{border-color:#2563eb;box-shadow:inset 0 0 0 1px #2563eb;background:#f0f7ff}
        .column.today-col{border-color:#93c5fd;background:linear-gradient(180deg,#eef6ff 0%, var(--hc-card) 16%)}
        .column-head{margin-bottom:8px}
        .column-title-row{display:flex;align-items:center;justify-content:space-between;gap:6px}
        .column h3{margin:0;font-size:.82rem;font-weight:700}
        .column-meta{display:inline-flex;align-items:center;gap:6px}
        .today-pill{font-size:.64rem;font-weight:700;text-transform:uppercase;letter-spacing:.03em;padding:2px 6px;border-radius:999px;background:#2563eb;color:#fff}
        .col-count{font-size:.76rem;color:#64748b;font-weight:600}
        .col-date{font-size:.68rem;color:#94a3b8;margin-top:2px}
        .tasks{display:grid;gap:6px;align-content:start}
        .task{background:var(--task-bg,#f8fafc);border:1px solid var(--task-border,#e2e8f0);color:var(--task-text,#0f172a);border-radius:10px;padding:7px;cursor:grab;user-select:none}
        .task.virtual-task{cursor:default;opacity:.96}
        .task.fixed-task{background:var(--task-bg,#ecf3ff);border-color:var(--task-border,#b7cdf3);box-shadow:inset 3px 0 0 var(--task-accent,#3b82f6)}
        .task.span-task{
          background:var(--span-bg, #e8f7ef);
          border-color:var(--span-border, #b9e7ce);
          color:var(--span-text, #0f172a);
          box-shadow:none;
          cursor:pointer;
          padding:7px 8px;
          min-height:50px;
          gap:4px;
          touch-action:pan-y;
        }
        .task.span-task .task-head{min-height:18px;align-items:flex-start}
        .task.span-task .task-title{
          font-size:.76rem;
          font-weight:600;
          line-height:1.2;
          -webkit-line-clamp:1;
          white-space:nowrap;
          text-overflow:ellipsis;
          overflow:hidden;
        }
        .task.span-task .task-meta{margin-top:4px}
        .task.span-task.span-start{border-radius:10px 6px 6px 10px}
        .task.span-task.span-mid{border-radius:6px}
        .task.span-task.span-end{border-radius:6px 10px 10px 6px}
        .task.swipe-complete-preview{background:#dcfce7;border-color:#86efac;box-shadow:inset 3px 0 0 #16a34a}
        .task.swipe-delete-preview{background:#fee2e2;border-color:#fca5a5;box-shadow:inset 3px 0 0 #dc2626}
        .task-head{display:flex;align-items:flex-start;justify-content:space-between;gap:6px}
        .task-title{
          font-size:.78rem;
          font-weight:600;
          line-height:1.34;
          max-width:100%;
          overflow:hidden;
          overflow-wrap:anywhere;
          word-break:break-word;
          display:-webkit-box;
          -webkit-line-clamp:2;
          -webkit-box-orient:vertical;
        }
        .task-sub{margin-top:4px;color:#64748b;font-size:.73rem}
        .task-meta{margin-top:6px;display:flex;gap:4px;flex-wrap:wrap}
        .task .chip{width:19px;height:19px;font-size:.66rem}
        .span-day-pad{width:100%}
        .empty-wrap{display:grid;gap:6px;align-content:start}
        .week-empty{grid-template-columns:1fr}
        .side-empty{grid-template-columns:1fr}
        .empty{border:1px dashed #cbd5e1;border-radius:9px;padding:10px 8px;color:#94a3b8;text-align:center;font-size:.77rem}
        .empty-title{font-size:.75rem;color:#64748b;font-weight:700}
        .empty-sub{font-size:.67rem;color:#94a3b8;margin-top:2px}
        .empty-mini{color:#94a3b8;font-size:.8rem}
        .loading{color:var(--hc-muted);font-size:.85rem}
        .error{color:#b91c1c;font-size:.85rem;background:#fee2e2;border:1px solid #fecaca;padding:8px;border-radius:8px}
        input,select,button{font:inherit;border-radius:10px;border:1px solid var(--hc-border);padding:8px 10px}
        input,select{background:#fff;color:var(--hc-text)}
        .modal-backdrop{position:fixed;inset:0;background:rgba(15,23,42,.45);display:flex;align-items:center;justify-content:center;z-index:999;padding:14px}
        .modal{width:min(540px,100%);max-height:88vh;overflow:auto;background:#fff;border-radius:14px;border:1px solid var(--hc-border);padding:12px;box-shadow:0 18px 50px rgba(2,6,23,.28)}
        .settings-modal{width:min(760px,100%);padding:14px}
        .modal-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
        .modal-head h3{margin:0;font-size:1rem}
        .close-btn{background:#e2e8f0;color:#0f172a;border:1px solid #cbd5e1;min-width:36px;padding:6px 10px}
        .row{display:flex;gap:6px;align-items:center}
        .legend-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
        .legend-item{display:grid;gap:8px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:8px}
        .legend-top{display:flex;align-items:center;gap:8px;min-width:0}
        .legend-name{font-size:.82rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .legend-controls{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:6px;align-items:center}
        .person-role-select{min-width:88px;padding:6px 8px;font-size:.74rem}
        .person-color-input{width:40px;height:32px;padding:2px}
        .task-form{margin-top:10px;display:grid;gap:8px}
        .toggle-row{display:grid;grid-template-columns:1fr 1fr auto;align-items:center;gap:8px}
        .toggle-row .settings-switch{justify-self:start}
        .weekday-picks{display:flex;gap:6px;flex-wrap:wrap}
        .weekday-dot{width:28px;height:28px;border-radius:999px;border:1px solid #cbd5e1;background:#fff;color:#334155;padding:0;font-size:.76rem;font-weight:700}
        .weekday-dot.sel{background:#0f766e;border-color:#0f766e;color:#fff}
        .assignees{display:flex;flex-wrap:wrap;gap:8px}
        .assignees label{display:flex;align-items:center;gap:5px;font-size:.78rem}
        .modal-actions{display:flex;justify-content:space-between;gap:8px}
        .delete-series{display:flex;align-items:center;gap:6px;font-size:.8rem;color:#334155}
        .danger{background:#b91c1c;color:#fff;border-color:transparent}
        .settings-form{gap:10px}
        .settings-section{border:1px solid #dbe3ef;border-radius:12px;padding:10px;background:#f8fafc}
        .settings-section h4{margin:0 0 8px;font-size:.82rem;color:#334155;letter-spacing:.02em;text-transform:uppercase}
        .settings-block{display:grid;gap:8px}
        .settings-grid{display:grid;gap:8px}
        .two-col{grid-template-columns:repeat(2,minmax(0,1fr))}
        .labels-grid{grid-template-columns:repeat(3,minmax(0,1fr))}
        .labels-grid.compact{gap:6px}
        .settings-field{display:grid;gap:4px;font-size:.78rem;color:#475569}
        .settings-field span{font-weight:600}
        .settings-switch{display:flex;align-items:center;gap:8px;font-size:.78rem;color:#334155;font-weight:600}
        .settings-switch input{width:16px;height:16px;padding:0}
        .settings-inline{display:flex;align-items:center;gap:8px}
        .quick-template-list{display:flex;gap:6px;flex-wrap:wrap}
        .quick-template-pill{display:inline-flex;align-items:center;gap:6px;background:#fff;border:1px solid #dbe3ef;border-radius:999px;padding:4px 8px;font-size:.76rem;color:#334155}
        .quick-template-pill button{height:20px;min-width:20px;padding:0;border-radius:999px;border:1px solid #cbd5e1;background:#f8fafc;color:#64748b}
        .schedule-list{display:grid;gap:6px}
        .schedule-row{display:flex;align-items:center;justify-content:space-between;gap:8px;background:#fff;border:1px solid #dbe3ef;border-radius:10px;padding:8px 10px}
        .schedule-label{font-size:.78rem;color:#64748b;font-weight:600}
        .schedule-value{font-size:.8rem;color:#0f172a;font-weight:700}
        textarea{font:inherit;border-radius:10px;border:1px solid var(--hc-border);padding:8px 10px;background:#fff;color:var(--hc-text);resize:vertical;min-height:80px}
        #settings-submit{margin-left:auto;background:#2563eb;color:#fff;border-color:#1d4ed8;font-weight:700}
        .settings-advanced{border:1px dashed #cbd5e1;border-radius:10px;padding:8px;background:#fff}
        .settings-advanced summary{cursor:pointer;font-size:.8rem;font-weight:600;color:#475569}
        .settings-advanced[open] summary{margin-bottom:8px}
        @media (max-width:900px){
          .top-row{grid-template-columns:1fr}
          .header-actions{justify-content:space-between}
          .assignee-filter{flex-wrap:wrap}
          .side-columns{grid-template-columns:1fr}
          .week-span-overlay{grid-template-columns:repeat(7,minmax(110px,1fr));min-width:770px}
          .column h3{font-size:.76rem}
          .task-title{font-size:.73rem}
          .side-columns .column.side-lane{min-height:110px;max-height:110px}
          .side-columns .column.side-lane .tasks{
            display:grid;
            grid-template-columns:repeat(auto-fit,minmax(130px,1fr));
            overflow-x:visible;
            overflow-y:visible;
            gap:6px;
            padding-bottom:0;
          }
          .side-columns .column.side-lane .task{
            min-width:0;
            width:auto;
            flex:none;
          }
          .settings-inline{flex-wrap:wrap}
          .two-col{grid-template-columns:1fr}
          .labels-grid{grid-template-columns:1fr 1fr}
          .legend-list{grid-template-columns:1fr}
          .toggle-row{grid-template-columns:1fr}
        }
      </style>

      <ha-card>
        <div class="wrap">
          ${viewMode === "board" ? `<h2 class="board-title">${this._escape(this._boardTitle())}</h2>` : ""}
          ${loadingHtml}
          ${errorHtml}
          ${undoHtml}
          ${
            viewMode === "next_up"
              ? `<div class="panel">${this._renderNextUpStrip() || `<div class="small">Enable Next up in Settings to show badges here.</div><div class="small"><button class="week-nav-btn" type="button" id="open-settings">⚙ Settings</button></div>`}</div>`
              : `
                <div class="panel">
                  <div class="top-row ${upcomingHtml ? "has-upcoming" : ""}">
                    <div class="week-nav">
                      <button class="week-nav-btn" type="button" id="week-prev" ${this._weekOffset === 0 ? "disabled" : ""}>◀</button>
                      <div>
                        <div class="week-label">Week ${this._weekNumberForOffset()}</div>
                        <div class="week-sub">${this._weekRangeLabel()}</div>
                      </div>
                      <button class="week-nav-btn" type="button" id="week-next" ${this._weekOffset >= this._maxWeekOffset ? "disabled" : ""}>▶</button>
                    </div>
                    ${upcomingHtml ? `<div>${upcomingHtml}</div>` : ""}
                    <div class="header-actions">
                      <div class="swipe-hint">Swipe left/right (0..+3)</div>
                      ${this._renderActiveFilterChip()}
                      ${this._renderAssigneeFilter()}
                      <button class="week-nav-btn" type="button" id="open-settings">⚙</button>
                    </div>
                  </div>
                  ${nextUpHtml ? nextUpHtml : ""}
                  ${this._renderOnboardingBanner()}
                  <div class="people-strip" id="open-people" role="button" tabindex="0" aria-label="Open people">
                    <span class="people-strip-label">People</span>
                    ${
                      this._board.people.length
                        ? this._board.people
                            .slice(0, 12)
                            .map((person) => `<span class="person-pill"><span class="chip-wrap"><span class="chip" draggable="true" data-person-id="${person.id}" style="background:${person.color}" title="${this._escape(person.name)}">${this._personInitial(person.name)}</span><span class="role-badge ${person.role === "child" ? "child" : "adult"}">${this._personRoleLabel(person.role)}</span></span><span>${this._escape(person.name)}</span></span>`)
                            .join("")
                        : `<span class="people-strip-empty">Tap to add people</span>`
                    }
                  </div>
                  ${this._renderQuickTemplatesBar()}
                </div>

                <div class="columns-wrap">
                  <div class="week-scroll">
                    <div class="week-grid-wrap">
                      ${this._renderWeekSpanOverlay()}
                      <div class="week-columns">${this._weekColumns().map((col) => this._renderColumn(col)).join("")}</div>
                    </div>
                  </div>
                  <div class="side-columns">${this._renderColumn({ key: "done", label: "Completed" })}</div>
                </div>
              `
          }
        </div>
      </ha-card>

      ${this._renderPeopleModal()}
      ${this._renderTaskModal()}
      ${this._renderSettingsModal()}
    `;

    const openPeopleBtn = this.shadowRoot.querySelector("#open-people");
    const openSettingsBtn = this.shadowRoot.querySelector("#open-settings");
    const weekPrevBtn = this.shadowRoot.querySelector("#week-prev");
    const weekNextBtn = this.shadowRoot.querySelector("#week-next");
    const nextUpButtons = this.shadowRoot.querySelectorAll("[data-nextup-task-id]");
    const closePeopleBtn = this.shadowRoot.querySelector("#close-people");
    const closeTaskBtn = this.shadowRoot.querySelector("#close-task");
    const peopleBackdrop = this.shadowRoot.querySelector("#people-backdrop");
    const taskBackdrop = this.shadowRoot.querySelector("#task-backdrop");
    const settingsBackdrop = this.shadowRoot.querySelector("#settings-backdrop");
    const personForm = this.shadowRoot.querySelector("#person-form");
    const personInput = this.shadowRoot.querySelector("#person-name");
    const personRoleInput = this.shadowRoot.querySelector("#person-role");
    const personColorInput = this.shadowRoot.querySelector("#person-color");
    const settingsForm = this.shadowRoot.querySelector("#settings-form");
    const settingsTitle = this.shadowRoot.querySelector("#settings-title");
    const settingsTheme = this.shadowRoot.querySelector("#settings-theme");
    const settingsCompactMode = this.shadowRoot.querySelector("#settings-compact-mode");
    const settingsShowNextUp = this.shadowRoot.querySelector("#settings-show-next-up");
    const settingsShowOnboarding = this.shadowRoot.querySelector("#settings-show-onboarding");
    const settingsWeekday = this.shadowRoot.querySelector("#settings-weekday");
    const settingsRefreshHour = this.shadowRoot.querySelector("#settings-refresh-hour");
    const settingsRefreshMinute = this.shadowRoot.querySelector("#settings-refresh-minute");
    const settingsSwipeComplete = this.shadowRoot.querySelector("#settings-swipe-complete");
    const settingsSwipeDelete = this.shadowRoot.querySelector("#settings-swipe-delete");
    const settingsExportJson = this.shadowRoot.querySelector("#settings-export-json");
    const settingsImportJson = this.shadowRoot.querySelector("#settings-import-json");
    const copyExportJsonBtn = this.shadowRoot.querySelector("#copy-export-json");
    const importBoardJsonBtn = this.shadowRoot.querySelector("#import-board-json");
    const settingsLabelInputs = this.shadowRoot.querySelectorAll("[data-label-key]");
    const taskForm = this.shadowRoot.querySelector("#task-form");
    const taskTitleInput = this.shadowRoot.querySelector("#task-title");
    const taskColumnInput = this.shadowRoot.querySelector("#task-column");
    const taskEndDateInput = this.shadowRoot.querySelector("#task-end-date");
    const taskFixedInput = this.shadowRoot.querySelector("#task-fixed");
    const taskAllDaySpanInput = this.shadowRoot.querySelector("#task-all-day-span");
    const taskDeleteSeriesInput = this.shadowRoot.querySelector("#task-delete-series");
    const saveTaskAsTemplateBtn = this.shadowRoot.querySelector("#save-task-as-template");
    const deleteTaskBtn = this.shadowRoot.querySelector("#delete-task");
    const closeSettingsBtn = this.shadowRoot.querySelector("#close-settings");
    const deletePersonButtons = this.shadowRoot.querySelectorAll("[data-delete-person-id]");
    const personRoleSelects = this.shadowRoot.querySelectorAll("[data-person-role-id]");
    const personColorSelects = this.shadowRoot.querySelectorAll("[data-person-color-id]");
    const focusFilterButtons = this.shadowRoot.querySelectorAll("[data-focus-filter]");
    const personFocusSelect = this.shadowRoot.querySelector("#person-focus-select");
    const clearFilterBtn = this.shadowRoot.querySelector("#clear-filter");
    const dismissOnboardingBtn = this.shadowRoot.querySelector("#dismiss-onboarding");
    const quickTemplateButtons = this.shadowRoot.querySelectorAll("[data-quick-template]");
    const undoActionBtn = this.shadowRoot.querySelector("#undo-action-btn");
    const settingsQuickTemplateInput = this.shadowRoot.querySelector("#settings-quick-template-input");
    const settingsAddQuickTemplateBtn = this.shadowRoot.querySelector("#settings-add-quick-template");
    const settingsRemoveQuickTemplateBtns = this.shadowRoot.querySelectorAll("[data-remove-quick-template]");

    const weekGridWrap = this.shadowRoot.querySelector(".week-grid-wrap");
    const firstWeekHead = this.shadowRoot.querySelector(".week-columns .column.week-lane .column-head");
    if (weekGridWrap && firstWeekHead) {
      const headStyle = window.getComputedStyle(firstWeekHead);
      const marginBottom = Number.parseFloat(headStyle.marginBottom || "0") || 0;
      const offset = Math.max(48, Math.round(firstWeekHead.getBoundingClientRect().height + marginBottom + 6));
      weekGridWrap.style.setProperty("--week-head-offset", `${offset}px`);
    }

    if (openPeopleBtn) {
      openPeopleBtn.addEventListener("click", () => this._openPeopleModal());
      openPeopleBtn.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          this._openPeopleModal();
        }
      });
    }
    if (openSettingsBtn) openSettingsBtn.addEventListener("click", () => this._openSettingsModal());
    nextUpButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const taskId = btn.dataset.nextupTaskId || btn.getAttribute("data-nextup-task-id") || "";
        if (!taskId) return;
        const task = this._board.tasks.find((t) => String(t.id) === String(taskId));
        if (!task) return;
        this._openEditTask(task);
      });
    });
    focusFilterButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = btn.dataset.focusFilter || "all";
        if (mode === "person") {
          const personId = this._personFilter.startsWith("person:")
            ? this._personFilter.slice("person:".length)
            : (this._personFilterSelection || this._board.people[0]?.id || "");
          this._setPersonFilter(personId ? `person:${personId}` : "all");
        } else {
          this._setPersonFilter(mode);
        }
        this._render();
      });
    });
    if (personFocusSelect) personFocusSelect.addEventListener("change", (ev) => {
      const personId = String(ev.target.value || "");
      this._personFilterSelection = personId;
      this._setPersonFilter(personId ? `person:${personId}` : "all");
      this._render();
    });
    if (clearFilterBtn) clearFilterBtn.addEventListener("click", () => {
      this._setPersonFilter("all");
      this._render();
    });
    if (dismissOnboardingBtn) dismissOnboardingBtn.addEventListener("click", async () => this._dismissOnboardingTips());
    quickTemplateButtons.forEach((btn) => {
      btn.addEventListener("click", () => this._openAddTaskFromQuickTemplate(btn.dataset.quickTemplate || ""));
    });
    if (undoActionBtn) undoActionBtn.addEventListener("click", async () => this._undoLastAction());
    if (weekPrevBtn) weekPrevBtn.addEventListener("click", () => this._shiftWeek(-1));
    if (weekNextBtn) weekNextBtn.addEventListener("click", () => this._shiftWeek(1));
    if (closePeopleBtn) closePeopleBtn.addEventListener("click", () => this._closePeopleModal());
    if (closeTaskBtn) closeTaskBtn.addEventListener("click", () => this._closeTaskModal());
    if (closeSettingsBtn) closeSettingsBtn.addEventListener("click", () => this._closeSettingsModal());
    if (peopleBackdrop) peopleBackdrop.addEventListener("click", (ev) => { if (ev.target === peopleBackdrop) this._closePeopleModal(); });
    if (taskBackdrop) taskBackdrop.addEventListener("click", (ev) => { if (ev.target === taskBackdrop) this._closeTaskModal(); });
    if (settingsBackdrop) settingsBackdrop.addEventListener("click", (ev) => { if (ev.target === settingsBackdrop) this._closeSettingsModal(); });

    if (personForm) personForm.addEventListener("submit", (ev) => this._onAddPerson(ev));
    if (personInput) personInput.addEventListener("input", (ev) => this._onPersonNameInput(ev));
    if (personRoleInput) personRoleInput.addEventListener("change", (ev) => this._onPersonRoleInput(ev));
    if (personColorInput) personColorInput.addEventListener("change", (ev) => this._onPersonColorInput(ev));
    if (settingsForm) settingsForm.addEventListener("submit", (ev) => this._onSubmitSettings(ev));
    if (settingsTitle) settingsTitle.addEventListener("input", (ev) => this._onSettingsFieldInput(["title"], ev.target.value));
    if (settingsTheme) settingsTheme.addEventListener("change", (ev) => this._onSettingsFieldInput(["theme"], ev.target.value));
    if (settingsCompactMode) settingsCompactMode.addEventListener("change", (ev) => this._onSettingsFieldInput(["compact_mode"], ev.target.checked));
    if (settingsShowNextUp) settingsShowNextUp.addEventListener("change", (ev) => this._onSettingsFieldInput(["show_next_up"], ev.target.checked));
    if (settingsShowOnboarding) settingsShowOnboarding.addEventListener("change", (ev) => this._onSettingsFieldInput(["onboarding_dismissed"], !ev.target.checked));
    if (settingsWeekday) settingsWeekday.addEventListener("change", (ev) => this._onSettingsFieldInput(["weekly_refresh", "weekday"], Number(ev.target.value)));
    if (settingsRefreshHour) settingsRefreshHour.addEventListener("input", (ev) => this._onSettingsFieldInput(["weekly_refresh", "hour"], Number(ev.target.value)));
    if (settingsRefreshMinute) settingsRefreshMinute.addEventListener("input", (ev) => this._onSettingsFieldInput(["weekly_refresh", "minute"], Number(ev.target.value)));
    if (settingsSwipeComplete) settingsSwipeComplete.addEventListener("change", (ev) => this._onSettingsFieldInput(["gestures", "swipe_complete"], ev.target.checked));
    if (settingsSwipeDelete) settingsSwipeDelete.addEventListener("change", (ev) => this._onSettingsFieldInput(["gestures", "swipe_delete"], ev.target.checked));
    if (settingsImportJson) settingsImportJson.addEventListener("input", (ev) => this._onImportBoardInput(ev));
    if (settingsQuickTemplateInput) settingsQuickTemplateInput.addEventListener("input", (ev) => this._onQuickTemplateInput(ev.target.value));
    if (settingsAddQuickTemplateBtn) settingsAddQuickTemplateBtn.addEventListener("click", () => this._onAddQuickTemplate());
    settingsRemoveQuickTemplateBtns.forEach((btn) => {
      btn.addEventListener("click", () => this._onRemoveQuickTemplate(Number(btn.dataset.removeQuickTemplate)));
    });
    if (copyExportJsonBtn) copyExportJsonBtn.addEventListener("click", async () => this._onCopyExportJson());
    if (importBoardJsonBtn) importBoardJsonBtn.addEventListener("click", async (ev) => this._onImportBoard(ev));
    if (settingsExportJson) settingsExportJson.addEventListener("focus", (ev) => ev.target.select());
    settingsLabelInputs.forEach((input) => {
      input.addEventListener("input", (ev) => this._onSettingsFieldInput(["labels", input.dataset.labelKey], ev.target.value));
    });

    if (taskForm) taskForm.addEventListener("submit", (ev) => this._onSubmitTaskForm(ev));
    if (taskTitleInput) taskTitleInput.addEventListener("input", (ev) => this._onTaskFieldInput("title", ev.target.value));
    if (taskColumnInput) taskColumnInput.addEventListener("change", (ev) => this._onTaskFieldInput("column", ev.target.value));
    if (taskEndDateInput) taskEndDateInput.addEventListener("change", (ev) => this._onTaskFieldInput("endDate", ev.target.value));
    if (taskFixedInput) {
      taskFixedInput.addEventListener("change", (ev) => {
        const checked = Boolean(ev.target.checked);
        this._onTaskFieldInput("fixed", checked);
        this._render();
      });
    }
    if (taskAllDaySpanInput) {
      taskAllDaySpanInput.addEventListener("change", (ev) => {
        const checked = Boolean(ev.target.checked);
        this._onTaskFieldInput("allDaySpan", checked);
        this._render();
      });
    }
    if (taskDeleteSeriesInput) taskDeleteSeriesInput.addEventListener("change", (ev) => this._onTaskDeleteSeriesInput(ev.target.checked));
    if (saveTaskAsTemplateBtn) saveTaskAsTemplateBtn.addEventListener("click", async () => this._onSaveTaskTitleAsQuickTemplate());
    if (deleteTaskBtn) deleteTaskBtn.addEventListener("click", () => this._onDeleteTask());
    deletePersonButtons.forEach((btn) => {
      btn.addEventListener("click", () => this._onDeletePerson(btn.dataset.deletePersonId));
    });
    personRoleSelects.forEach((select) => {
      select.addEventListener("change", (ev) => this._onChangePersonRole(select.dataset.personRoleId, ev.target.value));
    });
    personColorSelects.forEach((input) => {
      input.addEventListener("input", (ev) => this._onChangePersonColor(input.dataset.personColorId, ev.target.value, { commit: false }));
      input.addEventListener("change", (ev) => this._onChangePersonColor(input.dataset.personColorId, ev.target.value, { commit: true }));
    });
    this.shadowRoot.querySelectorAll(".weekday-dot").forEach((dot) => {
      dot.addEventListener("click", () => this._toggleTaskWeekday(dot.dataset.weekday));
    });

    this.shadowRoot.querySelectorAll("input[name='assignee']").forEach((cb) => {
      cb.addEventListener("change", () => this._toggleTaskAssignee(cb.value));
    });

    this.shadowRoot.querySelectorAll("[data-person-id]").forEach((el) => {
      el.addEventListener("dragstart", (ev) => {
        const sourceTaskId = el.dataset.sourceTaskId || "";
        ev.dataTransfer.effectAllowed = sourceTaskId ? "move" : "copy";
        ev.dataTransfer.setData("text/person", el.dataset.personId);
        if (sourceTaskId) {
          ev.dataTransfer.setData("text/person-assignment", el.dataset.personId);
          ev.dataTransfer.setData("text/source-task", sourceTaskId);
        }
      });
    });

    this.shadowRoot.querySelectorAll(".task").forEach((taskEl) => {
      const isVirtual = taskEl.dataset.virtual === "1";
      const taskId = taskEl.dataset.taskId;
      const templateId = taskEl.dataset.templateId || "";
      const taskColumn = taskEl.dataset.column || "monday";
      if (!this._isReadOnlyWeekView() && !isVirtual) {
        taskEl.addEventListener("dragstart", (ev) => {
          this._draggingTask = true;
          ev.dataTransfer.effectAllowed = "move";
          ev.dataTransfer.setData("text/task", taskId);
        });
        taskEl.addEventListener("dragend", () => {
          setTimeout(() => {
            this._draggingTask = false;
          }, 0);
        });
      }

      taskEl.addEventListener("click", () => {
        if (this._draggingTask) return;
        if (Date.now() < this._suppressTaskClickUntil) return;
        if (isVirtual && templateId) {
          this._openEditTemplateModal(templateId, taskColumn);
          return;
        }
        if (isVirtual) return;
        this._openEditTaskModal(taskId);
      });

      taskEl.addEventListener("touchstart", (ev) => this._onTaskTouchStart(taskEl, ev), { passive: true });
      taskEl.addEventListener("touchmove", (ev) => this._onTaskTouchMove(taskEl, ev), { passive: false });
      taskEl.addEventListener("touchend", (ev) => this._onTaskTouchEnd(taskEl, ev), { passive: true });
      taskEl.addEventListener("touchcancel", () => {
        taskEl.style.transform = "";
        taskEl.style.transition = "";
        taskEl.classList.remove("swipe-complete-preview", "swipe-delete-preview");
        this._taskSwipe = null;
      }, { passive: true });

      taskEl.addEventListener("dragover", (ev) => {
        if (ev.dataTransfer.types.includes("text/person")) ev.preventDefault();
      });

      taskEl.addEventListener("drop", async (ev) => {
        const personId = ev.dataTransfer.getData("text/person-assignment") || ev.dataTransfer.getData("text/person");
        const sourceTaskId = ev.dataTransfer.getData("text/source-task");
        if (!personId) return;
        ev.preventDefault();
        if (sourceTaskId && sourceTaskId !== taskId) {
          this._removeAssigneeFromTask(sourceTaskId, personId);
        }
        this._assignAssigneeToTask(taskId, personId);

        this._render();
        await this._saveBoard();
      });
    });

    this.shadowRoot.querySelectorAll(".column").forEach((columnEl) => {
      const columnKey = columnEl.dataset.column;
      columnEl.addEventListener("click", (ev) => {
        const isWeekdayColumn = this._weekdayKeys().some((day) => day.key === columnKey);
        if (this._draggingTask) return;
        if (ev.target.closest(".task")) return;
        if (ev.target.closest("header")) return;
        if (ev.target.closest("button, input, select, label, a")) return;
        this._openAddTaskModalForColumn(columnKey);
      });
      columnEl.addEventListener("dragover", (ev) => {
        if (ev.dataTransfer.types.includes("text/task")) {
          ev.preventDefault();
          columnEl.classList.add("drag-over");
        }
      });
      columnEl.addEventListener("dragleave", () => {
        columnEl.classList.remove("drag-over");
      });
      columnEl.addEventListener("drop", async (ev) => {
        columnEl.classList.remove("drag-over");
        const taskId = ev.dataTransfer.getData("text/task");
        const personId = ev.dataTransfer.getData("text/person-assignment");
        const sourceTaskId = ev.dataTransfer.getData("text/source-task");
        if (personId && sourceTaskId) {
          ev.preventDefault();
          this._removeAssigneeFromTask(sourceTaskId, personId);
          this._render();
          await this._saveBoard();
          return;
        }
        if (!taskId) return;
        ev.preventDefault();

        const task = this._board.tasks.find((t) => t.id === taskId);
        if (!task) return;
        if (task.column === columnKey) return;
        const snapshot = this._snapshotBoard();
        task.column = columnKey;
        task.week_start = this._weekStartIso(this._weekOffset);
        task.week_number = this._weekNumberForOffset(this._weekOffset);
        this._reindexAllColumns();
        this._setUndo(`Task moved to ${this._labelForColumn(columnKey)}`, snapshot);
        this._render();
        await this._saveBoard();
      });
    });

    const weekScroll = this.shadowRoot.querySelector(".week-scroll");
    if (weekScroll) {
      weekScroll.addEventListener("touchstart", (ev) => this._onWeekTouchStart(ev), { passive: true });
      weekScroll.addEventListener("touchend", (ev) => this._onWeekTouchEnd(ev), { passive: true });
    }

    this._restoreFocusState(focusState);
  }
}

if (!customElements.get("household-chores-card")) {
  customElements.define("household-chores-card", HouseholdChoresCard);
}

window.customCards = window.customCards || [];
window.customCards.push({
  type: "household-chores-card",
  name: "Household Chores Card",
  description: "Weekly chore planner with drag/drop, edit modal, and person assignment by drag.",
});
