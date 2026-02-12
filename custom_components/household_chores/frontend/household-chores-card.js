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
    this._board = { people: [], tasks: [] };
    this._loading = true;
    this._saving = false;
    this._error = "";
    this._newPersonName = "";
    this._newTaskTitle = "";
    this._newTaskColumn = "backlog";
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

  async _resolveEntryId() {
    if (!this._hass || this._config.entry_id) return;
    try {
      const result = await this._hass.callWS({ type: "household_chores/list_entries" });
      const entries = result?.entries || [];
      if (entries.length === 1) {
        this._config.entry_id = entries[0].entry_id;
      }
    } catch (_err) {
      // No-op: a friendly error is shown during load.
    }
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
      this._board = this._normalizeBoard(result.board || { people: [], tasks: [] });
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

  _normalizeBoard(board) {
    const people = Array.isArray(board.people) ? board.people : [];
    const tasks = Array.isArray(board.tasks) ? board.tasks : [];
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
          column: this._columns().some((column) => column.key === task.column) ? task.column : "backlog",
          order: Number.isFinite(task.order) ? task.order : index,
          created_at: task.created_at || new Date().toISOString(),
        }))
        .filter((task) => task.title),
    };
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

  _tasksForColumn(column) {
    return this._board.tasks
      .filter((task) => task.column === column)
      .sort((a, b) => a.order - b.order || a.created_at.localeCompare(b.created_at));
  }

  _onPersonNameInput(ev) {
    this._newPersonName = ev.target.value;
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
    this._render();
    await this._saveBoard();
  }

  _onTaskTitleInput(ev) {
    this._newTaskTitle = ev.target.value;
  }

  _onTaskColumnInput(ev) {
    this._newTaskColumn = ev.target.value;
  }

  async _onAddTask(ev) {
    ev.preventDefault();
    const title = this._newTaskTitle.trim();
    if (!title) return;

    const form = ev.target;
    const checkedBoxes = [...form.querySelectorAll("input[name='assignee']:checked")];
    const assignees = checkedBoxes.map((box) => box.value);

    const newTask = {
      id: `task_${Math.random().toString(36).slice(2, 10)}`,
      title,
      assignees,
      column: this._newTaskColumn,
      order: this._tasksForColumn(this._newTaskColumn).length,
      created_at: new Date().toISOString(),
    };

    this._board.tasks = [...this._board.tasks, newTask];
    this._newTaskTitle = "";
    this._newTaskColumn = "backlog";
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

  _renumberColumn(columnKey) {
    const tasks = this._tasksForColumn(columnKey);
    tasks.forEach((task, index) => {
      task.order = index;
    });
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

  _renderTaskCard(task) {
    return `
      <article class="task" draggable="true" data-task-id="${task.id}">
        <div class="task-title">${this._escape(task.title)}</div>
        <div class="task-meta">${this._assigneeChips(task)}</div>
      </article>
    `;
  }

  _renderColumn(column) {
    const tasks = this._tasksForColumn(column.key);
    const isDragOver = this._dragOverColumn === column.key;

    return `
      <section class="column ${isDragOver ? "drag-over" : ""}" data-column="${column.key}">
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

        .wrap {
          display: grid;
          gap: 12px;
          padding: 12px;
        }

        .top {
          display: grid;
          grid-template-columns: 1.4fr 1fr;
          gap: 10px;
        }

        .panel {
          background: var(--hc-card);
          border: 1px solid var(--hc-border);
          border-radius: 14px;
          padding: 10px;
        }

        .panel h2 {
          margin: 0 0 8px;
          font-size: 0.98rem;
          line-height: 1.2;
        }

        .row {
          display: flex;
          gap: 6px;
          align-items: center;
        }

        input, select, button {
          font: inherit;
          border-radius: 10px;
          border: 1px solid var(--hc-border);
          padding: 8px 10px;
        }

        input, select {
          background: #fff;
          min-width: 0;
          color: var(--hc-text);
        }

        button {
          background: var(--hc-accent);
          color: #fff;
          border-color: transparent;
          cursor: pointer;
          white-space: nowrap;
        }

        .small {
          font-size: 0.8rem;
          color: var(--hc-muted);
          margin-top: 6px;
        }

        .legend-list {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
          gap: 6px;
        }

        .legend-item {
          display: flex;
          align-items: center;
          gap: 6px;
          background: #f8fafc;
          border-radius: 9px;
          padding: 4px 6px;
        }

        .legend-name {
          font-size: 0.82rem;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

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

        .task-form {
          margin-top: 10px;
          display: grid;
          gap: 8px;
        }

        .assignees {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
        }

        .assignees label {
          display: flex;
          align-items: center;
          gap: 5px;
          font-size: 0.78rem;
        }

        .columns-wrap {
          overflow-x: auto;
          padding-bottom: 2px;
        }

        .columns {
          display: grid;
          grid-template-columns: repeat(9, minmax(170px, 1fr));
          gap: 8px;
          min-width: 980px;
        }

        .column {
          background: var(--hc-card);
          border: 1px solid var(--hc-border);
          border-radius: 12px;
          padding: 8px;
          min-height: 220px;
          display: grid;
          grid-template-rows: auto 1fr;
        }

        .column.drag-over {
          border-color: #2563eb;
          box-shadow: inset 0 0 0 1px #2563eb;
          background: #f0f7ff;
        }

        .column header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 8px;
        }

        .column h3 {
          margin: 0;
          font-size: 0.85rem;
          letter-spacing: 0.01em;
        }

        .column header span {
          font-size: 0.75rem;
          color: var(--hc-muted);
        }

        .tasks {
          display: grid;
          gap: 6px;
          align-content: start;
        }

        .task {
          background: #f8fafc;
          border: 1px solid #e2e8f0;
          border-radius: 10px;
          padding: 7px;
          cursor: grab;
          user-select: none;
        }

        .task:active {
          cursor: grabbing;
        }

        .task-title {
          font-size: 0.82rem;
          font-weight: 600;
          line-height: 1.25;
        }

        .task-meta {
          margin-top: 6px;
          display: flex;
          flex-wrap: wrap;
          gap: 4px;
        }

        .empty {
          border: 1px dashed #cbd5e1;
          border-radius: 9px;
          padding: 10px 8px;
          color: #94a3b8;
          text-align: center;
          font-size: 0.77rem;
        }

        .empty-mini {
          color: #94a3b8;
          font-size: 0.8rem;
        }

        .loading {
          color: var(--hc-muted);
          font-size: 0.85rem;
        }

        .error {
          color: #b91c1c;
          font-size: 0.85rem;
          background: #fee2e2;
          border: 1px solid #fecaca;
          padding: 8px;
          border-radius: 8px;
        }

        @media (max-width: 900px) {
          .top {
            grid-template-columns: 1fr;
          }

          .columns {
            min-width: 880px;
          }
        }
      </style>

      <ha-card header="${this._escape(this._config.title)}">
        <div class="wrap">
          ${loadingHtml}
          ${errorHtml}

          <div class="top">
            <div class="panel">
              <h2>People</h2>
              <form class="row" id="person-form">
                <input id="person-name" type="text" placeholder="Add person" value="${this._escape(this._newPersonName)}" />
                <button type="submit">Add</button>
              </form>
              <div class="small">Each person gets a unique color badge.</div>
              <div style="margin-top:8px;">${this._renderPeopleLegend()}</div>
            </div>

            <div class="panel">
              <h2>Add task</h2>
              <form class="task-form" id="task-form">
                <input id="task-title" type="text" placeholder="Task title" value="${this._escape(this._newTaskTitle)}" />
                <select id="task-column">
                  ${this._columns()
                    .map(
                      (column) =>
                        `<option value="${column.key}" ${this._newTaskColumn === column.key ? "selected" : ""}>${column.label}</option>`
                    )
                    .join("")}
                </select>
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
              </form>
            </div>
          </div>

          <div class="columns-wrap">
            <div class="columns">
              ${this._columns().map((column) => this._renderColumn(column)).join("")}
            </div>
          </div>
        </div>
      </ha-card>
    `;

    const personForm = this.shadowRoot.querySelector("#person-form");
    const personInput = this.shadowRoot.querySelector("#person-name");
    const taskForm = this.shadowRoot.querySelector("#task-form");
    const taskTitleInput = this.shadowRoot.querySelector("#task-title");
    const taskColumnInput = this.shadowRoot.querySelector("#task-column");

    if (personForm) personForm.addEventListener("submit", (ev) => this._onAddPerson(ev));
    if (personInput) personInput.addEventListener("input", (ev) => this._onPersonNameInput(ev));
    if (taskForm) taskForm.addEventListener("submit", (ev) => this._onAddTask(ev));
    if (taskTitleInput) taskTitleInput.addEventListener("input", (ev) => this._onTaskTitleInput(ev));
    if (taskColumnInput) taskColumnInput.addEventListener("change", (ev) => this._onTaskColumnInput(ev));

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

customElements.define("household-chores-card", HouseholdChoresCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "household-chores-card",
  name: "Household Chores Card",
  description: "Weekly chore planner with backlog, Monday-Sunday columns, done lane, and drag/drop.",
});
