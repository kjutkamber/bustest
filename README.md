# STANICA — Live Departures, NYC Subway Style

A **100% static, serverless** web app for live bus departures in **Beograd, Novi Sad and Niš**,
styled after the New York City subway (MTA Helvetica, route bullets, countdown-clock boards,
mosaic tile strips).

It talks **directly** to the upstream BusLogic / NSmart carrier endpoints — the same
reverse-engineered APIs documented in
[FmasterofU/NSmart-RE](https://github.com/FmasterofU/NSmart-RE) and proxied by
[MikMik1011/bgpp](https://github.com/MikMik1011/bgpp) — but uses **no bgpp backend at all**.
Belgrade's AES-256-CBC-encrypted V2 API is decrypted in the browser with WebCrypto.

## Features

- City picker styled as subway "lines": **BG** (red), **NS** (blue), **NI** (orange)
- Station search (diacritic-insensitive), sorted by distance if you share location
- Live departure board in MTA countdown-clock style: route bullet, destination,
  minutes, stops-away, current vehicle position, auto-refresh every 20 s
- Favorite stops (saved in `localStorage`), hash-based routing (works on GitHub Pages)
- Optional CORS-proxy setting if the upstream blocks cross-origin browser requests
- Zero dependencies, zero build step: three files.

## Files

```
index.html          markup
assets/style.css    MTA visual system
assets/app.js       API clients (V1 + V2 crypto), views, router
```

## Deploy to GitHub Pages

1. Create a new repository (e.g. `stanica`).
2. Upload these files to the repository root (keep the `assets/` folder).
3. In the repo: **Settings → Pages → Source: Deploy from a branch → `main` / `(root)` → Save**.
4. Wait a minute, then open `https://<your-username>.github.io/stanica/`.

No build, no Actions workflow, no environment variables.

### Try it locally

Any static server works, e.g.:

```bash
python3 -m http.server 8000
# → http://localhost:8000
```

## A note on CORS

The app sends the `X-Api-Authentication` header, which triggers a browser preflight.
If the upstream server responds without CORS headers, the direct connection fails —
the app will show a "SIGNAL PROBLEM" notice. In that case open **⚙ settings** and set a
proxy prefix, e.g. `https://corsproxy.io/?url=` (public instances come and go; any
forwarding CORS proxy works, including a tiny Cloudflare Worker of your own).

## Fair use

Station lists are cached in `localStorage` for 24 h and arrivals refresh at most every
20 s per open board. Please don't lower the refresh interval — these are shared public
endpoints.

Unofficial hobby project. Not affiliated with GSP Beograd, JGSP Novi Sad, JGPNiš, BusLogic
or the MTA.
