# csv-reader-speed-01 — fast drop-in for csv-reader 1.0.0

`solve.js` is a dependency-free ES module written from scratch. `run(input)`
returns exactly what csv-reader 1.0.0 returns for `{text, header}`:
`{columns, rows, errors}` — same broken-row policy (BOM, CRLF/lone CR,
quoted fields with `""` and embedded line breaks, `quote_junk`,
`unterminated_quote`, `stray_cr`, `short_row`/`long_row` padding and cutting).

## How it is fast

No per-character loop anywhere:

- A record line with no quote and no CR is cut out with `slice()` and split
  in one native `split(',')` call.
- Every other field is found with `indexOf` scans bounded by the field's own
  end (next comma / line break) and cut out with `slice()`, so a field is
  built from at most a couple of substrings instead of one string per
  character.
- CRLF / lone CR inside quotes are normalised with a single `replace()`.

`main.ts` is the house driver (reads `/input/cases.json`, answers each case
with `run`, writes `/output/answers.json`), with V8 incremental marking off
as the baseline runs.

## Files

- `solve.js` — the reader (`export function run(input)`)
- `main.ts` — the harness driver
- `package.json` — `{"type": "module"}`

## make.fun

[![make.fun](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/dunz72/csv-reader-speed-01-run-20261121/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/dunz72/csv-reader-speed-01-run-20261121/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)

Built for the [csv-reader-speed-01 bounty on make.fun](https://make.fun/bounty/csv-reader-speed-01-run-20261121) — referral code `rwrq8ddk`.
