# Crafty Planner — Developer Workflow

Your reference for how this app is built, how it deploys, and everything you need to touch (or deliberately not touch) when making changes.

---

## Contents

1. [Project Overview](#1-project-overview)
2. [File Inventory](#2-file-inventory)
3. [Daily Development Loop](#3-daily-development-loop)
4. [APP_VERSION & CHANGELOG Protocol](#4-app_version--changelog-protocol)
5. [When You Need to Rebuild the Play Store App](#5-when-you-need-to-rebuild-the-play-store-app)
6. [Service Worker & Caching](#6-service-worker--caching)
7. [Cloudflare Worker (Receipt Scanner)](#7-cloudflare-worker-receipt-scanner)
8. [Firebase Sync](#8-firebase-sync)
9. [Common Edit Patterns](#9-common-edit-patterns)
10. [Testing Checklist](#10-testing-checklist)
11. [Gotchas & Constraints](#11-gotchas--constraints)
12. [Emergency Rollback](#12-emergency-rollback)
13. [Quick Reference](#13-quick-reference)

---

## 1. Project Overview

**What it is:** a small-business dashboard PWA for makers and sellers — order management, expenses, customers, products, recipes, supplies, analytics, receipt scanning.

**Distribution channels:**
- **Direct PWA install** — users visit the site and "Add to Home Screen." Gets live updates instantly on every push.
- **Google Play Store** — a TWA (Trusted Web Activity) wrapper around the same web app. The Android shell (icon, shortcuts, splash screen) is frozen at build time; the web content inside updates live.

**Stack:**
- Single-file `index.html` with vanilla JavaScript — no frameworks, no build step
- Firebase Auth + Firestore for cloud sync
- Cloudflare Worker proxies the Anthropic Claude Vision API for receipt scanning
- GitHub Pages hosts everything
- Bubblewrap-built TWA for Play Store

**Philosophy:**
- Mobile-first — primary target is your Android phone
- Surgical edits — the app is stable; preserve what works, don't refactor aggressively
- Single-file architecture for the app itself; small, focused auxiliary files elsewhere

---

## 2. File Inventory

| File | Role | Edit frequency |
|---|---|---|
| `index.html` | The entire app — HTML, CSS, JS, all inline | Every feature change |
| `sw.js` | Service worker (caching, offline) | Rarely |
| `manifest.json` | PWA manifest (name, icons, shortcuts) | Rarely |
| `android-icon-*.png` | App icons, various sizes | Almost never |
| `apple-icon-180.png` | iOS home screen icon | Almost never |
| `favicon.svg` | Browser tab icon | Almost never |
| `screenshot-mobile.png` / `screenshot-desktop.png` | Install prompt previews | Once per major redesign |
| `DEVELOPER.md` | This file | When workflow changes |

**Lives elsewhere, also matters:**
- `receipt-worker.js` — Cloudflare Workers dashboard → `crafty-receipt`. Edit via the Cloudflare web UI.
- `twa-manifest.json` — on your local machine, in your Bubblewrap project directory. Not in the GitHub repo.
- `assetlinks.json` — may be in the repo under `.well-known/`; required for Play Store verification. Don't touch unless the package ID or signing key changes.

---

## 3. Daily Development Loop

The five-step session pattern:

1. **Upload current `index.html` to Claude** at the start of each session. Keeps Claude working from your real current state rather than stale memory.
2. **Describe changes → Claude edits → delivers file back.**
3. **Download the file** from the Claude response.
4. **Commit and push to GitHub.** Pages redeploys in ~30 seconds.
5. **Open the app on your phone** to verify.

**For user-visible changes:** at the end of the session, ask Claude to *"add a changelog entry for what we did."* Claude bumps `APP_VERSION` and writes the entry based on what was actually built.

**For bug fixes, refactors, and minor tweaks:** skip the changelog. Push silently.

---

## 4. APP_VERSION & CHANGELOG Protocol

Near the top of the main `<script>` block in `index.html`:

```js
const APP_VERSION = '2026.04.18.1';
const CHANGELOG = {
  '2026.04.18.1': {
    date: 'April 2026',
    entries: [
      '✨ First entry...',
      '📊 Second entry...'
    ]
  }
};
```

**When to bump:**
- ✅ New features, analytics, visible UI changes
- ✅ Anything you want users to actively notice
- ❌ Bug fixes with no visible effect
- ❌ Refactoring or code cleanup
- ❌ Typo fixes

**Version string format:** `YYYY.MM.DD.N`, where `N` is the Nth release that day (start at `.1`). This format sorts correctly as a plain string, which is how the detection code decides what counts as "new to this user."

**What users see:** on their next app open after a bump, a dismissible banner at the bottom: "✨ Crafty Planner updated — tap to see what's new." Tap opens a modal with every changelog entry since they last visited.

**Important:**
- Don't delete old entries — a user who hasn't opened the app in months needs to see them all
- Newer versions go at the top of the object
- Each entry string accepts inline HTML and emoji
- Users who dismiss the banner with ✕ without reading will see it again next open. Only tapping through the modal marks the version as seen.

**Testing the flow manually:** clear `cp-last-seen-version` from your app's localStorage (DevTools → Application → Local Storage), reload, banner appears.

---

## 5. When You Need to Rebuild the Play Store App

The Play Store app is a TWA — a thin Android shell wrapping your PWA. The shell is frozen at build time; the web inside updates live.

**Does NOT require a Play Store rebuild:**
- Any change to `index.html` (JS, CSS, HTML, content, features, bug fixes)
- `CHANGELOG` updates
- Service worker changes
- Receipt worker changes

**DOES require a rebuild + Play Store submission:**
- App icon (the one on the home screen)
- App display name
- Launcher shortcuts (the long-press menu)
- Splash screen color or image
- Status bar / nav bar colors (Android chrome, not the web page)
- TWA-level behaviors (pull-to-refresh disable, orientation lock)
- Adding new verified origins
- Target SDK bumps (Google forces roughly annually)

**The rebuild workflow:**

```
cd <your bubblewrap project dir>
bubblewrap update           # re-reads your web manifest
# edit twa-manifest.json: bump appVersionCode by 1, bump appVersionName
bubblewrap build            # produces a new .aab
# upload .aab to Play Console, submit for review
```

**Rule of thumb:** if a change requires a Play Store rebuild, ask yourself whether the change is worth a release cycle. For routine feature work, the direct-PWA install covers everything.

---

## 6. Service Worker & Caching

`sw.js` controls offline behavior and how updates reach users.

**Key levers:**

- `CACHE_NAME` (currently `'crafty-planner-v4'`) — bumping this invalidates all caches across all users
- `STATIC_ASSETS` — list of files prefetched on install
- **Network-first for `index.html`** with `cache: 'no-cache'` to bypass the browser's HTTP cache — every app open fetches fresh HTML, falls back to cached copy only if offline
- **Cache-first for everything else** — icons, fonts, static assets served from cache for speed

**When to bump `CACHE_NAME`:**
- You added or removed files in `STATIC_ASSETS`
- You changed the fetch strategy
- Users are reporting stuck-on-old-version behavior

You do NOT need to bump it for routine `index.html` changes — those update via network-first regardless.

---

## 7. Cloudflare Worker (Receipt Scanner)

The receipt scanner posts images to `https://crafty-receipt.tymckinney2222.workers.dev`, which proxies the request to the Anthropic Claude Vision API.

**Critical security rule:** the Anthropic API key lives in Cloudflare as a secret environment variable named `ANTHROPIC_API_KEY`. **NEVER hardcode it** in `receipt-worker.js`. If you accidentally commit it, revoke at console.anthropic.com immediately and create a new one.

**To update the worker code:**
1. Cloudflare dashboard → Workers & Pages → `crafty-receipt` → Edit Code
2. Make changes
3. Deploy
4. No app rebuild needed — changes take effect on the next receipt scan

**To rotate the API key:**
1. Create new key at console.anthropic.com
2. Cloudflare → worker → Settings → Variables and Secrets → edit `ANTHROPIC_API_KEY`, paste new value, Save
3. Delete the old key from the Anthropic console

**Debugging scan failures:** when Claude Vision returns an error, the worker now passes the full upstream error text back to the frontend. The receipt review modal shows the exact error in a red box under the raw-text section. Check there first before guessing.

---

## 8. Firebase Sync

**What syncs to the cloud:**
- Orders, expenses, products, recipes, supplies
- User profile (business name, currency, theme)

**What stays local:**
- Custom expense categories
- `cp-last-seen-version` (changelog state)
- Theme customizations
- Session flags (guide-seen, etc.)

**How to verify sync is working:**
- Sidebar shows "☁️ Synced" when up to date
- Offline edits queue and push on reconnect
- Sign out + sign back in on another device — data should appear

**Security note:** the Firebase web-client config keys embedded in `index.html` are designed to be public. Security is enforced server-side via Firestore security rules, not key secrecy. Do not feel bad that they're visible in the repo.

---

## 9. Common Edit Patterns

**Add a new expense category:**
Edit `EXPENSE_CATS` array in `index.html`. Users can also add custom ones via the UI.

**Add a new analytics chart:**
- For time-series line charts: use `buildLineChartSVG(points, opts)` — pass `{color, fmtY, fmtTip}` options
- For grouped bar charts: use `buildTrendChartSVG(months, maxVal)`
- Insert the rendered HTML string into `renderAnalytics()` where you want it positioned

**Add a new launcher shortcut:**
1. Edit `manifest.json` — add to `shortcuts` array with a unique `?action=...` URL
2. Edit `index.html` — add the handler in the URL-param switch block (near the bottom of the init chain)
3. Reinstall the PWA on your phone (shortcut definitions don't refresh live — only bake in on install)

**Add a new guide tab:**
Edit `openUserGuide()` function. Add an entry to the `tabs` array and a matching key to the `content` object.

**Update the theme palette:**
Edit the CSS custom properties in `:root` and `[data-theme="dark"]`. Test both light and dark modes.

**Change the app name shown in the browser:**
Update `<title>` tag in index.html. Play Store app name requires a Bubblewrap rebuild.

---

## 10. Testing Checklist

Before pushing:

- [ ] Load the app on your phone
- [ ] Tap through every affected tab — no layout breakage
- [ ] If you changed a form, create a test entry and verify it saves
- [ ] Toggle dark mode if styles were touched
- [ ] If you touched sync, test signed-in and signed-out states
- [ ] Pull-to-refresh should still be disabled
- [ ] Long-press the app icon — shortcuts still work
- [ ] If you added new JavaScript, Claude should have run `node --check` during the session

---

## 11. Gotchas & Constraints

- **No ES2020+ syntax.** Optional chaining (`?.`) and nullish coalescing (`??`) break on older Android WebViews. Use `&&` / `||` instead.
- **Always run `node --check`** before committing. Syntax errors don't show up until the browser tries to parse the full file at runtime.
- **Never dump full code inline** in Claude responses — always deliver via file. Claude has been briefed.
- **Surgical edits only.** The app is large but stable. Unnecessary refactoring creates bugs.
- **Preserve the single-file structure.** No build step, no modules, no frameworks.
- **Shortcut icons in manifest must be PNG**, not SVG.
- **Pull-to-refresh is disabled via `overscroll-behavior-y: contain`** in the body CSS. Keep that rule in place or accidental pulls will reload the app.
- **Firebase config IS safe to expose** — don't panic when you see it in plain text in the repo.
- **The Anthropic API key is NEVER safe to expose.** Only in Cloudflare as a secret.

---

## 12. Emergency Rollback

If a push breaks the app:

1. GitHub → your repo → Commits tab → find the last known-good commit
2. Click the three-dot menu on the bad commit → Revert (or manually checkout the good commit's file contents)
3. Commit the revert
4. Pages redeploys in ~30 seconds
5. Users get the fixed version on their next network-first fetch (any open since the deploy already got the broken version, so they may need one more reload)

If the service worker has cached a broken version app-wide:
- Bump `CACHE_NAME` in `sw.js`
- Push
- Users get the clean cache on their next cold open

If a worker change broke receipt scanning:
- Cloudflare dashboard → Workers & Pages → `crafty-receipt` → Deployments tab
- Roll back to the previous deployment with one click

---

## 13. Quick Reference

```
Domain:           tymckinney2222.github.io/Crafty-Planner/
Receipt worker:   crafty-receipt.tymckinney2222.workers.dev
Play Store ID:    com.craftyplanner.app
Secrets:          ANTHROPIC_API_KEY (Cloudflare)
Auth:             Google Sign-In (Firebase)
Storage:          Firestore (cloud) + localStorage (device)
PWA manifest:     manifest.json (repo root)
Service worker:   sw.js (repo root)
```

**Session-starter phrase for Claude:**
> "Here's the current index.html. I want to [describe goal]."

**Session-closer phrase for Claude:**
> "Add a changelog entry for what we did" — for user-visible changes only.

---

*Keep this document updated when your workflow or stack changes. Future-you will thank present-you.*
