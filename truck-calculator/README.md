# Tube Weight & Semi Truck Loading Calculator

A standalone web app for planning semi-truck shipments of boiler/condenser tubes: computes tube weight from material/OD/wall/length, builds crate weight from plywood + 2x6 framing (or a manual tare), checks each crate against forklift lift capacity and reach, and bin-packs crates onto a trailer while checking payload and stack-height limits.

Plain HTML/CSS/JS, no build step, no dependencies — deploys as a static site.

## Local development

Open `index.html` directly, or serve the folder with any static file server, e.g.:

```bash
python -m http.server 4173
```

## Deploying to Vercel

This is a static site (`index.html` at the project root) — Vercel will detect and deploy it with zero configuration.
