![csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)
![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/Mumet69/csv-reader-speed/rank.svg)
![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/Mumet69/csv-reader-speed/reward.svg)

# csv-reader-speed

A faster drop-in for make.fun's own csv-reader 1.0.0, written for the
[csv-reader-speed-01-run-20261121 bounty](https://make.fun/bounty/csv-reader-speed-01-run-20261121).
It answers exactly as csv-reader does on every case — same `{columns, rows,
errors}`, same broken-row policy — while reading the file several times
faster.

## How it is fast

The reference reads one character at a time and grows every field by
concatenation. This reader instead jumps between delimiters with the
engine's native string search and cuts each field out with a single slice:

- **Clean records** (no quote and no stray CR on the physical line) are cut
  with one slice and one native `split(',')`. That is most records.
- **Records with a quote or a stray CR** go through a careful scanner that
  still works in slices: it jumps to the next quote, comma, CR or LF with
  `indexOf` and only joins segments when a field really spans more than one
  (doubled quotes, line breaks inside quotes, junk after a closing quote).
- Nothing is allocated per character, no regex runs, and no work is kept
  from one case to the next.

## Exactness

Every rule of csv-reader's policy is reproduced, including the awkward
corners: a U+FEFF dropped only at the very start, stray CRs outside quotes
dropped with a `stray_cr` error, CRLF and lone CR inside quotes read as one
LF, `""` inside quotes read as one quote, junk after a closing quote
appended as it stands with a `quote_junk` error, an unclosed quote read
again as an unquoted field starting with the quote itself
(`unterminated_quote`), short and long rows padded or cut to the first
record's width, and every error reported in the order met with the record's
starting line and its index in rows.

## Layout

- `solve.js` — the parser: `run(input)` returns csv-reader's answer.
- `main.ts` — the driver the harness runs: reads `/input/cases.json`,
  answers each case with `run`, writes `/output/answers.json`. It turns
  V8's incremental marking off before importing `solve.js`, as the house
  baseline does.

## Verify

```sh
MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=/tmp/csv-out node main.ts
```

then compare `/tmp/csv-out/answers.json` against the kit's
`practice/reference/expected.json` with the kit's scorer
(`program/scorer/main.ts`). On the practice set all 6 cases must match
exactly.

## License

MIT — see [LICENSE](LICENSE).
