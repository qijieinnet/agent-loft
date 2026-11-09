// Apple Mail via JXA, run by Agent Loft Bridge: osascript -l JavaScript mail.js <cmd> [--opts]
// 只读邮件、起草（存进草稿箱）。不发送、不删除、不移动。
// Output is JSON on stdout; errors are JSON on stderr with exit code 1.
ObjC.import('Foundation');
ObjC.import('stdlib');

const Mail = Application('Mail');

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
function parseDay(s) {
  const t = { today: 0, yesterday: -1 }[s];
  const d = t !== undefined ? new Date() : new Date(s.replace(' ', 'T'));
  if (isNaN(d)) fail(`cannot parse date '${s}'; use YYYY-MM-DD, today or yesterday`);
  if (t !== undefined) { d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + t); }
  else if (!/\d:\d/.test(s)) d.setHours(0, 0, 0, 0);
  return d;
}

// --- 邮箱 --------------------------------------------------------------------

function accounts() {
  return Mail.accounts().filter(a => { try { return a.enabled(); } catch (e) { return true; } });
}

function mailboxPath(mb) {
  const names = [];
  let cur = mb;
  for (let i = 0; i < 10; i++) {
    try {
      names.unshift(cur.name());
      const c = cur.container();
      if (ObjectSpecifier.classOf(c) !== 'mailbox') break;
      cur = c;
    } catch (e) { break; }
  }
  return names.join('/');
}

function inboxOf(acc) {
  for (const mb of acc.mailboxes()) {
    const n = mb.name();
    if (/^(inbox|收件箱)$/i.test(n)) return mb;
  }
  return null;
}

function findMailbox(name, accountName) {
  const accs = accounts().filter(a => !accountName || a.name() === accountName);
  if (!accs.length) fail(`account '${accountName}' not found; available: ` + accounts().map(a => a.name()).join(', '));
  const found = [];
  for (const a of accs) {
    for (const mb of a.mailboxes()) {
      const p = mailboxPath(mb);
      if (p === name || mb.name() === name) found.push({ acc: a, mb });
    }
  }
  if (found.length === 1) return found[0];
  if (found.length > 1) fail(`several mailboxes named '${name}'; pass --account: ` + found.map(x => x.acc.name()).join(', '));
  fail(`mailbox '${name}' not found`);
}

/** 要搜的邮箱：给了 --mailbox 就是那个，否则所有账户的收件箱 */
function targets(opts) {
  if (opts.mailbox) return [findMailbox(opts.mailbox, opts.account)];
  const out = [];
  for (const a of accounts().filter(a => !opts.account || a.name() === opts.account)) {
    const mb = inboxOf(a);
    if (mb) out.push({ acc: a, mb });
  }
  if (!out.length) fail('no inbox found' + (opts.account ? ` for account '${opts.account}'` : ''));
  return out;
}

// 邮件 id：账户 / 邮箱路径 / 邮件编号，读的时候按这个找回来
function msgId(accName, path, id) { return `${accName}\u001f${path}\u001f${id}`; }
function parseMsgId(s) {
  const p = String(s || '').split('\u001f');
  if (p.length !== 3 || !/^\d+$/.test(p[2])) fail('invalid message id; use an id from search / list results');
  return { acc: p[0], path: p[1], id: Number(p[2]) };
}
function getMessage(s) {
  const { acc, path, id } = parseMsgId(s);
  const a = accounts().find(x => x.name() === acc);
  if (!a) fail(`account '${acc}' not found`);
  const mb = a.mailboxes().find(m => mailboxPath(m) === path);
  if (!mb) fail(`mailbox '${path}' not found`);
  const m = mb.messages.byId(id);
  try { m.subject(); } catch (e) { fail('message not found (it may have been moved or deleted)'); }
  return { acc: a, mb, path, m };
}

function summary(accName, path, m) {
  return {
    id: msgId(accName, path, m.id()),
    subject: m.subject(),
    from: m.sender(),
    date: fmtDate(m.dateReceived()),
    read: m.readStatus(),
    flagged: m.flaggedStatus(),
    account: accName,
    mailbox: path,
  };
}

// --- 命令 --------------------------------------------------------------------

const HELP = `Agent Loft Bridge mail — Apple Mail (JSON output; read & draft only, never sends)

  accounts                                       accounts and their mailboxes
  search  [--query TEXT] [--from TEXT] [--mailbox PATH] [--account A] [--since D] [--unread] [--limit N]
          newest first; default: inboxes of all accounts, limit 20. --query matches the subject
  read    --id ID [--max-chars N]                plain-text content (default first 20000 chars)
  draft   --to A[,B] [--cc ..] [--bcc ..] --subject S --body TEXT [--account A]
          saves to Drafts; the user sends it from Mail themselves`;

function run(argv) {
  const { pos, opts } = parseArgs(argv);
  const cmd = pos[0] || 'help';
  let out;
  switch (cmd) {
    case 'help': case '-h': return HELP;

    case 'accounts':
      out = accounts().map(a => ({
        name: a.name(),
        emails: (() => { try { return a.emailAddresses(); } catch (e) { return []; } })(),
        mailboxes: a.mailboxes().map(mb => ({ path: mailboxPath(mb), unread: mb.unreadCount() })),
      }));
      break;

    case 'search': {
      const lim = Math.min(100, parseInt(opts.limit || '20', 10));
      const since = opts.since ? parseDay(opts.since) : null;
      const rows = [];
      for (const { acc, mb } of targets(opts)) {
        const accName = acc.name(), path = mailboxPath(mb);
        const cond = [];
        if (opts.query) cond.push({ subject: { _contains: opts.query } });
        if (opts.from) cond.push({ sender: { _contains: opts.from } });
        if (opts.unread === 'true') cond.push({ readStatus: false });
        if (since) cond.push({ dateReceived: { _greaterThanEquals: since } });
        const list = cond.length ? mb.messages.whose(cond.length === 1 ? cond[0] : { _and: cond }) : mb.messages;
        // 一次取一列，比一封一封问快得多
        let ids, dates;
        try { ids = list.id(); dates = list.dateReceived(); } catch (e) { continue; }
        for (let i = 0; i < ids.length; i++) rows.push({ accName, path, mb, id: ids[i], t: dates[i] ? dates[i].getTime() : 0 });
      }
      rows.sort((a, b) => b.t - a.t);
      out = { total: rows.length, messages: rows.slice(0, lim).map(r => summary(r.accName, r.path, r.mb.messages.byId(r.id))) };
      break;
    }

    case 'read': {
      if (!opts.id) fail('--id is required');
      const { acc, path, m } = getMessage(opts.id);
      const max = parseInt(opts['max-chars'] || '20000', 10);
      const content = m.content() || '';
      out = Object.assign(summary(acc.name(), path, m), {
        to: m.toRecipients().map(r => r.address()),
        cc: m.ccRecipients().map(r => r.address()),
        replyTo: m.replyTo(),
        attachments: (() => { try { return m.mailAttachments().map(x => x.name()); } catch (e) { return []; } })(),
        content: content.slice(0, max),
        truncated: content.length > max,
      });
      break;
    }

    case 'draft': {
      if (!opts.to) fail('--to is required');
      if (opts.subject === undefined) fail('--subject is required');
      const props = { subject: opts.subject, content: opts.body || '', visible: false };
      if (opts.account) {
        const a = accounts().find(x => x.name() === opts.account);
        if (!a) fail(`account '${opts.account}' not found`);
        const emails = a.emailAddresses();
        if (emails.length) props.sender = emails[0];
      }
      const msg = Mail.OutgoingMessage(props);
      Mail.outgoingMessages.push(msg);
      const add = (list, kind) => {
        for (const addr of String(list || '').split(',').map(s => s.trim()).filter(Boolean)) {
          const r = kind === 'to' ? Mail.ToRecipient({ address: addr }) : kind === 'cc' ? Mail.CcRecipient({ address: addr }) : Mail.BccRecipient({ address: addr });
          (kind === 'to' ? msg.toRecipients : kind === 'cc' ? msg.ccRecipients : msg.bccRecipients).push(r);
        }
      };
      add(opts.to, 'to'); add(opts.cc, 'cc'); add(opts.bcc, 'bcc');
      msg.save();
      // 存好后关掉这个（看不见的）撰写窗口，草稿留在草稿箱里
      try { msg.close({ saving: 'yes' }); } catch (e) {}
      out = { action: 'drafted', subject: opts.subject, to: opts.to, note: 'saved to Drafts; not sent. The user can review and send it from Mail.' };
      break;
    }

    default:
      fail(`unknown command '${cmd}'. Run with 'help'.`);
  }
  return JSON.stringify(out, null, 2);
}
