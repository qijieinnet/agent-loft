// Apple Notes via JXA, run by Agent Loft Bridge: osascript -l JavaScript notes.js <cmd> [--opts]
// Output is JSON on stdout; errors are JSON on stderr with exit code 1.
ObjC.import('Foundation');
ObjC.import('stdlib');

const Notes = Application('Notes');

function fail(msg) {
  const s = JSON.stringify({ error: msg }, null, 2) + '\n';
  $.NSFileHandle.fileHandleWithStandardError.writeData($(s).dataUsingEncoding($.NSUTF8StringEncoding));
  $.exit(1);
}

function parseArgs(argv) {
  const pos = [], opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const eq = key.indexOf('=');
      if (eq >= 0) opts[key.slice(0, eq)] = key.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opts[key] = argv[++i];
      else opts[key] = 'true';
    } else pos.push(a);
  }
  return { pos, opts };
}

function pad(n) { return String(n).padStart(2, '0'); }
function fmtDate(d) {
  if (!d) return null;
  const off = -d.getTimezoneOffset(), sign = off >= 0 ? '+' : '-', ao = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(ao / 60))}:${pad(ao % 60)}`;
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
// Plain text -> Notes-style HTML (one <div> per line).
function textToHtml(s) {
  return s.split('\n').map(l => l.length ? `<div>${escapeHtml(l)}</div>` : '<div><br></div>').join('');
}
function bodyHtml(opts) {
  if (opts.body === undefined) return '';
  return opts.html === 'true' ? opts.body : textToHtml(opts.body);
}

// --- folders -----------------------------------------------------------------

function allFolders() {
  const out = [];
  for (const acc of Notes.accounts()) {
    const accName = acc.name();
    for (const f of acc.folders()) out.push({ acc: accName, f });
  }
  return out;
}

function folderInfo({ acc, f }) {
  let parent = null;
  try {
    const c = f.container();
    if (ObjectSpecifier.classOf(c) === 'folder') parent = c.name();
  } catch (e) {}
  return { account: acc, name: f.name(), id: f.id(), parent, count: f.notes.length };
}

function findFolder(name, account) {
  const all = allFolders().filter(x => !account || x.acc === account);
  const byId = all.find(x => x.f.id() === name);
  if (byId) return byId;
  const m = all.filter(x => x.f.name() === name);
  if (m.length === 1) return m[0];
  if (m.length > 1) fail(`several folders named '${name}'; pass --account or the folder id: ` + m.map(x => `${x.f.id()} (${x.acc})`).join(', '));
  fail(`folder '${name}' not found; available: ` + all.map(x => x.f.name()).join(', '));
}

function targetFolders(opts) {
  if (opts.folder) return opts.folder.split(',').map(n => findFolder(n, opts.account));
  return allFolders().filter(x => !opts.account || x.acc === opts.account);
}

// --- notes -------------------------------------------------------------------

// Bulk-fetch summaries for all notes in the given folders (one Apple event per property per folder).
function summaries(folders, withText) {
  const rows = [];
  for (const { acc, f } of folders) {
    const fname = f.name();
    const n = f.notes;
    if (n.length === 0) continue;
    const ids = n.id(), names = n.name(), mod = n.modificationDate(), cre = n.creationDate(), locked = n.passwordProtected();
    let texts = null;
    if (withText) { try { texts = n.plaintext(); } catch (e) { texts = null; } }
    for (let i = 0; i < ids.length; i++) {
      rows.push({
        id: ids[i], title: names[i], folder: fname, account: acc,
        modified: fmtDate(mod[i]), created: fmtDate(cre[i]), locked: locked[i],
        _mod: mod[i] ? mod[i].getTime() : 0,
        _text: texts && !locked[i] ? (texts[i] || '') : '',
      });
    }
  }
  rows.sort((a, b) => b._mod - a._mod);
  return rows;
}

function clean(r) { const o = Object.assign({}, r); delete o._mod; delete o._text; return o; }

function getNote(id) {
  if (!id) fail('--id is required');
  const n = Notes.notes.byId(id);
  try { n.name(); } catch (e) { fail(`note not found: ${id}`); }
  return n;
}

function noteMeta(n) {
  let folder = null;
  try { folder = n.container().name(); } catch (e) {}
  return {
    id: n.id(), title: n.name(), folder,
    modified: fmtDate(n.modificationDate()), created: fmtDate(n.creationDate()),
    locked: n.passwordProtected(), attachments: n.attachments.length,
  };
}

// Rewriting the body via scripting can lose attachments, tables, checklists and list styles.
function guardRewrite(n, opts) {
  if (n.passwordProtected()) fail('note is locked (password protected); cannot modify it');
  if (opts.force === 'true') return;
  const html = n.body();
  const risks = [];
  if (n.attachments.length) risks.push(`${n.attachments.length} attachment(s)`);
  if (/<table/i.test(html)) risks.push('a table');
  if (/<(ul|ol)\b/i.test(html)) risks.push('lists/checklists');
  if (/<img/i.test(html)) risks.push('images');
  if (risks.length) fail(`note contains ${risks.join(', ')}; rewriting the body through scripting may lose them. Ask the user, then re-run with --force if they accept.`);
}

function snippet(text, q) {
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return null;
  const s = Math.max(0, i - 40);
  return (s > 0 ? '…' : '') + text.slice(s, i + q.length + 60).replace(/\s+/g, ' ') + '…';
}

function writeFile(path, content) {
  const ok = $(content).writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, null);
  if (!ok) fail(`cannot write ${path}`);
}

// --- commands ----------------------------------------------------------------

const HELP = `agent-loft-apple notes — Apple Notes (JSON output)

  folders                                        list accounts/folders with note counts
  list    [--folder NAME[,NAME]] [--account A] [--limit N]     newest first (default limit 50)
  search  --query TEXT [--body] [--folder ..] [--account ..] [--limit N]
          (title match by default; --body also searches note text)
  read    --id ID [--format text|html|both|none]  default text; none = metadata only
  create  --title T [--body TEXT] [--html] [--folder NAME] [--account A]
  append  --id ID --body TEXT [--html] [--force]
  update  --id ID [--title T] [--body TEXT] [--html] [--force]   (--body replaces content below title)
  move    --id ID --folder NAME [--account A]
  delete  --id ID                                moves to "Recently Deleted" (recoverable ~30 days)
  create-folder --name NAME [--account A]
  export  --out DIR [--folder ..] [--account ..] writes one .html per note + index.json (backup)

Body text is plain text by default (newlines kept); pass --html to supply Notes HTML.
append/update refuse notes with attachments, tables, lists or images unless --force.`;

function run(argv) {
  const { pos, opts } = parseArgs(argv);
  const cmd = pos[0] || 'help';
  let out;
  switch (cmd) {
    case 'help': case '-h': return HELP;

    case 'folders':
      out = allFolders().map(folderInfo);
      break;

    case 'list': {
      const rows = summaries(targetFolders(opts), false);
      const lim = parseInt(opts.limit || '50', 10);
      out = { total: rows.length, notes: rows.slice(0, lim).map(clean) };
      break;
    }

    case 'search': {
      if (!opts.query) fail('--query is required');
      const q = opts.query.toLowerCase();
      const inBody = opts.body === 'true';
      const rows = summaries(targetFolders(opts), inBody).filter(r => {
        if (r.title.toLowerCase().includes(q)) return true;
        if (inBody && r._text.toLowerCase().includes(q)) { r.match = snippet(r._text, q); return true; }
        return false;
      });
      const lim = parseInt(opts.limit || '50', 10);
      out = { total: rows.length, notes: rows.slice(0, lim).map(clean) };
      break;
    }

    case 'read': {
      const n = getNote(opts.id);
      out = noteMeta(n);
      if (out.locked) { out.note = 'locked: content not readable'; break; }
      const f = opts.format || 'text';
      if (f === 'text' || f === 'both') out.text = n.plaintext();
      if (f === 'html' || f === 'both') out.html = n.body();
      break;
    }

    case 'create': {
      if (!opts.title) fail('--title is required');
      let folder;
      if (opts.folder) folder = findFolder(opts.folder, opts.account).f;
      else {
        const acc = opts.account ? Notes.accounts.byName(opts.account) : Notes.defaultAccount();
        folder = acc.defaultFolder();
      }
      const html = `<div><h1>${escapeHtml(opts.title)}</h1></div>` + bodyHtml(opts);
      const n = Notes.make({ new: 'note', at: folder, withProperties: { body: html } });
      out = { action: 'created', note: noteMeta(n) };
      break;
    }

    case 'append': {
      if (opts.body === undefined) fail('--body is required');
      const n = getNote(opts.id);
      guardRewrite(n, opts);
      n.body = n.body() + bodyHtml(opts);
      out = { action: 'appended', note: noteMeta(n) };
      break;
    }

    case 'update': {
      const n = getNote(opts.id);
      if (opts.title === undefined && opts.body === undefined) fail('pass --title and/or --body');
      guardRewrite(n, opts);
      const before = noteMeta(n);
      if (opts.body !== undefined) {
        const title = opts.title !== undefined ? opts.title : n.name();
        n.body = `<div><h1>${escapeHtml(title)}</h1></div>` + bodyHtml(opts);
      } else {
        n.name = opts.title;
      }
      out = { action: 'updated', before, after: noteMeta(n) };
      break;
    }

    case 'move': {
      if (!opts.folder) fail('--folder is required');
      const n = getNote(opts.id);
      const target = findFolder(opts.folder, opts.account).f;
      Notes.move(n, { to: target });
      out = { action: 'moved', note: noteMeta(getNote(opts.id)) };
      break;
    }

    case 'delete': {
      const n = getNote(opts.id);
      const meta = noteMeta(n);
      Notes.delete(n);
      out = { action: 'deleted', note: meta, recoverable: 'in "Recently Deleted" for ~30 days' };
      break;
    }

    case 'create-folder': {
      if (!opts.name) fail('--name is required');
      const acc = opts.account ? Notes.accounts.byName(opts.account) : Notes.defaultAccount();
      const f = Notes.make({ new: 'folder', at: acc, withProperties: { name: opts.name } });
      out = { action: 'created', folder: { name: f.name(), id: f.id(), account: acc.name() } };
      break;
    }

    case 'export': {
      if (!opts.out) fail('--out is required');
      const dir = $(opts.out).stringByExpandingTildeInPath.js;
      const fm = $.NSFileManager.defaultManager;
      const index = [];
      let skipped = 0;
      for (const { acc, f } of targetFolders(opts)) {
        const n = f.notes;
        if (n.length === 0) continue;
        const fdir = `${dir}/${acc}/${f.name().replace(/[\/:]/g, '_')}`;
        fm.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(fdir, true, $(), null);
        const ids = n.id(), names = n.name(), locked = n.passwordProtected(), mod = n.modificationDate();
        for (let i = 0; i < ids.length; i++) {
          if (locked[i]) { skipped++; continue; }
          const short = ids[i].split('/').pop();
          const file = `${fdir}/${names[i].replace(/[\/:]/g, '_').slice(0, 80)} - ${short}.html`;
          writeFile(file, Notes.notes.byId(ids[i]).body());
          index.push({ id: ids[i], title: names[i], folder: f.name(), account: acc, modified: fmtDate(mod[i]), file });
        }
      }
      writeFile(`${dir}/index.json`, JSON.stringify(index, null, 2));
      out = { action: 'exported', dir, count: index.length, skippedLocked: skipped };
      break;
    }

    default:
      fail(`unknown command '${cmd}'. Run with 'help'.`);
  }
  return JSON.stringify(out, null, 2);
}
