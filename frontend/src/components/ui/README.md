# Control-panel design system

Every screen in `frontend/src` is built from this folder. Import from the barrel:

```tsx
import { Button, IconButton, Card, PageHeader } from "../components/ui";
```

Colours come only from the tokens in `frontend/src/index.css` (`bg`, `panel`, `line`, `text-main`, `muted`, `faint`, `brand-*`, `ok`, `warn`, `danger`, `info`). Layout uses logical properties (`ms` / `me` / `ps` / `pe` / `start` / `end`) so Arabic RTL works. Touch targets are at least 40px. New visible strings, including tooltips, go in `i18n/en/dashboard.json` and the same key in every required locale (`ar`, `pt-BR`, `es-419`), then `npm run i18n:build`. `frontend/src/i18n/translations.ts` is generated.

The four status tokens (`ok`, `warn`, `danger`, `info`) are theme-aware and meet WCAG AA contrast (at least 4.5:1) as text against both `panel` and `panel-raised` surfaces in light and dark themes.

`text-white` is the foreground on `primary` and `danger-fill` fills (`danger-fill` keeps white text at 4.5:1 or more in both themes), and the switch thumb is `bg-white`, because those sit on saturated brand / danger tokens in both themes. Do not add any other raw colour.

## Design contract

The control panel adheres to a unified, tokenized design contract. Screens do not invent their own layout metrics, colors, typography, or interaction patterns.

### Typography scale and heading hierarchy

- **Page title**: [PageHeader](#card--panel--cardheader--pageheader--section) uses `text-base font-bold text-text-main md:text-lg`. Page-level description uses `text-xs text-muted`.
- **Section title**: [Section](#card--panel--cardheader--pageheader--section) or [CardHeader](#card--panel--cardheader--pageheader--section) uses `text-base font-bold text-text-main md:text-lg`.
- **Card / Row title**: [Card](#card--panel--cardheader--pageheader--section), [StatTile](#stattile), and [ListRow](#listrow) use `text-sm font-semibold text-text-main` or `text-sm font-bold text-text-main`.
- **Body copy**: Standard content uses `text-sm text-text-main` (dense) or `text-xs leading-relaxed text-muted` (descriptions, hints, and explanations).
- **Meta / Captions**: Secondary hints use `text-xs text-muted`. Eyebrows and section tags use `text-[11px] font-bold uppercase tracking-wider text-faint`.
- **Monospace tokens**: Technical commands, prefixes, JIDs, phone numbers, and cron strings use `font-mono text-xs` or `text-sm` via [CodeText](#codetext) (`<bdi dir="ltr">`).
- **Text density**: Content remains compact and information-dense without excessive vertical line spacing. User text is clamped to 1-3 lines using [UserText](#usertext) with the full text provided in the `title` attribute.

### Colour tokens and semantic colours

All colours derive strictly from the CSS variables declared in `frontend/src/index.css`:
- **Surfaces**: `bg` (`--color-bg`), `bg-soft` (`--color-bg-soft`), `panel` (`--color-panel`), `panel-raised` (`--color-panel-raised`), `panel-hover` (`--color-panel-hover`), `panel-solid` (`--color-panel-solid`).
- **Borders and lines**: `line` (`--color-line`), `line-soft` (`--color-line-soft`).
- **Text levels**: `text-main` (`--color-text-main`), `muted` (`--color-muted`), `faint` (`--color-faint`).
- **Brand accents**: `brand-blue` (`#176bfa`), `brand-blue-deep` (`#0b50d0`), `brand-cyan` (`var(--brand-cyan)`), `brand-purple` (`#a855f7`).
- **Semantic status**: `ok` (`--color-ok`), `warn` (`--color-warn`), `danger` (`--color-danger`), `danger-fill` (`--color-danger-fill`), `info` (`--color-info`).
- **Contrast rule**: `tests/ui-contrast.test.mjs` enforces WCAG AA contrast (at least 4.5:1 relative luminance) for text against both `panel` and `panel-raised` surfaces across both dark and light modes. White text (`text-white`) is permitted only on saturated fills (`primary` and `danger-fill`), and the switch thumb is `bg-white`. Never use raw hex literals (`#...`) or Tailwind palette classes (`text-red-400`, `bg-slate-*`).

### Radii, elevation, and card surfaces

- **Page cards**: `rounded-2xl border border-line bg-panel shadow-sm` ([Card](#card--panel--cardheader--pageheader--section), with `p-4 md:p-5` default padding).
- **Raised rows and compact tiles**: `rounded-xl border border-line bg-panel-raised/40` or `bg-panel` ([StatTile](#stattile), [ListRow](#listrow), with `p-3 sm:p-4`).
- **Dialog panels**: `rounded-2xl border border-line bg-panel shadow-xl` ([Dialog](#dialog--confirmdialog)), switching to `rounded-none sm:rounded-2xl` under `mobileFullscreen`.
- **Badges, pills, and chips**: `rounded-full` ([Badge](#badge--statuspill), [Chip](#chip--chipinput)).
- **Inputs and buttons**: `rounded-xl` ([Button](#button), [Input](#field-input-textarea-select-checkbox-radiogroup-toggle)).

### Spacing, page padding, grid, and breakpoints

- **Mobile first**: Minimum supported viewport is 360 px width. Layouts must never cause horizontal scrolling, clipped badges, or overflowing tables.
- **Page padding**: Outer view padding follows `p-4 md:p-6 lg:p-8`.
- **Grid layouts**: 1 column on mobile (`grid-cols-1`), expanding to 2 columns on tablet/desktop (`sm:grid-cols-2` or `xl:grid-cols-2`). Stat grids use a compact 2-column mobile grid (`grid grid-cols-2 gap-3 sm:grid-cols-4`).
- **Breakpoints**: Standard Tailwind breakpoints: `sm` (640px), `md` (768px), `lg` (1024px), `xl` (1280px).

### Button hierarchy

- **Primary**: Exactly one primary button (`<Button variant="primary">`) per screen region for the principal call-to-action ("Start session", "Save changes", "Create pack").
- **Secondary**: `<Button variant="secondary">` for named alternative actions ("Restart", "Export").
- **Ghost**: `<Button variant="ghost">` for low-emphasis, tertiary text actions ("Discard", "Cancel").
- **IconButton (R1)**: Simple, self-explanatory actions (share, download, copy, edit, delete, refresh, close, open-externally, export) MUST use `<IconButton>` with a required localized `label` for tooltips and accessibility. Never use full icon-and-text buttons for routine utility actions.
- **Danger**: `<Button variant="danger">` is reserved strictly for destructive confirmation actions inside confirmation dialogs. Never place a full-width danger button in normal page flow.
- **OverflowMenu (R2, R5)**: Non-essential, secondary, rarely used, and rare destructive actions belong in an [OverflowMenu](#menu--menuitem--overflowmenu). An overflow menu must contain at least two items (a single secondary action remains an `IconButton`). It sits beside the primary action at the end of the row, never alone on its own row.

### Inputs, selects, toggles, checkboxes, labels, SaveField vs useDirtyForm (R6)

- Always wrap inputs with [Field](#field-input-textarea-select-checkbox-radiogroup-toggle) to connect `label`, `description`, and `error` via accessible IDs.
- **Explicit save requirement**: Settings that the operator types or picks MUST use explicit save mechanisms. Never save on blur or on keystroke.
- **Per-field save**: For single, independent settings (timezone, standalone API key, storage limit, panel language), use [SaveField](#savefield--usesavedvalue--formactions--usedirtyform) paired with `useSavedValue`. It renders an inline save `IconButton` enabled only when dirty, displays a spinner while saving, Enter saves, and Escape reverts.
- **Form-level save**: For interdependent grouped settings (delay minimum and maximum, provider endpoint + key + model, proxy host/port/auth), wrap fields in a `<form>` and use `useDirtyForm` with [FormActions](#savefield--usesavedvalue--formactions--usedirtyform) (Save `type="submit"` and Discard).
- **Toggles**: [Toggle](#field-input-textarea-select-checkbox-radiogroup-toggle) switches apply immediately on toggle (a switch represents live circuit state).

### Dialogs, bottom sheets, overflow menus, confirmation for destructive actions

- **Modals**: Use [Dialog](#dialog--confirmdialog). Long editor forms on mobile use `variant="mobileFullscreen"`, ensuring full viewport height below 640px with sticky footers clearing `env(safe-area-inset-bottom)`.
- **Bottom sheets**: [Popover](#popover) and [FilterButton](#filterbutton) automatically convert to bottom sheets on screens smaller than 640px.
- **Destructive confirmation**: Any destructive or irreversible operation (deleting records, unlinking accounts, purging logs) requires a [ConfirmDialog](#dialog--confirmdialog) with `variant="danger"`.

### Loading, empty, error, success, disabled states

- **Loading**: Use [LoadingState](#emptystate--spinner--skeleton--loadingstate) for entire view loading, [Spinner](#emptystate--spinner--skeleton--loadingstate) for inline actions, and [Skeleton](#emptystate--spinner--skeleton--loadingstate) for card/list content placeholders.
- **Empty**: Use [EmptyState](#emptystate--spinner--skeleton--loadingstate) with `kind="empty"` for zero records, or `kind="no-results"` for filtered search results. Render empty states outside horizontally scrollable table containers.
- **Error**: Use [EmptyState](#emptystate--spinner--skeleton--loadingstate) (`kind="error"`), [Callout](#callout) (`tone="danger"` or `"warn"`), or `toast(userErrorMessage(t, err, fallbackKey), "error")`. Never show raw error objects or `.message` strings.
- **Success**: Use `toast(t("savedSuccessfully"), "success")`, [SaveField](#savefield--usesavedvalue--formactions--usedirtyform) `justSaved` checkmarks, or [Callout](#callout) (`tone="ok"`).
- **Disabled**: Apply the native `disabled` attribute, which dims opacity to 50% and removes pointer events.

### RTL/LTR and bidi

- **Logical properties only**: Always write `ms-`, `me-`, `ps-`, `pe-`, `start-`, `end-`. NEVER use physical layout classes (`ml-`, `mr-`, `pl-`, `pr-`, `left-`, `right-`, `text-left`, `text-right`, `rounded-l-`, `rounded-r-`, `border-l-`, `border-r-`).
- **Technical tokens**: Pass technical strings (commands, prefixes, phone numbers, JIDs, cron expressions, placeholders) through [CodeText](#codetext) (`<bdi dir="ltr">`) so tokens retain left-to-right order inside Arabic RTL layouts.
- **User-entered text**: Wrap arbitrary user input (pack names, keywords, chat titles) in [UserText](#usertext) with `dir="auto"`.

### Navigation, tabs, toolbars, page headers

- **Page header**: [PageHeader](#card--panel--cardheader--pageheader--section) standardizes titles, descriptions, status icons, and top-level action toolbars.
- **Tabs & segments**: Use [Tabs](#tabs--segmentedcontrol) for scrolling pill lists. Use [SegmentedControl](#tabs--segmentedcontrol) for compact, enclosed view switches with roving keyboard navigation.
- **Toolbars**: [Toolbar](#toolbar) wraps search [Input](#field-input-textarea-select-checkbox-radiogroup-toggle) (`flex-1 min-w-48`), [FilterButton](#filterbutton) (R3: single filter dropdown/sheet), [SortMenu](#sortmenu) (R4: single sort dropdown), and [OverflowMenu](#menu--menuitem--overflowmenu).

### Accessibility

- **Accessible names**: Every interactive button, input, toggle, and dialog must have an accessible name via localized `label`, `aria-label`, or associated `<FieldLabel>`.
- **Focus visible**: Focus rings use `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue`.
- **Touch targets**: All interactive targets must provide at least a 40px touch bounding box (e.g., [Toggle](#field-input-textarea-select-checkbox-radiogroup-toggle) has a 44px hit target, [IconButton](#iconbutton) minimum 40px).
- **Keyboard navigation**: Escape closes dialogs, menus, and popovers; arrow keys navigate roving menus and tab segments; focus is automatically trapped within active dialogs.

### Content density rules

1. **Short actionable labels**: Use concise verbs and direct phrases instead of lengthy prose.
2. **No repeated information across cards**: Do not echo page headers or replicate data between sibling cards.
3. **Progressive disclosure**: Keep advanced and rarely adjusted settings tucked inside disclosures or overflow menus.
4. **Never show JIDs, internal keys, database fields, raw error objects, decision traces to ordinary users**: Format identifiers as contact names or phone numbers, and translate errors.
5. **Never show raw placeholders like {quotedText} or {count} as finished text outside an editor**: Interpolate values or display formatted previews.
6. **Concise status labels**: Use short translated status pills (`ok`, `warn`, `danger`, `info`) rather than descriptive sentences.
7. **No card per setting**: Group related configuration options into cohesive sections and cards.
8. **Grouping over whitespace**: Separate logically grouped controls with borders, dividers, or subtle surface tiers rather than excessive blank margins.
9. **No oversized buttons for secondary actions**: Keep secondary and utility actions as compact icon buttons or standard buttons.
10. **Keep security, billing and destructive explanations**: Never omit essential warnings, data loss explanations, or security prerequisites to save space.

### PR checklist

Every UI PR must fulfill this checklist before merge:
- [ ] Before/after screenshots captured at 360 px mobile viewport and 1280 px desktop viewport.
- [ ] Visual verification in both light and dark themes.
- [ ] Visual verification in both English (LTR) and Arabic (RTL) locales.
- [ ] Automated static guards pass: `tests/ui-design-contract.test.mjs`, `tests/ui-contrast.test.mjs`, `tests/ui-no-raw-keys.test.mjs`.
- [ ] No untranslated strings, English fallbacks (`|| "..."`), or raw identifiers. All new visible strings defined in `i18n/*/dashboard.json`.

## Composition

One base per concept. Variants are a hand-written map (`buttonVariants`, badge `TONE`) passed through `cn()` from `frontend/src/utils/cn.ts`. A specialised control is built by rendering the base, not by copying its class string.

```tsx
import { IconButton, type IconButtonProps } from "./button";

export function RefreshButton(props: Omit<IconButtonProps, "label"> & { label?: string }) {
  return <IconButton variant="ghost" label={props.label ?? "Refresh"} {...props} />;
}
```

To add a component: create it here, export it from `index.ts`, add a section to this file, then use it. Do not fork a one-off in a view.

Props extend the native element (`ComponentPropsWithoutRef`) and forward `ref` and `className`. `className` is for layout (width, `self-center`), not a new look.

## Action rules

- **R1.** Simple actions are `IconButton` (the `label` prop is the tooltip and the accessible name): share, download, copy, edit, delete, refresh, close, open-externally, export. Text, with an optional icon, is for the screen's primary action and for actions whose icon alone is ambiguous ("Start session", "Save", "Create pack").
- **R2.** Non-essential, secondary, rarely used, and rare destructive actions go in `OverflowMenu`. Only essential actions stay visible.
- **R3.** Filters are one `FilterButton`. It opens a popover on desktop and a bottom sheet under 640px. No rows of filter chips or selects.
- **R4.** Sorting is one `SortMenu`. No row of sort options and no visible sort `<select>`.

## Catalogue

### Button

`variant`: `primary` | `secondary` | `ghost` | `danger`. `size`: `sm` | `md` | `lg`. `loading` replaces the icon with a spinner and disables the control. `icon` is an optional leading glyph.

Use `primary` for the screen's main action, `secondary` for a named alternate, `ghost` for a quiet text action, `danger` for a destructive confirm.

```tsx
<Button variant="primary" icon={<Play size={16} />} onClick={start}>
  {t("start")}
</Button>
```

### IconButton

`LinkButton` is the same button surface for navigation. It renders an anchor, so a link never nests a button.

Icon only. `label` is required. Same variants and sizes. `pressed` sets `aria-pressed` for toggle-style tools (auto-scroll, active filter).

```tsx
<IconButton label={t("share")} icon={<Share2 size={18} />} onClick={share} />
```

### Card / Panel / CardHeader / PageHeader / Section

`Card` and `Panel` are the bordered surface (`padded` defaults to true; set `padded={false}` for a flush table). `CardHeader` takes `title`, `description`, `actions`, and an `icon`. `PageHeader` is that header on a card. `Section` is the header plus children, without a card.

```tsx
<PageHeader icon={<Terminal size={20} />} title={t("logs")} description={t("logsSubtitle")} actions={<IconButton label={t("refresh")} icon={<RefreshCw />} />} />
```

### Badge / StatusPill

`tone`: `ok` | `warn` | `danger` | `info` | `neutral`. `StatusPill` adds an optional `dot` and `pulse`.

```tsx
<StatusPill tone={online ? "ok" : "warn"} dot pulse>{online ? t("online") : t("offline")}</StatusPill>
```

### Field, Input, Textarea, Select, Checkbox, RadioGroup, Toggle

`Field` wraps a control with `label`, `description`, and `error`. `Input`, `Textarea`, and `Select` are the native controls with the shared field style. `Checkbox` and `RadioGroup` are labelled choices. `Toggle` is the switch (`checked`, `onChange(checked)`, optional `label` and `description`). When `htmlFor` is set, the error or description `<p>` uses id `${htmlFor}-message`; the control should set `aria-describedby` to that id (join with a space if it already has one). With no `htmlFor`, the `<p>` has no id.

`Toggle` keeps a 44px-high hit target around its 44×26px visible track (20px thumb, equal 3px insets). Its button ref, `id`, `disabled`, `role="switch"`, and `aria-checked` work as native controls do.

For technical tokens (keys, URLs, emails, model IDs, JIDs, command names), pass `technical` to `Input`. It sets `dir="ltr"` and start alignment inside an RTL form. An explicit `dir` overrides it.

`PasswordInput` extends native input props except `type` and `technical`, forwards the input ref, and owns an independent reveal state. It starts hidden and uses translated show/hide labels with `aria-pressed`. It defaults to `dir="ltr"`, `spellCheck={false}`, `autoCapitalize="off"`, and `autoCorrect="off"`; pass those props to override. Put it directly inside `Field` or `SaveField` and keep the saved secret out of `value`.

Per-row settings stay as `Select` (with `SaveField`) or `Toggle`. A list filter does not — that is `FilterButton`.

```tsx
<Field label={t("packName")} htmlFor="pack-name" error={nameError}>
  <Input
    id="pack-name"
    aria-describedby={nameError ? "pack-name-message" : undefined}
    value={name}
    onChange={(event) => setName(event.target.value)}
  />
</Field>
```

### SaveField / useSavedValue / FormActions / useDirtyForm

Settings that the operator types or picks do not save on blur or on every change. A `Toggle` still applies immediately — that is what a switch means.

**Per-field** — one independent value (timezone, a standalone API key, a storage number, panel language, bot reply language, a group media restriction, a command permission). `useSavedValue` holds the draft. `SaveField` renders the input plus an inline Save `IconButton` at its end: enabled only while the draft differs from the saved value, spinner while saving, a brief success check, Enter saves (on an `<input>`), Escape reverts, error under the field.

```tsx
const timezone = useSavedValue(savedTimezone);
<SaveField
  label={t("botTimezone")}
  dirty={timezone.dirty}
  saving={timezone.status === "saving"}
  justSaved={timezone.status === "saved"}
  error={timezone.error}
  onSave={() => timezone.save(persistTimezone)}
  onRevert={timezone.revert}
  saveLabel={t("save")}
  savedLabel={t("saved")}
>
  <Input value={timezone.value} onChange={(event) => timezone.setValue(event.target.value)} />
</SaveField>
```

**One form** — values that only make sense together (min+max delay, the selected AI provider's API key + base URL + model, the WhatsApp proxy protocol/host/port/username/password). `useDirtyForm` holds the group. `FormActions` is one primary Save and a Discard, both disabled until something changed, with an "unsaved changes" hint. Wrap the fields in a `<form>`; Save is `type="submit"`.

```tsx
const delay = useDirtyForm({ min: savedMin, max: savedMax });
<form
  onSubmit={(event) => {
    event.preventDefault();
    delay.save(persistDelay);
  }}
>
  <Input value={delay.draft.min} onChange={(event) => delay.setField("min", Number(event.target.value))} />
  <Input value={delay.draft.max} onChange={(event) => delay.setField("max", Number(event.target.value))} />
  <FormActions
    dirty={delay.dirty}
    saving={delay.status === "saving"}
    justSaved={delay.status === "saved"}
    error={delay.error}
    onDiscard={delay.revert}
    saveLabel={t("save")}
    discardLabel={t("discard")}
    unsavedLabel={t("unsavedChanges")}
    savedLabel={t("saved")}
  />
</form>
```

Dialogs that already end in a submit button stay as they are.

### Dialog / ConfirmDialog

`Dialog` keeps the old modal contract: `isOpen`, `onClose`, `title`, `children`, `footer`, `maxWidth`. Escape and the backdrop close it. Focus is trapped and returned to the trigger. The body scrolls and the footer stays on screen. The footer's bottom padding (the body's, when there is no footer) is `max(1rem, env(safe-area-inset-bottom))`. `ConfirmDialog` composes `Dialog` with cancel and confirm buttons (`variant` `danger` or `primary`, `loading`).

`Dialog` has a `variant` map: `default` stays centered; `mobileFullscreen` fills the viewport below 640px and keeps the centered desktop layout and `maxWidth`. Both share the same focus trap, scrolling body and sticky footer. The full-screen header clears `env(safe-area-inset-top)`; the footer clears `env(safe-area-inset-bottom)`. Import `Dialog` and `DialogVariant` from the barrel. Long editor forms use `<Dialog variant="mobileFullscreen" footer={actions}>…</Dialog>`.

```tsx
<ConfirmDialog
  isOpen={open}
  onClose={close}
  onConfirm={remove}
  title={t("deletePackTitle")}
  confirmLabel={t("delete")}
  cancelLabel={t("cancel")}
/>
```

### Popover

Anchored to `trigger`. Click-outside and Escape close it. It flips to stay on screen and treats `align` `start` / `end` as logical (RTL-aware). Under 640px it renders as a bottom sheet, with bottom padding `max(1rem, env(safe-area-inset-bottom))` so the last control clears the home indicator. `haspopup` is `"menu"` or `"dialog"`.

Build menus and filters on this. Do not position a dropdown by hand.

### Tour / Spotlight

The guided tour. `Tour` renders a fixed overlay (via portal): the page dimmed to
token colours with a rounded cut-out around the current target, a soft
brand-token glow ring pulsing around it (disabled under
`prefers-reduced-motion`), and the explanation card anchored beside the target.
Under 640px the card docks to the bottom like a sheet.

Steps point at real elements by their `data-tour` attribute values. The target
is scrolled into view when a step starts; if it never appears within ~1.5 s
(feature hidden, empty state) the step is skipped silently — the host receives
`onAdvance` for that. `index`, `onAdvance`, `onBack` and `onClose` are owned by
the host so it can switch hash routes between steps; the card, keyboard
support (Escape closes, arrow keys advance in reading direction, initial focus
on Next), focus trap and repositioning live here.

```tsx
<Tour
  open
  index={2}
  steps={[{ target: "connection-start", title, body }, ...]}
  labels={{ back, next, done, skip, stepOf: "Step 3 of 10" }}
  onAdvance={next}
  onBack={back}
  onClose={finish}
/>
```

### Menu / MenuItem / OverflowMenu

`Menu` is a popover with `role="menu"`. `MenuItem` is `role="menuitem"` (`danger` uses the danger tone, `checked` draws a check, arrow keys move, Enter and Space activate). `OverflowMenu` is the 3-dots `MoreVertical` button on `IconButton`.

```tsx
<OverflowMenu label={t("more")}>
  <MenuItem icon={<Pencil size={16} />} onSelect={rename}>{t("rename")}</MenuItem>
  <MenuSeparator />
  <MenuItem danger icon={<Trash2 size={16} />} onSelect={remove}>{t("delete")}</MenuItem>
</OverflowMenu>
```

A `type="submit"` item stays mounted so a real form post (sign out) still fires.

### FilterButton

The filter icon. `activeCount` shows a badge. `onReset` renders inside the panel. Children are the choices (`Select`, `RadioGroup`, `Checkbox`).

```tsx
<FilterButton label={t("filter")} resetLabel={t("reset")} activeCount={count} onReset={reset}>
  <Select aria-label={t("filterBy")} value={filter} onChange={...}>...</Select>
</FilterButton>
```

### SortMenu

One `ArrowUpDown` button. `options` is `{ value, label }[]`. The current value gets a check.

```tsx
<SortMenu label={t("sort")} value={sort} onChange={setSort} options={sortOptions} />
```

### Tabs / SegmentedControl

Both take `value`, `onChange`, `options` (`{ value, label, icon? }`), and `aria-label`. `SegmentedControl` is one enclosed, horizontally scrolling single row (source switch, short modes). Both controls support Arrow Left/Right (following RTL), Home/End and roving keyboard focus. `Tabs` is a row of pills for a scrolling section switch.

### Chip / ChipInput

`Chip` is a token. Pass `onRemove` and `removeLabel` to make it removable (an `IconButton`). `dir` defaults to `auto` for text the operator typed.

`ChipInput` is that chip plus a draft field. Enter, comma, or an Arabic comma commits the draft. Backspace on an empty draft removes the last chip. Pasting `a, b, c` splits on commas. `max` and `maxLength` reject the extra token through `onReject` (`"max"`, `"long"`, `"empty"`, `"duplicate"`). `prepare` maps a raw token to the stored string (keyword normalization). `countLabel` is the counter, already translated. `removeLabel` names each remove button.

```tsx
<ChipInput
  value={keywords}
  onChange={setKeywords}
  max={50}
  removeLabel={(word) => fill(t("removeKeyword"), { word })}
  countLabel={fill(t("keywordCount"), { n: keywords.length, max: 50 })}
  aria-label={t("keywordsLabel")}
/>
```

### CodeText

A technical token: a command, a prefix, a timezone id, a cron expression, a phone number, or a `{placeholder}`. It renders `<bdi dir="ltr">` in a monospace face so the token keeps its written order inside Arabic RTL. The text is exactly `children` — nothing is reversed or inserted. Set `copy` to add a copy `IconButton` (`copyLabel` is its accessible name). The button calls `navigator.clipboard.writeText` and shows the translated failure when the browser refuses. It does not throw.

```tsx
<CodeText>{`!help`}</CodeText>
<CodeText copy copyLabel={t("copyCommand")}>{`${prefix}${command.name}`}</CodeText>
```

### UserText

A name or a message the operator typed (a sticker pack, a sticker, a keyword, a chat subject). It sets `dir="auto"` so Arabic, English, and mixed strings each lay out inside both the RTL and the LTR UI, and it wraps with `break-words` instead of cutting words off. Set `lines` (`1`–`3`) for dense cards and chips: the element clamps and, when the child is a string, gets the full text as its `title`. Use it for every user-entered string, or `dir="auto"` when the element already is a primitive (an `<option>`). Commands, prefixes, and other tokens use `CodeText`, not `UserText`.

```tsx
<UserText className="font-bold">{pack.name}</UserText>
<UserText as="p" lines={2}>{sticker.name}</UserText>
```

### RelativeTime

A `<time>` whose text comes from `Intl.RelativeTimeFormat` in the active language. `value` is unix milliseconds, an ISO string, or a `Date`. The tooltip is the absolute time. Mounted instances share one 30s ticker.

```tsx
<RelativeTime value={rule.lastDeletedAt} className="text-xs text-muted" />
```

### EmptyState / Spinner / Skeleton / LoadingState

`EmptyState` accepts `icon`, `title`, `description` (and `text` for a single muted line), plus an `action`. `Spinner` is the inline indicator (`label` makes it a status). `LoadingState` is the centred spinner. `Skeleton` is the pulse block.

Set `kind="empty"` for no records, `kind="no-results"` for an empty search/filter, or `kind="error"` for a failed load. Each has a translated default title; `title` overrides it. Pass at most one `action` (Create, Clear filters, or Retry). Render the empty state outside any min-width table wrapper so it fits mobile screens.

### Pagination / usePagination

`<Pagination page={page} pageCount={pageCount} total={total} onPageChange={setPage} label={optionalAccessibleLabel} />` shows a count even for one page, and hides the controls when there is only one page. Its arrows follow RTL. Server-paged screens can use it directly.

`usePagination<T>(items: T[], pageSize = 20, resetKey?: unknown)` returns `{ page, pageCount, pageItems, setPage, total }`. Filter and sort first, then pass the resulting array. Change `resetKey` when search, filters, or sort change; the hook resets to page 1 and clamps when the list shrinks.

### InfoTip

`<InfoTip label={t("indicatorLabel")} content={t("indicatorExplanation")}><Icon size={16} /></InfoTip>` accepts any icon child. The icon button has the accessible `label`; the explanation has `role="tooltip"` and is connected with `aria-describedby` while open. Hover or focus opens it. Tap toggles it; Escape and an outside tap close it. The tooltip stays inside the viewport.

### Toolbar

A wrapping row. Put the search `Input` first (`className="min-w-48 flex-1"`), then `FilterButton`, `SortMenu`, and `OverflowMenu`.

### CrownIcon / PlusBadge / PlusFeatureRow

`CrownIcon` is the Levix Plus crown as an inline SVG in `currentColor`. It is `aria-hidden`, so always put text beside it. `PlusBadge` is a pill with that text (`tone`: `active` | `muted`, `crown` adds the icon).

`PlusFeatureRow` announces one Plus feature in the screen it belongs to. Props: `title`, `benefit` (one line), and `tab` (the Plus page tab, such as `autoReply`). It reads the server's answer through `usePlusStatus` and maps it with `accessFromStatus`:

- `active`: an "Open" link to `#plus/<tab>`.
- `locked`: a lock mark, the benefit line and a "Learn more" link to `#plus`. No dialog, no popup.
- `unknown`: says the status is being checked; the action is disabled and explains why.
- `unavailable` (not offered on this platform): renders nothing.

Add at most one per screen, never in place of a free control, and never decide access in the view.

```tsx
<PlusFeatureRow tab="autoReply" title={t("plusRowAutoReplyTitle")} benefit={t("plusRowAutoReplyBenefit")} />
```

### StatusDot / Avatar / Disclosure

`StatusDot` takes a `tone` and accessible `label`; it displays only a dot.
`Avatar` takes an optional `src` and a `name`, loads its picture lazily and falls back to the
name initial on missing/failed images. Give it a new key when its source changes.
An absent `src` renders only the fallback and makes no image request.
`Disclosure` takes `summary` and children, composing Card and Button into an
animated expandable region. Closed content is inert and hidden from assistive
technology; reduced-motion preferences disable the transition. Put only
noninteractive content in its summary.

### StatTile

A compact metric tile designed for a 2-column mobile grid (`grid-cols-2`). Displays a `label`, prominent `value`, optional `icon`, and optional `hint` or `trend`. May be rendered as an interactive tile with `onClick` or `href`. `variant`: `default` | `raised`.

```tsx
<StatTile
  label={t("commandCount")}
  value={stats?.commandCount ?? 0}
  icon={<Terminal size={16} />}
  hint={t("activeCommands")}
/>
```

### ListRow

A compact list row for dense collections (Needs Attention items, Auto Reply chat targets, message templates). Accepts leading icons or avatars, a `title`, an optional `meta` line, and an optional `trailing` slot for action buttons or badges. Supports `as="li"` or `as="div"`, and optional `onClick` / `href` for interactive rows. `variant`: `default` | `raised` | `ghost`.

```tsx
<ListRow
  leading={<Avatar name={chat.name} src={chat.photoUrl} size="sm" />}
  title={chat.name}
  meta={chat.lastMessageTime}
  trailing={<IconButton label={t("edit")} icon={<Pencil size={16} />} onClick={editChat} />}
/>
```

### Callout

An inline notice box with semantic tone styling (`ok` | `warn` | `danger` | `info`), an icon (defaults to semantic Lucide icons), a `title`, short descriptive body `children`, and an optional `action` slot.

```tsx
<Callout tone="warn" title={t("backupWarningTitle")} action={<Button variant="secondary" size="sm">{t("learnMore")}</Button>}>
  {t("backupWarningBody")}
</Callout>
```
