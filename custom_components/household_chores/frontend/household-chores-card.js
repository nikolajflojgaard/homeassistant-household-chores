class HouseholdChoresCard extends HTMLElement {
  static getConfigElement() {
    return document.createElement("ha-form");
  }

  static getStubConfig() {
    return {
      type: "custom:household-chores-card",
      title: "Household Chores",
    };
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._config = null;
    this._board = { people: [], tasks: [], templates: [] };
    this._loading = true;
    this._saving = false;
    this._error = "";
    this._newPersonName = "";
    this._newTaskTitle = "";
    this._newTaskColumn = "backlog";
    this._newTaskEndDate = "";
    this._newTaskFixed = false;
    this._newTaskWeekdays = [];
    this._showPeopleModal = false;
    this._showTaskModal = false;
    this._dragTaskId = "";
    this._dragOverColumn = "";
  }

  setConfig(config) {
    this._config = {
      title: config.title || "Household Chores",
      entry_id: config.entry_id || "",
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
    return [
      { key: "monday", label: "Mon" },
      { key: "tuesday", label: "Tue" },
      { key: "wednesday", label: "Wed" },
      { key: "thursday", label: "Thu" },
      { key: "friday", label: "Fri" },
      { key: "saturday", label: "Sat" },
      { key: "sunday", label: "Sun" },
    ];
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

  _autoColor(index) {
    const hue = (index * 47) % 360;
    return `hsl(${hue} 72% 42%)`;
  }

  _personInitial(name) {
    return (name || "?").trim().charAt(0).toUpperCase() || "?";
  }

  _escape(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  _todayIsoDate() {
    return new Date().toISOString().slice(0, 10);
  }

  _startOfWeek(baseDate = new Date()) {
    const d = new Date(baseDate);
    const day = d.getDay(); // Sun=0 .. Sat=6
    const diff = (day + 6) % 7; // Monday-based offset
    d.setDate(d.getDate() - diff);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  _weekdayDateForCurrentWeek(weekdayKey) {
    const weekStart = this._startOfWeek();
    const index = this._weekdayKeys().findIndex((item) => item.key === weekdayKey);
    if (index < 0) return null;
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + index);
    return d;
  }

  _toIsoDate(dateObj) {
    return dateObj.toISOString().slice(0, 10);
  }

  async _resolveEntryId() {
    if (!this._hass || this._config.entry_id) return;
    try {
      const result = await this._hass.callWS({ type: "household_chores/list_entries" });
      const entries = result?.entries || [];
      if (entries.length === 1) {
        this._config.entry_id = entries[0].entry_id;
      }
    } catch (_err) {
      // Friendly error handled in _loadBoard.
    }
  }

  _normalizeBoard(board) {
    const people = Array.isArray(board.people) ? board.people : [];
    const tasks = Array.isArray(board.tasks) ? board.tasks : [];
    const templates = Array.isArray(board.templates) ? board.templates : [];
    const validColumns = this._columns().map((column) => column.key);

    return {
      people: people.map((person, index) => ({
        id: person.id || `person_${index}`,
        name: (person.name || "Person").trim() || "Person",
        color: person.color || this._autoColor(index),
      })),
      tasks: tasks
        .map((task, index) => ({
          id: task.id || `task_${index}`,
          title: (task.title || "").trim(),
          assignees: Array.isArray(task.assignees) ? task.assignees : [],
          column: validColumns.includes(task.column) ? task.column : "backlog",
          order: Number.isFinite(task.order) ? task.order : index,
          created_at: task.created_at || new Date().toISOString(),
          end_date: task.end_date || "",
          template_id: task.template_id || "",
          fixed: Boolean(task.fixed),
        }))
        .filter((task) => task.title),
      templates: templates
        .map((tpl, index) => ({
          id: tpl.id || `tpl_${index}`,
          title: (tpl.title || "").trim(),
          assignees: Array.isArray(tpl.assignees) ? tpl.assignees : [],
          end_date: tpl.end_date || "",
          weekdays: Array.isArray(tpl.weekdays) ? tpl.weekdays.filter((day) => this._weekdayKeys().some((w) => w.key === day)) : [],
          created_at: tpl.created_at || new Date().toISOString(),
        }))
        .filter((tpl) => tpl.title && tpl.end_date && tpl.weekdays.length),
    };
  }

  async _loadBoard() {
    if (!this._hass || !this._config) return;
    if (!this._config.entry_id) {
      await this._resolveEntryId();
      if (!this._config.entry_id) {
        this._error = "Set entry_id in card config or keep only one Household Chores integration entry.";
        this._loading = false;
        this._render();
        return;
      }
    }

    this._loading = true;
    this._error = "";
    this._render();

    try {
      const result = await this._hass.callWS({
        type: "household_chores/get_board",
        entry_id: this._config.entry_id,
      });
      this._board = this._normalizeBoard(result.board || { people: [], tasks: [], templates: [] });
    } catch (err) {
      this._error = `Failed to load board: ${err?.message || err}`;
    } finally {
      this._loading = false;
      this._render();
    }
  }

  async _saveBoard() {
    if (!this._hass || !this._config?.entry_id) return;
    this._saving = true;
    this._error = "";
    this._render();

    try {
      const result = await this._hass.callWS({
        type: "household_chores/save_board",
        entry_id: this._config.entry_id,
        board: this._board,
      });
      this._board = this._normalizeBoard(result.board || this._board);
    } catch (err) {
      this._error = `Failed to save board: ${err?.message || err}`;
    } finally {
      this._saving = false;
      this._render();
    }
  }

  _tasksForColumn(column) {
    return this._board.tasks
      .filter((task) => task.column === column)
      .sort((a, b) => a.order - b.order || a.created_at.localeCompare(b.created_at));
  }

  _renumberColumn(columnKey) {
    const tasks = this._tasksForColumn(columnKey);
    tasks.forEach((task, index) => {
      task.order = index;
    });
  }

  _onPersonNameInput(ev) {
    this._newPersonName = ev.target.value;
  }

  _openPeopleModal() {
    this._showPeopleModal = true;
    this._render();
  }

  _closePeopleModal() {
    this._showPeopleModal = false;
    this._render();
  }

  _openTaskModal() {
    this._showTaskModal = true;
    this._render();
  }

  _closeTaskModal() {
    this._showTaskModal = false;
    this._render();
  }

  async _onAddPerson(ev) {
    ev.preventDefault();
    const name = this._newPersonName.trim();
    if (!name) return;

    const taken = new Set(this._board.people.map((person) => person.color));
    let color = this._autoColor(this._board.people.length);
    for (let i = 0; i < 200 && taken.has(color); i += 1) {
      color = this._autoColor(this._board.people.length + i + 1);
    }

    this._board.people = [
      ...this._board.people,
      {
        id: `person_${Math.random().toString(36).slice(2, 10)}`,
        name,
        color,
      },
    ];

    this._newPersonName = "";
    this._showPeopleModal = false;
    this._render();
    await this._saveBoard();
  }

  _onTaskTitleInput(ev) {
    this._newTaskTitle = ev.target.value;
  }

  _onTaskColumnInput(ev) {
    this._newTaskColumn = ev.target.value;
  }

  _onTaskEndDateInput(ev) {
    this._newTaskEndDate = ev.target.value;
  }

  _onTaskFixedInput(ev) {
    this._newTaskFixed = Boolean(ev.target.checked);
    if (!this._newTaskFixed) {
      this._newTaskWeekdays = [];
    }
    this._render();
  }

  _toggleWeekday(dayKey) {
    if (!this._newTaskFixed) return;
    if (this._newTaskWeekdays.includes(dayKey)) {
      this._newTaskWeekdays = this._newTaskWeekdays.filter((day) => day !== dayKey);
    } else {
      this._newTaskWeekdays = [...this._newTaskWeekdays, dayKey];
    }
    this._render();
  }

  _buildFixedInstancesForCurrentWeek(template, title, assignees) {
    const todayIso = this._todayIsoDate();
    const endDateIso = template.end_date;
    const items = [];

    for (const dayKey of template.weekdays) {
      const dayDate = this._weekdayDateForCurrentWeek(dayKey);
      if (!dayDate) continue;
      const dayIso = this._toIsoDate(dayDate);
      if (dayIso < todayIso) continue;
      if (dayIso > endDateIso) continue;

      items.push({
        id: `task_${Math.random().toString(36).slice(2, 10)}`,
        title,
        assignees,
        column: dayKey,
        order: this._tasksForColumn(dayKey).length + items.filter((i) => i.column === dayKey).length,
        created_at: new Date().toISOString(),
        end_date: endDateIso,
        template_id: template.id,
        fixed: true,
      });
    }

    return items;
  }

  async _onAddTask(ev) {
    ev.preventDefault();
    const title = this._newTaskTitle.trim();
    if (!title) return;

    const form = ev.target;
    const checkedBoxes = [...form.querySelectorAll("input[name='assignee']:checked")];
    const assignees = checkedBoxes.map((box) => box.value);

    if (this._newTaskFixed) {
      if (!this._newTaskEndDate) {
        this._error = "Fixed tasks require an end date.";
        this._render();
        return;
      }
      if (!this._newTaskWeekdays.length) {
        this._error = "Select at least one weekday for fixed tasks.";
        this._render();
        return;
      }

      const template = {
        id: `tpl_${Math.random().toString(36).slice(2, 10)}`,
        title,
        assignees,
        end_date: this._newTaskEndDate,
        weekdays: [...this._newTaskWeekdays],
        created_at: new Date().toISOString(),
      };

      const instances = this._buildFixedInstancesForCurrentWeek(template, title, assignees);
      this._board.templates = [...(this._board.templates || []), template];
      this._board.tasks = [...this._board.tasks, ...instances];
    } else {
      const newTask = {
        id: `task_${Math.random().toString(36).slice(2, 10)}`,
        title,
        assignees,
        column: this._newTaskColumn,
        order: this._tasksForColumn(this._newTaskColumn).length,
        created_at: new Date().toISOString(),
        end_date: this._newTaskEndDate || "",
        template_id: "",
        fixed: false,
      };
      this._board.tasks = [...this._board.tasks, newTask];
    }

    this._newTaskTitle = "";
    this._newTaskColumn = "backlog";
    this._newTaskEndDate = "";
    this._newTaskFixed = false;
    this._newTaskWeekdays = [];
    this._showTaskModal = false;
    this._error = "";
    this._render();
    await this._saveBoard();
  }

  _assigneeChips(task) {
    return task.assignees
      .map((personId) => this._board.people.find((person) => person.id === personId))
      .filter(Boolean)
      .map(
        (person) => `
          <span class="chip" style="background:${person.color}" title="${this._escape(person.name)}">
            ${this._personInitial(person.name)}
          </span>
        `
      )
      .join("");
  }

  _taskMetaLine(task) {
    const bits = [];
    if (task.fixed) bits.push("fixed");
    if (task.end_date) bits.push(`until ${task.end_date}`);
    if (!bits.length) return "";
    return `<div class=\"task-sub\">${this._escape(bits.join(" • "))}</div>`;
  }

  _onDragStart(ev, taskId) {
    this._dragTaskId = taskId;
    ev.dataTransfer.effectAllowed = "move";
    ev.dataTransfer.setData("text/plain", taskId);
  }

  _onDragOverColumn(ev, columnKey) {
    ev.preventDefault();
    this._dragOverColumn = columnKey;
    ev.dataTransfer.dropEffect = "move";
    this._render();
  }

  _onDragLeaveColumn(columnKey) {
    if (this._dragOverColumn === columnKey) {
      this._dragOverColumn = "";
      this._render();
    }
  }

  async _onDropColumn(ev, columnKey) {
    ev.preventDefault();
    const taskId = ev.dataTransfer.getData("text/plain") || this._dragTaskId;
    if (!taskId) return;

    const task = this._board.tasks.find((item) => item.id === taskId);
    if (!task) return;

    const fromColumn = task.column;
    task.column = columnKey;
    task.order = this._tasksForColumn(columnKey).length;

    this._renumberColumn(fromColumn);
    this._renumberColumn(columnKey);
    this._dragTaskId = "";
    this._dragOverColumn = "";
    this._render();
    await this._saveBoard();
  }

  _renderPeopleLegend() {
    if (!this._board.people.length) {
      return `<div class="empty-mini">No people yet</div>`;
    }

    return `
      <div class="legend-list">
        ${this._board.people
          .map(
            (person) => `
              <div class="legend-item">
                <span class="chip" style="background:${person.color}">${this._personInitial(person.name)}</span>
                <span class="legend-name">${this._escape(person.name)}</span>
              </div>
            `
          )
          .join("")}
      </div>
    `;
  }

  _renderWeekdaySelector() {
    return `
      <div class="weekday-picks">
        ${this._weekdayKeys()
          .map((day) => {
            const selected = this._newTaskWeekdays.includes(day.key);
            return `<button type=\"button\" class=\"weekday-dot ${selected ? "sel" : ""}\" data-weekday=\"${day.key}\">${day.short}</button>`;
          })
          .join("")}
      </div>
    `;
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
    const isDragOver = this._dragOverColumn === column.key;
    const isSideLane = column.key === "backlog" || column.key === "done";
    const laneClass = isSideLane ? "side-lane" : "week-lane";

    return `
      <section class="column ${laneClass} ${isDragOver ? "drag-over" : ""}" data-column="${column.key}">
        <header>
          <h3>${column.label}</h3>
          <span>${tasks.length}</span>
        </header>
        <div class="tasks">
          ${tasks.length ? tasks.map((task) => this._renderTaskCard(task)).join("") : '<div class="empty">Drop here</div>'}
        </div>
      </section>
    `;
  }

  _render() {
    if (!this.shadowRoot || !this._config) return;

    const loadingHtml = this._loading ? `<div class="loading">Loading board...</div>` : "";
    const errorHtml = this._error ? `<div class="error">${this._escape(this._error)}</div>` : "";

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          --hc-bg: linear-gradient(145deg, #f8fafc 0%, #eef2ff 100%);
          --hc-text: #0f172a;
          --hc-muted: #64748b;
          --hc-border: #dbe3ef;
          --hc-card: #ffffff;
          --hc-accent: #0f766e;
          display: block;
        }

        ha-card {
          background: var(--hc-bg);
          color: var(--hc-text);
          border-radius: 18px;
          border: 1px solid var(--hc-border);
          overflow: hidden;
        }

        .wrap { display: grid; gap: 12px; padding: 12px; }
        .top { display: grid; grid-template-columns: 1fr; gap: 10px; }
        .panel { background: var(--hc-card); border: 1px solid var(--hc-border); border-radius: 14px; padding: 10px; }
        .panel h2 { margin: 0 0 8px; font-size: 0.98rem; line-height: 1.2; }
        .row { display: flex; gap: 6px; align-items: center; }

        input, select, button {
          font: inherit;
          border-radius: 10px;
          border: 1px solid var(--hc-border);
          padding: 8px 10px;
        }

        input, select { background: #fff; min-width: 0; color: var(--hc-text); }
        button { background: var(--hc-accent); color: #fff; border-color: transparent; cursor: pointer; white-space: nowrap; }

        .small { font-size: 0.8rem; color: var(--hc-muted); margin-top: 6px; }
        .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
        .action-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          font-weight: 700;
          min-height: 40px;
        }
        .legend-inline {
          margin-top: 8px;
          display: flex;
          gap: 6px;
          flex-wrap: wrap;
        }
        .legend-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 6px; }
        .legend-item { display: flex; align-items: center; gap: 6px; background: #f8fafc; border-radius: 9px; padding: 4px 6px; }
        .legend-name { font-size: 0.82rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

        .chip {
          width: 22px;
          height: 22px;
          border-radius: 999px;
          color: #fff;
          font-weight: 700;
          font-size: 0.75rem;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          box-shadow: inset 0 -1px 0 rgba(0,0,0,0.2);
        }

        .task-form { margin-top: 10px; display: grid; gap: 8px; }
        .toggle-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
        .toggle-row label { display: flex; gap: 6px; align-items: center; font-size: 0.84rem; }

        .weekday-picks { display: flex; gap: 6px; flex-wrap: wrap; }
        .weekday-dot {
          width: 28px;
          height: 28px;
          border-radius: 999px;
          border: 1px solid #cbd5e1;
          background: #fff;
          color: #334155;
          padding: 0;
          font-size: 0.76rem;
          font-weight: 700;
        }
        .weekday-dot.sel { background: #0f766e; border-color: #0f766e; color: #fff; }

        .assignees { display: flex; flex-wrap: wrap; gap: 8px; }
        .assignees label { display: flex; align-items: center; gap: 5px; font-size: 0.78rem; }

        .columns-wrap { display: grid; gap: 10px; }
        .week-scroll { overflow-x: auto; padding-bottom: 2px; }
        .week-columns { display: grid; grid-template-columns: repeat(7, minmax(170px, 1fr)); gap: 8px; min-width: 860px; }
        .side-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }

        .column {
          background: var(--hc-card);
          border: 1px solid var(--hc-border);
          border-radius: 12px;
          padding: 8px;
          min-height: 220px;
          display: grid;
          grid-template-rows: auto 1fr;
        }

        .week-columns .column.week-lane {
          min-height: 360px;
          max-height: 360px;
        }

        .week-columns .column.week-lane .tasks {
          max-height: 300px;
          overflow-y: auto;
          overflow-x: hidden;
          padding-right: 2px;
        }

        .side-columns .column.side-lane {
          min-height: 170px;
        }

        .side-columns .column.side-lane .tasks {
          display: flex;
          flex-direction: row;
          align-items: flex-start;
          overflow-x: auto;
          overflow-y: hidden;
          padding-bottom: 3px;
          gap: 6px;
        }

        .side-columns .column.side-lane .task {
          min-width: 180px;
          flex: 0 0 180px;
        }

        .column.drag-over {
          border-color: #2563eb;
          box-shadow: inset 0 0 0 1px #2563eb;
          background: #f0f7ff;
        }

        .column header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
        .column h3 { margin: 0; font-size: 0.85rem; letter-spacing: 0.01em; }
        .column header span { font-size: 0.75rem; color: var(--hc-muted); }

        .tasks { display: grid; gap: 6px; align-content: start; }
        .task { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 7px; cursor: grab; user-select: none; }
        .task:active { cursor: grabbing; }
        .task-title { font-size: 0.82rem; font-weight: 600; line-height: 1.25; }
        .task-sub { margin-top: 4px; color: #64748b; font-size: 0.73rem; }
        .task-meta { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 4px; }

        .empty { border: 1px dashed #cbd5e1; border-radius: 9px; padding: 10px 8px; color: #94a3b8; text-align: center; font-size: 0.77rem; }
        .empty-mini { color: #94a3b8; font-size: 0.8rem; }
        .loading { color: var(--hc-muted); font-size: 0.85rem; }

        .error {
          color: #b91c1c;
          font-size: 0.85rem;
          background: #fee2e2;
          border: 1px solid #fecaca;
          padding: 8px;
          border-radius: 8px;
        }

        .modal-backdrop {
          position: fixed;
          inset: 0;
          background: rgba(15, 23, 42, 0.45);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 999;
          padding: 14px;
        }
        .modal {
          width: min(540px, 100%);
          max-height: 88vh;
          overflow: auto;
          background: #ffffff;
          border-radius: 14px;
          border: 1px solid var(--hc-border);
          padding: 12px;
          box-shadow: 0 18px 50px rgba(2, 6, 23, 0.28);
        }
        .modal-head {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 10px;
        }
        .modal-head h3 {
          margin: 0;
          font-size: 1rem;
        }
        .close-btn {
          background: #e2e8f0;
          color: #0f172a;
          border: 1px solid #cbd5e1;
          min-width: 36px;
          padding: 6px 10px;
        }

        @media (max-width: 900px) {
          .top { grid-template-columns: 1fr; }
          .week-columns { min-width: 820px; }
          .side-columns { grid-template-columns: 1fr; }
        }
      </style>

      <ha-card header="${this._escape(this._config.title)}">
        <div class="wrap">
          ${loadingHtml}
          ${errorHtml}

          <div class="top">
            <div class="panel">
              <div class="actions">
                <button class="action-btn" type="button" id="open-people">People</button>
                <button class="action-btn" type="button" id="open-task">Add task</button>
              </div>
              <div class="legend-inline">
                ${this._board.people
                  .slice(0, 8)
                  .map(
                    (person) =>
                      `<span class="chip" style="background:${person.color}" title="${this._escape(person.name)}">${this._personInitial(person.name)}</span>`
                  )
                  .join("")}
              </div>
              <div class="small">Compact mode: tap buttons to open forms.</div>
            </div>
          </div>

          <div class="columns-wrap">
            <div class="week-scroll">
              <div class="week-columns">
                ${this._weekColumns().map((column) => this._renderColumn(column)).join("")}
              </div>
            </div>
            <div class="side-columns">
              ${this._renderColumn({ key: "backlog", label: "Backlog" })}
              ${this._renderColumn({ key: "done", label: "Done" })}
            </div>
          </div>
        </div>
      </ha-card>

      ${this._showPeopleModal ? `
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
            <div class="small">Each person gets a unique color badge.</div>
            <div style="margin-top:8px;">${this._renderPeopleLegend()}</div>
          </div>
        </div>
      ` : ""}

      ${this._showTaskModal ? `
        <div class="modal-backdrop" id="task-backdrop">
          <div class="modal">
            <div class="modal-head">
              <h3>Add task</h3>
              <button type="button" class="close-btn" id="close-task">X</button>
            </div>
            <form class="task-form" id="task-form">
              <input id="task-title" type="text" placeholder="Task title" value="${this._escape(this._newTaskTitle)}" />

              <div class="toggle-row">
                <label><input id="task-fixed" type="checkbox" ${this._newTaskFixed ? "checked" : ""} /> Fixed until date</label>
                <input id="task-end-date" type="date" value="${this._escape(this._newTaskEndDate)}" />
              </div>

              ${this._newTaskFixed ? this._renderWeekdaySelector() : `<select id="task-column">${this._columns().map((column) => `<option value="${column.key}" ${this._newTaskColumn === column.key ? "selected" : ""}>${column.label}</option>`).join("")}</select>`}

              <div class="assignees">
                ${this._board.people
                  .map(
                    (person) => `
                      <label>
                        <input type="checkbox" name="assignee" value="${person.id}" />
                        <span class="chip" style="background:${person.color}">${this._personInitial(person.name)}</span>
                      </label>
                    `
                  )
                  .join("")}
              </div>

              <button type="submit" ${this._saving ? "disabled" : ""}>${this._saving ? "Saving..." : "Create"}</button>
              <div class="small">No end date: task is removed on weekly refresh (or nightly if moved to Done).</div>
            </form>
          </div>
        </div>
      ` : ""}
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

    if (openPeopleBtn) openPeopleBtn.addEventListener("click", () => this._openPeopleModal());
    if (openTaskBtn) openTaskBtn.addEventListener("click", () => this._openTaskModal());
    if (closePeopleBtn) closePeopleBtn.addEventListener("click", () => this._closePeopleModal());
    if (closeTaskBtn) closeTaskBtn.addEventListener("click", () => this._closeTaskModal());
    if (peopleBackdrop) {
      peopleBackdrop.addEventListener("click", (ev) => {
        if (ev.target === peopleBackdrop) this._closePeopleModal();
      });
    }
    if (taskBackdrop) {
      taskBackdrop.addEventListener("click", (ev) => {
        if (ev.target === taskBackdrop) this._closeTaskModal();
      });
    }
    if (personForm) personForm.addEventListener("submit", (ev) => this._onAddPerson(ev));
    if (personInput) personInput.addEventListener("input", (ev) => this._onPersonNameInput(ev));
    if (taskForm) taskForm.addEventListener("submit", (ev) => this._onAddTask(ev));
    if (taskTitleInput) taskTitleInput.addEventListener("input", (ev) => this._onTaskTitleInput(ev));
    if (taskColumnInput) taskColumnInput.addEventListener("change", (ev) => this._onTaskColumnInput(ev));
    if (taskEndDateInput) taskEndDateInput.addEventListener("change", (ev) => this._onTaskEndDateInput(ev));
    if (taskFixedInput) taskFixedInput.addEventListener("change", (ev) => this._onTaskFixedInput(ev));

    this.shadowRoot.querySelectorAll(".weekday-dot").forEach((dot) => {
      dot.addEventListener("click", () => this._toggleWeekday(dot.dataset.weekday));
    });

    this.shadowRoot.querySelectorAll(".task").forEach((taskEl) => {
      taskEl.addEventListener("dragstart", (ev) => this._onDragStart(ev, taskEl.dataset.taskId));
    });

    this.shadowRoot.querySelectorAll(".column").forEach((columnEl) => {
      const columnKey = columnEl.dataset.column;
      columnEl.addEventListener("dragover", (ev) => this._onDragOverColumn(ev, columnKey));
      columnEl.addEventListener("dragleave", () => this._onDragLeaveColumn(columnKey));
      columnEl.addEventListener("drop", (ev) => this._onDropColumn(ev, columnKey));
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
  description: "Weekly chore planner with recurring fixed tasks, end dates, and drag/drop.",
});
