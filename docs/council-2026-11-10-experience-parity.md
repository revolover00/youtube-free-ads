# Council session #2 — experience parity with YouTube

**Date:** 2026-11-10
**Repo:** `revolover00/youtube-free-ads`, branch `arena/906f8020-youtube-free-ads`
**Convened after:** council #1 (`council-2026-11-10-screenshot-and-ui-fidelity.md`) and the
fidelity commit `d40553b`.

**Question put to the council:** council #1 and the commit that followed it closed the
*visual* gap on the home feed, masthead, guide and watch page. The user now asks us to go
over **every inch** — *"كل شبر"* — and reach parity in the **experience**, not just the
pixels. What is still different, and what is worth doing?

---

## Members

| Seat | Role | Brief |
|---|---|---|
| **R. Okonkwo** | Principal engineer, web platform | Owns routing, SSR, URL semantics, history. |
| **M. Haddad** | Senior front-end engineer | Owns component behaviour, state, keyboard, focus. |
| **S. Lindqvist** | Product designer (video surfaces) | Owns layout, type, motion, interaction feel. |
| **T. Varga** | Design-systems lead | Owns tokens, density, consistency across surfaces. |
| **D. Ferreira** | QA / adversarial reviewer | Holds the "would a real user notice?" line. |

Protocol per `.agents/skills/council/references/protocol.md`: round 1 independent and
blind, round 2 cross-examination, round 3 verdict. Consensus is not forced.

---

## Pre-read: measurements taken before the session

Run against the dev server, so these are facts and not opinions.

```
200  /
200  /watch?v=dQw4w9WgXcQ
404  /results?search_query=test
404  /@mrbeast
404  /shorts/abc123
404  /feed/subscriptions
307  /playlist?list=PL123
```

Route files present: `index, watch, search, channel, playlist, shorts, subscriptions,
library, policies`. Every one of them is `component: () => null`; rendering is done by
`<App />` off `useAppStore().route`, and `__root.tsx` hides `<Outlet />` in a `div.hidden`.

---

## Round 1 — independent analysis

### R. Okonkwo — principal engineer

**Position:** The site has invented its own URL scheme. That is the single largest
remaining parity gap, and nothing in a screenshot will ever show it.

**Reasoning**

- YouTube's URLs are a public contract that predates most of its UI. `/results?search_query=`,
  `/@handle`, `/channel/UC…`, `/shorts/<id>`, `/feed/subscriptions`, `/playlist?list=`.
  This app uses `/search?q=`, `/channel?id=`, `/shorts`, `/subscriptions`, `/playlist?id=`.
- The consequence is concrete: take any real YouTube link, swap the domain, and you get a
  404. Every link anyone has ever saved, pasted in a chat, or bookmarked is dead here.
  A user who "tests whether it behaves like YouTube" will try exactly that within a minute.
- The state-driven router is fine as an internal mechanism — `/watch?v=` already deep-links
  correctly, including a fetch to hydrate the video. The problem is purely the *surface*:
  the paths and param names we expose.

**Risk:** Changing URL shapes is normally a migration headache. Here it is nearly free —
the app has no inbound links to protect and no SEO history worth keeping. If we do not do it
now, we do it later with real users attached.

**Surprise:** `/playlist?list=` returns 307, not 404 — TanStack is redirecting because the
route exists but the param is named `id`. We are one parameter name away from correct.

---

### M. Haddad — senior front-end

**Position:** The watch page is visually close now but still *behaves* unlike YouTube in
three places users touch constantly.

**Reasoning**

- **Description box.** YouTube's is a single collapsed surface at `#272727`, showing
  `N views · date` in bold on the first line and `…more` at the end; clicking anywhere in
  the box expands it in place, and an expanded box gets a `Show less`. Ours renders the
  metadata as loose text with no container and no expand affordance.
- **Comments.** YouTube shows `N Comments` followed by a `Sort by` control (Top / Newest),
  and the composer is a single underlined input that only reveals Cancel/Comment buttons
  on focus. Ours lacks the count header and the sort entirely.
- **Scroll restoration.** YouTube restores feed scroll position when you come back from a
  video. We reset to top. That is the kind of thing nobody can name but everybody feels.

**Risk:** The description box is the most-clicked non-player element on the page. Getting it
wrong is more noticeable than any font mismatch we fixed yesterday.

---

### S. Lindqvist — product designer

**Position:** The surfaces we have not touched yet — channel, shorts, search results — are
still visibly "a YouTube-like app" rather than YouTube.

**Reasoning**

- **Channel page.** No banner. The header centres on mobile (`justify-center`), which
  YouTube never does. There is no `@handle` line; YouTube's header is avatar + name (36px/700)
  + `@handle · N subscribers · N videos` on one metadata line, with the description truncated
  to one line and a `…more` that opens a dialog. Tabs are 48px tall with a 2px indicator —
  ours are `py-3` with `font-bold`, which reads heavier.
- **Shorts.** Ours is a 56px toolbar with a red Shorts wordmark over a letterboxed column of
  cards with `rounded-xl` and a visible gap. YouTube's shorts viewer is edge-to-edge black,
  one short filling the viewport height, actions in a vertical rail to the right of the video,
  and no toolbar at all beyond the masthead.
- **Search results.** YouTube uses a single-column list with large 360px thumbnails and a
  `Filters` button opening a panel of grouped options. Ours reuses the home grid and exposes
  filters as chips, which is a different mental model.

**Risk:** These three are where the remaining "it's not quite YouTube" feeling lives now that
the home page is fixed.

---

### T. Varga — design systems

**Position:** We introduced good tokens yesterday but only applied them on three surfaces.
The inconsistency is now *internal*, which is worse than the original uniform wrongness.

**Reasoning**

- `.yt-pill`, `.yt-chip`, `.yt-guide-item`, `.yt-title`, `.yt-meta` exist and are used on the
  feed, guide and watch action row. Channel, library, playlist, shorts, settings and the
  dialogs still carry hand-written `h-9 px-4 rounded-full bg-yt-surface text-sm font-medium`.
- `font-display` still appears on headings across six files. We repointed it at Roboto, so it
  is harmless today, but it is a trapdoor: the next person who changes the token changes
  typography in places they did not intend.
- Several surfaces still use `font-bold` (700) where YouTube uses 500. Roboto 700 at 14px is
  noticeably heavier than YouTube's text and is the most common single mismatch left.

**Risk:** Low severity, high spread. Cheap to fix now, annoying later.

---

### D. Ferreira — QA / adversarial

**Position:** Before any of this, note that the headline feature from council #1 is still
**unverified**. I will not sign off on a parity claim built on an untested foundation.

**Reasoning**

- The storyboard capture path has never executed against YouTube. Sandbox egress is limited to
  github/npm/pypi, so `parseStoryboardSpec` → `fetchAsDataUrl` → canvas crop has only ever been
  type-checked. The spec format is from documentation, not from a response we have seen.
- Specifically unverified: that `playerMeta` still returns `storyboardSpec` for the current
  InnerTube client version; that `i.ytimg.com` serves the sheets without a signed referer;
  and that `fetchAsDataUrl`'s UA/referer pair is accepted.
- The failure mode is silent and ugly: the dialog opens, spins, then shows the generic
  "failed" string with no diagnosis.

**Risk:** We ship a flagship feature that works on the author's machine and nowhere else.

**Surprise:** The poster fallback (`maxres → sd → hq`) will succeed even when storyboards fail,
so the user gets *a* frame — just always the thumbnail, never their actual timestamp. That is
worse than an error, because it looks like it worked.

---

## Round 2 — cross-examination

**Ferreira → Okonkwo:** You want to rewrite the URL layer. That is the riskiest change on the
table and it fixes something no screenshot shows. Justify the ordering.

**Okonkwo:** It is not a rewrite. The state router already resolves a video from `?v=`; I am
adding path aliases and renaming one query param. Concretely: a `/results` route that reads
`search_query`, a `/@$handle` and `/channel/$id` route, `/shorts/$id`, `/feed/$name`, and
`list` accepted alongside `id` on playlist. The internal `route` union does not change. As for
ordering — the user said *experience*, and the first experience anyone has with a YouTube
clone is pasting a YouTube link into it.

**Ferreira:** Accepted, on condition the old paths keep working rather than being deleted.

**Okonkwo:** Agreed. They redirect.

---

**Lindqvist → Varga:** You want a token sweep across six files. I want three redesigned
surfaces. We cannot do both well in one pass.

**Varga:** Then do mine as a side-effect of yours. If you rebuild the channel header you will
touch those buttons anyway; use `.yt-pill` when you do. I am not asking for a separate pass,
I am asking that no new hand-written pill metrics get committed.

**Lindqvist:** That I can hold to.

---

**Haddad → Lindqvist:** Shorts full-bleed is a bigger change than it looks — the viewer sits
inside the app shell with its own scroll container and snap points. Is it worth it versus the
description box, which every single watch-page visitor sees?

**Lindqvist:** No, it is not, and I will concede the ordering. Description box first. Shorts
is the most visibly wrong surface but also the least visited. Channel page sits between them
and is cheap — it is mostly deletion: remove the mobile centring, add the handle line, fix the
tab metrics.

**Haddad:** Then we agree. Description, channel, search, shorts, in that order.

---

**Okonkwo → Ferreira:** On the capture feature — we cannot reach YouTube from this sandbox. You
are asking for a verification we are physically unable to perform. What do you actually want?

**Ferreira:** Not a test run. Three things. One: make the failure *legible* — if the storyboard
fetch fails and we fall back to the poster, say so in the dialog instead of silently handing
over the wrong frame. Two: a deployed preview so the user can exercise the real path, which the
user has now asked for anyway. Three: stop describing it as done. It is built, not verified.

**Okonkwo:** All three are reasonable and none are expensive.

**Varga:** The fallback already sets `source`, so the dialog has the information. It just does
not show it.

**Ferreira:** Then it is a label, and there is no excuse.

---

**Lindqvist → Haddad:** Scroll restoration. Is that in scope or is it scope creep?

**Haddad:** Creep, for today. It needs a scroll cache keyed by route and it interacts with the
infinite feed. I am withdrawing it from this pass and noting it.

---

## Round 3 — verdict

### Consensus

1. **The URL contract is the highest-value remaining gap and the cheapest of the big ones.**
   Real YouTube paths must resolve. Legacy paths redirect rather than break. *(Unanimous.)*
2. **The watch description box is the highest-value single component.** Collapsed `#272727`
   surface, bold `views · date` first line, click-to-expand, `Show less` when open. *(Unanimous.)*
3. **Channel page is mostly deletion, not design.** Drop mobile centring, add the `@handle ·
   subs · videos` line, 48px tabs with a 2px indicator, `.yt-pill` for the buttons. *(Unanimous.)*
4. **No new hand-written pill/chip metrics.** Use the tokens from council #1. *(Unanimous.)*
5. **The capture feature is built, not verified, and must be described that way** until it has
   run against a real deployment. The poster fallback must be labelled in the UI. *(Unanimous.)*
6. **Deploy a preview.** It is the only way to close item 5, and the user has asked for it.
   *(Unanimous.)*

### Strongest dissent

**Lindqvist** maintains that the shorts viewer is the most visibly non-YouTube surface in the
app and that deferring it means the parity claim is overstated. The council accepts the point
and records it rather than resolving it: *shorts remains a known, named gap.*

### Premise check

The user's premise — *"reach parity in the experience"* — was initially read by three members
as "finish the visual pass on the remaining pages". Okonkwo's 404 measurements reframed it:
experience parity includes the parts of YouTube that are not rendered at all. The council
adopted the broader reading. Members also flagged that **100% identity is not reachable** —
no ads, no sign-in graph, no recommendation model, no DRM playback — and that the honest
target is *indistinguishable in structure, navigation and chrome*.

### Work order

| # | Item | Owner | Size |
|---|---|---|---|
| 1 | Real YouTube URLs (`/results`, `/@handle`, `/channel/$id`, `/shorts/$id`, `/feed/*`, `list=`) with legacy redirects | Okonkwo | M |
| 2 | Watch description box — collapsed surface, bold meta line, expand/collapse | Haddad | S |
| 3 | Comments header — `N Comments` + Sort by (Top / Newest) | Haddad | S |
| 4 | Channel header + 48px tabs + `@handle` line | Lindqvist | M |
| 5 | Label the poster fallback in the capture dialog | Ferreira | XS |
| 6 | Token sweep on surfaces touched by 1–4; no new ad-hoc pills | Varga | S |
| 7 | Deploy preview, then exercise capture against it | Okonkwo | S |
| — | *Deferred:* shorts full-bleed, search-results list layout, scroll restoration | — | — |

### Recommendation

Do 1 through 7 in order. Report shorts, search-results layout and scroll restoration to the
user as **named, deliberate deferrals** rather than letting them pass as oversights — the
council's view is that an honest gap list is worth more than an inflated completion claim.
