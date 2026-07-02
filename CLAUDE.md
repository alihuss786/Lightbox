# Lightbox — project memory

## What this is
`lb.html` is the whole product: a single self-contained HTML file (Three.js
r128 + ClipperLib r6.4.2 + opentype.js, all inlined) that designs a
3D-printable letter-shaped "lightbox lid" and exports it as a Bambu Studio
`.3mf`. There is no `textures.html` — everything lives in `lb.html`. The file
is ~1.5MB with CRLF line endings; never full-Read it, drive it with small
node scripts instead.

## Geometry / mesh conventions
- Three.js r128 (global `THREE`), `MeshLambertMaterial`, **non-indexed**
  `BufferGeometry`.
- ClipperLib r6.4.2 at scale `S=1000`. Helpers: `intersect(a,b)`, `diff(a,b)`,
  `union2(a,b)`, `off(paths,deltaMM)` (delta*S internally, jtRound,
  ClipperOffset(2,0.25)), `cleanPaths`.
- Local helpers: `_sc(poly)` scale poly to Clipper; `_rrp(x,y,w,h,r)`
  rounded-rect points; `_segp(x0,y0,x1,y1,w)` thin stroke rect.
- Manifold check: weld verts at Q=1e3 (0.001mm), count edge incidence.
  boundary=count 1, non-manifold=count >2, badWind=directed-edge
  inconsistency. Target: 0 non-manifold, 0 bad-winding.

## Key fixes already in place (do not regress)
- **Solid-lid-when-sliced fix**: `addWalls(paths,z0,z1,flip)` has a `flip`
  param; cavity walls must face *into* the cavity. Skirt uses
  `addWalls(rec,BOT,0,true)`. Regressing this makes the lid slice as a solid
  block in Bambu.
- **Single watertight body shell** `buildBodyShell`: one shell (back cap −z,
  front rim filled+inner ring +z, cavity floor +z, outer walls flip=false,
  inner cavity walls flip=true), per-face normal forced via cross product.
  Replaced two overlapping extrusions that gave 348 non-manifold edges.
- **Pocket widening**: `const POCKET_CLEARANCE=0.2;` offset applied then
  `cleanPaths` **after** the offset so walls and floor share vertices
  (cleaning only the floor exploded boundary edges).

## Texture engine
Vector-polygon tiles. Each TEXTURES entry has `gen(a,b,c,d)` returning
`_sc`-scaled Clipper paths over the bbox [a,b]-[c,d]. Cap hook:
`_tiles=intersect(_cells,_Rin); _grout=diff(_topReg,_tiles)`; grout at TT,
tiles raised to TT+relief via `addWalls`. A dormant height-field path
(`addCapTextured`/`addWallTexTop`/`addDome`, gated by `LIDTEX.fn`) remains
but is unused.

### TEXTURES list (lb.html ~line 633)
`none`, `subway`, `basketweave`, `herringbone`, `fishscale`, `scallop`,
`isocube` (Isometric Diamonds/harlequin), `isostar` (Isometric Cubes),
`puzzle` (Jigsaw, bezier filled pieces), `crackle` (Cracked Stone, Voronoi),
`crackleinv` (Cracked Stone Raised), `filigree` (Debossed Filigree Scrolls).

**Debossing convention**: the cap hook always *raises* the tiles
(`_grout` at TT, `_tiles` at TT+relief). To get recessed grooves (as
`filigree` does), `gen` returns the *background* — `diff(fieldRect, off(strokes,δ))`
— so the raised field leaves the scroll strokes low. `filigree` builds
symmetric heart-scroll motifs from bezier `ribbon()` strokes + `spiral()`
curls + `leaf()` accents, orientation-normalized (CCW) before `_sc`.

**Leopard was added then removed** — user didn't like the print.

**Knit was attempted many times and abandoned** — the tile engine can't make
continuous rounded ribs and the height-field V-loop read as chevrons/pillows.
Removed permanently; replaced by `leopard`. Don't reintroduce knit without a
fundamentally different approach.

## Git / deploy gotchas
- Feature branch: `claude/catalog-selection-stl-models-vmuffu`.
- **Run all git commands from `/home/user/Lightbox`**, never from the
  scratchpad dir — `cd "$SP" && git ...` fails with "not a git repository".
- Viewing is via **GitHub Pages** ("Deploy from a branch"), not PRs. Deploys
  run through the "pages build and deployment" workflow.
- Backup branches (`textures_backup`, `backup_2`, `Perfect_Backup_branch`) all
  carry the solid-lid fix and are pushed individually for testing.

## Local testing
- `build.js` writes `site/lb.test.html` with local libs; `serve.js` on port
  8182. Playwright headless chromium at
  `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`,
  `NODE_PATH=/opt/node22/lib/node_modules`.
- `checkall.js` runs the manifold check across all textures.
