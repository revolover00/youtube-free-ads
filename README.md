<div align="center">

# Youtubiy

**A YouTube front-end that doesn't fight you.** Watch, search, and organise videos through a fast, server-rendered interface — no player ads, no clutter, and full Arabic + English support.

[![Live](https://img.shields.io/badge/live-youtubys.vercel.app-FF0000?style=for-the-badge&logo=youtube&logoColor=white)](https://youtubys.vercel.app)
[![React](https://img.shields.io/badge/React-19-149ECA?style=for-the-badge&logo=react&logoColor=white)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![TanStack](https://img.shields.io/badge/TanStack-Router%20%2B%20Query-FF4154?style=for-the-badge&logo=reactquery&logoColor=white)](https://tanstack.com)
[![Firebase](https://img.shields.io/badge/Firebase-Auth%20%2B%20Firestore-FFCA28?style=for-the-badge&logo=firebase&logoColor=black)](https://firebase.google.com)

</div>

---

## Why this exists

Most "ad-free YouTube" projects wrap a public Piped or Invidious instance, or bounce requests through a third-party CORS proxy. Both are a single point of failure: the instance rate-limits you, the proxy dies, and the entire app turns into a wall of error states.

**Youtubiy does none of that.** Every request goes through *our own* TanStack server functions, which talk to YouTube directly, and normalise the response into typed objects the UI consumes. When YouTube changes something, there is exactly one layer to fix — not a dependency you don't control.

---

## Features

### Watch experience
- **Custom player** — no overlays, no suggested-video cards at the end, no ad slots in the UI.
- **Shorts viewer** — vertical, snap-scrolling, dedicated view separate from the long-form feed.
- **Miniplayer** — keeps playing while you browse; survives navigation.
- **Keyboard shortcuts** — a full shortcut map with an in-app reference modal.

### Discovery
- **Trending & home feed** with infinite scroll (`useInfiniteQuery` + cursor pagination).
- **Topic chips** — Curated Arabic/English categories (Gaming, Tech, Cooking, Travel, Music, Cars…) mapped to real search queries.
- **Search** across videos, channels and playlists, with filter chips (Shorts, Live, Watched, Unwatched, Recently uploaded).
- **Channel pages** — banner, stats, uploads, playlists.
- **Suggestions** — related videos on the watch page.

### Library & personal data
- **Playlists** — create, edit, reorder, add from anywhere via a dialog.
- **Watch history & watch-later**, subscriptions, and likes — all synced to the signed-in account.
- **YouTube import** — pull your existing subscriptions/history in through a guided modal.
- **Guest mode** — everything works locally before you ever sign in.

### Platform
- **Bilingual** — full Arabic (RTL) and English UI, not a machine-translated afterthought.
- **PWA** — installable, with a service worker and web manifest for offline shell caching.
- **Privacy** — no trackers, no third-party analytics; user data lives in your own Firebase project.
- **AI helpers** — Gemini-powered utilities (summaries, recommendations) behind a server-side key.

---

## Architecture

```
Browser (React 19 + TanStack Router)
   │
   ├── TanStack Query        cache, retries, infinite pagination
   │
   └── server functions      src/lib/*.functions.ts
          │                 (run on Vercel, never in the browser)
          │
          ├── YouTube         direct fetch + response normalisation
          ├── Firebase Admin  privileged reads/writes
          └── Google GenAI    AI features, key stays server-side
```

**Key directories**

| Path | Purpose |
|---|---|
| `src/routes` | File-based routes (TanStack Router) |
| `src/components` | Feature components — `Feed`, `Watch`, `ShortsViewer`, `ChannelPage`, `Miniplayer`, `LibraryPage`, `PlaylistPage`, `SettingsDialog` |
| `src/components/ui` | shadcn/ui primitives (Radix) |
| `src/lib/*.functions.ts` | Server functions: search, trending, channel, playlist, comments, suggestions |
| `src/lib/api.ts` | Single client-side façade over the server functions |
| `src/lib/appStore.ts` | Local-first state (history, library, settings) |
| `src/lib/aiAlgorithm.ts` | Feeds ranking / AI helpers |
| `firestore.rules` | Deny-by-default security rules with per-collection validators |

**Security model.** Firestore rules start from `allow read, write: if false` and then grant per-collection access with ownership checks (`request.auth.uid`) and field-level validators (types, max lengths, allowed keys). Nothing is world-writable.

---

## Getting started

**Requirements:** Node.js 20+ and npm.

```bash
git clone https://github.com/revolover00/youtube-free-ads.git
cd youtube-free-ads
npm install
cp .env.example .env.local     # then fill in the values below
npm run dev                    # http://localhost:3000
```

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `VITE_GOOGLE_CLIENT_ID` | for Google sign-in | OAuth 2.0 Web client ID from Google Cloud Console |
| `GEMINI_API_KEY` | for AI features | Server-only Gemini key — never exposed to the client |
| `FIREBASE_*` | for accounts | Firebase web config (apiKey, authDomain, projectId, …) |

Firebase setup: enable **Authentication → Google**, create a **Firestore** database, then deploy the rules in this repo (`firebase deploy --only firestore:rules`).

### Scripts

| Command | Action |
|---|---|
| `npm run dev` | Vite dev server on port 3000 |
| `npm run build` | Production build with the Vercel Nitro preset |
| `npm run preview` | Preview the production build |
| `npm run lint` | ESLint |
| `npm run format` | Prettier |

---

## Deployment

The build targets **Vercel** out of the box (`NITRO_PRESET=vercel`); the live instance runs at [youtubys.vercel.app](https://youtubys.vercel.app).

```bash
npm i -g vercel
vercel --prod
```

Set the same environment variables in the Vercel dashboard, and add your production domain to the Firebase **Authorized domains** list — otherwise sign-in silently fails in production.

---

## Known limitations

Being honest about this saves everyone time:

- **YouTube is the dependency.** Playback and metadata rely on YouTube's internal APIs, which change without notice. When a feed or search breaks, the fix belongs in `src/lib/*.functions.ts`.
- **No background playback** on mobile browsers — a platform restriction, not an app one.
- **First paint of a cold feed** can take a second; YouTube's first response is the bottleneck, not the UI.
- **AI features require** `GEMINI_API_KEY`; without it those panels stay disabled rather than failing loudly.

---

## Contributing

Issues and PRs are welcome. Please keep the one rule that defines this project: **every network request goes through a server function in `src/lib/`** — no public instances, no client-side CORS proxies.

---

<div align="center">
<sub>Built by <a href="https://github.com/revolover00">revolover00</a> · Cairo, Egypt</sub>
</div>
