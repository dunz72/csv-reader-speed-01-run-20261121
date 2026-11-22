// Fast CSV reader, written from scratch to return exactly what csv-reader 1.0.0
// returns for every input: {columns, rows, errors} for {text, header}.
//
// Semantics (mirroring the reference reader, reimplemented here, not copied):
//   - a U+FEFF at the very start is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside a quoted field a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled,
//     "" inside it is one quote, and each CRLF or lone CR inside it is read as LF;
//     what follows its closing quote, up to the next comma or line break, is
//     appended as it stands (quote_junk, when the field ends); a quote that never
//     closes is a literal character, and the text after it is read again as
//     unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay
//     strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds the
//     records after it, each padded with "" (short_row, with fields: its count)
//     or cut (long_row, with extra: the cut fields) to the first record's width;
//   - each error is {code, line, row}: line the 1-based line its record starts
//     on, row its record's index in rows (null for the header), in the order met.
//
// Speed: no per-character loop. A record line with no quote and no CR is split
// in one native call; every other field is found with indexOf scans and cut
// out with slice(), so a field is built from at most a couple of substrings
// instead of one string per character. Newlines inside quotes are normalised
// with a single replace. Field results travel in shared variables, not fresh
// objects, to keep the garbage collector out of the hot path. Deterministic:
// two runs return byte-identical JSON.

/** How a field ended: at a comma (the record goes on), at a line break or at the end of the text. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input, faster. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  let recordLine = 1; // the line the record being read starts on
  let recordRow = null; // its index in rows (null: the header)

  // The field just read: its value, how it ended, and how many characters
  // were kept for it (shared variables, not a fresh object per field).
  let fValue = '';
  let fEnd = END;
  let fAdded = 0;

  if (len > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record's fields, once fully read: skipped when a lone empty unquoted
  // field, else the header, else a row padded or cut to the first width.
  function finishRecord(fields, quoted) {
    if (fields.length === 1 && fields[0] === '' && !quoted) return;
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.slice(width) });
      fields.length = width;
    }
    rows.push(fields);
  }

  // Reads an unquoted field from pos, starting from `init` ('' normally, '"'
  // when a quote that never closed is re-read as unquoted). The next comma or
  // line break bounds the scan, so no search ever runs past the field's end.
  // Leaves the result in fValue, fEnd and fAdded.
  function readUnquoted(init) {
    let value = init;
    let added = 0;
    let start = pos;
    for (;;) {
      const comma = text.indexOf(',', start);
      const bound = comma === -1 ? len : comma;
      const seg = text.slice(start, bound);
      const lf = seg.indexOf('\n');
      const cr = seg.indexOf('\r');
      if (cr !== -1 && (lf === -1 || cr < lf)) {
        if (seg.charCodeAt(cr + 1) === 10) {
          // CRLF: the record ends here.
          if (cr > 0) {
            const s = seg.slice(0, cr);
            value = value === '' ? s : value + s;
            added += cr;
          }
          pos = start + cr + 2;
          line += 1;
          fValue = value;
          fEnd = LINE_BREAK;
          fAdded = added;
          return;
        }
        // A lone CR: dropped (stray_cr), the field goes on after it.
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        if (cr > 0) {
          const s = seg.slice(0, cr);
          value = value === '' ? s : value + s;
          added += cr;
        }
        start = start + cr + 1;
        pos = start;
        continue;
      }
      if (lf !== -1) {
        if (lf > 0) {
          const s = seg.slice(0, lf);
          value = value === '' ? s : value + s;
          added += lf;
        }
        pos = start + lf + 1;
        line += 1;
        fValue = value;
        fEnd = LINE_BREAK;
        fAdded = added;
        return;
      }
      if (seg.length > 0) {
        value = value === '' ? seg : value + seg;
        added += seg.length;
      }
      if (comma === -1) {
        pos = len;
        fValue = value;
        fEnd = END;
        fAdded = added;
        return;
      }
      pos = comma + 1;
      fValue = value;
      fEnd = COMMA;
      fAdded = added;
      return;
    }
  }

  // A quoted segment [start, end) with each CRLF or lone CR inside it read as
  // one LF, counting the lines it spans; unchanged when it holds no line break.
  function normalizeSegment(start, end) {
    const seg = text.slice(start, end);
    if (seg.indexOf('\n') === -1 && seg.indexOf('\r') === -1) return seg;
    const norm = seg.replace(/\r\n?/g, '\n');
    let breaks = 0;
    let i = norm.indexOf('\n');
    while (i !== -1) {
      breaks += 1;
      i = norm.indexOf('\n', i + 1);
    }
    line += breaks;
    return norm;
  }

  // Reads a quoted field whose opening quote is at pos. Leaves the result in
  // fValue, fEnd and fAdded.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    let acc = '';
    let parts = null;
    const addSeg = (s) => {
      if (s === '') return;
      if (parts !== null) {
        parts.push(s);
        return;
      }
      if (acc === '') {
        acc = s;
        return;
      }
      parts = [acc, s];
      acc = '';
    };
    let segStart = pos;
    for (;;) {
      const q = text.indexOf('"', pos);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        readUnquoted('"');
        return;
      }
      if (text.charCodeAt(q + 1) === 34) {
        // A doubled quote is one literal quote.
        addSeg(normalizeSegment(segStart, q) + '"');
        pos = q + 2;
        segStart = pos;
        continue;
      }
      addSeg(normalizeSegment(segStart, q));
      pos = q + 1;
      break;
    }
    const value = parts === null ? acc : parts.join('');
    if (pos >= len) {
      fValue = value;
      fEnd = END;
      fAdded = 0;
      return;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      fValue = value;
      fEnd = COMMA;
      fAdded = 0;
      return;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      fValue = value;
      fEnd = LINE_BREAK;
      fAdded = 0;
      return;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      fValue = value;
      fEnd = LINE_BREAK;
      fAdded = 0;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the next
    // comma or line break.
    readUnquoted(value);
    if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
  }

  while (pos < len) {
    // The rest of this line, and whether it is a plain line: no quote, no CR
    // inside it (a trailing CR before the LF is the CRLF ending the line).
    const lineEnd = text.indexOf('\n', pos);
    const end = lineEnd === -1 ? len : lineEnd;
    let segEnd = end;
    if (lineEnd !== -1 && segEnd > pos && text.charCodeAt(segEnd - 1) === 13) segEnd -= 1;
    if (segEnd === pos) {
      // A line left with no characters is no record.
      pos = lineEnd === -1 ? len : lineEnd + 1;
      line += 1;
      continue;
    }
    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const lineStr = text.slice(pos, segEnd);
    if (lineStr.indexOf('"') === -1 && lineStr.indexOf('\r') === -1) {
      // Plain line: split it in one native call.
      const fields = lineStr.split(',');
      pos = lineEnd === -1 ? len : lineEnd + 1;
      line += 1;
      finishRecord(fields, false);
      continue;
    }
    // A line with a quote or a CR: read it field by field.
    const fields = [];
    let quoted = false;
    for (;;) {
      quoted = text.charCodeAt(pos) === 34;
      if (quoted) readQuoted();
      else readUnquoted('');
      fields.push(fValue);
      if (fEnd !== COMMA) break;
    }
    finishRecord(fields, quoted);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
