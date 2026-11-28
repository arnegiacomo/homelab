// A Home Assistant dashboard card for the floorplan drawings. Pinch, scroll or drag to zoom and pan,
// double-tap to go back to the view it started in. Tapping a room's name opens that room in Home Assistant.
// One button looks from the next corner, the other hides or shows the room names. It fills the screen below
// Home Assistant's header.
// See docs/homeassistant.md#floorplan.
//
//   type: custom:floorplan-card
//   views: one per corner, each { light, dark, aspect, elements: [{ entity, icon, left, top }], labels: [{ name, left, top }] }
//
// floorplan.ts writes that config. `left` and `top` place an icon or a name on the drawing in percent.

const MAX_ZOOM = 8;
const TAP_SLOP = 8;
const DOUBLE_TAP_MS = 350;
const TOGGLED = ["light", "switch"];
// Tapping a room's name opens that area in Home Assistant's own Home dashboard.
const areaPage = (areaId) => `/home/areas-${areaId}`;
// Whether the room names are hidden is remembered per browser.
const NAMES_HIDDEN = "floorplan-card-names-hidden";

const STYLE = `
  .viewport { position: relative; width: 100%; overflow: hidden; touch-action: none; cursor: grab; user-select: none;
    height: calc(100dvh - var(--header-height, 56px) - env(safe-area-inset-bottom, 0px)); }
  img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; transform-origin: 0 0; pointer-events: none; }
  .icon, .button { position: absolute; display: flex; align-items: center; justify-content: center; border-radius: 50%;
    background: var(--card-background-color); box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3); cursor: pointer; }
  .icon { left: 0; top: 0; width: 40px; height: 40px; margin: -20px 0 0 -20px; }
  .button { right: 12px; width: 44px; height: 44px; color: var(--primary-text-color); }
  .tag { position: absolute; left: 0; top: 0; padding: 8px; white-space: nowrap; cursor: pointer;
    font: 500 11px/14px var(--ha-font-family-body, sans-serif); letter-spacing: 0.06em; text-transform: uppercase;
    color: var(--secondary-text-color); opacity: 0.8; }
  .no-names .tag { display: none; }
`;

// Home Assistant sets properties of its own on a card, `layout` among them. Everything the card keeps for itself
// starts with an underscore, so the two can't collide.
class FloorplanCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._corner = 0;
    this._zoom = 1;
    this._offset = { x: 0, y: 0 };
    this._pointers = new Map();
    this._lastTap = 0;
  }

  setConfig(config) {
    if (!Array.isArray(config.views) || config.views.length === 0) throw new Error("floorplan-card needs views");
    this._config = config;
    this.shadowRoot.innerHTML = `<style>${STYLE}</style>
      <ha-card><div class="viewport"><img alt="" draggable="false" />
        <div class="button" data-action="turn" style="top: 12px"><ha-icon icon="mdi:rotate-3d-variant"></ha-icon></div>
        <div class="button" data-action="names" style="top: 68px"><ha-icon icon="mdi:tag-text-outline"></ha-icon></div>
      </div></ha-card>`;
    this._viewport = this.shadowRoot.querySelector(".viewport");
    this._image = this.shadowRoot.querySelector("img");
    this._viewport.classList.toggle("no-names", localStorage.getItem(NAMES_HIDDEN) === "yes");
    this._viewport.addEventListener("pointerdown", (event) => this._pointerDown(event));
    this._viewport.addEventListener("pointermove", (event) => this._pointerMove(event));
    this._viewport.addEventListener("pointerup", (event) => this._pointerUp(event));
    this._viewport.addEventListener("pointercancel", (event) => this._pointers.delete(event.pointerId));
    this._viewport.addEventListener("wheel", (event) => this._wheel(event), { passive: false });
    new ResizeObserver(() => this._home()).observe(this._viewport);
    this._showCorner();
  }

  set hass(hass) {
    this._hass = hass;
    this._refresh();
  }

  getCardSize() {
    return 8;
  }

  get _view() {
    return this._config.views[this._corner];
  }

  // Builds the room names and the icons of the current corner. The drawing and the states follow in refresh().
  _showCorner() {
    this._viewport.querySelectorAll(".icon, .tag").forEach((node) => node.remove());
    this._tags = (this._view.labels ?? []).map((label) => {
      const tag = document.createElement("div");
      tag.className = "tag";
      tag.textContent = label.name;
      tag.dataset.room = label.name;
      this._viewport.append(tag);
      return { spot: label, node: tag };
    });
    this._icons = this._view.elements.map((element) => {
      const icon = document.createElement("div");
      icon.className = "icon";
      icon.dataset.entity = element.entity;
      const badge = document.createElement("state-badge");
      badge.stateColor = true;
      badge.overrideIcon = element.icon;
      icon.append(badge);
      this._viewport.append(icon);
      return { spot: element, node: icon, badge };
    });
    this._refresh();
    this._home();
  }

  // The view a corner starts in. On a wide screen that is the whole plan. On an upright one, like a phone,
  // the whole plan would be a narrow strip, so it starts zoomed in until the plan is as tall as the screen.
  _home() {
    const { width, height } = this._viewport.getBoundingClientRect();
    if (width === 0) return;
    this._zoom = height > width ? Math.min(MAX_ZOOM, (height * this._view.aspect) / width) : 1;
    this._offset = { x: (width * (1 - this._zoom)) / 2, y: (height * (1 - this._zoom)) / 2 };
    this._layout();
  }

  _refresh() {
    if (!this._hass || !this._icons) return;
    const address = this._hass.themes?.darkMode ? this._view.dark : this._view.light;
    if (this._image.getAttribute("src") !== address) this._image.setAttribute("src", address);
    for (const { spot, badge } of this._icons) {
      badge.hass = this._hass;
      badge.stateObj = this._hass.states[spot.entity];
    }
    this._layout();
  }

  // The drawing is scaled as a whole. Icons and names keep their size and are moved to where their spot on it ends up.
  _layout() {
    const { width, height } = this._viewport.getBoundingClientRect();
    if (width === 0) return;
    this._offset = {
      x: Math.min(0, Math.max(width * (1 - this._zoom), this._offset.x)),
      y: Math.min(0, Math.max(height * (1 - this._zoom), this._offset.y)),
    };
    this._image.style.transform = `translate(${this._offset.x}px, ${this._offset.y}px) scale(${this._zoom})`;
    // `object-fit: contain` centres the drawing in the viewport when their shapes differ.
    const drawn = { width: Math.min(width, height * this._view.aspect), height: Math.min(height, width / this._view.aspect) };
    const edge = { x: (width - drawn.width) / 2, y: (height - drawn.height) / 2 };
    const place = ({ spot, node }, centring) => {
      const x = this._offset.x + this._zoom * (edge.x + (spot.left / 100) * drawn.width);
      const y = this._offset.y + this._zoom * (edge.y + (spot.top / 100) * drawn.height);
      node.style.transform = `translate(${x}px, ${y}px) ${centring}`;
    };
    for (const icon of this._icons ?? []) place(icon, "");
    for (const tag of this._tags ?? []) place(tag, "translate(-50%, -50%)");
  }

  // Zooms by `factor`, keeping the point of the drawing under `at` where it is.
  _zoomAt(at, factor) {
    const zoom = Math.min(MAX_ZOOM, Math.max(1, this._zoom * factor));
    this._offset = { x: at.x - ((at.x - this._offset.x) * zoom) / this._zoom, y: at.y - ((at.y - this._offset.y) * zoom) / this._zoom };
    this._zoom = zoom;
    this._layout();
  }

  _position(event) {
    const box = this._viewport.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  }

  _pointerDown(event) {
    this._viewport.setPointerCapture(event.pointerId);
    this._pointers.set(event.pointerId, this._position(event));
    // The capture takes the click away from the icon that was pressed, so a tap is worked out by hand.
    this._pressed = event.composedPath().find((node) => node.dataset?.entity || node.dataset?.action || node.dataset?.room);
    this._travelled = 0;
  }

  _pointerMove(event) {
    const before = this._pointers.get(event.pointerId);
    if (!before) return;
    const now = this._position(event);
    this._pointers.set(event.pointerId, now);
    this._travelled += Math.hypot(now.x - before.x, now.y - before.y);
    const other = [...this._pointers.entries()].find(([id]) => id !== event.pointerId)?.[1];
    if (!other) {
      this._offset = { x: this._offset.x + now.x - before.x, y: this._offset.y + now.y - before.y };
      this._layout();
      return;
    }
    const spread = (p) => Math.hypot(p.x - other.x, p.y - other.y);
    this._zoomAt({ x: (now.x + other.x) / 2, y: (now.y + other.y) / 2 }, spread(now) / (spread(before) || 1));
  }

  _pointerUp(event) {
    this._pointers.delete(event.pointerId);
    if (this._travelled > TAP_SLOP || this._pointers.size > 0) return;
    if (this._pressed?.dataset.action === "turn") {
      this._corner = (this._corner + 1) % this._config.views.length;
      this._showCorner();
      return;
    }
    if (this._pressed?.dataset.action === "names") {
      localStorage.setItem(NAMES_HIDDEN, this._viewport.classList.toggle("no-names") ? "yes" : "no");
      return;
    }
    if (this._pressed?.dataset.room) {
      this._openRoom(this._pressed.dataset.room);
      return;
    }
    if (this._pressed) {
      this._tapEntity(this._pressed.dataset.entity);
      return;
    }
    if (event.timeStamp - this._lastTap < DOUBLE_TAP_MS) this._home();
    this._lastTap = event.timeStamp;
  }

  _wheel(event) {
    event.preventDefault();
    this._zoomAt(this._position(event), Math.exp(-event.deltaY * 0.002));
  }

  // The areas in Home Assistant have the same names as the rooms on the plan.
  _openRoom(name) {
    const area = Object.values(this._hass.areas ?? {}).find((candidate) => candidate.name === name);
    if (!area) return;
    history.pushState(null, "", areaPage(area.area_id));
    window.dispatchEvent(new CustomEvent("location-changed"));
  }

  _tapEntity(entity) {
    if (TOGGLED.includes(entity.split(".")[0])) {
      this._hass.callService("homeassistant", "toggle", { entity_id: entity });
      return;
    }
    this.dispatchEvent(new CustomEvent("hass-more-info", { detail: { entityId: entity }, bubbles: true, composed: true }));
  }
}

customElements.define("floorplan-card", FloorplanCard);
