# Home Assistant

Home Assistant OS on a Raspberry Pi 4, `homeassistant` at `192.168.142.3`, UI on `:8123`. Its config lives in Home Assistant, not in this repo.

## SSH

`ssh homeassistant` (host entry in the dotfiles' `~/.ssh/config`) goes to the **Advanced SSH & Web Terminal** add-on.

- User `hassio`, with passwordless sudo.
- Add-on options: `ssh.authorized_keys` has the Mac's `~/.ssh/id_ed25519.pub`, and `packages: [websocat]`.
- The shell has `/config` and the `ha` CLI.

## API

The entity, device and area registries are websocket only. `scripts/ha-ws.sh` sends one websocket command over SSH and prints the response:

```sh
scripts/ha-ws.sh '{"type":"config/entity_registry/list"}' | jq '.result[] | select(.platform=="systemmonitor")'
```

## Floorplan

The `Floorplan` dashboard (`/floor-plan`) shows the home from a corner, with an icon for each entity where it really is.

- It fills the screen. On a phone held upright it starts zoomed in, so the plan is as tall as the screen and you drag sideways to see the rest.
- Pinch, scroll or drag to zoom and pan. Double-tap to go back to the view it started in.
- The top button on the right looks from the next corner, four in all. The one below it hides or shows the room names.
- Tapping a light or switch toggles it. Tapping anything else opens its details.
- Tapping a room's name opens that area in Home Assistant's Home dashboard.

It is made of three parts, all in `floorplan/`:

| Part | What it does |
|---|---|
| `floorplan.ts` | Draws the plan from a scan of the rooms: a light and a dark drawing for each corner, and the dashboard's config |
| `card.js` | The dashboard card, `custom:floorplan-card`. It shows the drawings, the icons and the room names. Home Assistant loads it as a dashboard resource from `/local/floorplan/card.js` |
| `run.sh` | Runs `floorplan.ts` and publishes everything to Home Assistant |

The plan of the home is personal, so the data is not in this repo: it is in the NAS `archive` share under `homelab/floorplan/` ([nas](nas.md#shares)), which has a README of its own.

| File | What it is |
|---|---|
| `scan.json` | The plan: walls, doors, windows, furniture and room names. Edited by hand |
| `placements.json` | Where each entity sits. Edited by hand |
| `floorplan-light-0.svg` to `floorplan-dark-3.svg`, `dashboard.json` | Written by `floorplan.ts` |

### Redraw and publish

With the share mounted on the Mac:

```sh
floorplan/run.sh
```

- It prints every room with its size and what stands in it, in the coordinates `placements.json` uses.
- It copies the drawings and the card to `/config/www/floorplan/`, registers the card as a dashboard resource, creates the dashboard if it is missing and saves its config. Nothing restarts.
- Home Assistant serves `/config/www` as `/local` without a login. Anyone on the LAN or the tailnet who knows the address can fetch a drawing.
- The dashboard is owned by `dashboard.json`. A change made in the Home Assistant editor is gone after the next run.
- A browser or the phone app that had the dashboard open shows the new card only after a reload.

### The plan

`scan.json` is Apple RoomPlan JSON as [OpenPlan3D](https://github.com/laanlabs/openPlan3D) exports it (`docs/handoff-format-v1.md` there): lengths in metres, each wall, door, window and object with `dimensions` `[width, height, depth]` and a column-major 4x4 `transform`.

What the script does with it:

- Turns the plan square to the page and snaps walls that are within 5 degrees of an axis.
- Merges the two copies of a wall that two stitched scans share into one, and moves the outer walls onto one line per side.
- Draws everything as if cut off 0.9 m above the floor and flattened, seen from 45 degrees above the floor. Anything that hangs higher on a wall should not be in the plan.
- Draws each object by its category: `bed`, `sofa`, `sofa_chaise`, `chair`, `table`, `toilet`, `bathtub`, `bathtub_corner`, `sink`, `shower`, `television`, `fireplace`, `fireplace_corner`, `stove`, `fridge`, `dishwasher`, `washer`, `water_heater`, `oven`, `vacuum_dock`. Any other category is a wooden box. The back of an object is its local -Z side.
- Names a room after the `displayName` of its section. `Room 3` and the like are OpenPlan3D's names for rooms nobody named and get no name. The card shows the names as tags over the drawing.

`sofa_chaise`, `fireplace_corner`, `bathtub_corner`, `water_heater` and `vacuum_dock` are not OpenPlan3D categories. A plan that uses them can't go back through its editor.

To add a piece of furniture, add an object to `objects` with a `category`, its `dimensions` and a `transform` that holds its rotation and the position of its centre.

### Placements

```json
[{ "entity": "light.example", "room": "Stuen", "x": 1.2, "y": 3.5, "z": 0.9, "icon": "mdi:lamp" }]
```

`room` is a room's name. `x` and `y` are metres from that room's top-left corner in a top-down view, x to the right and y down. `z` is the height above the floor and is optional. `icon` is the icon to show. Without one Home Assistant picks, and for a media player that can be a picture of what is playing.

To put a new device on the plan, add a line for one of its entities and run `floorplan/run.sh`. Its output lists what stands in each room with its coordinates, which is the easiest way to find the spot.

### Scanning again

1. Scan each room by itself with the OpenPlan3D iPhone app, with every door open and seen from both sides.
2. Export each with **Export Editable Plan (JSON)**. **Open in OpenPlan3D** uploads the plan to a bucket that anyone with the code can read for a day.
3. In the web editor, import the hall, add each room with **Build -> Import RoomPlan -> Add to this plan**, and snap it into place with **Join to another door**. Name the rooms.
4. **Export -> Download interchange JSON** gives the new `scan.json`. The furniture that was corrected by hand in the old one has to be carried over.

### Areas

There is one floor, and one area for each room on the plan, with the same names. The card finds a room's area by that name.

## Monitoring

- Prometheus scrapes it, see [monitoring](monitoring.md#home-assistant).
- The System Monitor integration has the CPU temperature, CPU, memory and disk sensors enabled. They feed the Home Assistant tile on Homepage.
- The model server it uses is in [llm](llm.md#home-assistant).
