# House Hunt

A private web app for two people house-hunting together. Save the houses you've viewed, note what you'd change, and see what each one could become — as an editable floor plan, a 3D dollhouse, a first-person walkthrough, and photoreal visuals.

## What it does

| | |
|---|---|
| **Save** | Paste a PropertyPal link (Rightmove, Zoopla and agent sites work too) or add a house by hand. Photos and floor plans are copied into the app, so you keep them after the listing comes down. Status, a star rating each, and signed viewing notes. |
| **Imagine** | A wishlist split into three levels — **Refresh** (within the existing plan), **Reconfigure** (walls out, rooms re-purposed) and **Extend** (new space). "Ask Claude" reads the photos, plan, your wishes and notes and suggests what's possible at each level, with indicative cost bands, likely consents and what to check before offering. |
| **Plan** | Claude traces the agent's floor plan into an editable model. Copy it into scenarios, then drag rooms (edges snap together), click any wall to make it a doorway, window, bi-fold glazing or remove it, add extension rooms, change paint and flooring. Or describe a change ("open kitchen into dining, 4m rear extension") and Claude draws it. Every scenario shows area, bedrooms and open-plan changes versus today, plus a rough build-cost roll-up. |
| **See it** | Every scenario renders in 3D: a cut-away dollhouse view and a walk-through (drag to look, WASD / arrows, or the on-screen pad on a phone). "Make this view photoreal" sends the 3D view to an image model; you can also re-imagine a real listing photo ("sage shaker kitchen, oak floor"). Before/after slider on every visual. |

Try it without any keys: **Explore the demo house** on the empty board loads a terrace with three ready-made scenarios.

## Running it

Needs Node 22+.

```bash
npm install
cp .env.example .env.local   # then fill in keys (see below)
npm run dev                  # http://localhost:3000
```

For production: `npm run build && npm start`, or the Docker image (below).

### Keys

| Variable | Needed for | Without it |
|---|---|---|
| `ANTHROPIC_API_KEY` | Tracing floor plans, "What's possible", drafting scenarios, reading listing pages, writing image prompts | Everything manual still works: add houses by hand, sketch plans yourself, 3D and walkthrough |
| `GEMINI_API_KEY` **or** `OPENAI_API_KEY` | Generating visuals (photo re-imagining, photoreal 3D views) | Visuals tab is disabled |
| `APP_PASSCODE` | A shared passcode gate | Anyone who can reach the URL can use it — fine on your own laptop, not on the internet |
| `HOUSEHOLD_MEMBERS` | Names in the "who's looking" switch | Defaults to `Gokul,Laura` |

Claude calls use `claude-opus-5` with adaptive thinking and schema-validated structured outputs; override with `CLAUDE_MODEL`. Server-side refusal fallback (`fallbacks: "default"`) is enabled. Image model names are configurable (`GEMINI_IMAGE_MODEL`, `OPENAI_IMAGE_MODEL`) because they change often.

## Sharing it with each other

The app stores everything as files under `DATA_DIR` (one JSON per house plus an uploads folder), so it needs a host with a persistent disk:

- **Simplest:** run it on a machine at home and reach it from your phones over [Tailscale](https://tailscale.com).
- **Always on:** deploy the Docker image to Fly.io, Railway or Render with a volume mounted at `/data`, and set `APP_PASSCODE`.

```bash
docker build -t house-hunt .
docker run -p 3000:3000 -v house-hunt-data:/data --env-file .env.local house-hunt
```

Serverless platforms such as Vercel won't keep the data folder between requests; that would need the store in `src/lib/store.ts` swapped for a database and blob storage.

Backups: copy the data folder.

## How it works

```
src/lib/layout.ts     Plan geometry: rooms are axis-aligned rectangles (metres); walls are derived
                      where rectangles meet. Doors come from connections; windows default onto
                      exterior walls; party walls (terrace/semi) stay solid. Wall edits are stored
                      per segment. Shared by the 2D editor, the 3D builder and the server.
src/lib/claude.ts     All Claude calls — trace, listing extraction (with web-fetch fallback when a
                      site blocks the server), ideas, scenario drafting, image prompts.
src/lib/imagegen.ts   Gemini / OpenAI image editing.
src/lib/listing.ts    Listing import: fetch page → digest (meta, JSON-LD, __NEXT_DATA__, image URLs)
                      → Claude → download and normalise images.
src/lib/ops.ts        Every mutation the UI can make, validated with zod.
src/components/       Board, workspace tabs, PlanEditor (SVG), Viewer3D (three.js).
```

`npm test` runs the geometry and cost tests; `npm run lint` type-checks.

## Limits worth knowing

- **The plan model is rectangles.** Angled walls, bays and curved rooms are approximated (an L-shaped room becomes two rectangles joined by an opening). Stairs are part of the hall/landing, not modelled.
- **Traces are a starting point, not a survey.** Claude reads printed dimensions where they exist and estimates the rest, and says how confident it is. Check key dimensions against the agent's plan (use "Show agent's plan" in the editor).
- **Structure isn't known.** Removing a wall in the app shows where a beam would sit; whether a wall is load-bearing needs an engineer.
- **Cost rates are editable starting assumptions, not sourced benchmarks.** Replace them with your builder's numbers (Edit rates). Totals exclude kitchens, bathrooms, fees, VAT and contingency. Claude's cost bands are likewise indicative.
- **Planning rules differ by jurisdiction.** Claude is told to reason from the address (NI, ROI, England, Scotland and Wales differ) and flag what to confirm with the council; treat its consent notes as a checklist, not advice.
- **Listing import is best-effort.** Portals change their pages and sometimes block servers. If import fails, add the house manually and upload the photos and floor plan.
