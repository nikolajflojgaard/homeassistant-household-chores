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
    this._taskFormOriginal = null;
    this._taskFormDirty = false;

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
    this._config = { title: config.title || "Household Chores", entry_id: config.entry_id || "" };
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

  _columns() {
    return [
      { key: "backlog", label: "Backlog" },
      { key: "monday", label: "Mon" },
      { key: "tuesday", label: "Tue" },
      { key: "wednesday", label: "Wed" },
      { key: "thursday", label: "Thu" },
      { key: "friday", label: "Fri" },
      { key: "saturday", label: "Sat" },
      { key: "sunday", label: "Sun" },
      { key: "done", label: "Done" },
    ];
  }

  _weekColumns() {
    return this._columns().filter((col) => col.key !== "backlog" && col.key !== "done");
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
      title: "",
      fixed: false,
      endDate: "",
      column: "backlog",
      weekdays: [],
      assignees: [],
    };
  }

  _defaultSettings() {
    return {
      title: this._config?.title || "Household Chores",
      theme: "light",
      labels: {
        backlog: "Backlog",
        done: "Done",
        monday: "Mon",
        tuesday: "Tue",
        wednesday: "Wed",
        thursday: "Thu",
        friday: "Fri",
        saturday: "Sat",
        sunday: "Sun",
      },
      weekly_refresh: { weekday: 6, hour: 0, minute: 30 },
      done_cleanup: { hour: 3, minute: 0 },
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
    return dateObj.toISOString().slice(0, 10);
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

  _isReadOnlyWeekView() {
    return this._weekOffset !== 0;
  }

  _shiftWeek(delta) {
    this._weekOffset = Math.min(this._maxWeekOffset, Math.max(0, this._weekOffset + delta));
    this._render();
  }

  _onWeekTouchStart(ev) {
    if (!ev.touches || ev.touches.length !== 1) return;
    this._swipeStartX = ev.touches[0].clientX;
  }

  _onWeekTouchEnd(ev) {
    if (this._swipeStartX === null || !ev.changedTouches || !ev.changedTouches.length) return;
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
    return {
      people: people.map((p, i) => ({
        id: p.id || `person_${i}`,
        name: (p.name || "Person").trim() || "Person",
        color: p.color || this._autoColor(i),
        role: p.role === "child" ? "child" : "adult",
      })),
      tasks: tasks
        .map((t, i) => {
          const column = validColumns.includes(t.column) ? t.column : "backlog";
          const isWeekday = this._weekdayKeys().some((day) => day.key === column);
          return {
          id: t.id || `task_${i}`,
          title: (t.title || "").trim(),
          assignees: Array.isArray(t.assignees) ? t.assignees : [],
          column,
          order: Number.isFinite(t.order) ? t.order : i,
          created_at: t.created_at || new Date().toISOString(),
          end_date: t.end_date || "",
          template_id: t.template_id || "",
          fixed: Boolean(t.fixed),
          week_start: isWeekday ? (t.week_start || currentWeekStart) : "",
          week_number: Number.isFinite(t.week_number) ? t.week_number : this._weekNumberForOffset(0),
        };
        })
        .filter((t) => t.title),
      templates: templates
        .map((tpl, i) => ({
          id: tpl.id || `tpl_${i}`,
          title: (tpl.title || "").trim(),
          assignees: Array.isArray(tpl.assignees) ? tpl.assignees : [],
          end_date: tpl.end_date || "",
          weekdays: Array.isArray(tpl.weekdays) ? tpl.weekdays : [],
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
        done_cleanup: {
          ...this._defaultSettings().done_cleanup,
          ...(settings.done_cleanup || {}),
        },
      },
    };
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
      this._error = "";
    } catch (err) {
      const message = String(err?.message || err || "");
      if (message.toLowerCase().includes("unknown command")) {
        const fallbackBoard = this._loadBoardFromStateEntity();
        if (fallbackBoard) {
          this._board = this._normalizeBoard(fallbackBoard);
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
      const result = await this._callBoardWs({
        type: "household_chores/save_board",
        entry_id: this._config.entry_id,
        board: this._board,
      });
      this._board = this._normalizeBoard(result.board || this._board);
      this._error = "";
    } catch (err) {
      const message = String(err?.message || err || "");
      if (message.toLowerCase().includes("unknown command")) {
        try {
          await this._hass.callService("household_chores", "save_board", {
            entry_id: this._config.entry_id,
            board: this._board,
          });
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

  _tasksForColumn(column) {
    const isWeekdayColumn = this._weekdayKeys().some((day) => day.key === column);
    const selectedWeekStart = this._weekStartIso(this._weekOffset);
    const currentWeekStart = this._weekStartIso(0);
    const stored = this._board.tasks
      .filter((t) => t.column === column)
      .filter((t) => (t.week_start || currentWeekStart) === selectedWeekStart)
      .sort((a, b) => a.order - b.order || a.created_at.localeCompare(b.created_at));

    if (isWeekdayColumn && this._weekOffset > 0) {
      const projected = this._projectedTasksForFutureWeekday(column, this._weekOffset).filter(
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

    const tpl = task.template_id ? this._board.templates.find((x) => x.id === task.template_id) : null;
    const weekdays = tpl?.weekdays?.length
      ? [...tpl.weekdays]
      : this._weekdayKeys().some((d) => d.key === task.column)
        ? [task.column]
        : [];

    this._taskForm = {
      mode: "edit",
      taskId: task.id,
      templateId: task.template_id || "",
      title: task.title,
      fixed: Boolean(task.fixed),
      endDate: task.end_date || tpl?.end_date || "",
      column: task.column || "backlog",
      weekdays,
      assignees: [...task.assignees],
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

  _openSettingsModal() {
    this._settingsForm = this._emptySettingsForm();
    this._showSettingsModal = true;
    this._render();
  }

  _closeSettingsModal() {
    this._showSettingsModal = false;
    this._settingsForm = this._emptySettingsForm();
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

  async _onSubmitSettings(ev) {
    ev.preventDefault();
    const next = JSON.parse(JSON.stringify(this._settingsForm || this._defaultSettings()));
    next.theme = ["light", "dark", "colorful"].includes(next.theme) ? next.theme : "light";
    this._board.settings = next;
    this._showSettingsModal = false;
    this._render();
    await this._saveBoard();
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
    this._render();
    await this._saveBoard();
  }

  async _onChangePersonColor(personId, color) {
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
    this._render();
    await this._saveBoard();
  }

  _personRoleLabel(role) {
    return role === "child" ? "C" : "A";
  }

  _personRoleTitle(role) {
    return role === "child" ? "Child" : "Adult";
  }

  async _onDeletePerson(personId) {
    this._board.people = this._board.people.filter((person) => person.id !== personId);
    this._board.tasks = this._board.tasks.map((task) => ({
      ...task,
      assignees: task.assignees.filter((id) => id !== personId),
    }));
    this._board.templates = this._board.templates.map((tpl) => ({
      ...tpl,
      assignees: tpl.assignees.filter((id) => id !== personId),
    }));
    this._render();
    await this._saveBoard();
  }

  _onTaskFieldInput(field, value) {
    this._taskForm = { ...this._taskForm, [field]: value };
    this._recalcTaskFormDirty();
    this._updateSubmitButtons();
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
      endDate: form.endDate || "",
      column: form.column || "backlog",
      weekdays: [...(form.weekdays || [])].sort(),
      assignees: [...(form.assignees || [])].sort(),
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
    this._taskForm = { ...this._taskForm, weekdays: [...set] };
    this._recalcTaskFormDirty();
    this._render();
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
        week_start: weekStart,
        week_number: weekNumber,
      });
    }
    return items;
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
        created_at: new Date().toISOString(),
      };
      const instances = this._buildFixedInstancesForCurrentWeek(template, template.title, template.assignees);
      this._board.templates = [...this._board.templates, template];
      this._board.tasks = [...this._board.tasks, ...instances];
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
    if (!original) return;
    const effectiveFixed = form.fixed;

    if (effectiveFixed) {
      if (!form.endDate || !form.weekdays.length) {
        this._error = "Fixed task requires end date and weekdays.";
        this._render();
        return;
      }

      const templateId = form.templateId || `tpl_${Math.random().toString(36).slice(2, 10)}`;

      // Remove old instances for same template (or this single task if converting).
      if (original.template_id) {
        this._board.tasks = this._board.tasks.filter((t) => t.template_id !== original.template_id);
      } else {
        this._board.tasks = this._board.tasks.filter((t) => t.id !== original.id);
      }

      // Remove old template if present.
      if (original.template_id) {
        this._board.templates = this._board.templates.filter((tpl) => tpl.id !== original.template_id);
      }

      const template = {
        id: templateId,
        title: form.title.trim(),
        assignees: [...form.assignees],
        end_date: form.endDate,
        weekdays: [...form.weekdays],
        created_at: new Date().toISOString(),
      };
      const instances = this._buildFixedInstancesForCurrentWeek(template, template.title, template.assignees);
      this._board.templates = [...this._board.templates, template];
      this._board.tasks = [...this._board.tasks, ...instances];
    } else {
      // If converting from fixed -> single task, remove template + template instances first.
      if (original.template_id) {
        this._board.templates = this._board.templates.filter((tpl) => tpl.id !== original.template_id);
        this._board.tasks = this._board.tasks.filter((t) => t.template_id !== original.template_id);
      } else {
        this._board.tasks = this._board.tasks.filter((t) => t.id !== original.id);
      }

      if (form.weekdays.length > 0) {
        const oneOffInstances = this._buildOneOffWeekdayInstances(form.title, form.assignees, form.weekdays, form.endDate || "");
        this._board.tasks.push(...oneOffInstances);
      } else {
        this._board.tasks.push({
          id: original.id,
          title: form.title.trim(),
          assignees: [...form.assignees],
          column: form.column,
          order: this._tasksForColumn(form.column).length,
          created_at: original.created_at,
          end_date: form.endDate || "",
          template_id: "",
          fixed: false,
          week_start: this._weekStartIso(this._weekOffset),
          week_number: original.week_number || this._weekNumberForOffset(this._weekOffset),
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
    const form = this._taskForm;
    const task = this._board.tasks.find((t) => t.id === form.taskId);
    if (!task) return;

    if (task.template_id) {
      this._board.templates = this._board.templates.filter((tpl) => tpl.id !== task.template_id);
      this._board.tasks = this._board.tasks.filter((t) => t.template_id !== task.template_id);
    } else {
      this._board.tasks = this._board.tasks.filter((t) => t.id !== task.id);
    }

    this._reindexAllColumns();
    this._closeTaskModal();
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

    if (!targetTask.assignees.includes(personId)) targetTask.assignees.push(personId);
  }

  _taskMetaLine(task) {
    const bits = [];
    if (task.fixed) bits.push("fixed");
    if (task.end_date) bits.push(`until ${task.end_date}`);
    return bits.length ? `<div class="task-sub">${this._escape(bits.join(" • "))}</div>` : "";
  }

  _renderTaskCard(task) {
    const draggable = !task.virtual;
    return `
      <article class="task ${task.virtual ? "virtual-task" : ""}" draggable="${draggable ? "true" : "false"}" data-task-id="${task.id}" data-virtual="${task.virtual ? "1" : "0"}">
        <div class="task-title">${this._escape(task.title)}</div>
        ${this._taskMetaLine(task)}
        <div class="task-meta">${this._assigneeChips(task)}</div>
      </article>
    `;
  }

  _renderColumn(column) {
    const tasks = this._tasksForColumn(column.key);
    const isSideLane = column.key === "backlog" || column.key === "done";
    const isWeekday = this._weekdayKeys().some((day) => day.key === column.key);
    const weekdayDate = isWeekday ? this._formatWeekdayDate(column.key) : "";
    const emptyContent = `
      <div class="empty-wrap ${isSideLane ? "side-empty" : "week-empty"}">
        <div class="empty">Drop here</div>
      </div>
    `;
    return `
      <section class="column ${isSideLane ? "side-lane" : "week-lane"}" data-column="${column.key}">
        <header><h3>${this._escape(this._labelForColumn(column.key))}${weekdayDate ? `<small>${weekdayDate}</small>` : ""}</h3><span>${tasks.length}</span></header>
        <div class="tasks">
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
                <span class="chip-wrap">
                  <span class="chip" draggable="true" data-person-id="${person.id}" style="background:${person.color}">${this._personInitial(person.name)}</span>
                  <span class="role-badge ${person.role === "child" ? "child" : "adult"}">${this._personRoleLabel(person.role)}</span>
                </span>
                <span class="legend-name">${this._escape(person.name)}</span>
                <select class="person-role-select" data-person-role-id="${person.id}">
                  <option value="adult" ${person.role !== "child" ? "selected" : ""}>Adult</option>
                  <option value="child" ${person.role === "child" ? "selected" : ""}>Child</option>
                </select>
                <input class="person-color-input" data-person-color-id="${person.id}" type="color" value="${this._normalizeHexColor(person.color, this._suggestPersonColor())}" title="Choose color" />
                <button type="button" class="person-delete" data-delete-person-id="${person.id}" title="Delete person">Delete</button>
              </div>`
          )
          .join("")}
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
    const showWeekdayMode = form.fixed || form.weekdays.length > 0;
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
              <label><input id="task-fixed" type="checkbox" ${form.fixed ? "checked" : ""} /> Fixed until date</label>
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
            <div class="small">Without fixed: selected weekdays create one-off tasks for this week and do not require end date.</div>
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
            <input id="person-color" type="color" value="${this._normalizeHexColor(this._newPersonColor, this._suggestPersonColor())}" title="Choose color" />
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
            <h3>Board settings</h3>
            <button type="button" class="close-btn" id="close-settings">X</button>
          </div>
          <form class="task-form settings-form" id="settings-form">
            <section class="settings-section">
              <h4>General</h4>
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
            </section>

            <section class="settings-section">
              <h4>Lane Labels</h4>
              <div class="settings-grid labels-grid">
                ${this._columns().map((col) => `<label class="settings-field"><span>${this._escape(col.label)}</span><input data-label-key="${col.key}" data-focus-key="label-${col.key}" type="text" value="${this._escape(form.labels?.[col.key] || this._labelForColumn(col.key))}" /></label>`).join("")}
              </div>
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
              <h4>Done Cleanup</h4>
              <div class="settings-inline">
                <input id="settings-cleanup-hour" data-focus-key="settings-cleanup-hour" type="number" min="0" max="23" value="${this._escape(form.done_cleanup?.hour ?? 3)}" />
                <span>:</span>
                <input id="settings-cleanup-minute" data-focus-key="settings-cleanup-minute" type="number" min="0" max="59" value="${this._escape(form.done_cleanup?.minute ?? 0)}" />
              </div>
            </section>
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
    const theme = this._themeVars();

    this.shadowRoot.innerHTML = `
      <style>
        :host{--hc-bg:${theme.bg};--hc-text:${theme.text};--hc-muted:${theme.muted};--hc-border:${theme.border};--hc-card:${theme.card};--hc-accent:${theme.accent};display:block}
        ha-card{background:var(--hc-bg);color:var(--hc-text);border-radius:18px;border:1px solid var(--hc-border);overflow:hidden}
        .wrap{display:grid;gap:6px;padding:6px 12px 12px}
        .board-title{margin:0;padding:2px 0 0;font-size:2rem;line-height:1.1;font-weight:500;color:var(--hc-text)}
        .panel{background:var(--hc-card);border:1px solid var(--hc-border);border-radius:14px;padding:10px}
        .top-row{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
        .week-nav{display:flex;align-items:center;gap:8px}
        .week-nav-btn{border:1px solid #94a3b8;background:#fff;color:#1e293b;border-radius:10px;padding:6px 10px;font-weight:700;cursor:pointer}
        .week-label{font-weight:700;font-size:.92rem}
        .week-sub{font-size:.78rem;color:var(--hc-muted)}
        .swipe-hint{font-size:.75rem;color:var(--hc-muted)}
        .people-strip{margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;align-items:center;border:1px dashed #cbd5e1;border-radius:10px;padding:6px 8px;cursor:pointer;background:#f8fafc}
        .people-strip:focus-visible{outline:2px solid #2563eb;outline-offset:2px}
        .people-strip-label{font-size:.78rem;font-weight:700;color:#334155;margin-right:2px}
        .people-strip-empty{font-size:.78rem;color:#64748b}
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
        .week-scroll{overflow-x:hidden}
        .week-columns{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:8px;min-width:0}
        .side-columns{display:grid;grid-template-columns:1fr 1fr;gap:8px}
        .column{background:var(--hc-card);border:1px solid var(--hc-border);border-radius:12px;padding:8px;display:grid;grid-template-rows:auto 1fr;min-height:220px}
        .week-columns .column.week-lane{min-height:360px;max-height:360px}
        .week-columns .column.week-lane .tasks{max-height:300px;overflow-y:auto;overflow-x:hidden;padding-right:2px}
        .side-columns .column.side-lane{min-height:132px;max-height:132px}
        .side-columns .column.side-lane .tasks{display:flex;flex-direction:row;align-items:flex-start;overflow-x:auto;overflow-y:hidden;gap:6px;padding-bottom:3px}
        .side-columns .column.side-lane .task{min-width:180px;flex:0 0 180px}
        .column.drag-over{border-color:#2563eb;box-shadow:inset 0 0 0 1px #2563eb;background:#f0f7ff}
        .column header{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
        .column h3{margin:0;font-size:.82rem;display:flex;flex-direction:column;gap:2px}
        .column h3 small{font-weight:500;color:#64748b;font-size:.68rem}
        .column header span{font-size:.75rem;color:var(--hc-muted)}
        .tasks{display:grid;gap:6px;align-content:start}
        .task{background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:7px;cursor:grab;user-select:none}
        .task.virtual-task{cursor:default;opacity:.96}
        .task-title{font-size:.78rem;font-weight:600;line-height:1.25}
        .task-sub{margin-top:4px;color:#64748b;font-size:.73rem}
        .task-meta{margin-top:6px;display:flex;gap:4px;flex-wrap:wrap}
        .empty-wrap{display:grid;gap:6px;align-content:start}
        .week-empty{grid-template-columns:1fr}
        .side-empty{grid-template-columns:1fr}
        .empty{border:1px dashed #cbd5e1;border-radius:9px;padding:10px 8px;color:#94a3b8;text-align:center;font-size:.77rem}
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
        .legend-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:6px}
        .legend-item{display:flex;align-items:center;gap:6px;background:#f8fafc;border-radius:9px;padding:4px 6px}
        .legend-name{font-size:.82rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .person-role-select{min-width:74px;padding:4px 6px;font-size:.74rem}
        .person-color-input{width:38px;height:30px;padding:2px}
        .task-form{margin-top:10px;display:grid;gap:8px}
        .toggle-row{display:flex;align-items:center;justify-content:space-between;gap:8px}
        .toggle-row label{display:flex;gap:6px;align-items:center;font-size:.84rem}
        .weekday-picks{display:flex;gap:6px;flex-wrap:wrap}
        .weekday-dot{width:28px;height:28px;border-radius:999px;border:1px solid #cbd5e1;background:#fff;color:#334155;padding:0;font-size:.76rem;font-weight:700}
        .weekday-dot.sel{background:#0f766e;border-color:#0f766e;color:#fff}
        .assignees{display:flex;flex-wrap:wrap;gap:8px}
        .assignees label{display:flex;align-items:center;gap:5px;font-size:.78rem}
        .modal-actions{display:flex;justify-content:space-between;gap:8px}
        .danger{background:#b91c1c;color:#fff;border-color:transparent}
        .settings-form{gap:12px}
        .settings-section{border:1px solid #dbe3ef;border-radius:12px;padding:10px;background:#f8fafc}
        .settings-section h4{margin:0 0 8px;font-size:.86rem;color:#334155}
        .settings-grid{display:grid;gap:8px}
        .labels-grid{grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}
        .settings-field{display:grid;gap:4px;font-size:.78rem;color:#475569}
        .settings-field span{font-weight:600}
        .settings-inline{display:flex;align-items:center;gap:8px}
        #settings-submit{margin-left:auto;background:#2563eb;color:#fff;border-color:#1d4ed8;font-weight:700}
        @media (max-width:900px){
          .side-columns{grid-template-columns:1fr}
          .column h3{font-size:.76rem}
          .task-title{font-size:.73rem}
          .side-columns .column.side-lane{min-height:150px;max-height:150px}
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
          .labels-grid{grid-template-columns:1fr 1fr}
        }
      </style>

      <ha-card>
        <div class="wrap">
          <h2 class="board-title">${this._escape(this._boardTitle())}</h2>
          ${loadingHtml}
          ${errorHtml}
          <div class="panel">
            <div class="top-row">
              <div>
                <div class="week-nav">
                  <button class="week-nav-btn" type="button" id="week-prev" ${this._weekOffset === 0 ? "disabled" : ""}>◀</button>
                  <div>
                    <div class="week-label">Week ${this._weekNumberForOffset()}</div>
                    <div class="week-sub">${this._weekRangeLabel()}</div>
                  </div>
                  <button class="week-nav-btn" type="button" id="week-next" ${this._weekOffset >= this._maxWeekOffset ? "disabled" : ""}>▶</button>
                </div>
              </div>
              <div class="swipe-hint">Swipe left/right to browse weeks (0..+3)</div>
              <button class="week-nav-btn" type="button" id="open-settings">⚙</button>
            </div>
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
          </div>

          <div class="columns-wrap">
            <div class="week-scroll"><div class="week-columns">${this._weekColumns().map((col) => this._renderColumn(col)).join("")}</div></div>
            <div class="side-columns">${this._renderColumn({ key: "backlog", label: "Backlog" })}${this._renderColumn({ key: "done", label: "Done" })}</div>
          </div>
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
    const settingsWeekday = this.shadowRoot.querySelector("#settings-weekday");
    const settingsRefreshHour = this.shadowRoot.querySelector("#settings-refresh-hour");
    const settingsRefreshMinute = this.shadowRoot.querySelector("#settings-refresh-minute");
    const settingsCleanupHour = this.shadowRoot.querySelector("#settings-cleanup-hour");
    const settingsCleanupMinute = this.shadowRoot.querySelector("#settings-cleanup-minute");
    const settingsLabelInputs = this.shadowRoot.querySelectorAll("[data-label-key]");
    const taskForm = this.shadowRoot.querySelector("#task-form");
    const taskTitleInput = this.shadowRoot.querySelector("#task-title");
    const taskColumnInput = this.shadowRoot.querySelector("#task-column");
    const taskEndDateInput = this.shadowRoot.querySelector("#task-end-date");
    const taskFixedInput = this.shadowRoot.querySelector("#task-fixed");
    const deleteTaskBtn = this.shadowRoot.querySelector("#delete-task");
    const closeSettingsBtn = this.shadowRoot.querySelector("#close-settings");
    const deletePersonButtons = this.shadowRoot.querySelectorAll("[data-delete-person-id]");
    const personRoleSelects = this.shadowRoot.querySelectorAll("[data-person-role-id]");
    const personColorSelects = this.shadowRoot.querySelectorAll("[data-person-color-id]");

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
    if (personColorInput) personColorInput.addEventListener("input", (ev) => this._onPersonColorInput(ev));
    if (settingsForm) settingsForm.addEventListener("submit", (ev) => this._onSubmitSettings(ev));
    if (settingsTitle) settingsTitle.addEventListener("input", (ev) => this._onSettingsFieldInput(["title"], ev.target.value));
    if (settingsTheme) settingsTheme.addEventListener("change", (ev) => this._onSettingsFieldInput(["theme"], ev.target.value));
    if (settingsWeekday) settingsWeekday.addEventListener("change", (ev) => this._onSettingsFieldInput(["weekly_refresh", "weekday"], Number(ev.target.value)));
    if (settingsRefreshHour) settingsRefreshHour.addEventListener("input", (ev) => this._onSettingsFieldInput(["weekly_refresh", "hour"], Number(ev.target.value)));
    if (settingsRefreshMinute) settingsRefreshMinute.addEventListener("input", (ev) => this._onSettingsFieldInput(["weekly_refresh", "minute"], Number(ev.target.value)));
    if (settingsCleanupHour) settingsCleanupHour.addEventListener("input", (ev) => this._onSettingsFieldInput(["done_cleanup", "hour"], Number(ev.target.value)));
    if (settingsCleanupMinute) settingsCleanupMinute.addEventListener("input", (ev) => this._onSettingsFieldInput(["done_cleanup", "minute"], Number(ev.target.value)));
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
    if (deleteTaskBtn) deleteTaskBtn.addEventListener("click", () => this._onDeleteTask());
    deletePersonButtons.forEach((btn) => {
      btn.addEventListener("click", () => this._onDeletePerson(btn.dataset.deletePersonId));
    });
    personRoleSelects.forEach((select) => {
      select.addEventListener("change", (ev) => this._onChangePersonRole(select.dataset.personRoleId, ev.target.value));
    });
    personColorSelects.forEach((input) => {
      input.addEventListener("input", (ev) => this._onChangePersonColor(input.dataset.personColorId, ev.target.value));
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
        if (isVirtual) return;
        this._openEditTaskModal(taskId);
      });

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
        task.column = columnKey;
        task.week_start = this._weekStartIso(this._weekOffset);
        task.week_number = this._weekNumberForOffset(this._weekOffset);
        this._reindexAllColumns();
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
