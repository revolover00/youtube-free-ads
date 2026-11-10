# Council Session — 10 Nov 2026

> Run with the `council` skill installed at `.agents/skills/council/`
> (source: `tsenart/council-skill`, MIT).
> Protocol mode: **single-agent fallback** — this host has no subagent
> spawning, so the three rounds are simulated as clearly separated persona
> sections. This is disclosed per the skill's Fallback Mode rules.

---

## Problem

Youtubiy is a YouTube front-end. Three things are on the table at once:

1. **Bug sweep** — the repo has 92 TypeScript errors, several of which are
   live runtime crashes (`setMeta is not defined`, `appStore is not defined`,
   prop-name mismatches that pass `undefined` where a function is called).
2. **Visual fidelity** — the owner says the UI is "far from YouTube" and wants
   it to be *100% like YouTube*, including behaviour/structure, not just colours.
3. **New feature** — "let me take a screenshot of the video / the frame I'm
   paused on, **from inside the site**, not from the device."

Hard constraint discovered during code review: **playback is a cross-origin
`<iframe>` to `youtube.com/embed`** (`src/components/YouTubePlayer.tsx`).
Browsers forbid reading pixels out of a cross-origin iframe. `canvas`,
`html2canvas`, `getDisplayMedia` on the element — all blocked or nonsensical.
So feature #3 cannot be implemented the obvious way.

Panel: **Ada Lovelace** (formal systems / invariants), **Richard Feynman**
(first-principles mechanism), **Linus Torvalds** (senior pragmatic
engineering), **Steve Jobs** (product taste / design). Selected to match the
request for "specialists, designers and seniors" rather than the default
`architecture` triad.

---

## Round 1 — Independent analysis

### Ada Lovelace — formal systems, invariants

The screenshot request decomposes into a function
`capture: (videoId, t) -> Image` where the output must *depend on `t`*.
Everything else is packaging. There are exactly four places that function can
be evaluated, and each has a hard precondition:

| Evaluation site | Precondition | Holds here? |
|---|---|---|
| Client canvas over the player | player is same-origin | **No** — iframe to youtube.com |
| Client canvas over a `<video>` we own | we own a decodable, CORS-clean stream | Not today (`videoStreams: []`) |
| Screen Capture API | user grants per-call permission, picks a surface | Yes, but it is *the device taking the shot* |
| Server-side frame source | something on YouTube's side exposes frames by time | **Yes — storyboards** |

The storyboard spec (`playerStoryboardSpecRenderer.spec`) is a *total function
from time to tile*: `frame = floor(t * frameCount / duration)`,
`sheet = floor(frame / (cols*rows))`, `col = frame % cols`,
`row = floor((frame % (cols*rows)) / cols)`. That is a real frame decoded from
the real video, addressable by timestamp, served from `i.ytimg.com`.

The invariant I care about: **the artefact handed to the user must never
silently be a different moment than the one on screen.** If we fall back to
`maxresdefault.jpg` (the poster frame) we are lying about `t`. So: fallbacks
are allowed, but the fallback level must be *stated in the UI*.

Verdict: server-resolved storyboard tile, keyed on current time, with an
explicit quality/source label. Confidence: high.
Where I may be wrong: storyboard tiles are small (160×90 … 320×180). If the
owner's mental model of "screenshot" is "wallpaper", this fails him.

### Richard Feynman — first principles, mechanism

Let's stop talking about APIs and ask what is physically in the browser.

The pixels of the video live in a compositor layer owned by a *different
origin*. The security model exists precisely so you can't read it. There is no
clever trick — `html2canvas` will draw a white rectangle, `drawImage(iframe)`
throws, and `-webkit-background-clip` nonsense doesn't apply. Anyone who tells
you they screenshotted a YouTube iframe either used an extension (different
privilege level) or used `getDisplayMedia` and the user clicked "share this
tab".

So the question becomes: **where else does a decoded frame of this video exist
that we're allowed to touch?** Answer: YouTube ships one. The seek-preview
thumbnails you see when you scrub the progress bar are decoded frames on a
sprite sheet, public, on `i.ytimg.com`. That's the mechanism. We are not
faking a screenshot — we are fetching the frame YouTube itself decoded for
that timestamp.

Second mechanism worth naming: `getDisplayMedia({ preferCurrentTab: true })`.
The user picks the tab, we grab one `ImageBitmap`, stop the track. That yields
a *full-resolution, pixel-perfect* shot of the actual player. It costs one
permission prompt. It is still "from inside the site" — the site initiates it,
the site composes it, the site saves it — it just asks the OS politely.

Verdict: build the storyboard path as the default (zero friction, always
works, exact timestamp), and offer the display-capture path as an opt-in "HD"
mode for people who want real resolution. Confidence: high on mechanism,
medium on how many browsers expose `preferCurrentTab`.
Where I may be wrong: if YouTube starts gating storyboard specs behind PO
tokens the way it gates streams, the default path rots.

### Linus Torvalds — pragmatic engineering

Two of the three asks are not debatable, so let me be short on them.

**Bugs.** `setMeta` isn't imported in `App.tsx` — that's a hard
`ReferenceError` every time a user clicks "Save to Watch Later" with a video
object. `appStore` isn't imported in `Feed.tsx` — "Add to queue" and "Play
next" throw on every card menu. `ShortsViewer` is handed `initialIndex` and
`onOpenWatch` but declares `startIndex` and `notify` — so every short opens at
index 0 and any notify call explodes. `ChannelPage` declares
`onAddToPlaylist` as required and never receives it. These aren't type
pedantry, they're crashes, and the only reason nobody noticed is that
`tsc` is apparently never run in CI. Fix the 92 errors, then *add a typecheck
script*, or they come straight back.

**"100% like YouTube".** That phrase is a trap if you read it as pixel
diffing. Read it as: a YouTube user should never notice they left. The things
that actually leak are not colours — they're the gratuitous additions. Cards
that scale on hover. A staggered fade-in on every grid item. A "Theater" and a
"Shortcuts" button sitting in the action row where YouTube has Share/Save.
`Tajawal` as the default font when YouTube ships Roboto. Those scream
"someone's clone". Delete the decoration before you fine-tune a border radius.

**Screenshot.** Whatever you build, it must not add a new hard dependency to
the critical path. A server function that can fail and degrade is fine. A
mandatory stream proxy that pushes video bytes through a serverless function
is not — you'll eat the bandwidth bill and the cold starts, and it'll be the
first thing to break when YouTube rotates signatures.

Verdict: storyboard via existing server-function pattern, no new
infrastructure, hard-fail into a labelled fallback. Confidence: high.
Where I may be wrong: I'm dismissive of the quality complaint; if 320×180 is
genuinely useless the feature is decoration regardless of how clean the code is.

### Steve Jobs — product taste, design

You're all solving for "can we get pixels". Wrong question. The question is
**what does the user hold at the end.**

Someone pauses on a moment and hits the button because they want to *send it
to a friend* or *keep it*. What they want handed back is not a bare 320×180
JPEG. It's a card: the frame, the timestamp burned in, the video title, the
channel. That's shareable. That's worth the button. And — this is the part
that matters — **once you're composing a card, the source resolution stops
being the headline.** You upscale the frame, you put it in a frame, you add
the metadata, and a 320×180 tile becomes a 1280×720 artefact that looks
deliberate instead of apologetic.

On fidelity: "100% like YouTube" and "has a screenshot button YouTube doesn't
have" are not in conflict, and you shouldn't resolve it by hiding the feature.
Resolve it by making the button *look like it shipped from Mountain View* —
same 36px pill, same `#272727`, same icon weight, sitting in the row next to
Share. The user should feel like they found a feature, not like someone glued
one on.

One more: the keyboard shortcut. YouTube people live on the keyboard. `s` is
free. Use it, and put it in the existing shortcuts modal so it's discoverable.

Verdict: ship it as a *composed shareable card*, not a raw frame dump, styled
as native YouTube chrome. Confidence: high.
Where I may be wrong: the burned-in watermark could annoy people who want the
clean frame. Make it a toggle, default on.

---

## Round 2 — Cross-examination

**Ada → Torvalds, Jobs.**
Linus, I disagree with "no new infrastructure" being an absolute. One server
function *is* new infrastructure and you're accepting it, so the line is about
cost, not novelty — say that instead. Steve strengthened my thinking: the
composition step is what makes the resolution question survivable, and it also
gives me a natural place to render the source label I insisted on, as part of
the card rather than as a nag. Position unchanged, but I now want the
caption-card to be the *primary* output, not an export option.

**Feynman → Ada, Jobs.**
Ada's table is right but one row is understated. "Client canvas over a
`<video>` we own" is marked *not today* — it's not today because
`videoDetails()` returns `videoStreams: []`, which is a choice, not a law. I'd
keep that row alive as a future path rather than deleting it. Where I most
disagree is with Steve: upscaling 320×180 to 1280×720 is not free — it's
mushy, and people can tell. I'll accept it only if the upscale is paired with
the display-capture HD path for anyone who cares. What changed for me:
I came in thinking HD capture was the feature and the storyboard was the
fallback. It's the reverse — the zero-friction path has to be the default,
because a permission prompt on first click kills a feature.

**Torvalds → Feynman, Jobs.**
Feynman is right that I was dismissive about quality, and the two-tier answer
(instant storyboard by default, opt-in display capture for real pixels)
is better than either of my positions. Steve's point about deleting the
decoration before polishing — that was my point, and he's stating the
stronger version of it: the clone tells on itself through *additions*, not
through imprecision. Where I still disagree with Steve: a watermark on by
default is us branding the user's content without asking. Default it *off*
for the plain frame and *on* only for the explicitly-chosen "share card"
layout. Two outputs, one button, a toggle between them.

**Jobs → Torvalds, Feynman.**
Linus is right about the watermark default and I'll take it — but the toggle
has to be one control, not a settings panel. Richard's two-tier framing is
the correct product shape and it maps to language the user already
understands: "Quick" and "HD". On the fidelity work, I want to add a
constraint nobody has stated: **the screenshot dialog itself must be YouTube
chrome.** Same surface colour, same pill buttons, same corner radii. If the
dialog looks like shadcn defaults, the whole "100% like YouTube" claim
collapses at the exact moment the user is most engaged.

---

## Round 3 — Final positions

- **Ada:** Storyboard-indexed capture, total and timestamp-exact; every output
  carries its provenance. The composed card is the primary artefact.
- **Feynman:** Two tiers. Storyboard = default, instant, no prompt. Display
  capture = opt-in HD. Keep the "our own `<video>`" path documented as the
  future upgrade when `videoStreams` is populated.
- **Torvalds:** Fix the 92 errors and add a `typecheck` script first — a new
  feature on a codebase that doesn't compile is malpractice. Then strip the
  non-YouTube decoration. Then the feature, through the existing server-function
  pattern only. Watermark off by default on the raw frame.
- **Jobs:** One button, two outputs, one toggle. Native YouTube chrome
  everywhere including the dialog. `s` on the keyboard, listed in the
  shortcuts modal.

---

## Council Verdict

### Consensus Position

Build the capture feature on **YouTube's own storyboard sprite sheets**,
resolved server-side and returned as base64 so the browser never has a CORS
problem, cropped and composed on a client canvas. Default path is instant and
prompt-free; an opt-in **HD** path uses `getDisplayMedia({ preferCurrentTab })`
for true-resolution grabs. Order of work: **bugs → strip non-YouTube
decoration → fidelity pass → feature.**

### Key Insights by Member

- **Ada** — the storyboard spec is a total function from timestamp to tile, so
  the capture is genuinely "the frame I'm on", not an approximation; provenance
  must be visible.
- **Feynman** — cross-origin iframe pixels are unreachable by construction; the
  frames we *can* reach are the ones YouTube already decoded for its scrubber.
- **Torvalds** — the crashes are real and un-caught because nothing runs `tsc`;
  the clone tells on itself through additions (hover-zoom, stagger animation,
  stray buttons, wrong font), not through imprecise spacing.
- **Jobs** — the deliverable is a shareable artefact, not a pixel dump, and the
  dialog itself has to be YouTube chrome or the fidelity claim dies on contact.

### Points of Agreement

- Cross-origin iframe capture is impossible; stop looking.
- Default path must be zero-friction (no permission prompt).
- Typecheck in CI, or the same bugs return.
- Non-YouTube flourishes get deleted before anyone argues about border radius.
- The button must be indistinguishable from native YouTube chrome.

### Points of Disagreement

- **Upscaling.** Feynman thinks 320×180 → 1280×720 is visibly mushy; Jobs
  thinks composition makes it a non-issue. Unresolved — mitigated by shipping
  the HD tier.
- **Watermark default.** Jobs wanted on; Torvalds won the argument for off on
  the raw frame, on for the share-card layout.

### Minority Report

Feynman: the only *durable* answer is owning the playback stack — populate
`videoStreams`, play our own `<video>`, and capture frames locally at full
resolution. Everything else is renting a mechanism from YouTube that YouTube
can revoke. Worth doing eventually; too large to couple to this change.

### Unresolved Questions

1. Does the owner consider a composed card an acceptable "screenshot", or does
   he mean a raw full-resolution frame? (HD tier hedges this.)
2. How long until storyboard specs require PO tokens like streams do?

### Recommended Next Steps

1. Drive TypeScript errors to zero, fix the four runtime crashes, add
   `npm run typecheck`.
2. Delete non-YouTube decoration and rebuild header / sidebar / grid / card /
   watch layout against real YouTube metrics.
3. Ship capture: server fn → storyboard tile → client canvas → YouTube-chrome
   dialog, with `s` shortcut, Quick/HD tiers and a watermark toggle.
