// csv-reader-speed: a fast drop-in for make.fun's csv-reader 1.0.0.
//
// The reference reads one character at a time and grows every field by
// concatenation, which is O(n^2) allocation churn on megabyte inputs. This
// reader instead cuts each field out with a single slice, and it finds the
// cut points with tight loops that only stop at a delimiter, so a plain
// field costs one short scan plus one slice and never a per-character copy.
// Segments are only collected when a field really transforms (a doubled
// quote, a line break inside quotes, a stray CR); the common field never
// allocates a list at all. The field scans are inlined in the record loop,
// so the common field pays no call and no per-field return object.
//
// Two gears:
//   - Clean records (no quote and no stray CR on the physical line) are cut
//     with one slice and one native split(','): most records take this gear.
//   - Records that do hold a quote or a stray CR go through a careful
//     scanner that reproduces csv-reader's exact broken-row policy: BOM
//     dropped, CRLF and lone CR inside quotes read as LF, "" inside quotes
//     read as one quote, junk after a closing quote appended as it stands,
//     an unclosed quote read again as an unquoted field starting with the
//     quote itself, stray CRs outside quotes dropped, and every error
//     recorded in the order it is met with the record's starting line and
//     its index in rows.
//
// Nothing is kept from one call to the next: run() builds fresh state and
// returns a fresh answer every time.

const COMMA = 0;
const BREAK = 1;
const EOF = 2;

const QUOTE = 34; // "
const COMMA_CH = 44; // ,
const CR = 13;
const LF = 10;
const BOM = 0xfeff;

/** csv-reader 1.0.0's answer for one case's input {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = text.charCodeAt(0) === BOM ? 1 : 0;
  let line = 1;

  // The record being read: the line it starts on and its index in rows
  // (null while it is the header). Field scanners report errors against it.
  let recLine = 1;
  let recRow = null;

  function pushError(code) {
    errors.push({ code, line: recLine, row: recRow });
  }

  // Reads an unquoted field starting at pos. Returns its value and how it
  // ended. A CR not followed by LF is dropped and reported as stray_cr;
  // the field then carries on from the character after it. Only used for
  // the unclosed-quote re-read; the common plain scan is inlined below.
  function plainField() {
    let parts = null;
    let seg = pos;
    for (;;) {
      let p = pos;
      while (p < n) {
        const c = text.charCodeAt(p);
        if (c === COMMA_CH || c === LF || c === CR) break;
        p += 1;
      }
      if (p >= n) {
        const tail = text.slice(seg, n);
        pos = n;
        return { value: parts === null ? tail : parts.join('') + tail, end: EOF };
      }
      const c = text.charCodeAt(p);
      if (c === COMMA_CH) {
        const tail = text.slice(seg, p);
        pos = p + 1;
        return { value: parts === null ? tail : parts.join('') + tail, end: COMMA };
      }
      if (c === LF) {
        const tail = text.slice(seg, p);
        pos = p + 1;
        line += 1;
        return { value: parts === null ? tail : parts.join('') + tail, end: BREAK };
      }
      if (text.charCodeAt(p + 1) === LF) {
        const tail = text.slice(seg, p);
        pos = p + 2;
        line += 1;
        return { value: parts === null ? tail : parts.join('') + tail, end: BREAK };
      }
      pushError('stray_cr');
      if (parts === null) parts = [];
      parts.push(text.slice(seg, p));
      pos = p + 1;
      seg = pos;
    }
  }

  // Reads what follows a closing quote, appending it to `base` as it
  // stands, up to the next comma or line break. Reports quote_junk when at
  // least one character was kept (after any stray_cr reports from the scan).
  function junkField(base) {
    let parts = null;
    let seg = pos;
    let kept = 0;
    for (;;) {
      let p = pos;
      while (p < n) {
        const c = text.charCodeAt(p);
        if (c === COMMA_CH || c === LF || c === CR) break;
        p += 1;
      }
      if (p >= n) {
        const tail = text.slice(seg, n);
        kept += n - seg;
        pos = n;
        if (kept > 0) pushError('quote_junk');
        return { value: parts === null ? base + tail : base + parts.join('') + tail, end: EOF };
      }
      const c = text.charCodeAt(p);
      if (c === COMMA_CH) {
        const tail = text.slice(seg, p);
        kept += p - seg;
        pos = p + 1;
        if (kept > 0) pushError('quote_junk');
        return { value: parts === null ? base + tail : base + parts.join('') + tail, end: COMMA };
      }
      if (c === LF) {
        const tail = text.slice(seg, p);
        kept += p - seg;
        pos = p + 1;
        line += 1;
        if (kept > 0) pushError('quote_junk');
        return { value: parts === null ? base + tail : base + parts.join('') + tail, end: BREAK };
      }
      if (text.charCodeAt(p + 1) === LF) {
        const tail = text.slice(seg, p);
        kept += p - seg;
        pos = p + 2;
        line += 1;
        if (kept > 0) pushError('quote_junk');
        return { value: parts === null ? base + tail : base + parts.join('') + tail, end: BREAK };
      }
      pushError('stray_cr');
      if (parts === null) parts = [];
      parts.push(text.slice(seg, p));
      kept += p - seg;
      pos = p + 1;
      seg = pos;
    }
  }

  // Reads one record the careful way, field by field. Returns its fields,
  // or null for a line that held only stray CRs (its errors stay). The
  // plain and quoted scans are inlined here: they run for most fields, so
  // they pay no call and no per-field return object. Only the rare junk
  // after a closing quote and the unclosed-quote re-read call out.
  function slowRecord() {
    const fields = [];
    let end;
    let lastQuoted = false;
    do {
      if (text.charCodeAt(pos) === QUOTE) {
        lastQuoted = true;
        const open = pos;
        const openLine = line;
        let parts = null;
        let cur = pos + 1;
        let p = pos + 1;
        let value;
        for (;;) {
          let q = p;
          while (q < n) {
            const c = text.charCodeAt(q);
            if (c === QUOTE || c === CR || c === LF) break;
            q += 1;
          }
          if (q >= n) {
            pos = open + 1;
            line = openLine;
            pushError('unterminated_quote');
            const back = plainField();
            value = '"' + back.value;
            end = back.end;
            break;
          }
          const c = text.charCodeAt(q);
          if (c === QUOTE) {
            if (text.charCodeAt(q + 1) === QUOTE) {
              if (parts === null) parts = [];
              parts.push(text.slice(cur, q));
              parts.push('"');
              p = q + 2;
              cur = p;
              continue;
            }
            const tail = text.slice(cur, q);
            value = parts === null ? tail : parts.join('') + tail;
            pos = q + 1;
            if (pos >= n) {
              end = EOF;
              break;
            }
            const next = text.charCodeAt(pos);
            if (next === COMMA_CH) {
              pos += 1;
              end = COMMA;
              break;
            }
            if (next === LF) {
              pos += 1;
              line += 1;
              end = BREAK;
              break;
            }
            if (next === CR && text.charCodeAt(pos + 1) === LF) {
              pos += 2;
              line += 1;
              end = BREAK;
              break;
            }
            const junk = junkField(value);
            value = junk.value;
            end = junk.end;
            break;
          }
          if (parts === null) parts = [];
          parts.push(text.slice(cur, q));
          parts.push('\n');
          line += 1;
          p = c === CR && text.charCodeAt(q + 1) === LF ? q + 2 : q + 1;
          cur = p;
        }
        fields.push(value);
      } else {
        lastQuoted = false;
        let parts = null;
        let seg = pos;
        let value;
        for (;;) {
          let p = pos;
          while (p < n) {
            const c = text.charCodeAt(p);
            if (c === COMMA_CH || c === LF || c === CR) break;
            p += 1;
          }
          if (p >= n) {
            const tail = text.slice(seg, n);
            value = parts === null ? tail : parts.join('') + tail;
            pos = n;
            end = EOF;
            break;
          }
          const c = text.charCodeAt(p);
          if (c === COMMA_CH) {
            const tail = text.slice(seg, p);
            value = parts === null ? tail : parts.join('') + tail;
            pos = p + 1;
            end = COMMA;
            break;
          }
          if (c === LF) {
            const tail = text.slice(seg, p);
            value = parts === null ? tail : parts.join('') + tail;
            pos = p + 1;
            line += 1;
            end = BREAK;
            break;
          }
          if (text.charCodeAt(p + 1) === LF) {
            const tail = text.slice(seg, p);
            value = parts === null ? tail : parts.join('') + tail;
            pos = p + 2;
            line += 1;
            end = BREAK;
            break;
          }
          pushError('stray_cr');
          if (parts === null) parts = [];
          parts.push(text.slice(seg, p));
          pos = p + 1;
          seg = pos;
        }
        fields.push(value);
      }
    } while (end === COMMA);
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) return null;
    return fields;
  }

  for (;;) {
    // Lines left with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === LF) {
        pos += 1;
        line += 1;
      } else if (c === CR && text.charCodeAt(pos + 1) === LF) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recLine = line;
    recRow = header && columns === null ? null : rows.length;

    // Fast gear: the physical line holds no quote and no stray CR, so the
    // record ends at its line break and its fields are a plain split.
    let fields = null;
    let eol = text.indexOf('\n', pos);
    if (eol === -1) eol = n;
    const qAt = text.indexOf('"', pos);
    if (qAt === -1 || qAt >= eol) {
      const rAt = text.indexOf('\r', pos);
      if (rAt === -1 || rAt >= eol) {
        fields = text.slice(pos, eol).split(',');
        pos = eol < n ? eol + 1 : n;
        if (eol < n) line += 1;
      } else if (rAt === eol - 1 && eol < n) {
        fields = text.slice(pos, eol - 1).split(',');
        pos = eol + 1;
        line += 1;
      }
    }
    if (fields === null) {
      fields = slowRecord();
      if (fields === null) continue;
    }

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recLine, row: recRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recLine, row: recRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
