class HouseholdChoresCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._config = null;
    this._loadedOnce = false;

    this._board = { people: [], tasks: [], templates: [] };
    this._loading = true;
    this._saving = false;
    this._error = "";

    this._newPersonName = "";
    this._showPeopleModal = false;
    this._showTaskModal = false;
    this._draggingTask = false;

    this._taskForm = this._emptyTaskForm("add");
  }

  static getStubConfig() {
    return { type: "custom:household-chores-card", title: "Household Chores" };
  }

  setConfig(config) {
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

  _todayIsoDate() {
    return new Date().toISOString().slice(0, 10);
  }

  _startOfWeek(baseDate = new Date()) {
    const d = new Date(baseDate);
    const day = d.getDay();
    const diff = (day + 6) % 7;
    d.setDate(d.getDate() - diff);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  _weekdayDateForCurrentWeek(weekdayKey) {
    const weekStart = this._startOfWeek();
    const idx = this._weekdayKeys().findIndex((d) => d.key === weekdayKey);
    if (idx < 0) return null;
    const d = new Date(weekStart);
    d.setDate(d.getDate() + idx);
    return d;
  }

  _toIsoDate(dateObj) {
    return dateObj.toISOString().slice(0, 10);
  }

  _normalizeBoard(board) {
    const people = Array.isArray(board.people) ? board.people : [];
    const tasks = Array.isArray(board.tasks) ? board.tasks : [];
    const templates = Array.isArray(board.templates) ? board.templates : [];
    const validColumns = this._columns().map((c) => c.key);

    return {
      people: people.map((p, i) => ({
        id: p.id || `person_${i}`,
        name: (p.name || "Person").trim() || "Person",
        color: p.color || this._autoColor(i),
      })),
      tasks: tasks
        .map((t, i) => ({
          id: t.id || `task_${i}`,
          title: (t.title || "").trim(),
          assignees: Array.isArray(t.assignees) ? t.assignees : [],
          column: validColumns.includes(t.column) ? t.column : "backlog",
          order: Number.isFinite(t.order) ? t.order : i,
          created_at: t.created_at || new Date().toISOString(),
          end_date: t.end_date || "",
          template_id: t.template_id || "",
          fixed: Boolean(t.fixed),
        }))
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
    return this._board.tasks
      .filter((t) => t.column === column)
      .sort((a, b) => a.order - b.order || a.created_at.localeCompare(b.created_at));
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
    this._showPeopleModal = true;
    this._render();
  }

  _closePeopleModal() {
    this._showPeopleModal = false;
    this._render();
  }

  _openAddTaskModal() {
    this._taskForm = this._emptyTaskForm("add");
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

    this._showTaskModal = true;
    this._render();
  }

  _closeTaskModal() {
    this._showTaskModal = false;
    this._taskForm = this._emptyTaskForm("add");
    this._render();
  }

  _onPersonNameInput(ev) {
    this._newPersonName = ev.target.value;
  }

  async _onAddPerson(ev) {
    ev.preventDefault();
    const name = this._newPersonName.trim();
    if (!name) return;

    const taken = new Set(this._board.people.map((p) => p.color));
    let color = this._autoColor(this._board.people.length);
    for (let i = 0; i < 200 && taken.has(color); i += 1) color = this._autoColor(this._board.people.length + i + 1);

    this._board.people = [...this._board.people, { id: `person_${Math.random().toString(36).slice(2, 10)}`, name, color }];
    this._newPersonName = "";
    this._closePeopleModal();
    await this._saveBoard();
  }

  _onTaskFieldInput(field, value) {
    this._taskForm = { ...this._taskForm, [field]: value };
  }

  _toggleTaskAssignee(personId) {
    const set = new Set(this._taskForm.assignees);
    if (set.has(personId)) set.delete(personId);
    else set.add(personId);
    this._taskForm = { ...this._taskForm, assignees: [...set] };
    this._render();
  }

  _toggleTaskWeekday(dayKey) {
    const set = new Set(this._taskForm.weekdays);
    if (set.has(dayKey)) set.delete(dayKey);
    else set.add(dayKey);
    this._taskForm = { ...this._taskForm, weekdays: [...set] };
    this._render();
  }

  _buildFixedInstancesForCurrentWeek(template, title, assignees) {
    const todayIso = this._todayIsoDate();
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
      });
    }
    return items;
  }

  async _createTaskFromForm() {
    const form = this._taskForm;
    if (!form.title.trim()) return;
    const effectiveFixed = form.fixed || form.weekdays.length > 0;

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
    const effectiveFixed = form.fixed || form.weekdays.length > 0;

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
      });
    }

    this._reindexAllColumns();
    this._closeTaskModal();
    await this._saveBoard();
  }

  async _onSubmitTaskForm(ev) {
    ev.preventDefault();
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
    return task.assignees
      .map((personId) => this._board.people.find((p) => p.id === personId))
      .filter(Boolean)
      .map(
        (person) =>
          `<span class="chip" draggable="true" data-person-id="${person.id}" style="background:${person.color}" title="${this._escape(person.name)}">${this._personInitial(person.name)}</span>`
      )
      .join("");
  }

  _taskMetaLine(task) {
    const bits = [];
    if (task.fixed) bits.push("fixed");
    if (task.end_date) bits.push(`until ${task.end_date}`);
    return bits.length ? `<div class="task-sub">${this._escape(bits.join(" • "))}</div>` : "";
  }

  _renderTaskCard(task) {
    return `
      <article class="task" draggable="true" data-task-id="${task.id}">
        <div class="task-title">${this._escape(task.title)}</div>
        ${this._taskMetaLine(task)}
        <div class="task-meta">${this._assigneeChips(task)}</div>
      </article>
    `;
  }

  _renderColumn(column) {
    const tasks = this._tasksForColumn(column.key);
    const isSideLane = column.key === "backlog" || column.key === "done";
    return `
      <section class="column ${isSideLane ? "side-lane" : "week-lane"}" data-column="${column.key}">
        <header><h3>${column.label}</h3><span>${tasks.length}</span></header>
        <div class="tasks">
          ${tasks.length ? tasks.map((task) => this._renderTaskCard(task)).join("") : '<div class="empty">Drop here</div>'}
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
              `<div class="legend-item"><span class="chip" draggable="true" data-person-id="${person.id}" style="background:${person.color}">${this._personInitial(person.name)}</span><span class="legend-name">${this._escape(person.name)}</span></div>`
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
            ${showWeekdayMode ? "" : `<select id="task-column">${this._columns().map((c) => `<option value="${c.key}" ${form.column === c.key ? "selected" : ""}>${c.label}</option>`).join("")}</select>`}
            <div class="assignees">
              ${this._board.people
                .map(
                  (person) => `<label><input type="checkbox" name="assignee" value="${person.id}" ${form.assignees.includes(person.id) ? "checked" : ""} /><span class="chip" style="background:${person.color}">${this._personInitial(person.name)}</span></label>`
                )
                .join("")}
            </div>
            <div class="modal-actions">
              ${form.mode === "edit" ? '<button type="button" class="danger" id="delete-task">Delete</button>' : ""}
              <button type="submit" ${this._saving ? "disabled" : ""}>${this._saving ? "Saving..." : form.mode === "edit" ? "Save" : "Create"}</button>
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
            <button type="submit">Add</button>
          </form>
          <div class="small">Tip: drag a person badge onto any task to assign.</div>
          <div style="margin-top:8px;">${this._renderPeopleLegend()}</div>
        </div>
      </div>
    `;
  }

  _render() {
    if (!this.shadowRoot || !this._config) return;
    const loadingHtml = this._loading ? `<div class="loading">Loading board...</div>` : "";
    const errorHtml = this._error ? `<div class="error">${this._escape(this._error)}</div>` : "";

    this.shadowRoot.innerHTML = `
      <style>
        :host{--hc-bg:linear-gradient(145deg,#f8fafc 0%,#eef2ff 100%);--hc-text:#0f172a;--hc-muted:#64748b;--hc-border:#dbe3ef;--hc-card:#fff;--hc-accent:#0f766e;display:block}
        ha-card{background:var(--hc-bg);color:var(--hc-text);border-radius:18px;border:1px solid var(--hc-border);overflow:hidden}
        .wrap{display:grid;gap:12px;padding:12px}
        .panel{background:var(--hc-card);border:1px solid var(--hc-border);border-radius:14px;padding:10px}
        .actions{display:grid;grid-template-columns:1fr 1fr;gap:8px}
        .action-btn{font:inherit;border-radius:10px;border:1px solid transparent;padding:10px;background:var(--hc-accent);color:#fff;font-weight:700;cursor:pointer}
        .legend-inline{margin-top:8px;display:flex;gap:6px;flex-wrap:wrap}
        .chip{width:22px;height:22px;border-radius:999px;color:#fff;font-weight:700;font-size:.75rem;display:inline-flex;align-items:center;justify-content:center;box-shadow:inset 0 -1px 0 rgba(0,0,0,.2)}
        .small{font-size:.8rem;color:var(--hc-muted);margin-top:6px}
        .columns-wrap{display:grid;gap:10px}
        .week-scroll{overflow-x:hidden}
        .week-columns{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:8px;min-width:0}
        .side-columns{display:grid;grid-template-columns:1fr 1fr;gap:8px}
        .column{background:var(--hc-card);border:1px solid var(--hc-border);border-radius:12px;padding:8px;display:grid;grid-template-rows:auto 1fr;min-height:220px}
        .week-columns .column.week-lane{min-height:360px;max-height:360px}
        .week-columns .column.week-lane .tasks{max-height:300px;overflow-y:auto;overflow-x:hidden;padding-right:2px}
        .side-columns .column.side-lane{min-height:170px}
        .side-columns .column.side-lane .tasks{display:flex;flex-direction:row;align-items:flex-start;overflow-x:auto;overflow-y:hidden;gap:6px;padding-bottom:3px}
        .side-columns .column.side-lane .task{min-width:180px;flex:0 0 180px}
        .column.drag-over{border-color:#2563eb;box-shadow:inset 0 0 0 1px #2563eb;background:#f0f7ff}
        .column header{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
        .column h3{margin:0;font-size:.82rem}
        .column header span{font-size:.75rem;color:var(--hc-muted)}
        .tasks{display:grid;gap:6px;align-content:start}
        .task{background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:7px;cursor:grab;user-select:none}
        .task-title{font-size:.78rem;font-weight:600;line-height:1.25}
        .task-sub{margin-top:4px;color:#64748b;font-size:.73rem}
        .task-meta{margin-top:6px;display:flex;gap:4px;flex-wrap:wrap}
        .empty{border:1px dashed #cbd5e1;border-radius:9px;padding:10px 8px;color:#94a3b8;text-align:center;font-size:.77rem}
        .empty-mini{color:#94a3b8;font-size:.8rem}
        .loading{color:var(--hc-muted);font-size:.85rem}
        .error{color:#b91c1c;font-size:.85rem;background:#fee2e2;border:1px solid #fecaca;padding:8px;border-radius:8px}
        input,select,button{font:inherit;border-radius:10px;border:1px solid var(--hc-border);padding:8px 10px}
        input,select{background:#fff;color:var(--hc-text)}
        .modal-backdrop{position:fixed;inset:0;background:rgba(15,23,42,.45);display:flex;align-items:center;justify-content:center;z-index:999;padding:14px}
        .modal{width:min(540px,100%);max-height:88vh;overflow:auto;background:#fff;border-radius:14px;border:1px solid var(--hc-border);padding:12px;box-shadow:0 18px 50px rgba(2,6,23,.28)}
        .modal-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
        .modal-head h3{margin:0;font-size:1rem}
        .close-btn{background:#e2e8f0;color:#0f172a;border:1px solid #cbd5e1;min-width:36px;padding:6px 10px}
        .row{display:flex;gap:6px;align-items:center}
        .legend-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:6px}
        .legend-item{display:flex;align-items:center;gap:6px;background:#f8fafc;border-radius:9px;padding:4px 6px}
        .legend-name{font-size:.82rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
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
        @media (max-width:900px){
          .side-columns{grid-template-columns:1fr}
          .column h3{font-size:.76rem}
          .task-title{font-size:.73rem}
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
        }
      </style>

      <ha-card header="${this._escape(this._config.title)}">
        <div class="wrap">
          ${loadingHtml}
          ${errorHtml}
          <div class="panel">
            <div class="actions">
              <button class="action-btn" type="button" id="open-people">People</button>
              <button class="action-btn" type="button" id="open-task">Add task</button>
            </div>
            <div class="legend-inline">
              ${this._board.people.slice(0, 12).map((person) => `<span class="chip" draggable="true" data-person-id="${person.id}" style="background:${person.color}" title="${this._escape(person.name)}">${this._personInitial(person.name)}</span>`).join("")}
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
    `;

    const openPeopleBtn = this.shadowRoot.querySelector("#open-people");
    const openTaskBtn = this.shadowRoot.querySelector("#open-task");
    const closePeopleBtn = this.shadowRoot.querySelector("#close-people");
    const closeTaskBtn = this.shadowRoot.querySelector("#close-task");
    const peopleBackdrop = this.shadowRoot.querySelector("#people-backdrop");
    const taskBackdrop = this.shadowRoot.querySelector("#task-backdrop");
    const personForm = this.shadowRoot.querySelector("#person-form");
    const personInput = this.shadowRoot.querySelector("#person-name");
    const taskForm = this.shadowRoot.querySelector("#task-form");
    const taskTitleInput = this.shadowRoot.querySelector("#task-title");
    const taskColumnInput = this.shadowRoot.querySelector("#task-column");
    const taskEndDateInput = this.shadowRoot.querySelector("#task-end-date");
    const taskFixedInput = this.shadowRoot.querySelector("#task-fixed");
    const deleteTaskBtn = this.shadowRoot.querySelector("#delete-task");

    if (openPeopleBtn) openPeopleBtn.addEventListener("click", () => this._openPeopleModal());
    if (openTaskBtn) openTaskBtn.addEventListener("click", () => this._openAddTaskModal());
    if (closePeopleBtn) closePeopleBtn.addEventListener("click", () => this._closePeopleModal());
    if (closeTaskBtn) closeTaskBtn.addEventListener("click", () => this._closeTaskModal());
    if (peopleBackdrop) peopleBackdrop.addEventListener("click", (ev) => { if (ev.target === peopleBackdrop) this._closePeopleModal(); });
    if (taskBackdrop) taskBackdrop.addEventListener("click", (ev) => { if (ev.target === taskBackdrop) this._closeTaskModal(); });

    if (personForm) personForm.addEventListener("submit", (ev) => this._onAddPerson(ev));
    if (personInput) personInput.addEventListener("input", (ev) => this._onPersonNameInput(ev));

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

    this.shadowRoot.querySelectorAll(".weekday-dot").forEach((dot) => {
      dot.addEventListener("click", () => this._toggleTaskWeekday(dot.dataset.weekday));
    });

    this.shadowRoot.querySelectorAll("input[name='assignee']").forEach((cb) => {
      cb.addEventListener("change", () => this._toggleTaskAssignee(cb.value));
    });

    this.shadowRoot.querySelectorAll("[data-person-id]").forEach((el) => {
      el.addEventListener("dragstart", (ev) => {
        ev.dataTransfer.effectAllowed = "copy";
        ev.dataTransfer.setData("text/person", el.dataset.personId);
      });
    });

    this.shadowRoot.querySelectorAll(".task").forEach((taskEl) => {
      const taskId = taskEl.dataset.taskId;
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

      taskEl.addEventListener("click", () => {
        if (this._draggingTask) return;
        this._openEditTaskModal(taskId);
      });

      taskEl.addEventListener("dragover", (ev) => {
        if (ev.dataTransfer.types.includes("text/person")) ev.preventDefault();
      });

      taskEl.addEventListener("drop", async (ev) => {
        const personId = ev.dataTransfer.getData("text/person");
        if (!personId) return;
        ev.preventDefault();
        const task = this._board.tasks.find((t) => t.id === taskId);
        if (!task) return;
        if (!task.assignees.includes(personId)) task.assignees.push(personId);

        if (task.template_id) {
          const tpl = this._board.templates.find((x) => x.id === task.template_id);
          if (tpl && !tpl.assignees.includes(personId)) tpl.assignees.push(personId);
          this._board.tasks.forEach((t) => {
            if (t.template_id === task.template_id && !t.assignees.includes(personId)) t.assignees.push(personId);
          });
        }

        this._render();
        await this._saveBoard();
      });
    });

    this.shadowRoot.querySelectorAll(".column").forEach((columnEl) => {
      const columnKey = columnEl.dataset.column;
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
        if (!taskId) return;
        ev.preventDefault();

        const task = this._board.tasks.find((t) => t.id === taskId);
        if (!task) return;
        task.column = columnKey;
        this._reindexAllColumns();
        this._render();
        await this._saveBoard();
      });
    });
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
