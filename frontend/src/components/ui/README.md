# Control-panel design system

Every screen in `frontend/src` is built from this folder. Import from the barrel:

```tsx
import { Button, IconButton, Card, PageHeader } from "../components/ui";
```

Colours come only from the tokens in `frontend/src/index.css` (`bg`, `panel`, `line`, `text-main`, `muted`, `faint`, `brand-*`, `ok`, `warn`, `danger`, `info`). Layout uses logical properties (`ms` / `me` / `ps` / `pe` / `start` / `end`) so Arabic RTL works. Touch targets are at least 40px. New visible strings, including tooltips, go through `frontend/src/i18n/translations.ts` in both `en` and `ar`.

`text-white` is the foreground on `primary` and `danger` fills, and the switch thumb is `bg-white`, because those sit on saturated brand / danger tokens in both themes. Do not add any other raw colour.

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

`Field` wraps a control with `label`, `description`, and `error`. `Input`, `Textarea`, and `Select` are the native controls with the shared field style. `Checkbox` and `RadioGroup` are labelled choices. `Toggle` is the switch (`checked`, `onChange(checked)`, optional `label` and `description`).

Per-row settings stay as `Select` or `Toggle`. A list filter does not — that is `FilterButton`.

```tsx
<Field label={t("packName")} htmlFor="pack-name" error={nameError}>
  <Input id="pack-name" value={name} onChange={(event) => setName(event.target.value)} />
</Field>
```

### Dialog / ConfirmDialog

`Dialog` keeps the old modal contract: `isOpen`, `onClose`, `title`, `children`, `footer`, `maxWidth`. Escape and the backdrop close it. Focus is trapped and returned to the trigger. The body scrolls and the footer stays on screen. The footer's bottom padding (the body's, when there is no footer) is `max(1rem, env(safe-area-inset-bottom))`. `ConfirmDialog` composes `Dialog` with cancel and confirm buttons (`variant` `danger` or `primary`, `loading`).

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

Both take `value`, `onChange`, `options` (`{ value, label, icon? }`), and `aria-label`. `SegmentedControl` is one enclosed group (source switch, short modes). `Tabs` is a row of pills for a scrolling section switch.

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

### UserText

A name or a message the operator typed (a sticker pack, a sticker, a keyword, a chat subject). It sets `dir="auto"` so Arabic, English, and mixed strings each lay out inside both the RTL and the LTR UI, and it wraps with `break-words` instead of cutting words off. Set `lines` (`1`–`3`) for dense cards and chips: the element clamps and, when the child is a string, gets the full text as its `title`. Use it for every user-entered string, or `dir="auto"` when the element already is a primitive (an `<option>`).

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

### Toolbar

A wrapping row. Put the search `Input` first (`className="min-w-48 flex-1"`), then `FilterButton`, `SortMenu`, and `OverflowMenu`.
