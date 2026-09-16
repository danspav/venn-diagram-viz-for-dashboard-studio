# SPL reference — Venn Diagram Viz

## Data contract

Long format: one row per `(item, category)`. `category` (and `value`/
`tooltip`) are read by field name, case-insensitive, wherever they sit in
the row; `item` is whatever column is left over. So the columns needed are:

```
item, category, value, tooltip
```

— in any order, under any names for `item`, as long as one field is
literally called `category`, one `value`, and one `tooltip`.

**A field NOT literally named `value` or `tooltip` still falls back to
reading positionally** (the last, or second-to-last, remaining column after
`item`/`category`/whichever of value-or-tooltip IS named are pulled out) —
so `host, category, count, note` still works with `count` read as value and
`note` as tooltip purely by position. **`category` has no positional
fallback** — a `category` field is required, by that exact name, or the row
is dropped.

- **item** — entity id (one dot per item)
- **category** — the ONE set this row's item belongs to (single value, not
  a list — see below for how an item in multiple sets is represented). The
  viz discovers the full list of distinct category names across all rows
  (alphabetically, for a stable A/B/C ↔ color mapping across search
  refreshes). True proportional Venn geometry only works for 2-3 sets, so
  if more than 3 distinct categories turn up, only the first 3
  (alphabetically) are shown — items belonging exclusively to an excluded
  category are dropped — and a warning banner at the bottom of the viz
  names which categories got left out. This is a soft limit, not an error:
  the diagram still renders normally with whatever fits.
- **value** — sizes the dot; optional, defaults to 1 if blank/absent
- **tooltip** — free text shown on hover for that row
- **any other columns** — not required, but not discarded either: every
  extra column your search supplies rides along and becomes a
  `row.<field>.value` drilldown token, selectable from the dashboard's "On
  Click" editor (see [Drilldown tokens](#drilldown-tokens) below)

**The same item can span multiple rows.** This is the normal shape of
`stats ... by item, category` in SPL — a host with two signals naturally
comes back as two rows, one per category, rather than one row with two
category columns:

```
host1,timeouts,20,"Lots of timeouts"
host1,restarts,4,"A few restarts"
```

When an item's rows are combined into a single dot:
- **memberships** = union of every category across all its rows
- **value** (dot size) = **sum** across all its rows (24, above)
- **tooltip** = one line per contributing row, not a pick-one or a lossy
  sum — hovering host1 above shows both "timeouts (20): Lots of timeouts"
  and "restarts (4): A few restarts", plus a `Total: 24` line


## Sample data (no real indexes needed)

Reproduces the exact 7-region distribution (34/21/28/10/13/6/4 across 116
hosts) that the containment/density-capping logic was validated against —
useful for confirming the viz renders correctly before wiring real data.
Generic category names since this is a synthetic geometry test, not a real
use case.

```spl
| makeresults count=116
| streamstats count as row_num
| eval host="host-" . row_num
| eval in_A=if(row_num<=34 OR (row_num>=84 AND row_num<=93) OR (row_num>=94 AND row_num<=106) OR row_num>=113, 1, 0)
| eval in_B=if((row_num>=35 AND row_num<=55) OR (row_num>=84 AND row_num<=93) OR (row_num>=107 AND row_num<=112) OR row_num>=113, 1, 0)
| eval in_C=if((row_num>=56 AND row_num<=83) OR (row_num>=94 AND row_num<=106) OR (row_num>=107 AND row_num<=112) OR row_num>=113, 1, 0)
| eval category=mvappend(if(in_A=1,"Category A",null()), if(in_B=1,"Category B",null()), if(in_C=1,"Category C",null()))
| mvexpand category
| eval value=round(random()/2147483647*17)+3
| eval tooltip="synthetic test row"
| table host category value tooltip
```

Row ranges → region (before the mvexpand splits multi-category hosts into
separate rows):

| rows      | region  |
|-----------|---------|
| 1–34      | A only  |
| 35–55     | B only  |
| 56–83     | C only  |
| 84–93     | A + B   |
| 94–106    | A + C   |
| 107–112   | B + C   |
| 113–116   | A + B + C |

## Production template

The three signals typically live in different indexes/sourcetypes. Each
sub-search just emits its own `category` value directly — no pivoting or
`fillnull` needed, since the long format handles partial membership on its
own:

```spl
index=auth sourcetype=linux_secure action=failure
| stats count as value by host
| eval category="Failed logins", tooltip="Failed login attempts"
| append
    [ search index=endpoint sourcetype=malware_alerts
      | stats count as value by host
      | eval category="Malware alerts", tooltip="Malware detections" ]
| append
    [ search index=firewall sourcetype=pan:traffic action=blocked
      | stats count as value by host
      | eval category="Firewall blocks", tooltip="Blocked connections" ]
| table host category value tooltip
```

Swap the three sub-searches for your real conditions. `category`, `value`,
and `tooltip` must keep those exact field names (case-insensitive) — only
`host` (the item column) can be called anything you like.

## Drilldown tokens

Clicking sets tokens a dashboard's "On Click" interaction ("Set Tokens") can
bind to. **Dashboard Studio's token editor only ever recognizes three shapes
of field reference: `name`, `value`, and `row.<fieldname>.value`** — nothing
else is selectable/bindable, no matter what a custom visualization's own
click payload actually contains. So everything other than the item's id and
its numeric value rides under the `row.<name>.value` form, including things
that aren't literally raw SPL columns.

**Three click targets, same in both Entity View and Numeric View (the
"Style" option):**
1. **A circle's background** (empty space inside it, on neither a dot nor a
   region's number) — resolves to the SPECIFIC exact region under the
   cursor (an invisible per-region hit-area sits beneath the dots/numbers
   for exactly this). In Numeric View this is the same target the visible
   number sits on; in Entity View it's the same background you'd hit
   between/around dots.
2. **A circle's true edge / anywhere its hit-area approximation doesn't
   reach** — falls through to the whole-category handler, since the
   per-region hit-areas are circular approximations of what are often
   crescent/lens-shaped regions and don't perfectly tile the circle's full
   area. This is "click the border" in practice, without a literal
   dedicated border element.
3. **A dot** (Entity View only) — sits on top of everything else for
   whatever pixels it covers, so it always wins over the region hit-area
   beneath it.

- **A dot** (an item) — `name` (the item id), `value` (its summed value),
  `row.tooltip.value` (its combined tooltip text), `row.color.value` (its
  blended hex color), `row.categoryList.value` and `row.splFilter.value`
  (see below), and `row.<field>.value` for **every column your search
  actually supplied**, under that column's own name — e.g. `row.host.value`,
  `row.count.value`, whatever you called your columns above. If your search
  happens to name a column literally `tooltip` (or `color`), the
  combined/blended value here wins over that raw column's value under the
  same key. If an item spans multiple rows, `row.<field>.value` reflects the
  last row that had a non-blank value for that field (a row that left a
  column blank doesn't erase an earlier row's value for it).
- **A parent circle** (a whole category — its edge, or any background pixel
  not covered by a region hit-area) — `name` (the category name),
  `row.color.value`, `row.categoryList.value`, and `row.splFilter.value`
  (see below).
- **A legend item** — same as a parent circle: `name`, `row.color.value`,
  `row.categoryList.value`, `row.splFilter.value`. Clicking a legend item
  still also toggles that category on/off as before — both happen on the
  same click.
- **A region** (its number in Numeric View, or its background area in
  Entity View) — `name` (the category name(s) that region belongs to, e.g.
  `Category A + Category B`), `value` (the item count shown), 
  `row.totalValue.value` (the sum of those items' own values),
  `row.color.value` (the region's blended color), `row.categoryList.value`,
  and `row.splFilter.value`.

### `row.categoryList.value` — for use with SPL's `IN()`

Every category-related click (a dot, a parent circle, a legend item, or a
region's count) also sets `row.categoryList.value`: the involved
category name(s), double-quoted and comma-separated — e.g. `"Restarts"`
for a single category, or `"Restarts", "Server Errors"` for a dot/region
spanning both. Bind a token to it and drop that token straight into an
`IN()` clause:

```spl
| where category IN($clicked_categories$)
```

This is deliberately a UNION list, not a filter for "only the exact
overlap." Clicking the A∩B overlap region gives you `"A", "B"` — which,
used in `IN()`, matches every event tagged EITHER category, i.e. all of
A-only + B-only + A∩B together. That's normally the more useful query
("show me everything related to this pair of signals"); the region itself
already shows you the exact-overlap count/total if that's what you
actually wanted to report on.

### `row.splFilter.value` — the exact-region opposite of `row.categoryList.value`

Where `row.categoryList.value` is a union, `row.splFilter.value` is the AND
of the *exact* region clicked, targeting the same `category` field the data
contract fixes the column name to — so there's no field-name-quoting
question here, only the *value* ever needs quoting (ordinary SPL string
literal syntax, same escaping as `row.categoryList.value` above).

**This only matches correctly against a search where `category` is
multivalued per item** — e.g. right after `| stats values(category) as
category by item` — since Splunk matches each term of a multivalue field
independently: `category="A" AND category="B"` matches an item whose
category values include BOTH. Run directly against the viz's own
one-row-per-item-per-category table, this filter would never match
anything, since a single row only ever has one category value.

```spl
| stats values(category) as category by item
| search $clicked_filter$
```

- **A dot or a region's count** — both represent one specific,
  mutually-exclusive Venn region, so the expression includes `NOT
  category="<category>"` for every category *not* in that region. Clicking
  the A∩B sliver gives `category="Category A" AND category="Category B"
  AND NOT category="Category C"` — it deliberately does NOT also match
  A∩B∩C center items, unlike `row.categoryList.value`'s union behavior
  above.
- **A parent circle or legend item** — represents the WHOLE circle (that
  category plus every overlap it participates in), so no `NOT` clauses are
  added: clicking category A's circle gives just `category="Category A"`.

## "Style" option — Entity View vs. Numeric View

For datasets with too many items to read as individual packed dots, the
"Style" dropdown's **Numeric View** option replaces every region's dots
with a single number — the item count for that exact combination of
categories (there are up to 7: 3 single-category regions, 3 pairwise
overlaps, and the center where all 3 overlap). Hovering a number highlights
its category circle(s) and shows a tooltip with the exact count and total
value — this is deliberately a tooltip rather than literally magnifying
part of the diagram, so the tiny center region (all 3 categories
overlapping) stays just as readable as any other without a different
interaction to learn. **Entity View** is the default: individually packed
dots, one per item.
The same per-region hit-area exists (invisibly) in Entity View too —
hovering background space inside a circle, away from any dot, gives this
identical region tooltip/click behavior even with the numbers off.

In the dashboard's "On Click" editor, reference these with `key:
"row.tooltip.value"` etc. (not a bare `tooltip`) when configuring which
token gets which field.
