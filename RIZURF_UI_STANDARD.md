# Rizurf microapp UI standard

The look and the small UI conventions every Rizurf microapp should share, taken
from what was built and shipped in **Rizurf Discussion** (PulseDiscussion). Hand
this file to the team, or the coding agent, working on another app and ask them
to apply it.

It builds on three gateway documents; where they say something, they win:

- `RIZURF_DESIGN_SYSTEM.md`: colour tokens, the shell (rail + top bar), buttons, inputs
- `MICROAPP_GATEWAY_BUTTON.md`: the floating "back to gateway" button
- `MICROAPP_BADGES.md`: the number on your app's icon in **Your apps**

This file adds what those leave open: dark mode, the exact small decisions we
made, and the fixes for the problems we actually hit.

---

## 1. Colour rules (the one rule that matters most)

**Indigo means "you can click this / this is selected". Navy and teal mean
"Rizurf".** Keep them apart.

| Use | Colour |
|---|---|
| Buttons, links, active nav item, focus rings, checkboxes, "selected" states | `--primary` `#4F46E5` (hover `--primary-600` `#4338CA`) |
| Selected background tint (active nav, active row) | `color-mix(in srgb, #4F46E5 11%, white)` |
| Headings, strong text | `--navy` `#021732`, `--navy-700` `#0A2A4E` |
| Normal text | `--ink` `#0E1B2C` |
| Labels, timestamps, icons at rest | `--muted` `#5A6B80` |
| Borders and dividers | `--line` `#E3E8EF` |
| Page background | `--soft` `#F6F8FB` |
| Cards, sidebar, top bar, dialogs | white |
| Logo, brand accents only (never a button) | `--teal` `#039DB1` |
| Unread / notification count bubble | `#E5484D` with white text |
| Online dot, success | `#12A150` |
| Danger (delete buttons) | `#DC2626` |

Rules:
- **Use variables, never raw hex, in components.** It's the only way dark mode
  (section 7) keeps working.
- If your app still has teal buttons, teal active tabs or teal focus rings from
  an older palette, **switch every one of them to indigo**. Search your CSS for
  `#039DB1`, `#00A3A6`, `rgba(3, 157, 177` and `rgba(0,163,166`.
- Shadows are navy-tinted, not grey:
  ```css
  --shadow-sm: 0 1px 2px 0 rgba(2, 23, 50, 0.05);
  --shadow-md: 0 4px 6px -1px rgba(2, 23, 50, 0.07), 0 2px 4px -2px rgba(2, 23, 50, 0.05);
  --shadow-lg: 0 10px 15px -3px rgba(2, 23, 50, 0.08), 0 4px 6px -4px rgba(2, 23, 50, 0.04);
  --shadow-xl: 0 20px 25px -5px rgba(2, 23, 50, 0.1), 0 8px 10px -6px rgba(2, 23, 50, 0.04);
  ```
- Radii: `--radius-sm: 6px`, `--radius-md: 10px` (cards, buttons, inputs, nav
  items), `--radius-lg: 14px` (dialogs), `--radius-pill` **only** for badges,
  tags and status pills.

---

## 2. The shell

Follow `RIZURF_DESIGN_SYSTEM.md` §2, with these decisions:

| Part | Standard |
|---|---|
| Top line | 4px, `linear-gradient(90deg, var(--navy), var(--primary))`, fixed, above everything |
| Top bar | **65px**, white, 1px bottom border, no shadow, 32px side padding |
| Breadcrumb | 13.5px `--muted`: `App name / ` then the page in **bold navy** (weight 650) |
| Sidebar (desktop) | 56px icon rail, widens to **208px** over the page on hover. The page never moves |
| Sidebar (below 1000px) | Hidden. A ☰ button in the top bar opens it as a drawer with a `rgba(2,23,50,0.45)` backdrop |
| Page background | `--soft`, white cards on top |

If the page uses a fixed-height layout (a chat, a board), subtract the top line
and the top bar: `height: calc(100vh - 69px)` (4px + 65px).

### Getting the rail right

```css
@media (min-width: 1001px) {
  .sidebar { width: 56px; min-width: 56px; transition: width 0.22s cubic-bezier(0.4, 0, 0.2, 1); }
  .sidebar:hover,
  .sidebar:has(:focus-visible) { width: 208px; box-shadow: var(--shadow-lg); }
  .main { margin-left: 56px; }

  /* Labels fade, but stay in place, so the icons never move. */
  .nav-label, .sidebar-user-info { opacity: 0; transition: opacity 0.14s ease; }
  .sidebar:is(:hover, :has(:focus-visible)) :is(.nav-label, .sidebar-user-info) { opacity: 1; }

  /* Collapsed: the unread count sits on the icon's corner instead of at the end of the row. */
  .sidebar:not(:hover):not(:has(:focus-visible)) .nav-count {
    position: absolute; top: 2px; left: 24px; padding: 0 5px; font-size: 0.62rem;
  }
}
@media (prefers-reduced-motion: reduce) {
  .sidebar, .nav-label, .sidebar-user-info { transition: none !important; }
}
```

- **Use `:has(:focus-visible)`, not `:focus-within`.** With `:focus-within`,
  clicking a nav item with the mouse focuses it and the rail stays open over
  the page until you click somewhere else. `:focus-visible` still opens it for
  keyboard users, which is what focus expansion is for.
- **The page must keep a fixed left margin equal to the rail (56px).** If your
  CSS sets the old sidebar width as the margin later in the file, the collapsed
  rail leaves a white gap: make the rail rule win (higher specificity or later).
- Nav items: `padding: 8px`, `gap: 11px`, 13.5px / 600, `--muted` at rest,
  `--soft` background + `--navy-700` text on hover, indigo tint + indigo text
  when active, 22px outline icons (stroke 2.2, `currentColor`).
- Hide the rail's own scrollbar (`scrollbar-width: none`) and its section
  titles; the rail is too narrow for either.
- The user/profile block sits at the bottom of the rail: 38px avatar,
  `padding: 12px 9px` so it's centred in 56px.

### Logos and favicon

Load them **from the gateway**, don't copy them:

```html
<link rel="icon" href="https://web-omega-two-47.vercel.app/logo-icon.png" />
...
<div class="sidebar-brand">
  <img class="brand-icon" src="https://web-omega-two-47.vercel.app/logo-icon.png" alt="Rizurf" />
  <img class="brand-full" src="https://web-omega-two-47.vercel.app/logo.png" alt="Rizurf Realty" />
</div>
```

```css
.brand-icon, .brand-full { display: block; height: 28px; width: auto; }
.sidebar:not(:hover):not(:has(:focus-visible)) .brand-full { display: none; }
.sidebar:is(:hover, :has(:focus-visible)) .brand-icon { display: none; }
@media (max-width: 1000px) { .brand-icon { display: none; } }
:root[data-theme="dark"] .brand-full { filter: brightness(0) invert(1); }
```

Why: a local logo file can silently disappear from a production build (a Vite
build empties `dist/` and only keeps files the page references or that sit in
`public/`), which broke our favicon. The gateway's files are always there and
always current.

---

## 3. The gateway button

Follow `MICROAPP_GATEWAY_BUTTON.md`: one script line in `<head>`, loaded from
the gateway, never copied or restyled.

```html
<script src="https://web-omega-two-47.vercel.app/widget/gateway-button.js" defer></script>
```

- **Delete any "Go back to all apps" / "Back to gateway" / sign-out button of
  your own.** The gateway button is the only way back.
- **Keep its corner empty instead of moving the button.** It sits 20px from the
  bottom-right, about 44px tall and 140px wide (a 48px circle on phones under
  560px). Lifting it with `data-offset` just moves it over your content. Leave
  the corner free in your layout:

```css
/* The bar at the bottom of the screen (compose bar, form footer, toolbar):
   leave room on the right so the button sits next to your own button. */
.bottom-bar { padding-right: 180px; }
@media (max-width: 560px) { .bottom-bar { padding-right: 80px; } }

/* A right-hand side panel or a scrolling list that reaches the bottom:
   leave room underneath so the last item can scroll clear of the button. */
.side-panel, .scroll-list { padding-bottom: 88px; }
```

  Check every screen: the button must never cover a message, a Send button, a
  list item or a form field.

---

## 4. Components

### Buttons
Rounded rectangles (`--radius-md`), never pills.

```css
.btn-primary { background: var(--primary); color: #fff; border-radius: var(--radius-md); box-shadow: var(--shadow-sm); }
.btn-primary:hover { background: var(--primary-600); box-shadow: var(--shadow-md); }
.btn-danger { background: #DC2626; color: #fff; }
.btn-danger:hover { background: #B91C1C; }
.btn-danger-subtle { color: #DC2626; background: transparent; box-shadow: inset 0 0 0 1px #DC2626; }
.btn-danger-subtle:hover { color: #fff; background: #DC2626; }
button { white-space: nowrap; }   /* button labels never wrap onto two lines */
```

### Inputs and focus
Every input gets the same indigo focus ring:

```css
input:focus-visible, textarea:focus-visible, select:focus-visible {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, #4F46E5 15%, white);
}
```

### Toasts
Bottom-right would collide with the gateway button. Put toasts somewhere else
(top-right or bottom-centre) or above the reserved corner.

```css
.toast {
  background: var(--navy-700); color: #fff;
  border-radius: var(--radius-sm); border-left: 4px solid var(--primary);
  box-shadow: var(--shadow-lg); padding: 0.75rem 1.25rem; font-size: 0.85rem; font-weight: 600;
}
```

Never give a toast a background built from a text token (e.g. `--text-main`):
in dark mode that token turns light and the white text vanishes.

### Dialogs
- Backdrop: `rgba(2, 23, 50, 0.5)` with a 4px blur. Card: white, `--radius-lg`.
- **Confirmations offer the choices in one dialog, not several menu items.**
  Example: one **Delete** item in a menu opens a dialog with *Cancel*,
  *Delete for me* (subtle danger) and *Delete for everyone* (solid danger), and
  the second is simply hidden when the person isn't allowed to. Show what's
  being deleted (a quote of it) so the person knows.
- Escape closes any dialog; focus goes to the safe button (Cancel) when it opens.

### Scrollbars
```css
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: var(--soft); }
::-webkit-scrollbar-thumb { background: #CBD5E1; border-radius: 999px; }
::-webkit-scrollbar-thumb:hover { background: #94A3B8; }
:root[data-theme="dark"] ::-webkit-scrollbar-thumb { background: #1B3452; }
```

### Counts and badges
- Unread / waiting counts: a red `#E5484D` pill, white text, bold 11px. Hidden at 0.
- When a count goes **up**, flash it once (scale 1.5 → 1 over ~1s). Never
  animate continuously.
- One count per section. If the app has two areas (e.g. *Chat* and *Groups*),
  each nav item gets its own count, not one combined number.
- In a list, **don't write "4+ new messages"** under a row that already shows a
  count bubble: show the latest item's text, in bold/highlighted, and let the
  bubble carry the number.

### Online presence
A green dot on the corner of a person's photo, only when they're online:

```css
.presence-wrap { position: relative; display: inline-flex; }
.presence-dot { display: none; }
.presence-dot.online {
  display: block; position: absolute; right: -1px; bottom: -1px;
  width: 11px; height: 11px; border-radius: 50%;
  background: #12A150; border: 2px solid var(--bg-surface);
}
```

The app pings the server about once a minute while the tab is visible, and
"online" means seen in the last ~2.5 minutes. Toggle the dots in place when the
answer comes back; don't re-render the page for it.

### Member lists (Discord-style)
For anything with members (a group, a project, a team), a side panel on the
right, toggled by a people icon in the header:

- Sections in this order: one per **role** (online members with that role,
  role order, name in the role's colour), then **Online — n**, then
  **Offline — n** at 45% opacity.
- The owner gets a 👑 right after their name.
- Section labels are sentence case ("Online — 4"), not uppercase.
- Whoever can manage roles sees a "Manage roles and members" button at the
  bottom that opens the settings.
- Width 240px (200px under 1100px); under 900px it stacks below the content.

---

## 5. Chat-style screens

For any app with messages or comments:

- **Other people's messages show a 30px round photo** to the left of the
  bubble. Your own messages don't.
- **Consecutive messages from the same person merge**, like WhatsApp: only the
  first shows the name and photo, the rest line up under it with a smaller gap
  (`margin-top: -6px` on the continuation).
- **Hover actions go under the bubble** (reactions, reply, "⋯"), not on top of
  it, where they'd hide the text of the message above.
- **Replying to an image or video shows a small thumbnail** of it in the quote,
  and "Photo" / "Video" instead of the file name when there was no caption.
- An @mention of the viewer gets a full-width indigo-tinted line that pulses
  twice, once per session.

---

## 6. Behaviour that affects the UI

- **A failed load must never look like an empty list.** If a refresh fails,
  keep what's already on screen. Only show "No messages yet" / "Nothing here"
  when the server actually said so.
- **Session expiry: reload, don't show empty screens.** Wrap `fetch`: on any
  `401` from your own API, reload the page once (guard it with a timestamp in
  `sessionStorage` so it can't loop). The reload goes through gateway sign-in
  and back.
- **Hover-only controls must be reachable without hover.** Under
  `@media (hover: none)` show them always, and make them keyboard-focusable
  (`:focus-within` on the row shows them too).
- Anything clickable that isn't a `<button>` or `<a>` needs one.

---

## 7. Dark mode

Optional, but if your app has it, do it this way so every app behaves the same:

- Toggled per device and saved in `localStorage` under **`rizurf-theme`**
  (`"dark"` / absent), applied **before first paint** by a tiny script in
  `<head>` so there's no white flash:
  ```html
  <script>try { if (localStorage.getItem("rizurf-theme") === "dark") document.documentElement.dataset.theme = "dark"; } catch (e) {}</script>
  ```
- Only the semantic tokens change; the brand palette doesn't:
  ```css
  :root[data-theme="dark"] {
    color-scheme: dark;
    --bg-surface: #0E1B2C;      /* cards, sidebar, top bar */
    --bg-canvas:  #021732;      /* page background */
    --bg-subtle:  #0A2A4E;      /* hover fills */
    --text-main:  #E7F6F8;
    --text-muted: #A7B6C8;
    --border-color: #1B3452;
    --primary-light: rgba(79, 70, 229, 0.22);  /* selected tint */
    --primary-hover: #818CF8;                  /* indigo text on dark */
    --shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.35);
    --shadow-lg: 0 12px 28px -6px rgba(0, 0, 0, 0.55);
  }
  ```
- Active nav text and indigo links use the lighter `#818CF8` in dark mode so
  they stay readable.
- The white wordmark logo: `filter: brightness(0) invert(1)`.

---

## 8. Checklist

- [ ] Every button, link, active item and focus ring is indigo; no teal left on anything clickable
- [ ] Components use `var(--…)`, not raw hex
- [ ] 4px navy→indigo top line, 65px white top bar with breadcrumb
- [ ] 56px rail → 208px on hover, page doesn't move; opens on keyboard focus but doesn't stay open after a mouse click
- [ ] Below 1000px: ☰ drawer with backdrop, nothing overflows at 375px
- [ ] Logos and favicon load from the gateway
- [ ] Gateway button script in `<head>`; its bottom-right corner is kept empty on every screen; no own back/sign-out button
- [ ] Buttons are 10px rounded rectangles; pills only for counts, tags and status
- [ ] Counts are red `#E5484D`, hidden at 0, one per section
- [ ] A failed load keeps what's on screen; a `401` reloads through sign-in
- [ ] Hover controls work on touch and keyboard
- [ ] Dark mode (if present) uses `rizurf-theme`, applies before paint, and every screen is readable in it
