# SPL reference — Venn Diagram Viz

## Data contract

Long format: one row per `(item, category)` — mostly positional, so columns
can be called whatever you like, as long as the *order* and *count* match
one of these shapes:

| columns | shape                                                    |
|---------|-----------------------------------------------------------|
| 4       | `item, category, value, tooltip`                          |
| 5       | `item, category1, category2, value, tooltip`               |
| 6       | `item, category1, category2, category3, value, tooltip`    |

**Exception:** if a column is literally named `value` or `tooltip`
(case-insensitive), it's used by name instead of position — it can be
anywhere in the row, in any order, and either or both may be named. Any
`value`/`tooltip` that ISN'T named still falls back to reading positionally
(last, or second-to-last, of whatever's left) exactly as above. `item` and
`category` are always positional (first column, and everything between
item and whichever of value/tooltip is positional) — only `value`/
`tooltip` get name-based detection. So `host, tooltip, category, value` and
`value, category, host, tooltip` both work identically to the 4-column
shape above, as long as one field is named `tooltip` and one is named
`value`.

- **item** — entity id (one dot per item)
- **category** (1-3 of them) — the set(s) this row's item belongs to. The
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

A single row that already lists 2-3 categories at once (the 5- or
6-column shapes) works the same way — its one tooltip line is labeled with
all the categories that row covers, since the tooltip text was presumably
written for that combination already.

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

Swap the three sub-searches for your real conditions. Column order/count
is what matters — `host`, `category`, `value`, `tooltip` above could just
as easily be named anything.

## Drilldown tokens

Clicking sets tokens a dashboard's "On Click" interaction ("Set Tokens") can
bind to. **Dashboard Studio's token editor only ever recognizes three shapes
of field reference: `name`, `value`, and `row.<fieldname>.value`** — nothing
else is selectable/bindable, no matter what a custom visualization's own
click payload actually contains. So everything other than the item's id and
its numeric value rides under the `row.<name>.value` form, including things
that aren't literally raw SPL columns:

- **A dot** (an item) — `name` (the item id), `value` (its summed value),
  `row.tooltip.value` (its combined tooltip text), `row.color.value` (its
  blended hex color), and `row.<field>.value` for **every column your
  search actually supplied**, under that column's own name — e.g.
  `row.host.value`, `row.count.value`, whatever you called your columns
  above. If your search happens to name a column literally `tooltip` (or
  `color`), the combined/blended value here wins over that raw column's
  value under the same key. If an item spans multiple rows,
  `row.<field>.value` reflects the last row that had a non-blank value for
  that field (a row that left a column blank doesn't erase an earlier row's
  value for it).
- **A parent circle** (a whole category) — `name` (the category name) and
  `row.color.value` only; a category doesn't have one row's value/tooltip
  to offer.
- **A legend item** — same as a parent circle: `name` and
  `row.color.value`. Clicking a legend item still also toggles that
  category on/off as before — both happen on the same click.

In the dashboard's "On Click" editor, reference these with `key:
"row.tooltip.value"` etc. (not a bare `tooltip`) when configuring which
token gets which field.
