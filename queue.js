/*
 * Background sending engine. Used by background.js (the service worker) and by the pages.
 *
 *  - The queue lives in chrome.storage, so it survives closing the popup, a Chrome restart, etc.
 *  - A 30-second alarm wakes the worker, which sends for a few minutes at a time ("a slice").
 *  - Random delay between emails, and a daily cap, protect your Gmail account.
 *  - Every successful send is saved to history immediately, so nothing is ever sent twice.
 */

const QUEUE_ITEMS_KEY = 'queueItems';
const QUEUE_META_KEY = 'queueMeta';
const SLICE_MS = 4 * 60 * 1000;
const LOCK_MS = 90 * 1000;

const DEFAULT_QUEUE_META = {
  state: 'idle', // idle | running | paused
  nextSendAt: 0,
  lastSendAt: 0,
  lastCheckAt: 0,
  lastSyncAt: 0,
  lastBadgeAt: 0,
  lockUntil: 0,
  waitReason: '', // '' | limit | quota
  lastError: '',
  lastCheckError: ''
};

let jobCounter = 0;
function newJobId() {
  jobCounter++;
  return `${Date.now().toString(36)}${jobCounter}${Math.random().toString(36).slice(2, 6)}`;
}

function getQueueItems() {
  return new Promise((resolve) => {
    chrome.storage.local.get([QUEUE_ITEMS_KEY], (items) => resolve(items[QUEUE_ITEMS_KEY] || []));
  });
}

function setQueueItems(items) {
  return saveSettings({ [QUEUE_ITEMS_KEY]: items });
}

function getQueueMeta() {
  return new Promise((resolve) => {
    chrome.storage.local.get([QUEUE_META_KEY], (items) => resolve({ ...DEFAULT_QUEUE_META, ...(items[QUEUE_META_KEY] || {}) }));
  });
}

function patchQueueMeta(patch) {
  return withLock('queueMeta', async () => {
    const meta = await getQueueMeta();
    const next = { ...meta };
    Object.keys(patch).forEach((k) => {
      if (patch[k] !== undefined) next[k] = patch[k];
    });
    await saveSettings({ [QUEUE_META_KEY]: next });
    return next;
  });
}

function mutateQueue(fn) {
  return withLock('queue', async () => {
    const items = await getQueueItems();
    const result = await fn(items);
    await setQueueItems(items);
    return result;
  });
}

function updateJob(id, patch) {
  return mutateQueue((items) => {
    const job = items.find((j) => j.id === id);
    if (job) Object.assign(job, patch);
  });
}

/*
 * Adds jobs to the queue and starts sending. If a batch is still running the new jobs are
 * appended (addresses already waiting are not added twice); otherwise they replace the old batch.
 */
function enqueueJobs(jobs) {
  return mutateQueue(async (items) => {
    const hasPending = items.some((j) => j.status === 'Pending' || j.status === 'Sending...');
    const base = hasPending ? items.slice() : [];
    const waiting = new Set(
      base.filter((j) => j.status === 'Pending' || j.status === 'Sending...').map((j) => `${j.kind || 'new'}:${normalizeEmail(j.email)}`)
    );
    let added = 0;
    let duplicates = 0;
    jobs.forEach((job) => {
      const key = `${job.kind || 'new'}:${normalizeEmail(job.email)}`;
      if (waiting.has(key)) {
        duplicates++;
        return;
      }
      waiting.add(key);
      base.push({ ...job, id: newJobId(), kind: job.kind || 'new', status: 'Pending', error: null });
      added++;
    });
    items.length = 0;
    items.push(...base);
    if (added > 0) {
      await patchQueueMeta({ state: 'running', lastError: '', waitReason: '', nextSendAt: 0, lockUntil: 0, startedAt: hasPending ? undefined : Date.now() });
    }
    return { added, duplicates };
  });
}

function pauseQueue() {
  return patchQueueMeta({ state: 'paused' });
}

function resumeQueue() {
  return patchQueueMeta({ state: 'running', lastError: '', waitReason: '', nextSendAt: 0 });
}

function cancelRemaining() {
  return mutateQueue(async (items) => {
    let n = 0;
    items.forEach((j) => {
      if (j.status === 'Pending') {
        j.status = 'Cancelled';
        n++;
      }
    });
    await patchQueueMeta({ state: 'idle', waitReason: '', nextSendAt: 0 });
    return n;
  });
}

function countQueue(items) {
  const c = { total: items.length, pending: 0, sending: 0, sent: 0, failed: 0, skipped: 0, cancelled: 0 };
  items.forEach((j) => {
    if (j.status === 'Pending') c.pending++;
    else if (j.status === 'Sending...') c.sending++;
    else if (j.status === 'Sent') c.sent++;
    else if (j.status === 'Failed') c.failed++;
    else if (j.status === 'Cancelled') c.cancelled++;
    else c.skipped++;
  });
  return c;
}

// Contacts that were emailed, have not replied, and are past the follow-up delay.
function buildFollowUpJobs(history, settings, items, now) {
  const opts = { followUpDays: settings.followUpDays, maxFollowUps: settings.maxFollowUps, now };
  const waiting = new Set(
    (items || []).filter((j) => j.status === 'Pending' || j.status === 'Sending...').map((j) => `${j.kind}:${normalizeEmail(j.email)}`)
  );
  return Object.values(history)
    .filter((rec) => deriveStatus(rec, opts) === 'Follow-up due' && !waiting.has(`followup:${rec.email}`))
    .map((rec) => ({ kind: 'followup', email: rec.email, company: rec.company || '', fields: {}, template: '', cv: 'none' }));
}

/* ------------------------------------------------------------------ */
/* Checks: bounces + replies                                           */
/* ------------------------------------------------------------------ */

async function runChecks(token, onProgress) {
  const startedAt = Date.now();
  const history = await getSentHistory();
  const last = await getLastBounceCheck();
  const since = last ? `after:${Math.floor(last / 1000) - 86400}` : 'newer_than:90d';

  const bounceResult = await scanBounces({
    token,
    query: `from:(mailer-daemon OR postmaster) ${since}`,
    knownEmails: history,
    onProgress: (done, total) => onProgress && onProgress(`Reading bounce notices: ${done} / ${total}`)
  });
  const bounced = await markBounced(bounceResult.bounces);

  // Replies. They get their own "last checked" time (a bounce check must not shorten the reply search).
  const lastReply = await getLastReplyCheck();
  const replySince = lastReply ? `after:${Math.floor(lastReply / 1000) - 86400}` : 'newer_than:90d';
  const afterBounces = await getSentHistory();
  const threadMap = {};
  const noThread = [];
  Object.values(afterBounces).forEach((rec) => {
    if (rec.status !== 'sent' || rec.repliedAt) return;
    if (rec.threadId) threadMap[rec.threadId] = rec.email;
    else noThread.push(rec.email);
  });

  let replyToken = bounceResult.token;
  let replied = 0;
  let repliesScanned = 0;
  if (Object.keys(threadMap).length > 0) {
    const byThread = await scanReplies({
      token: replyToken,
      query: `${replySince} -from:me -from:(mailer-daemon OR postmaster)`,
      threadMap,
      onProgress: (n) => onProgress && onProgress(`Looking for replies: ${n} messages`)
    });
    replyToken = byThread.token;
    repliesScanned = byThread.scanned;
    replied += await markReplied(byThread.replies);
  }
  if (noThread.length > 0) {
    const byAddress = await scanRepliesByAddress({
      token: replyToken,
      addresses: noThread,
      since: replySince,
      onProgress: (done, total) => onProgress && onProgress(`Looking for replies from older emails: ${done} / ${total}`)
    });
    replied += await markReplied(byAddress.replies);
  }
  await setLastReplyCheck(startedAt);

  await setLastBounceCheck(startedAt);
  await patchQueueMeta({ lastCheckAt: startedAt, lastCheckError: '' });
  return { bounced, replied, scanned: bounceResult.scanned, repliesScanned };
}

// When should the background worker look for bounces / replies on its own?
function shouldCheckNow(meta, now) {
  if (!meta.lastSendAt) return false;
  const lastCheck = meta.lastCheckAt || 0;
  const sinceSend = now - meta.lastSendAt;
  // 5 minutes after the last email, once. (Bounces usually arrive within minutes.)
  if (lastCheck < meta.lastSendAt && sinceSend >= 5 * 60000) return true;
  // Then every 3 hours for 3 days, to catch slow bounces and new replies. During a very long
  // batch the clock starts when the batch started, so results appear while it is still running.
  const reference = lastCheck || meta.startedAt || meta.lastSendAt;
  if (sinceSend < 72 * 3600000 && now - reference >= 3 * 3600000) return true;
  return false;
}

function shouldSyncNow(meta, settings, now) {
  if (!settings.autoSync || !meta.lastSendAt) return false;
  return meta.lastSendAt > (meta.lastSyncAt || 0) && now - meta.lastSendAt >= 5 * 60000 && now - (meta.lastSyncAt || 0) >= 30 * 60000;
}

/* ------------------------------------------------------------------ */
/* Sending one job                                                     */
/* ------------------------------------------------------------------ */

async function sendJob(job, ctx) {
  const { settings, userEmail, history } = ctx;
  let token = ctx.token;

  if (job.kind === 'followup') {
    const rec = history[normalizeEmail(job.email)];
    let inReplyTo = '';
    let original = rec.subject || 'my application';
    if (rec.messageId) {
      try {
        const info = await getMessageThreadInfo(token, rec.messageId);
        token = info.token;
        inReplyTo = info.messageIdHeader;
        if (info.subject) original = info.subject;
      } catch (err) {
        /* send it as a normal email if the original cannot be read */
      }
    }
    const baseSubject = original.replace(/^\s*(re:\s*)+/i, '');
    const days = Math.max(1, Math.round((ctx.now - Date.parse(rec.sentAt || 0)) / 86400000));
    const vars = { company: rec.company || job.company, name: settings.senderName || '', email: rec.email, days, originalSubject: baseSubject };
    const missing = findMissingPlaceholders(settings.followUpTemplate, vars);
    if (missing.length) throw new Error(`Follow-up template uses an unknown field: ${missing.join(', ')}`);
    const subject = `Re: ${baseSubject}`;
    const result = await sendEmailWithRetry({
      token,
      fromEmail: userEmail,
      senderName: settings.senderName,
      toEmail: rec.email,
      subject,
      bodyText: renderTemplate(settings.followUpTemplate, vars),
      attachment: null,
      inReplyTo: inReplyTo || undefined,
      threadId: inReplyTo && rec.threadId ? rec.threadId : undefined,
      interactive: false
    });
    return { token: result.token, data: result.data, subject };
  }

  const template = findByName(settings.templates, job.template);
  if (!template) throw new Error(`Unknown template "${job.template}"`);
  let cv = null;
  if (String(job.cv || '').toLowerCase() !== 'none') {
    cv = findByName(settings.cvs, job.cv);
    if (!cv) throw new Error(`Unknown CV "${job.cv}"`);
  }
  const vars = { ...job.fields, company: job.company, name: settings.senderName || '', email: job.email };
  const missing = findMissingPlaceholders(`${template.subject}\n${template.body}`, vars);
  if (missing.length) throw new Error(`Missing field: ${missing.join(', ')}`);
  const subject = renderTemplate(template.subject, vars);
  const result = await sendEmailWithRetry({
    token,
    fromEmail: userEmail,
    senderName: settings.senderName,
    toEmail: job.email,
    subject,
    bodyText: renderTemplate(template.body, vars),
    attachment: attachmentFromCv(cv),
    interactive: false
  });
  return { token: result.token, data: result.data, subject };
}

/*
 * Sends for up to env.sliceMs, then returns. The alarm calls it again.
 * env: { now(), sleep(ms), getToken(), sliceMs, random() }
 */
async function processQueueSlice(env) {
  const startedAt = env.now();
  let meta = await getQueueMeta();
  if (meta.state !== 'running') return { ran: false };
  if (meta.lockUntil > env.now()) return { ran: false, locked: true };

  await patchQueueMeta({ lockUntil: env.now() + LOCK_MS });
  const result = { ran: true, sent: 0, failed: 0, skipped: 0, finished: false };

  try {
    // A job still marked "Sending..." belongs to a worker that was killed mid-send. We cannot know
    // whether it left, so it is NOT retried (that could mean a double send).
    await mutateQueue((items) => {
      items.forEach((j) => {
        if (j.status === 'Sending...') {
          j.status = 'Failed';
          j.error = 'Interrupted while sending. Check your Gmail Sent folder before retrying.';
        }
      });
    });

    let token = null;
    for (;;) {
      meta = await getQueueMeta();
      if (meta.state !== 'running') break;
      if (env.now() >= startedAt + env.sliceMs) break;
      await patchQueueMeta({ lockUntil: env.now() + LOCK_MS });

      const items = await getQueueItems();
      const job = items.find((j) => j.status === 'Pending');
      if (!job) {
        await patchQueueMeta({ state: 'idle', waitReason: '', nextSendAt: 0 });
        result.finished = true;
        break;
      }

      const settings = await getSettingsResolved();
      if (settings.dailyLimit > 0 && (await getSentToday()) >= settings.dailyLimit) {
        if (meta.waitReason !== 'limit') await patchQueueMeta({ waitReason: 'limit' });
        break; // checked again by every alarm; continues by itself tomorrow or if you raise the limit
      }
      if (meta.waitReason === 'limit') await patchQueueMeta({ waitReason: '' });

      if (meta.nextSendAt > env.now()) {
        const wait = meta.nextSendAt - env.now();
        if (env.now() + wait > startedAt + env.sliceMs) break; // the next alarm picks it up
        await env.sleep(wait);
        continue;
      }

      if (!token) {
        try {
          token = await env.getToken();
        } catch (err) {
          await patchQueueMeta({ state: 'paused', lastError: 'Gmail is not connected. Open the extension, click Connect Gmail, then press Resume.' });
          break;
        }
      }

      const history = await getSentHistory();
      const key = normalizeEmail(job.email);
      const rec = history[key];
      if (job.kind === 'followup') {
        if (!rec || rec.status !== 'sent' || rec.repliedAt) {
          await updateJob(job.id, { status: 'Skipped', error: rec && rec.repliedAt ? 'They already replied' : 'No longer eligible for a follow-up' });
          result.skipped++;
          continue;
        }
      } else {
        const blocked = historyBlock(rec);
        if (blocked) {
          await updateJob(job.id, { status: blocked.status, error: blocked.error });
          result.skipped++;
          continue;
        }
      }

      await updateJob(job.id, { status: 'Sending...', error: null });
      let sent = null;
      try {
        sent = await sendJob(job, { settings, token, userEmail: await getUserEmail(), history, now: env.now() });
        token = sent.token;
      } catch (err) {
        if (err.isQuota) {
          await updateJob(job.id, { status: 'Pending' });
          await patchQueueMeta({ waitReason: 'quota', nextSendAt: env.now() + 60 * 60000, lastError: `${err.message} Will retry in 1 hour.` });
          break;
        }
        if (err.isAuth) {
          await updateJob(job.id, { status: 'Pending' });
          await patchQueueMeta({ state: 'paused', lastError: 'Gmail needs to be reconnected. Open the extension, click Connect Gmail, then press Resume.' });
          break;
        }
        await updateJob(job.id, { status: 'Failed', error: err.message || 'Unknown error' });
        result.failed++;
        continue;
      }

      // Save to history FIRST, then mark the job. If we die in between, history still protects against a re-send.
      try {
        if (job.kind === 'followup') {
          await recordFollowUp(job.email);
        } else {
          await addSentRecord(job.email, job.company, {
            threadId: sent.data && sent.data.threadId,
            messageId: sent.data && sent.data.id,
            subject: sent.subject,
            template: job.template,
            cv: job.cv
          });
        }
      } catch (err) {
        await patchQueueMeta({ lastError: `Sent to ${job.email}, but saving history failed: ${err.message}` });
      }
      await bumpSentToday();
      await updateJob(job.id, { status: 'Sent', error: null, sentAt: new Date(env.now()).toISOString() });

      const span = Math.max(0, settings.delayMax - settings.delayMin);
      const delayMs = Math.round((settings.delayMin + span * env.random()) * 1000);
      await patchQueueMeta({ lastSendAt: env.now(), nextSendAt: env.now() + delayMs, waitReason: '', lastError: '' });
      result.sent++;
    }
  } finally {
    await patchQueueMeta({ lockUntil: 0 });
  }
  return result;
}

/*
 * One wake-up of the background worker: auto-check bounces/replies, auto-sync, send a slice,
 * and refresh the follow-up badge. env also has setBadge(text).
 */
async function runTick(env) {
  const settings = await getSettingsResolved();
  let meta = await getQueueMeta();
  const now = env.now();
  const outcome = { checked: false, synced: false };

  if (settings.autoCheck && shouldCheckNow(meta, now)) {
    try {
      await runChecks(await env.getToken());
      outcome.checked = true;
    } catch (err) {
      await patchQueueMeta({ lastCheckAt: now, lastCheckError: err.message || 'Check failed' });
    }
  }

  outcome.slice = await processQueueSlice(env);

  meta = await getQueueMeta();
  if (shouldSyncNow(meta, settings, env.now())) {
    try {
      const sync = await syncHistoryWithDrive(false);
      await patchQueueMeta({ lastSyncAt: sync.at });
      outcome.synced = true;
    } catch (err) {
      await patchQueueMeta({ lastSyncAt: env.now(), lastError: meta.lastError });
    }
  }

  if (env.setBadge && env.now() - (meta.lastBadgeAt || 0) >= 10 * 60000) {
    const due = countFollowUpsDue(await getSentHistory(), settings, env.now());
    env.setBadge(due > 0 ? String(due) : '');
    await patchQueueMeta({ lastBadgeAt: env.now() });
  }
  return outcome;
}
