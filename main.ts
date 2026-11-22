// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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
}

type Edit = (tree: Tree) => void;

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

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
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
      const before = exists(tree);
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
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
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

/** Matching and file helpers (SPEC.md sections 3 and 5). */
interface Ctx {
  strict: boolean;
  moves: Array<{ old: string; new: string }>;
}
type NItem = { text: string; ctx: number | null };
interface BodyItem {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
}

function fileInfo(text: string): { br: string; lines: string[]; final: boolean } {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}
function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}
function lead(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}
function keyAt(tier: number, s: string): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}
function occurrences(lines: string[], o: string[], tier: number, from: number, eofOnly: boolean): number[] {
  const out: number[] = [];
  const last = lines.length - o.length;
  for (let i = from; i <= last; i++) {
    if (eofOnly && i + o.length !== lines.length) continue;
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (keyAt(tier, lines[i + j]!) !== keyAt(tier, o[j]!)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}
function findTier(lines: string[], o: string[], strict: boolean, from: number, eofOnly: boolean): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, o, t, from, eofOnly);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}
function buildSeg(n: NItem[], o: string[], fileLines: string[], pos: number, tier: number): string[] {
  if (tier !== 2) return n.map((it) => (it.ctx !== null ? fileLines[pos + it.ctx]! : it.text));
  const f = lead(fileLines[pos] ?? '');
  const p = lead(o[0] ?? '');
  return n.map((it) => {
    if (it.ctx !== null) return fileLines[pos + it.ctx]!;
    const t = it.text;
    if (t === '' || t.trim() === '') return t;
    if (t.startsWith(p)) return f + t.slice(p.length);
    return t;
  });
}
function chunkON(body: BodyItem[]): { o: string[]; n: NItem[] } {
  const o: string[] = [];
  const n: NItem[] = [];
  for (const it of body) {
    if (it.kind === 'ctx') {
      o.push(it.text);
      n.push({ text: it.text, ctx: o.length - 1 });
    } else if (it.kind === 'old') {
      o.push(it.text);
    } else if (it.kind === 'new') {
      n.push({ text: it.text, ctx: null });
    }
  }
  return { o, n };
}

/** Unified diffs (SPEC.md section 6). */
interface Hunk {
  a: number;
  o: string[];
  n: NItem[];
  noEol: boolean;
  lastPlusNoEol: boolean | null;
  plus: string[];
}
interface Section {
  oldPath: string | null;
  newPath: string | null;
  oldRank: number;
  newRank: number;
  pairSeen: boolean;
  newFile: boolean;
  deleted: boolean;
  hunks: Hunk[];
}
function headerPath(l: string): string | null {
  const p = l.slice(4).split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}
function diffGitPaths(l: string): { old: string; new: string } | null {
  const t = l.trimEnd();
  let m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(t);
  if (m) return { old: m[1]!, new: m[2]! };
  m = /^diff --git a\/(.+?) b\/(.+)$/.exec(t);
  if (m) return { old: m[1]!, new: m[2]! };
  return null;
}
function hunkHead(l: string): number | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
  return m ? Number(m[1]) : null;
}
function buildHunk(a: number, body: BodyItem[]): Hunk {
  const o: string[] = [];
  const n: NItem[] = [];
  const plus: string[] = [];
  for (const it of body) {
    if (it.kind === 'ctx') {
      o.push(it.text);
      n.push({ text: it.text, ctx: o.length - 1 });
    } else if (it.kind === 'old') {
      o.push(it.text);
    } else if (it.kind === 'new') {
      n.push({ text: it.text, ctx: null });
      plus.push(it.text);
    }
  }
  let noEol = false;
  let lastPlusNoEol: boolean | null = null;
  for (let i = 0; i < body.length; i++) {
    const it = body[i]!;
    if (it.kind === 'ctx' || it.kind === 'new') noEol = body[i + 1]?.kind === 'bs';
    if (it.kind === 'new') lastPlusNoEol = body[i + 1]?.kind === 'bs';
  }
  return { a, o, n, noEol, lastPlusNoEol, plus };
}
function sectionEdit(sec: Section, ctx: Ctx): Edit {
  const oldP = sec.oldPath;
  const newP = sec.newPath;
  const isDelete = sec.deleted || newP === null;
  const isCreate = !isDelete && (sec.newFile || oldP === null);
  const isMove = !isDelete && !isCreate && oldP !== null && newP !== null && oldP !== newP;
  if (isDelete) {
    const p = oldP ?? newP ?? '';
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  if (isCreate) {
    const p = newP ?? '';
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let lastNoEol = false;
      for (const h of sec.hunks) {
        plus.push(...h.plus);
        if (h.lastPlusNoEol !== null) lastNoEol = h.lastPlusNoEol;
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (lastNoEol ? '' : '\n'));
    };
  }
  const source = oldP ?? '';
  const target = newP ?? oldP ?? '';
  return (tree) => {
    if (!safe(source)) throw new Fail('unsafe', source);
    if (isMove && !safe(target)) throw new Fail('unsafe', target);
    const before = tree.get(source);
    if (before === null) throw new Fail('missing', source);
    if (isMove && tree.get(target) !== null) throw new Fail('exists', target);
    const info = fileInfo(before);
    let lines = info.lines.slice();
    let final = info.final;
    let d = 0;
    for (const h of sec.hunks) {
      if (h.o.length === 0) {
        let ins = h.a + d;
        if (ins < 0) ins = 0;
        if (ins > lines.length) ins = lines.length;
        const atEnd = ins === lines.length;
        const seg = h.n.map((it) => it.text);
        lines = [...lines.slice(0, ins), ...seg, ...lines.slice(ins)];
        if (atEnd && seg.length > 0) final = !h.noEol;
        d += h.n.length;
      } else {
        const found = findTier(lines, h.o, ctx.strict, 0, false);
        if (found === null) throw new Fail('no-match', source);
        const want = h.a - 1 + d;
        let pos = found.positions[0]!;
        let best = Math.abs(pos - want);
        for (const q of found.positions) {
          const dist = Math.abs(q - want);
          if (dist < best) {
            best = dist;
            pos = q;
          }
        }
        const atEnd = pos + h.o.length === lines.length;
        const seg = buildSeg(h.n, h.o, lines, pos, found.tier);
        lines = [...lines.slice(0, pos), ...seg, ...lines.slice(pos + h.o.length)];
        if (atEnd) {
          if (h.n.length === 0) final = lines.length > 0;
          else final = !h.noEol;
        }
        d += h.n.length - h.o.length;
      }
    }
    const out = joinFile(lines, info.br, final);
    if (isMove) {
      tree.now.set(target, out);
      tree.now.set(source, null);
      ctx.moves.push({ old: source, new: target });
    } else {
      tree.now.set(source, out);
    }
  };
}
function unifiedEdits(lines: string[], ctx: Ctx): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  const newSection = (oldP: string | null, newP: string | null, oldRank: number, newRank: number): Section => {
    const s: Section = { oldPath: oldP, newPath: newP, oldRank, newRank, pairSeen: false, newFile: false, deleted: false, hunks: [] };
    sections.push(s);
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const dg = diffGitPaths(l);
      if (dg === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection(dg.old, dg.new, 1, 1);
      inHeader = true;
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = hunkHead(l);
      if (a === null) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      const body: BodyItem[] = [];
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b.startsWith('diff --git ')) break;
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
          body.push(
            b === ''
              ? { kind: 'ctx', text: '' }
              : b[0] === ' '
                ? { kind: 'ctx', text: b.slice(1) }
                : b[0] === '-'
                  ? { kind: 'old', text: b.slice(1) }
                  : b[0] === '+'
                    ? { kind: 'new', text: b.slice(1) }
                    : { kind: 'bs', text: b.slice(1) },
          );
          i++;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1]!.kind === 'ctx' && body[body.length - 1]!.text === '') body.pop();
      cur.hunks.push(buildHunk(a, body));
      inHeader = false;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader) {
        if (!cur.pairSeen) {
          cur.oldPath = headerPath(l);
          cur.newPath = headerPath(lines[i + 1]!);
          cur.oldRank = 3;
          cur.newRank = 3;
          cur.pairSeen = true;
        }
        i += 2;
        continue;
      }
      cur = newSection(headerPath(l), headerPath(lines[i + 1]!), 3, 3);
      cur.pairSeen = true;
      inHeader = true;
      i += 2;
      continue;
    }
    if (l.startsWith('--- ')) {
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('+++ ')) {
        if (!cur.pairSeen && cur.newRank < 3) {
          cur.newPath = headerPath(l);
          cur.newRank = 3;
        }
        i++;
        continue;
      }
      if (l.startsWith('rename from ')) {
        if (!cur.pairSeen && cur.oldRank < 2) {
          cur.oldPath = l.slice('rename from '.length).trim();
          cur.oldRank = 2;
        }
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        if (!cur.pairSeen && cur.newRank < 2) {
          cur.newPath = l.slice('rename to '.length).trim();
          cur.newRank = 2;
        }
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.newFile = true;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.deleted = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  return sections.map((s) => sectionEdit(s, ctx));
}

/** SEARCH/REPLACE blocks (SPEC.md section 7). */
function srEdit(path: string, oldLines: string[], newLines: string[], ctx: Ctx): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const info = fileInfo(before);
    const found = findTier(info.lines, oldLines, ctx.strict, 0, false);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0]!;
    const seg = buildSeg(
      newLines.map((t) => ({ text: t, ctx: null })),
      oldLines,
      info.lines,
      pos,
      found.tier,
    );
    const nl = [...info.lines.slice(0, pos), ...seg, ...info.lines.slice(pos + oldLines.length)];
    tree.now.set(path, joinFile(nl, info.br, info.final));
  };
}
function searchReplaceEdits(lines: string[], ctx: Ctx): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${searchLine}`);
    }
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchLine}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, ctx));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

/** V4A patches (SPEC.md section 8). */
interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyItem[];
}
function v4aAddEdit(path: string, contentLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, contentLines.length === 0 ? '' : contentLines.join('\n') + '\n');
  };
}
function v4aDelEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}
function v4aUpdEdit(path: string, moveTo: string | null, chunks: VChunk[], ctx: Ctx): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const info = fileInfo(before);
    let lines = info.lines.slice();
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        let foundAt = -1;
        const tiers = ctx.strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          for (let k = cursor; k < lines.length; k++) {
            if (keyAt(t, lines[k]!) === keyAt(t, ch.anchor)) {
              foundAt = k;
              break;
            }
          }
          if (foundAt >= 0) break;
        }
        if (foundAt < 0) throw new Fail('no-match', path);
        cursor = foundAt + 1;
      }
      const { o, n } = chunkON(ch.body);
      if (o.length === 0) {
        const ins = ch.eof ? lines.length : cursor;
        const seg = n.map((it) => it.text);
        lines = [...lines.slice(0, ins), ...seg, ...lines.slice(ins)];
        cursor = ins + seg.length;
      } else {
        const found = findTier(lines, o, ctx.strict, cursor, ch.eof);
        if (found === null) throw new Fail('no-match', path);
        const pos = found.positions[0]!;
        const seg = buildSeg(n, o, lines, pos, found.tier);
        lines = [...lines.slice(0, pos), ...seg, ...lines.slice(pos + o.length)];
        cursor = pos + seg.length;
      }
    }
    const out = joinFile(lines, info.br, info.final);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      ctx.moves.push({ old: path, new: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}
function v4aEdits(lines: string[], ctx: Ctx): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    while (i < last && blank(lines[i]!)) i++;
    if (i >= last) break;
    const l = lines[i]!;
    let kind: 'add' | 'del' | 'upd';
    let path: string;
    if (l.startsWith('*** Add File: ')) {
      kind = 'add';
      path = l.slice('*** Add File: '.length).trim();
    } else if (l.startsWith('*** Delete File: ')) {
      kind = 'del';
      path = l.slice('*** Delete File: '.length).trim();
    } else if (l.startsWith('*** Update File: ')) {
      kind = 'upd';
      path = l.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const headLine = i + 1;
    i++;
    if (kind === 'add') {
      const content: Array<{ text: string; fromBlank: boolean }> = [];
      while (i < last) {
        const cl = lines[i]!;
        if (isSectionStart(cl) || cl.trim() === '*** End Patch') break;
        if (cl === '') {
          content.push({ text: '', fromBlank: true });
          i++;
          continue;
        }
        if (cl.startsWith('+')) {
          content.push({ text: cl.slice(1), fromBlank: false });
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (content.length > 0 && content[content.length - 1]!.fromBlank) content.pop();
      edits.push(v4aAddEdit(path, content.map((c) => c.text)));
    } else if (kind === 'del') {
      while (i < last) {
        const cl = lines[i]!;
        if (isSectionStart(cl) || cl.trim() === '*** End Patch') break;
        if (blank(cl)) {
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      edits.push(v4aDelEdit(path));
    } else {
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let started = false;
      let afterEof = false;
      while (i < last) {
        const cl = lines[i]!;
        if (isSectionStart(cl) || cl.trim() === '*** End Patch') break;
        if (cl === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
          afterEof = true;
          i++;
          continue;
        }
        if (cl.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          cur = { anchor: cl.slice(2).trim(), eof: false, body: [] };
          started = true;
          afterEof = false;
          i++;
          continue;
        }
        if (cl.startsWith('*** ')) throw new Exit2(`error: parse ${i + 1}`);
        if (cl === '' || cl[0] === ' ' || cl[0] === '-' || cl[0] === '+') {
          if (cur === null) {
            if (cl === '' && (started || afterEof)) {
              i++;
              continue;
            }
            if (started) throw new Exit2(`error: parse ${i + 1}`);
            cur = { anchor: null, eof: false, body: [] };
            started = true;
          }
          afterEof = false;
          cur.body.push(
            cl === ''
              ? { kind: 'ctx', text: '' }
              : cl[0] === ' '
                ? { kind: 'ctx', text: cl.slice(1) }
                : cl[0] === '-'
                  ? { kind: 'old', text: cl.slice(1) }
                  : { kind: 'new', text: cl.slice(1) },
          );
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (cur !== null) {
        while (cur.body.length > 0 && cur.body[cur.body.length - 1]!.kind === 'ctx' && cur.body[cur.body.length - 1]!.text === '') cur.body.pop();
        chunks.push(cur);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headLine}`);
      edits.push(v4aUpdEdit(path, moveTo, chunks, ctx));
    }
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
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
  const moves: Array<{ old: string; new: string }> = [];
  const ctx: Ctx = { strict, moves };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, ctx);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, ctx);
    else edits = v4aEdits(lines, ctx);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: string[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push(p);
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  const display = new Map<string, { key: string; text: string }>();
  for (const p of changed) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    display.set(p, { key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const mv of moves) {
    if (tree.original(mv.old) !== null && tree.get(mv.old) === null && tree.original(mv.new) === null && tree.get(mv.new) !== null) {
      display.delete(mv.old);
      display.delete(mv.new);
      display.set(`\0${mv.new}`, { key: mv.new, text: `R ${mv.old} -> ${mv.new}` });
    }
  }
  const rows = [...display.values()]
    .sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)))
    .map((r) => r.text);
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
