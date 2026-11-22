// SwiftSite: a fast drop-in for makefun-site 1.0.0. run(input) returns the
// same output tree (path -> text) as makefun-site's build for every input,
// computed with native-regex escaping, an ASCII slug fast path, a regex-free
// front-matter and Markdown scanner, indexOf-based emphasis search, lazy
// reading-time counts, and templates compiled to functions (with per-build
// caching of includes that read only site/tags/recent).

const ESCAPABLE_HTML = /[&<>"']/;

// text with &, <, >, " and ' escaped; unchanged text comes back as itself.
function escapeHtml(text) {
  if (!ESCAPABLE_HTML.test(text)) return text;
  let out = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      out += text.slice(start, i) + rep;
      start = i + 1;
    }
  }
  return out + text.slice(start);
}

// Single-character escape by char code (only the five escapable codes set).
const ESC1 = new Array(128);
ESC1[38] = '&amp;';
ESC1[60] = '&lt;';
ESC1[62] = '&gt;';
ESC1[34] = '&quot;';
ESC1[39] = '&#39;';

const SLUG_MAX = 64;
const MARK_RE = /\p{M}/gu;

function finishSlug(out) {
  if (out.length > SLUG_MAX) {
    out = out.slice(0, SLUG_MAX);
    let end = out.length;
    while (end > 0 && out.charCodeAt(end - 1) === 45) end--;
    out = out.slice(0, end);
  }
  return out === '' ? 'untitled' : out;
}

// The slug of text, NFKD with marks dropped; pure-ASCII text skips normalize.
function slugifyRaw(text) {
  let out = '';
  let gap = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 128) return slugifyUnicode(text);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  return finishSlug(out);
}

function slugifyUnicode(text) {
  const plain = text.normalize('NFKD').replace(MARK_RE, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  return finishSlug(out);
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = slug + '-' + n;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function longDateRaw(date) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return d + ' ' + MONTHS[m - 1] + ' ' + y;
}

// Runs of non-whitespace characters in text (the body's word count).
// Whitespace is JavaScript's \s: ASCII 9-13 and 32, plus the Unicode spaces.
const WS_TABLE = new Uint8Array(65536);
for (const c of [9, 10, 11, 12, 13, 32, 160, 5760, 8232, 8233, 8239, 8287, 12288, 65279]) WS_TABLE[c] = 1;
for (let c = 8192; c <= 8202; c++) WS_TABLE[c] = 1;
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (WS_TABLE[text.charCodeAt(i)] === 1) inWord = false;
    else if (!inWord) { inWord = true; count++; }
  }
  return count;
}

// Spaces and tabs trimmed from both ends of a line.
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b) {
    const c = line.charCodeAt(a);
    if (c !== 32 && c !== 9) break;
    a++;
  }
  while (b > a) {
    const c = line.charCodeAt(b - 1);
    if (c !== 32 && c !== 9) break;
    b--;
  }
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

// Lines joined by "\n" (a single line needs no join).
function joinLines(parts) {
  return parts.length === 1 ? parts[0] : parts.join('\n');
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function isDigit(c) { return c >= 48 && c <= 57; }

// A title/summary string: quoted with \" and \\ escapes, or bare.
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function fmValue(key, raw) {
  if (key === 'title' || key === 'summary') {
    const s = stringOf(raw);
    return 'error' in s ? { error: 'key "' + key + '": ' + s.error } : s;
  }
  if (key === 'date') {
    let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
    if (ok) {
      for (let i = 0; i < 10; i++) {
        if (i === 4 || i === 7) continue;
        if (!isDigit(raw.charCodeAt(i))) { ok = false; break; }
      }
    }
    if (ok) {
      const y = Number(raw.slice(0, 4));
      const mo = Number(raw.slice(5, 7));
      const d = Number(raw.slice(8, 10));
      if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) ok = false;
    }
    return ok ? { value: raw } : { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
  }
  if (key === 'tags') {
    if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
    const inner = raw.slice(1, -1);
    if (inner.trim() === '') return { value: [] };
    const tags = inner.split(',').map((t) => t.trim());
    for (const t of tags) {
      if (t === '' || t.includes('"') || t.includes('[') || t.includes(']')) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
    }
    return { value: tags };
  }
  if (key === 'draft') {
    return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
  }
  if (key === 'layout') {
    let ok = raw.length > 0;
    for (let i = 0; ok && i < raw.length; i++) {
      const c = raw.charCodeAt(i);
      if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) ok = false;
    }
    return ok ? { value: raw } : { error: 'key "layout": not a template name' };
  }
  // slug
  let ok = raw.length > 0 && raw.length <= 64;
  if (ok) {
    let prevDash = true;
    for (let i = 0; i < raw.length; i++) {
      const c = raw.charCodeAt(i);
      if (c === 45) {
        if (prevDash) { ok = false; break; }
        prevDash = true;
      } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
      else { ok = false; break; }
    }
    if (prevDash) ok = false;
  }
  return ok ? { value: raw } : { error: 'key "slug": not a slug' };
}

// Front matter and body of one source, or the first refusal reason.
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const firstLine = firstNl === -1 ? text : text.slice(0, firstNl);
  if (firstLine !== '---') return { error: 'no front matter' };
  if (firstNl === -1) return { error: 'the front matter is not closed' };
  // The closing line is found before any line is judged.
  let closeStart = -1;
  let bodyStart = text.length;
  for (let p = firstNl + 1; p <= text.length;) {
    const nl = text.indexOf('\n', p);
    const lineEnd = nl === -1 ? text.length : nl;
    if (lineEnd - p === 3 && text.startsWith('---', p)) {
      closeStart = p;
      bodyStart = nl === -1 ? text.length : nl + 1;
      break;
    }
    if (nl === -1) break;
    p = nl + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let pos = firstNl + 1;
  let lineNo = 1;
  while (pos < closeStart) {
    const nl = text.indexOf('\n', pos);
    const line = text.slice(pos, nl);
    lineNo++;
    pos = nl + 1;
    // blank or comment?
    let blank = true;
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c !== 32 && c !== 9) { blank = false; break; }
    }
    if (blank || line.charCodeAt(0) === 35) continue;
    // key: value
    let ki = 0;
    while (ki < line.length) {
      const c = line.charCodeAt(ki);
      if ((c >= 97 && c <= 122) || c === 95) ki++;
      else break;
    }
    if (ki === 0 || line.charCodeAt(ki) !== 58 || (ki + 1 < line.length && line.charCodeAt(ki + 1) !== 32)) {
      return { error: 'line ' + lineNo + ' is not "key: value"' };
    }
    const key = line.slice(0, ki);
    let raw = ki + 1 >= line.length ? '' : line.slice(ki + 2);
    let end = raw.length;
    while (end > 0) {
      const c = raw.charCodeAt(end - 1);
      if (c !== 32 && c !== 9) break;
      end--;
    }
    if (end !== raw.length) raw = raw.slice(0, end);
    if (!FM_KEYS.has(key)) return { error: 'unknown key "' + key + '"' };
    if (Object.hasOwn(data, key)) return { error: 'key "' + key + '" is given twice' };
    if (raw === '') return { error: 'key "' + key + '" has no value' };
    const v = fmValue(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- markdown

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const TARGET_WS = /\s/;
const WS_RE = /\s/;

// First index from `from` where s holds `what` outside a backslash escape.
// Candidates come from indexOf; an escape pair (\ + escapable char) starting
// before a candidate consumes its two characters, so the search jumps past it.
function findUnescaped(s, what, from) {
  const n = s.length;
  const wlen = what.length;
  let j = from;
  while (j <= n - wlen) {
    const k = s.indexOf(what, j);
    if (k === -1 || k > n - wlen) return -1;
    let b = s.indexOf('\\', j);
    let jumped = false;
    while (b !== -1 && b < k) {
      if (b + 1 < n && ESCAPABLE.has(s[b + 1])) { j = b + 2; jumped = true; break; }
      b = s.indexOf('\\', b + 1);
    }
    if (!jumped) return k;
  }
  return -1;
}

// First single * from `from` (not part of **), outside an escape.
function findSingleStar(s, from) {
  const n = s.length;
  let j = from;
  while (j < n) {
    const k = s.indexOf('*', j);
    if (k === -1) return -1;
    let b = s.indexOf('\\', j);
    let jumped = false;
    while (b !== -1 && b < k) {
      if (b + 1 < n && ESCAPABLE.has(s[b + 1])) { j = b + 2; jumped = true; break; }
      b = s.indexOf('\\', b + 1);
    }
    if (jumped) continue;
    if (s[k + 1] === '*') { j = k + 2; continue; }
    return k;
  }
  return -1;
}

// Characters that end a plain run: markup starters and HTML-escapable ones.
const SPECIAL_TABLE = new Uint8Array(128);
for (const c of [92, 96, 42, 91, 38, 60, 62, 34, 39]) SPECIAL_TABLE[c] = 1;

// s rendered inline; env.link(target) gives a link's href.
function inline(s, env) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (!(c < 128 && SPECIAL_TABLE[c] === 1)) {
      let j = i + 1;
      while (j < n) {
        const cc = s.charCodeAt(j);
        if (cc < 128 && SPECIAL_TABLE[cc] === 1) break;
        j++;
      }
      out += s.slice(i, j);
      i = j;
      continue;
    }
    if (c === 92 && i + 1 < n && ESCAPABLE.has(s[i + 1])) {
      // No escapable character is HTML-escapable, so it stands as itself.
      out += s[i + 1];
      i += 2;
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        out += '<code>' + escapeHtml(s.slice(i + 1, j)) + '</code>';
        i = j + 1;
      } else { out += '`'; i++; }
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          out += '<strong>' + inline(s.slice(i + 2, j), env) + '</strong>';
          i = j + 2;
        } else { out += '**'; i += 2; }
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        out += '<em>' + inline(s.slice(i + 1, j), env) + '</em>';
        i = j + 1;
      } else { out += '*'; i++; }
      continue;
    }
    if (c === 91) {
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !TARGET_WS.test(target)) {
        out += '<a href="' + escapeHtml(env.link(target)) + '">' + inline(s.slice(i + 1, k), env) + '</a>';
        i = m + 1;
        continue;
      }
      out += '[';
      i++;
      continue;
    }
    out += ESC1[c] ?? s[i];
    i++;
  }
  return out;
}

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// A fence opening's language ('' for none), or null when not a fence.
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  const start = i;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(start, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// A heading line's depth and text, or null.
function headingOf(line) {
  let depth = 0;
  while (depth < line.length && line.charCodeAt(depth) === 35) depth++;
  if (depth === 0 || depth > 6) return null;
  if (depth >= line.length) return null;
  const c = line.charCodeAt(depth);
  if (c !== 32 && c !== 9) return null;
  let i = depth;
  while (i < line.length) {
    const d = line.charCodeAt(i);
    if (d !== 32 && d !== 9) break;
    i++;
  }
  let end = line.length;
  while (end > i) {
    const d = line.charCodeAt(end - 1);
    if (d !== 32 && d !== 9) break;
    end--;
  }
  if (end <= i) return null;
  return { depth, text: line.slice(i, end) };
}

function isHr(line) {
  const a = line.charCodeAt(0);
  if (a !== 45 && a !== 42) return false;
  if (line.charCodeAt(1) !== a || line.charCodeAt(2) !== a) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function endsParagraph(line) {
  if (isBlankLine(line)) return true;
  const c = line.charCodeAt(0);
  if (c === 96) return fenceLang(line) !== null;
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return isHr(line);
  return false;
}

// src rendered: html, toc (level 2/3 headings) and excerpt (first paragraph).
function renderMarkdown(src, env, slugOf) {
  const lines = src.split('\n');
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlankLine(line)) { i++; continue; }
    const lang = fenceLang(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < lines.length && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      const cls = lang === '' ? '' : ' class="language-' + escapeHtml(lang) + '"';
      // Each line escaped and ended by "\n" is the joined body escaped, plus "\n".
      const inner = body.length === 0 ? '' : escapeHtml(body.join('\n')) + '\n';
      blocks.push('<pre><code' + cls + '>' + inner + '</code></pre>');
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugOf(heading.text), ids);
      const html = inline(heading.text, env);
      blocks.push('<h' + heading.depth + ' id="' + id + '">' + html + '</h' + heading.depth + '>');
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) { blocks.push('<hr>'); i++; continue; }
    if (line.charCodeAt(0) === 62) {
      const parts = [];
      while (i < lines.length && lines[i].charCodeAt(0) === 62) {
        let rest = lines[i].slice(1);
        if (rest.charCodeAt(0) === 32) rest = rest.slice(1);
        const t = trimLine(rest);
        if (t !== '') parts.push(t);
        i++;
      }
      blocks.push(parts.length === 0 ? '<blockquote>\n</blockquote>' : '<blockquote>\n<p>' + inline(joinLines(parts), env) + '</p>\n</blockquote>');
      continue;
    }
    // list?
    let ordered = false;
    let start = 1;
    let firstText = null;
    const c0 = line.charCodeAt(0);
    if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) {
      firstText = line.slice(2);
    } else if (isDigit(c0)) {
      let j = 0;
      while (j < line.length && isDigit(line.charCodeAt(j)) && j < 9) j++;
      if (j >= 1 && j <= 9 && line.charCodeAt(j) === 46 && line.charCodeAt(j + 1) === 32) {
        ordered = true;
        start = Number(line.slice(0, j));
        firstText = line.slice(j + 2);
      }
    }
    if (firstText !== null) {
      const items = [[trimLine(firstText)]];
      i++;
      while (i < lines.length) {
        const l = lines[i];
        let text = null;
        if (!ordered) {
          const d = l.charCodeAt(0);
          if ((d === 45 || d === 42) && l.charCodeAt(1) === 32) text = l.slice(2);
        } else if (isDigit(l.charCodeAt(0))) {
          let j = 0;
          while (j < l.length && isDigit(l.charCodeAt(j)) && j < 9) j++;
          if (j >= 1 && j <= 9 && l.charCodeAt(j) === 46 && l.charCodeAt(j + 1) === 32) text = l.slice(j + 2);
        }
        if (text !== null) { items.push([trimLine(text)]); i++; continue; }
        let sp = 0;
        while (sp < l.length && l.charCodeAt(sp) === 32) sp++;
        if (sp >= 2 && sp < l.length && !WS_RE.test(l[sp])) {
          items[items.length - 1].push(trimLine(l));
          i++;
          continue;
        }
        break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const open = ordered && start !== 1 ? '<ol start="' + start + '">' : '<' + tag + '>';
      let inner = '';
      for (const parts of items) inner += '<li>' + inline(joinLines(parts), env) + '</li>\n';
      blocks.push(open + '\n' + inner + '</' + tag + '>');
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < lines.length && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(joinLines(body), env);
    if (excerpt === null) excerpt = html;
    blocks.push('<p>' + html + '</p>');
  }
  return { html: blocks.length === 0 ? '' : blocks.join('\n') + '\n', toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

const INCLUDE_DEPTH = 8;
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

// Property names that live on Object.prototype or Array.prototype. A path
// segment with one of these names must go through the own-property check;
// any other segment can be read directly (template values are plain objects,
// arrays and primitives only, so a direct read gives the same answer).
const DANGER = new Set([
  ...Object.getOwnPropertyNames(Object.prototype),
  ...Object.getOwnPropertyNames(Array.prototype),
]);

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError('template "' + name + '": ' + JSON.stringify(text) + ' is not a path');
  return text.split('.');
}

function tokenizeTemplate(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) { text += src.slice(i); break; }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') { text += src.slice(i, open + 1); i = open + 1; continue; }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError('template "' + name + '": a ' + (raw ? '{{{' : '{{') + ' is not closed');
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError('template "' + name + '": a {% is not closed');
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenizeTemplate(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError('template "' + name + '": an else outside an if');
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError('template "' + name + '": an ' + tag + ' with no open ' + tag.slice(3));
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError('template "' + name + '": {% ' + tag + ' %} is not a tag');
    }
  }
  if (stack.length > 1) throw new TemplateError('template "' + name + '": a ' + stack[stack.length - 1].kind + ' is not closed');
  return root.body;
}

// Template runtime helpers, shared by every compiled template of a build.
function tplGet(v, k) {
  return v !== null && typeof v === 'object' && Object.hasOwn(v, k) ? v[k] : undefined;
}

// tplGet for a key that is on no prototype (checked at compile time).
function tplGetF(v, k) {
  return v !== null && typeof v === 'object' ? v[k] : undefined;
}

function tplLookup(scope, name) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, name)) s = s.parent;
  return s === null ? undefined : s.vars[name];
}

// tplLookup for a name that is on no prototype (checked at compile time).
function tplLookupF(scope, name) {
  let s = scope;
  while (s !== null) {
    const v = s.vars[name];
    if (v !== undefined) return v;
    if (Object.hasOwn(s.vars, name)) return undefined;
    s = s.parent;
  }
  return undefined;
}

function tplText(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(tplText).join(', ');
  return '';
}

function tplTruthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function nodesHaveInclude(nodes) {
  for (const n of nodes) {
    if (n.kind === 'include') return true;
    if (n.kind === 'for' && nodesHaveInclude(n.body)) return true;
    if (n.kind === 'if' && (nodesHaveInclude(n.then) || (n.else !== null && nodesHaveInclude(n.else)))) return true;
  }
  return false;
}

// Whether nodes read the enclosing loop's `loop` (a nested for's body reads
// its own loop instead; its path is read in the enclosing scope).
function nodesUseLoop(nodes) {
  for (const n of nodes) {
    if (n.kind === 'var' || n.kind === 'raw') { if (n.path[0] === 'loop') return true; }
    else if (n.kind === 'if') {
      if (n.path[0] === 'loop' || nodesUseLoop(n.then) || (n.else !== null && nodesUseLoop(n.else))) return true;
    } else if (n.kind === 'for') { if (n.path[0] === 'loop') return true; }
  }
  return false;
}

// Free first-names of a template body (names read but not bound by an
// enclosing for), and the templates it includes. Include expansion is
// conservative: an included template's free names count as free here even
// when a for at the include site would bind them.
function directFree(nodes, bound, out, incs) {
  for (const n of nodes) {
    if (n.kind === 'var' || n.kind === 'raw') {
      if (!bound.has(n.path[0])) out.add(n.path[0]);
    } else if (n.kind === 'if') {
      if (!bound.has(n.path[0])) out.add(n.path[0]);
      directFree(n.then, bound, out, incs);
      if (n.else !== null) directFree(n.else, bound, out, incs);
    } else if (n.kind === 'for') {
      if (!bound.has(n.path[0])) out.add(n.path[0]);
      const inner = new Set(bound);
      inner.add(n.name);
      inner.add('loop');
      directFree(n.body, inner, out, incs);
    } else if (n.kind === 'include') {
      incs.add(n.name);
    }
  }
}

// One parsed template compiled to function(R, S, D, H) -> string.
function compileTemplate(nodes) {
  let uid = 0;
  const scopes = []; // { name, v, l } innermost last
  function pathExpr(path, sVar) {
    let expr;
    const first = path[0];
    if (first === 'loop' && scopes.length > 0) {
      expr = scopes[scopes.length - 1].l;
    } else {
      let bound = null;
      for (let k = scopes.length - 1; k >= 0; k--) {
        if (scopes[k].name === first && first !== 'loop') { bound = scopes[k].v; break; }
      }
      expr = bound !== null ? bound : (DANGER.has(first) ? 'H.lk(' : 'H.lkF(') + sVar + ',' + JSON.stringify(first) + ')';
    }
    for (let k = 1; k < path.length; k++) expr = (DANGER.has(path[k]) ? 'H.get(' : 'H.getF(') + expr + ',' + JSON.stringify(path[k]) + ')';
    return expr;
  }
  function gen(list, sVar) {
    let code = '';
    for (const n of list) {
      if (n.kind === 'text') {
        code += 'o+=' + JSON.stringify(n.text) + ';';
      } else if (n.kind === 'var') {
        code += 'o+=H.esc(H.txt(' + pathExpr(n.path, sVar) + '));';
      } else if (n.kind === 'raw') {
        code += 'o+=H.txt(' + pathExpr(n.path, sVar) + ');';
      } else if (n.kind === 'if') {
        code += 'if(' + (n.not ? '!' : '') + 'H.tru(' + pathExpr(n.path, sVar) + ')){';
        code += gen(n.then, sVar);
        code += '}';
        if (n.else !== null) code += 'else{' + gen(n.else, sVar) + '}';
      } else if (n.kind === 'for') {
        const id = uid++;
        const a = 'a' + id;
        const ix = 'i' + id;
        const v = 'v' + id;
        const l = 'l' + id;
        const needScope = nodesHaveInclude(n.body);
        const needLoop = needScope || nodesUseLoop(n.body);
        const s2 = needScope ? 's' + id : sVar;
        code += 'var ' + a + '=' + pathExpr(n.path, sVar) + ';';
        code += 'if(Array.isArray(' + a + ')){for(var ' + ix + '=0;' + ix + '<' + a + '.length;' + ix + '++){';
        code += 'var ' + v + '=' + a + '[' + ix + '];';
        if (needLoop) code += 'var ' + l + '={index:' + ix + '+1,first:' + ix + '===0,last:' + ix + '===' + a + '.length-1,length:' + a + '.length};';
        if (needScope) code += 'var ' + s2 + '={vars:{' + JSON.stringify(n.name) + ':' + v + ',loop:' + l + '},parent:' + sVar + '};';
        scopes.push({ name: n.name, v, l });
        code += gen(n.body, s2);
        scopes.pop();
        code += '}}';
      } else if (n.kind === 'include') {
        code += 'o+=H.inc(' + JSON.stringify(n.name) + ',R,' + sVar + ',D,H);';
      }
    }
    return code;
  }
  const body = 'var o="";' + gen(nodes, 'S') + 'return o;';
  return new Function('R', 'S', 'D', 'H', body);
}

// ---------------------------------------------------------------- the build

const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];

function byCodeUnits(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

function dirOf(path) {
  const k = path.lastIndexOf('/');
  return k === -1 ? '' : path.slice(0, k);
}

function resolvePath(dirParts, rel) {
  const parts = [...dirParts];
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 46 || c === 45)) return false;
  }
  return false;
}

export function run(input) {
  const slugCache = new Map();
  const slugOf = (text) => {
    let s = slugCache.get(text);
    if (s === undefined) { s = slugifyRaw(text); slugCache.set(text, s); }
    return s;
  };
  const dateCache = new Map();
  const dateOf = (date) => {
    let s = dateCache.get(date);
    if (s === undefined) { s = longDateRaw(date); dateCache.set(date, s); }
    return s;
  };

  const templates = new Map();
  const tplNodes = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      const nodes = parseTemplate(name, input.templates[name]);
      tplNodes.set(name, nodes);
      templates.set(name, compileTemplate(nodes));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  // Templates whose output at the root scope depends only on site, tags and
  // recent (the same objects for every render of this build) render once.
  const freeOf = new Map();
  const incsOf = new Map();
  for (const [name, nodes] of tplNodes) {
    const free = new Set();
    const incs = new Set();
    directFree(nodes, new Set(), free, incs);
    freeOf.set(name, free);
    incsOf.set(name, incs);
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, incs] of incsOf) {
      const free = freeOf.get(name);
      for (const inc of incs) {
        const sub = freeOf.get(inc);
        if (sub === undefined) continue;
        for (const f of sub) {
          if (!free.has(f)) { free.add(f); changed = true; }
        }
      }
    }
  }
  const rootOnly = new Set();
  for (const [name, free] of freeOf) {
    let ok = true;
    for (const f of free) {
      if (f !== 'site' && f !== 'tags' && f !== 'recent') { ok = false; break; }
    }
    if (ok) rootOnly.add(name);
  }
  const incCache = new Map();
  const H = {
    esc: escapeHtml,
    txt: tplText,
    tru: tplTruthy,
    get: tplGet,
    getF: tplGetF,
    lk: tplLookup,
    lkF: tplLookupF,
    inc: (name, R, S, D, HH) => {
      const t = templates.get(name);
      if (t === undefined || D >= INCLUDE_DEPTH) return '';
      if (S.parent === null && rootOnly.has(name)) {
        const key = name + '\0' + D;
        let hit = incCache.get(key);
        if (hit === undefined) { hit = t(R, S, D + 1, HH); incCache.set(key, hit); }
        return hit;
      }
      return t(R, S, D + 1, HH);
    },
  };
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. sources in code-unit order; .md is a source, the rest static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. front matter, generator-owned dirs, post dates, layouts, drafts.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) { report.push('refused ' + s.path + ': ' + fm.error); continue; }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) { report.push('refused ' + s.path + ': ' + own + '/ is the generator\'s own'); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) { report.push('refused ' + s.path + ': a post needs a date'); continue; }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) { report.push('refused ' + s.path + ': layout "' + layout + '" is no template that parses'); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push('draft ' + s.path); continue; }
    kept.push(s);
  }
  sources = kept;

  // 3. permalinks.
  const taken = new Map();
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) { set = new Set(dir === '' ? RESERVED : []); taken.set(dir, set); }
    s.slug = uniqueSlug(s.data.slug ?? slugOf(s.data.title), set);
    s.outDir = dir === '' ? s.slug : dir + '/' + s.slug;
    s.url = base + '/' + s.outDir + '/';
    bySource.set(s.path, s);
  }

  // 4. markdown with links resolved.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const linkCache = new Map();
  const brokenKeys = new Set();
  for (const s of sources) {
    const dir = dirOf(s.path);
    const dirParts = dir === '' ? [] : dir.split('/');
    const env = {
      link: (target) => {
        const cacheKey = dir + '\0' + target;
        let hit = linkCache.get(cacheKey);
        if (hit !== undefined) {
          if (brokenKeys.has(cacheKey)) broken.add('broken-link ' + s.path + ' -> ' + target);
          return hit;
        }
        let result;
        let isBroken = false;
        if (hasScheme(target) || target.startsWith('/') || target.startsWith('#')) {
          result = target;
        } else {
          const hash = target.indexOf('#');
          const rel = hash === -1 ? target : target.slice(0, hash);
          const frag = hash === -1 ? '' : target.slice(hash);
          const path = rel === '' ? null : resolvePath(dirParts, rel);
          if (path !== null && bySource.has(path)) result = bySource.get(path).url + frag;
          else if (path !== null && staticPaths.has(path)) result = base + '/' + path + frag;
          else { isBroken = true; result = target; }
        }
        if (isBroken) {
          brokenKeys.add(cacheKey);
          broken.add('broken-link ' + s.path + ' -> ' + target);
        }
        linkCache.set(cacheKey, result);
        return result;
      },
    };
    const md = renderMarkdown(s.body, env, slugOf);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. posts newest first, then slug; neighbours.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. tags grouped by slug.
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugOf(name);
      if (!seen.has(slug)) { seen.add(slug); out.push({ name, slug }); }
    }
    return out;
  };
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const { name, slug } of ownTags(p)) {
      let tag = bySlug.get(slug);
      if (tag === undefined) { tag = { name, slug, url: base + '/tags/' + slug + '/', posts: [] }; bySlug.set(slug, tag); }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (!s.post) s.tagRefs = ownTags(s).map(({ name, slug }) => bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  const tagItem = (t) => t._item ??= { name: t.name, slug: t.slug, url: t.url };
  // reading_minutes counted on first template read, then held as a value;
  // a layout that never reads it never pays for the count.
  const lazyMinutes = (obj, s) => {
    Object.defineProperty(obj, 'reading_minutes', {
      enumerable: true,
      configurable: true,
      get() {
        let v = s._rm;
        if (v === undefined) { v = Math.max(1, Math.ceil(wordsOf(s.body) / 200)); s._rm = v; }
        Object.defineProperty(obj, 'reading_minutes', { value: v, enumerable: true, configurable: true, writable: true });
        return v;
      },
    });
    return obj;
  };
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : dateOf(s.data.date) });
  const cardOf = (s) => lazyMinutes({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : dateOf(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    tags: s.tagRefs.map(tagItem),
  }, s);
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const pageOf = (s) => {
    const card = s.post ? cards.get(s) : cardOf(s);
    return lazyMinutes({
      title: card.title,
      url: card.url,
      date: card.date,
      date_long: card.date_long,
      summary: card.summary,
      excerpt: card.excerpt,
      tags: card.tags,
      slug: s.slug,
      content: s.html,
      toc: s.toc,
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    }, s);
  };

  // 7. layouts.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const fn = templates.get(name);
    if (fn === undefined) return null;
    const R = { site, tags: allTags, recent, ...vars };
    return fn(R, { vars: R, parent: null }, 0, H);
  };
  for (const s of sources) output[s.outDir + '/index.html'] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push('shadowed ' + f.path + ': a built page has its path');
    else output[f.path] = f.content;
  }

  // 8. report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = sources.filter((s) => !s.post).length;
  lines.push('built ' + pageCount + ' pages, ' + posts.length + ' posts, ' + tags.length + ' tags and ' + statics.length + ' static files');
  output[REPORT_FILE] = lines.join('\n') + '\n';
  return output;
}
