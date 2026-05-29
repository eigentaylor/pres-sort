# Presidential Preference Sorter & Tier List

Interactive, client-side web app for ranking U.S. presidents and building a tier board.

## What this project does

- Lets you rank presidents with two interactive flows:
  - Approval-style **Picker Mode** (primary flow)
  - Pairwise comparison sorter (legacy flow)
- Builds a draggable **SS-F tier board** from your ranking
- Saves progress in your browser (`localStorage`)
- Exports tier lists to:
  - PNG image
  - JSON data
  - Shareable URL (state encoded in the URL)
- Includes a Python script to simulate comparison counts for different sorting algorithms

## Project structure

- `index.html` - App markup and screen layout
- `style.css` - UI styling and responsive layout
- `app.js` - Main app logic (state, pairwise sorter, tier board, export/share)
- `picker-mode.js` - Approval-style picker workflow
- `data/presidents.json` - Primary president dataset
- `historical_ranking.csv` - Historical ordering used for simulation / seeding experiments
- `sort_sim.py` - Python simulation for algorithm comparison counts
- `img/` - President images and image notes

## Quick start

### Option 1: Open directly

Open `index.html` in your browser.

The app includes embedded JSON fallback data, so it can still run if `fetch` is limited in `file://` mode.

### Option 2: Run a local static server (recommended)

Using Python:

```bash
python -m http.server 8000
```

Then open:

```text
http://localhost:8000
```

## How to use

1. Open the app.
2. Choose one:
   - **Start Sorting (Approval-Style Picker)**
   - **Start Sorting (Pairwise)**
3. Complete sorting.
4. Go to **Build Tier List**.
5. Drag presidents between tiers.
6. Export PNG/JSON or copy a share link.

## Keyboard shortcuts

In Pairwise mode:

- Left arrow: choose left card
- `T`: tie
- Right arrow: choose right card

## Data and image notes

`data/presidents.json` entries are expected to include fields like:

- `id`
- `name`
- `number`
- `years`
- optional `image`

Image lookup tries several filename patterns in `img/`, including numbered variants and ID-based filenames.

## Running the simulation script

The script compares how many pairwise comparisons several sorting algorithms need when given a seeded shuffled order.

Run:

```bash
python sort_sim.py
```

Output includes attempts, average, median, min/max, and standard deviation of comparison counts.

## Deployment

This is a static site and is ready for GitHub Pages deployment.

Basic flow:

1. Push to your default branch.
2. In repository settings, enable Pages from the branch root.
3. Open the published Pages URL.

## Privacy

- No backend services are required.
- Processing is local in the browser.
- Saved state is stored locally in your browser.
