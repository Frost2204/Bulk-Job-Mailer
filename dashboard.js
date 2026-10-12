const els = {};
let rows = [];
let visibleLimit = 300;
let refreshTimer = null;
let busy = false;

function $(id) {
  return document.getElementById(id);
}

function showNotification(message, type) {
  els.notification.textContent = message;
  els.notification.className = `notification ${type}`;
}

function clearNotification() {
  els.notification.className = 'notification hidden';
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function kick() {
  try {
    chrome.runtime.sendMessage({ type: 'kick' }, () => void chrome.runtime.lastError);
  } catch (err) {
    /* alarm wakes the worker anyway */
  }
}

// One table row per contact: history records first, then queue entries that are not in history yet.
function buildRows(history, items, settings) {
  const opts = { followUpDays: settings.followUpDays, maxFollowUps: settings.maxFollowUps, now: Date.now() };
  const queued = new Map();
  items.forEach((j) => {
    const key = normalizeEmail(j.email);
    if (j.status === 'Pending' || j.status === 'Sending...') queued.set(`${j.kind}:${key}`, j);
  });

  const out = Object.values(history).map((rec) => {
    const status = deriveStatus(rec, opts);
    const pendingFollowUp = queued.get(`followup:${rec.email}`);
    let note = '';
    if (rec.status === 'bounced') note = rec.bounceReason === 'address_not_found' ? 'Address does not exist' : 'Delivery failed';
    else if (rec.repliedAt) note = `Replied ${fmtDate(rec.repliedAt)}`;
    if (pendingFollowUp) note = 'Follow-up queued';
    return {
      email: rec.email,
      company: rec.company || '',
      status,
      group: status,
      sentAt: rec.sentAt,
      lastContact: rec.lastFollowUpAt || rec.sentAt,
      followUps: rec.followUpCount || 0,
      note,
      rec
    };
  });

  items.forEach((j) => {
    if (j.kind === 'followup' || history[normalizeEmail(j.email)]) return;
    if (j.status === 'Sent') return;
    const label = j.status === 'Sending...' ? 'Sending' : j.status === 'Pending' ? 'Queued' : j.status;
    out.push({
      email: j.email,
      company: j.company || '',
      status: label,
      group: label === 'Failed' ? 'Failed' : 'Queued',
      sentAt: null,
      lastContact: null,
      followUps: 0,
      note: j.error || '',
      rec: null
    });
  });

  out.sort((a, b) => String(b.lastContact || '').localeCompare(String(a.lastContact || '')));
  return out;
}

function pillClass(status) {
  if (status === 'Follow-up due') return 'due';
  if (status === 'Followed up') return 'Followed';
  if (status === 'No reply') return 'Noreply';
  if (status === 'Sending') return 'Queued';
  if (status === 'Cancelled' || status === 'Skipped') return 'Noreply';
  return status.replace(/\W/g, '');
}

function matchesFilter(row, filter) {
  if (filter === 'all') return true;
  if (filter === 'Queued') return row.group === 'Queued' || row.group === 'Failed';
  return row.status === filter;
}

function renderRows() {
  const filter = els.filterSelect.value;
  const q = els.searchInput.value.trim().toLowerCase();
  const filtered = rows.filter((r) => matchesFilter(r, filter) && (!q || r.email.includes(q) || r.company.toLowerCase().includes(q)));

  els.tbody.innerHTML = '';
  const fragment = document.createDocumentFragment();
  filtered.slice(0, visibleLimit).forEach((r) => {
    const tr = document.createElement('tr');
    const cell = (text, cls) => {
      const td = document.createElement('td');
      td.textContent = text;
      if (cls) td.className = cls;
      return td;
    };
    const statusTd = document.createElement('td');
    const pill = document.createElement('span');
    pill.className = `pill ${pillClass(r.status)}`;
    pill.textContent = r.status;
    statusTd.appendChild(pill);
    tr.append(cell(r.company || '-'), cell(r.email), statusTd, cell(fmtDate(r.sentAt), 'muted'), cell(fmtDate(r.lastContact), 'muted'), cell(r.followUps ? String(r.followUps) : '', 'muted'), cell(r.note, 'muted'));
    fragment.appendChild(tr);
  });
  els.tbody.appendChild(fragment);
  els.emptyText.classList.toggle('hidden', filtered.length > 0);
  els.moreBtn.classList.toggle('hidden', filtered.length <= visibleLimit);
  els.moreBtn.textContent = `Show more (${filtered.length - visibleLimit} left)`;
}

function renderStats(history, items, settings, sentToday, meta) {
  const opts = { followUpDays: settings.followUpDays, maxFollowUps: settings.maxFollowUps, now: Date.now() };
  const records = Object.values(history);
  const statuses = records.map((r) => deriveStatus(r, opts));
  const count = (s) => statuses.filter((x) => x === s).length;
  const c = countQueue(items);
  const cards = [
    ['Contacted', records.length, ''],
    ['Replied', count('Replied'), 'replied'],
    ['Waiting for reply', count('Sent') + count('Followed up'), ''],
    ['Follow-up due', count('Follow-up due'), 'due'],
    ['Bounced', count('Bounced'), 'bounced'],
    [`Sent today${settings.dailyLimit ? ` (limit ${settings.dailyLimit})` : ''}`, sentToday, '']
  ];
  els.stats.innerHTML = '';
  cards.forEach(([label, num, cls]) => {
    const div = document.createElement('div');
    div.className = `stat ${cls}`;
    const n = document.createElement('div');
    n.className = 'num';
    n.textContent = String(num);
    const l = document.createElement('div');
    l.className = 'label';
    l.textContent = label;
    div.append(n, l);
    els.stats.appendChild(div);
  });

  const waiting = c.pending + c.sending;
  els.queueBadge.classList.toggle('hidden', c.total === 0);
  let text = `Queue: ${c.sent} sent, ${waiting} waiting${c.failed ? `, ${c.failed} failed` : ''}`;
  if (meta.state === 'paused') text += ' (paused)';
  else if (waiting > 0 && meta.waitReason === 'limit') text += ' (daily limit reached, continues tomorrow)';
  els.queueBadge.textContent = text;
  els.progressText.textContent = meta.lastError || '';

  els.pauseBtn.classList.toggle('hidden', !(meta.state === 'running' && waiting > 0));
  els.resumeBtn.classList.toggle('hidden', !(meta.state !== 'running' && waiting > 0));
  els.checkBtn.disabled = busy;
  els.syncBtn.disabled = busy;

  const due = count('Follow-up due');
  els.followUpBtn.disabled = busy || due === 0 || settings.maxFollowUps === 0;
  els.followUpBtn.textContent = due ? `Queue ${due} follow-up(s)` : 'Queue follow-ups';
}

async function refresh() {
  const [history, items, settings, sentToday, meta] = await Promise.all([
    getSentHistory(), getQueueItems(), getSettingsResolved(), getSentToday(), getQueueMeta()
  ]);
  rows = buildRows(history, items, settings);
  renderStats(history, items, settings, sentToday, meta);
  renderRows();
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 300);
}

/* ---- actions ---- */

async function withBusy(fn) {
  busy = true;
  clearNotification();
  await refresh();
  try {
    await fn();
  } catch (err) {
    showNotification(err.message || 'Something went wrong.', 'error');
  } finally {
    busy = false;
    els.progressText.textContent = '';
    await refresh();
  }
}

function handleCheck() {
  return withBusy(async () => {
    const token = await getAuthToken(true);
    const result = await runChecks(token, (text) => {
      els.progressText.textContent = text;
    });
    const found = [];
    if (result.bounced) found.push(`${result.bounced} new bounce(s)`);
    if (result.replied) found.push(`${result.replied} new repl${result.replied === 1 ? 'y' : 'ies'}`);
    showNotification(found.length ? `Found ${found.join(' and ')}.` : 'Nothing new. Bounces can take a few minutes to arrive.', found.length ? 'success' : 'info');
  });
}

function handleFollowUps() {
  return withBusy(async () => {
    const [history, items, settings] = await Promise.all([getSentHistory(), getQueueItems(), getSettingsResolved()]);
    const jobs = buildFollowUpJobs(history, settings, items, Date.now());
    if (jobs.length === 0) {
      showNotification('No follow-ups are due.', 'info');
      return;
    }
    const ok = window.confirm(`Queue ${jobs.length} follow-up email(s)? They are sent in the same Gmail thread. Anyone who replied or bounced is skipped automatically.`);
    if (!ok) return;
    const result = await enqueueJobs(jobs);
    kick();
    showNotification(`Queued ${result.added} follow-up(s). Sending continues in the background.`, 'success');
  });
}

function handleSync() {
  return withBusy(async () => {
    const result = await syncHistoryWithDrive(true);
    await patchQueueMeta({ lastSyncAt: result.at });
    showNotification(`Synced. ${result.total} contact(s) in history (${result.addedFromDrive} new from Google Drive).`, 'success');
  });
}

async function handlePause() {
  await pauseQueue();
  await refresh();
}

async function handleResume() {
  await resumeQueue();
  kick();
  await refresh();
}

// CSV that opens correctly in Excel (UTF-8 BOM). Cells starting with = + - @ are neutralised.
function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function buildCsv(allRows) {
  const header = ['Email', 'Company', 'Status', 'First sent', 'Last follow-up', 'Follow-ups sent', 'Replied at', 'Bounced at', 'Bounce reason', 'Template', 'CV', 'Note'];
  const lines = [header.map(csvCell).join(',')];
  allRows.forEach((r) => {
    const rec = r.rec || {};
    lines.push(
      [r.email, r.company, r.status, rec.sentAt || '', rec.lastFollowUpAt || '', r.followUps || 0, rec.repliedAt || '', rec.bouncedAt || '', rec.bounceReason || '', rec.template || '', rec.cv || '', r.note]
        .map(csvCell)
        .join(',')
    );
  });
  return `\uFEFF${lines.join('\r\n')}`;
}

function handleCsv() {
  const filter = els.filterSelect.value;
  const q = els.searchInput.value.trim().toLowerCase();
  const list = rows.filter((r) => matchesFilter(r, filter) && (!q || r.email.includes(q) || r.company.toLowerCase().includes(q)));
  if (list.length === 0) {
    showNotification('Nothing to download for this filter.', 'info');
    return;
  }
  const blob = new Blob([buildCsv(list)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `job-mailer-${todayKey()}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  showNotification(`Downloaded ${list.length} row(s). Opens in Excel or Google Sheets.`, 'success');
}

async function init() {
  ['notification', 'stats', 'searchInput', 'filterSelect', 'checkBtn', 'followUpBtn', 'pauseBtn', 'resumeBtn', 'syncBtn', 'csvBtn',
    'progressText', 'tbody', 'emptyText', 'moreBtn', 'queueBadge'].forEach((id) => {
    els[id] = $(id);
  });
  els.searchInput.addEventListener('input', () => {
    visibleLimit = 300;
    renderRows();
  });
  els.filterSelect.addEventListener('change', () => {
    visibleLimit = 300;
    renderRows();
  });
  els.moreBtn.addEventListener('click', () => {
    visibleLimit += 500;
    renderRows();
  });
  els.checkBtn.addEventListener('click', handleCheck);
  els.followUpBtn.addEventListener('click', handleFollowUps);
  els.syncBtn.addEventListener('click', handleSync);
  els.csvBtn.addEventListener('click', handleCsv);
  els.pauseBtn.addEventListener('click', handlePause);
  els.resumeBtn.addEventListener('click', handleResume);
  if (chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area && area !== 'local') return;
      if (changes.sentHistory || changes.queueItems || changes.queueMeta || changes.sentToday) scheduleRefresh();
    });
  }
  await refresh();
}

document.addEventListener('DOMContentLoaded', init);
