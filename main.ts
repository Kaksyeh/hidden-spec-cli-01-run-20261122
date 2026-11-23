// mend: one patch tool for every AI edit format, to SPEC.md version 1.
// Node 22, standard library only. Run as `node main.ts [options] [PATCH]`
// with the working directory as the root of a tree of text files.
// Reads unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON edits,
// finds the lines each edit names at the first of three matching tiers,
// and writes every change or none, printing what it changed or why not.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 answer: one line, nothing written. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit that failed, with the code and the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** Section 3: a path is safe when it is not empty, does not start with /, holds no \, and none of its segments is empty, . or ... */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

const leadWs = (s: string): string => s.match(/^[ \t]*/)?.[0] ?? '';
const trailWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const rstripWs = (s: string): string => s.replace(/[ \t]+$/, '');

/** Section 5: two lines equal at a tier. Tier 0 exact, tier 1 trailing spaces and tabs removed, tier 2 both sides removed. */
function tierMatch(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rstripWs(a) === rstripWs(b);
  return trailWs(a) === trailWs(b);
}

/** A file's lines, its line break, and whether it ends with one (section 3). */
interface FileState {
  lines: string[];
  br: '\r\n' | '\n';
  finalBreak: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function renderFile(s: FileState): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.br) + (s.finalBreak ? s.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, new path -> old path, for the R lines of section 2. */
  readonly moves = new Map<string, string>();

  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }

  move(oldP: string, newP: string, text: string): void {
    this.now.set(oldP, null);
    this.now.set(newP, text);
    this.moves.set(newP, oldP);
  }
}

type Edit = (tree: Tree) => void;

/** Section 4: detect the format from the patch lines, or null when none holds. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** Section 5: the first tier at which O occurs in lines at or after `from`, with every occurrence position. */
function findTier(O: string[], lines: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    const occ: number[] = [];
    for (let i = from; i + O.length <= lines.length; i++) {
      let ok = true;
      for (let j = 0; j < O.length; j++) {
        if (!tierMatch(O[j]!, lines[i + j]!, t)) {
          ok = false;
          break;
        }
      }
      if (ok) occ.push(i);
    }
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of a replacement: `ctx` is its index in O when it is a context line, -1 when it is added. */
interface NLine {
  text: string;
  ctx: number;
}

/**
 * Section 5: build the replacement lines. A context line is written as the
 * file's own matched line, never the patch's. At tier 2 every other line is
 * re-indented: its leading spaces and tabs P (of O's first line) replaced by
 * F (of the file's first matched line), when it is not empty, not only
 * whitespace, and starts with P. At tiers 0 and 1 lines are written as they are.
 */
function buildN(N: NLine[], fileLines: string[], pos: number, O: string[], tier: number): string[] {
  const F = tier === 2 ? leadWs(fileLines[pos] ?? '') : '';
  const P = tier === 2 ? leadWs(O[0] ?? '') : '';
  return N.map((n) => {
    if (n.ctx >= 0) return fileLines[pos + n.ctx]!;
    let s = n.text;
    if (tier === 2 && s !== '' && s.trim() !== '' && s.startsWith(P)) s = F + s.slice(P.length);
    return s;
  });
}

/** Split a hunk or chunk body into its old lines O and its new lines N. */
function splitBody(body: BodyLine[]): { O: string[]; N: NLine[] } {
  const O: string[] = [];
  const N: NLine[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      const oi = O.length;
      O.push(b.text);
      N.push({ text: b.text, ctx: oi });
    } else if (b.kind === 'old') {
      O.push(b.text);
    } else if (b.kind === 'new') {
      N.push({ text: b.text, ctx: -1 });
    }
  }
  return { O, N };
}

/** One line of a hunk or chunk body: context, old, new, or a backslash line. `raw` is the patch line as written. */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'back';
  text: string;
  raw: string;
}

/** Whether a `\` line follows the body's last context or `+` line (section 6). */
function backslashAfterLast(body: BodyLine[]): boolean {
  let last = -1;
  for (let k = 0; k < body.length; k++) {
    if (body[k]!.kind === 'ctx' || body[k]!.kind === 'new') last = k;
  }
  return last >= 0 && last + 1 < body.length && body[last + 1]!.kind === 'back';
}

// ---------------------------------------------------------------------------
// Section 9: JSON edits
// ---------------------------------------------------------------------------

/** One JSON edit object (section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const need = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = need(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = need(tree);
      const st = parseFile(before);
      if (line < 0 || line > st.lines.length) throw new Fail('no-match', p);
      const lines = [...st.lines];
      lines.splice(line, 0, ...add);
      tree.now.set(p, renderFile({ lines, br: st.br, finalBreak: st.finalBreak }));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

const GIT_RE = /^diff --git a\/(\S+) b\/(\S+)$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** A `--- `/`+++ ` path: text after the four characters, up to the first tab, surrounding spaces removed; /dev/null means no file; a leading a/ or b/ is removed. */
function dashPath(raw: string): string | null {
  let p = raw.split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  // Per-path slots, so the priority of section 6 holds whatever the order: ---/+++ beats rename, which beats diff --git.
  let dashOld: string | null | undefined;
  let dashNew: string | null | undefined;
  let renOld: string | undefined;
  let renNew: string | undefined;
  let inBody = false;
  let curHunk: Hunk | null = null;

  const finishSection = (): void => {
    if (cur !== null) {
      if (dashOld !== undefined) cur.oldPath = dashOld;
      if (dashNew !== undefined) cur.newPath = dashNew;
      if (renOld !== undefined && dashOld === undefined) cur.oldPath = renOld;
      if (renNew !== undefined && dashNew === undefined) cur.newPath = renNew;
      cur = null;
    }
    dashOld = undefined;
    dashNew = undefined;
    renOld = undefined;
    renNew = undefined;
  };

  const openSection = (oldP: string | null, newP: string | null): void => {
    finishSection();
    cur = { oldPath: oldP, newPath: newP, newFile: false, deletedFile: false, hunks: [] };
    sections.push(cur);
  };

  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (inBody) {
      // The body ends at a diff --git line, or at a --- line followed by a +++ line.
      if (line.startsWith('diff --git ')) {
        inBody = false;
        curHunk = null;
        continue;
      }
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        inBody = false;
        curHunk = null;
        continue;
      }
      if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\') || line === '') {
        const kind: BodyLine['kind'] = line === '' || line[0] === ' ' ? 'ctx' : line[0] === '-' ? 'old' : line[0] === '+' ? 'new' : 'back';
        curHunk!.body.push({ kind, text: kind === 'back' ? line : line.slice(1), raw: line });
        i++;
        continue;
      }
      inBody = false;
      curHunk = null;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const m = GIT_RE.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      openSection(m[1]!, m[2]!);
      i++;
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next === undefined || !next.startsWith('+++ ')) {
        // A --- line not followed by a +++ line, inside a section's header, is a parse error at the line after it.
        if (cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
        i++;
        continue;
      }
      const oldP = dashPath(line.slice(4));
      const newP = dashPath(next.slice(4));
      if (cur !== null && cur.hunks.length === 0) {
        dashOld = oldP;
        dashNew = newP;
      } else {
        openSection(oldP, newP);
        dashOld = oldP;
        dashNew = newP;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('+++ ') && cur !== null && cur.hunks.length === 0) {
      dashNew = dashPath(line.slice(4));
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      curHunk = { a: parseInt(m[1]!, 10), body: [] };
      cur.hunks.push(curHunk);
      inBody = true;
      i++;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) renOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) renNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      // index, old mode, new mode, similarity index, dissimilarity index, Index: and any other line are ignored.
      i++;
      continue;
    }
    i++;
  }
  finishSection();
  // Empty lines at the end of a body are not part of it: drop trailing body lines whose raw patch line was empty.
  for (const s of sections) {
    for (const h of s.hunks) {
      while (h.body.length > 0 && h.body[h.body.length - 1]!.raw === '') h.body.pop();
    }
  }
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

/**
 * Section 6: apply a section's hunks in order to a file's text, each to the
 * result of the ones before it. d is the sum over the hunks applied so far of
 * (N's length minus O's length). A hunk with a non-empty O takes the occurrence
 * nearest to A - 1 + d, the earlier of two equally near; an empty O inserts
 * after the first A + d lines. When the matched lines run to the end of the
 * file the result ends with a line break unless a `\` line follows the hunk's
 * last context or `+` line; otherwise the file's final break stays as it was.
 */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  let st = parseFile(text);
  let d = 0;
  for (const h of hunks) {
    const { O, N } = splitBody(h.body);
    if (O.length === 0) {
      const idx = Math.max(0, Math.min(h.a + d, st.lines.length));
      const atEnd = idx === st.lines.length;
      const added = N.map((x) => x.text);
      const lines = [...st.lines.slice(0, idx), ...added, ...st.lines.slice(idx)];
      const finalBreak = atEnd ? !backslashAfterLast(h.body) : st.finalBreak;
      st = { lines, br: st.br, finalBreak };
      d += N.length;
      continue;
    }
    const found = findTier(O, st.lines, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let pos = found.occ[0]!;
    let best = Math.abs(pos - target);
    for (const o of found.occ) {
      const dist = Math.abs(o - target);
      if (dist < best) {
        best = dist;
        pos = o;
      }
    }
    const touchesEnd = pos + O.length === st.lines.length;
    const replacement = buildN(N, st.lines, pos, O, found.tier);
    const lines = [...st.lines.slice(0, pos), ...replacement, ...st.lines.slice(pos + O.length)];
    const finalBreak = touchesEnd ? !backslashAfterLast(h.body) : st.finalBreak;
    st = { lines, br: st.br, finalBreak };
    d += N.length - O.length;
  }
  return renderFile(st);
}

/** One unified section is one edit (section 6). */
function unifiedSectionEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    const isCreate = oldP === null || sec.newFile;
    const isDelete = !isCreate && (newP === null || sec.deletedFile);
    if (isCreate) {
      // A creation: the new path does not exist; the file is the + lines of all its hunks, in order.
      if (newP === null) return; // both paths /dev/null: no file is named, nothing changes.
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let lastPlusBack = false;
      for (const h of sec.hunks) {
        let lastPlus = -1;
        for (let k = 0; k < h.body.length; k++) {
          if (h.body[k]!.kind === 'new') lastPlus = k;
        }
        if (lastPlus >= 0) lastPlusBack = lastPlus + 1 < h.body.length && h.body[lastPlus + 1]!.kind === 'back';
        for (const b of h.body) {
          if (b.kind === 'new') plus.push(b.text);
        }
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (lastPlusBack ? '' : '\n'));
      return;
    }
    if (isDelete) {
      // A deletion: the old path exists; it is deleted, and its hunks are not read.
      const p = oldP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (oldP !== null && newP !== null && oldP !== newP) {
      // A move: the old path exists, the new path does not; the hunks apply to the old file's lines.
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const out = applyHunks(tree.get(oldP)!, sec.hunks, strict, oldP);
      tree.move(oldP, newP, out);
      return;
    }
    // Otherwise a change of the one path, which exists.
    const p = oldP!;
    if (!safe(p)) throw new Fail('unsafe', p);
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunks(cur, sec.hunks, strict, p));
  };
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks
// ---------------------------------------------------------------------------

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (let k = eq + 1; k < lines.length; k++) {
      const t = lines[k]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    // The path is the nearest line before the SEARCH line, and after the previous block's REPLACE line, that is not
    // blank and, its surrounding whitespace removed, does not start with three backticks.
    let path: string | null = null;
    for (let m = i - 1; m >= prevEnd; m--) {
      const t = lines[m]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    prevPath = path;
    prevEnd = rep + 1;
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    i = rep + 1;
  }
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      // Empty old lines: the file is created with the new lines.
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const st = parseFile(cur);
    const found = findTier(oldLines, st.lines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const replacement = buildN(
      newLines.map((t) => ({ text: t, ctx: -1 })),
      st.lines,
      pos,
      oldLines,
      found.tier,
    );
    const lines = [...st.lines.slice(0, pos), ...replacement, ...st.lines.slice(pos + oldLines.length)];
    tree.now.set(path, renderFile({ lines, br: st.br, finalBreak: st.finalBreak }));
  };
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches
// ---------------------------------------------------------------------------

interface Chunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

const ADD_PREFIX = '*** Add File: ';
const DEL_PREFIX = '*** Delete File: ';
const UPD_PREFIX = '*** Update File: ';
const MOVE_PREFIX = '*** Move to: ';

function isSectionStart(l: string): boolean {
  return l.startsWith(ADD_PREFIX) || l.startsWith(DEL_PREFIX) || l.startsWith(UPD_PREFIX);
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    while (i < last && blank(lines[i]!)) i++;
    if (i >= last) break;
    const line = lines[i]!;
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith(ADD_PREFIX)) {
      kind = 'add';
      path = line.slice(ADD_PREFIX.length).trim();
    } else if (line.startsWith(DEL_PREFIX)) {
      kind = 'delete';
      path = line.slice(DEL_PREFIX.length).trim();
    } else if (line.startsWith(UPD_PREFIX)) {
      kind = 'update';
      path = line.slice(UPD_PREFIX.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const headerLine = i;
    const start = i + 1;
    let j = start;
    while (j < last && !isSectionStart(lines[j]!)) j++;
    let raw = lines.slice(start, j);
    // Blank lines at the end of a section are not part of it.
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (let k = 0; k < raw.length; k++) {
        const l = raw[k]!;
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (l === '') fileLines.push('');
        else throw new Exit2(`error: parse ${start + k + 1}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
    } else if (kind === 'delete') {
      for (let k = 0; k < raw.length; k++) {
        throw new Exit2(`error: parse ${start + k + 1}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      edits.push(v4aUpdateEdit(path, raw, start, headerLine, strict));
    }
    i = j;
  }
  return edits;
}

function v4aUpdateEdit(path: string, raw: string[], absStart: number, headerLine: number, strict: boolean): Edit {
  // Parse the section now, so a parse fault is reported before any file is looked at.
  let idx = 0;
  let moveTo: string | null = null;
  if (raw.length > 0 && raw[0]!.startsWith(MOVE_PREFIX)) {
    moveTo = raw[0]!.slice(MOVE_PREFIX.length).trim();
    idx = 1;
  }
  const chunks: Chunk[] = [];
  let cur: Chunk | null = null;
  let afterEof = false;
  const parseAt = (k: number): number => absStart + k + 1;
  for (; idx < raw.length; idx++) {
    const l = raw[idx]!;
    if (l.startsWith('@@')) {
      if (cur !== null) chunks.push(cur);
      cur = { anchor: l.slice(2).trim(), eof: false, body: [] };
      afterEof = false;
      continue;
    }
    if (l.trim() === '*** End of File') {
      // It ends a chunk and anchors it to the end of the file. With no chunk in progress there is nothing to end,
      // so the line is passed over and the section's validity is left to the no-chunk rule below.
      if (cur !== null) {
        cur.eof = true;
        chunks.push(cur);
        cur = null;
        afterEof = true;
      }
      continue;
    }
    if (l.startsWith(MOVE_PREFIX)) throw new Exit2(`error: parse ${parseAt(idx)}`);
    if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
      if (afterEof) throw new Exit2(`error: parse ${parseAt(idx)}`);
      if (cur === null) cur = { anchor: null, eof: false, body: [] };
      const kind: BodyLine['kind'] = l === '' || l[0] === ' ' ? 'ctx' : l[0] === '-' ? 'old' : 'new';
      cur.body.push({ kind, text: l === '' ? '' : l.slice(1), raw: l });
      continue;
    }
    throw new Exit2(`error: parse ${parseAt(idx)}`);
  }
  if (cur !== null) chunks.push(cur);
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine + 1}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    const curText = tree.get(path);
    if (curText === null) throw new Fail('missing', path);
    if (moveTo !== null) {
      if (!safe(moveTo)) throw new Fail('unsafe', moveTo);
      if (tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    }
    let st = parseFile(curText);
    let cursor = 0;
    const top = strict ? 0 : 2;
    for (const chunk of chunks) {
      if (chunk.anchor !== null && chunk.anchor !== '') {
        // First find the first line at or after the cursor equal to the anchor, at the first tier where one is.
        let found = -1;
        for (let t = 0; t <= top && found < 0; t++) {
          for (let k = cursor; k < st.lines.length; k++) {
            if (tierMatch(chunk.anchor, st.lines[k]!, t)) {
              found = k;
              break;
            }
          }
        }
        if (found < 0) throw new Fail('no-match', path);
        cursor = found + 1;
      } else if (chunk.anchor === '') {
        // An empty anchor is no anchor: the chunk starts at the cursor.
      }
      const { O, N } = splitBody(chunk.body);
      if (O.length === 0) {
        const at = chunk.eof ? st.lines.length : cursor;
        const added = N.map((x) => x.text);
        const lines = [...st.lines.slice(0, at), ...added, ...st.lines.slice(at)];
        st = { lines, br: st.br, finalBreak: st.finalBreak };
        cursor = at + added.length;
        continue;
      }
      // The chunk takes the first occurrence of O at or after the cursor, at the first tier with one; an end-of-file
      // chunk takes only an occurrence that ends at the file's last line.
      let taken: { tier: number; pos: number } | null = null;
      for (let t = 0; t <= top && taken === null; t++) {
        for (let p = cursor; p + O.length <= st.lines.length; p++) {
          if (chunk.eof && p + O.length !== st.lines.length) continue;
          let ok = true;
          for (let j = 0; j < O.length; j++) {
            if (!tierMatch(O[j]!, st.lines[p + j]!, t)) {
              ok = false;
              break;
            }
          }
          if (ok) {
            taken = { tier: t, pos: p };
            break;
          }
        }
      }
      if (taken === null) throw new Fail('no-match', path);
      const replacement = buildN(N, st.lines, taken.pos, O, taken.tier);
      const lines = [...st.lines.slice(0, taken.pos), ...replacement, ...st.lines.slice(taken.pos + O.length)];
      st = { lines, br: st.br, finalBreak: st.finalBreak };
      cursor = taken.pos + replacement.length;
    }
    const out = renderFile(st);
    if (moveTo !== null) tree.move(path, moveTo, out);
    else tree.now.set(path, out);
  };
}

// ---------------------------------------------------------------------------
// Section 1, 2, 10: invocation, output and exit codes, order and atomicity
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = new Map(tree.moves);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.clear();
      for (const [k, v] of beforeMoves) tree.moves.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  // A move that succeeded is one R line, sorting by its new path, and replaces that pair's D and A lines.
  const rPairs = new Map<string, string>();
  for (const [newP, oldP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rPairs.set(newP, oldP);
    }
  }
  const rOlds = new Set(rPairs.values());
  const rows: { key: string; line: string }[] = [];
  for (const p of [...tree.now.keys()]) {
    if (rOlds.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    const old = rPairs.get(p);
    if (old !== undefined) rows.push({ key: p, line: `R ${old} -> ${p}` });
    else if (was === null) rows.push({ key: p, line: `A ${p}` });
    else if (now === null) rows.push({ key: p, line: `D ${p}` });
    else rows.push({ key: p, line: `M ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
