const STORAGE_KEYS = {
  SENDER_NAME: 'senderName',
  DEFAULT_SUBJECT: 'defaultSubject',
  DEFAULT_TEMPLATE: 'defaultTemplate',
  CV_NAME: 'cvName',
  CV_DATA: 'cvData',
  SEND_DELAY_SECONDS: 'sendDelaySeconds',
  USER_EMAIL: 'userEmail',
  AUTO_EXPORT: 'autoExportHistory',
  TEMPLATES: 'templates',
  CVS: 'cvs',
  DAILY_LIMIT: 'dailyLimit',
  DELAY_MIN: 'delayMinSeconds',
  DELAY_MAX: 'delayMaxSeconds',
  FOLLOW_UP_DAYS: 'followUpDays',
  MAX_FOLLOW_UPS: 'maxFollowUps',
  FOLLOW_UP_TEMPLATE: 'followUpTemplate',
  AUTO_CHECK: 'autoCheck',
  AUTO_SYNC: 'autoSync',
  VERIFY_DOMAINS: 'verifyDomains'
};

const DEFAULT_FOLLOW_UP_TEMPLATE =
  'Dear {{company}} Hiring Team,\n\n' +
  'I am following up on my application sent {{days}} days ago. I remain very interested in the opportunity ' +
  'and would be glad to share any further details or a portfolio of my work.\n\n' +
  'Thank you for your time.\n\n' +
  'Best regards,\n{{name}}';

const DEFAULT_SETTINGS = {
  [STORAGE_KEYS.SENDER_NAME]: '',
  [STORAGE_KEYS.DEFAULT_SUBJECT]: 'Application for Unity Developer Position',
  [STORAGE_KEYS.DEFAULT_TEMPLATE]:
    'Dear {{company}} Hiring Team,\n\n' +
    'I am writing to express my interest in a Unity Developer position at {{company}}.\n\n' +
    'I have 1.5+ years of hands-on experience in Unity and C#, developing and deploying casual Android and WebGL games.\n\n' +
    'Best regards,\n{{name}}',
  [STORAGE_KEYS.CV_NAME]: '',
  [STORAGE_KEYS.CV_DATA]: '',
  [STORAGE_KEYS.SEND_DELAY_SECONDS]: 5,
  [STORAGE_KEYS.AUTO_EXPORT]: true,
  [STORAGE_KEYS.TEMPLATES]: [],
  [STORAGE_KEYS.CVS]: [],
  [STORAGE_KEYS.DAILY_LIMIT]: 400,
  [STORAGE_KEYS.DELAY_MIN]: 20,
  [STORAGE_KEYS.DELAY_MAX]: 60,
  [STORAGE_KEYS.FOLLOW_UP_DAYS]: 5,
  [STORAGE_KEYS.MAX_FOLLOW_UPS]: 1,
  [STORAGE_KEYS.FOLLOW_UP_TEMPLATE]: DEFAULT_FOLLOW_UP_TEMPLATE,
  [STORAGE_KEYS.AUTO_CHECK]: true,
  [STORAGE_KEYS.AUTO_SYNC]: false,
  [STORAGE_KEYS.VERIFY_DOMAINS]: true
};

function getSettings() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(DEFAULT_SETTINGS, (items) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(items);
    });
  });
}

function saveSettings(partialSettings) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(partialSettings, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function removeStorageKeys(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(keys, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function clearSettings() {
  const keysToRemove = Object.values(STORAGE_KEYS).filter((key) => key !== STORAGE_KEYS.USER_EMAIL);
  return removeStorageKeys(keysToRemove);
}

function getUserEmail() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([STORAGE_KEYS.USER_EMAIL], (items) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(items[STORAGE_KEYS.USER_EMAIL] || '');
    });
  });
}

function setUserEmail(email) {
  return saveSettings({ [STORAGE_KEYS.USER_EMAIL]: email });
}

function clearUserEmail() {
  return removeStorageKeys([STORAGE_KEYS.USER_EMAIL]);
}

/* ------------------------------------------------------------------ */
/* Settings with templates / CVs resolved                              */
/* Older versions stored a single template and a single CV; they are   */
/* shown as the "default" entry until the person saves new settings.   */
/* ------------------------------------------------------------------ */

function toNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

async function getSettingsResolved() {
  const s = await getSettings();

  const templates =
    Array.isArray(s.templates) && s.templates.length
      ? s.templates
      : [{ id: 'default', name: 'default', subject: s.defaultSubject, body: s.defaultTemplate }];

  const cvs =
    Array.isArray(s.cvs) && s.cvs.length
      ? s.cvs
      : s.cvName && s.cvData
        ? [{ id: 'default', name: 'default', fileName: s.cvName, data: s.cvData }]
        : [];

  const delayMin = Math.max(0, toNumber(s.delayMinSeconds, 20));
  const delayMax = Math.max(delayMin, toNumber(s.delayMaxSeconds, delayMin));

  return {
    ...s,
    templates,
    cvs,
    delayMin,
    delayMax,
    dailyLimit: Math.max(0, toNumber(s.dailyLimit, 400)),
    followUpDays: Math.max(1, toNumber(s.followUpDays, 5)),
    maxFollowUps: Math.max(0, toNumber(s.maxFollowUps, 1))
  };
}

// Finds a template/CV by its name or id (case-insensitive). No name = the first one (the default).
function findByName(list, name) {
  if (!list || list.length === 0) return null;
  if (name === undefined || name === null || String(name).trim() === '') return list[0];
  const wanted = String(name).trim().toLowerCase();
  return list.find((item) => String(item.name).toLowerCase() === wanted || String(item.id).toLowerCase() === wanted) || null;
}

function attachmentFromCv(cv) {
  if (!cv || !cv.data) return null;
  const commaIndex = cv.data.indexOf(',');
  return {
    fileName: cv.fileName || 'CV.pdf',
    mimeType: 'application/pdf',
    base64Data: commaIndex >= 0 ? cv.data.substring(commaIndex + 1) : cv.data
  };
}

/* ------------------------------------------------------------------ */
/* Locks. Pages and the background worker can both write to storage;   */
/* a lock makes every read-modify-write safe so nothing is lost.       */
/* ------------------------------------------------------------------ */

const lockChains = {};

function withLock(name, fn) {
  if (typeof navigator !== 'undefined' && navigator.locks && navigator.locks.request) {
    return navigator.locks.request(name, () => fn());
  }
  const previous = lockChains[name] || Promise.resolve();
  const run = previous.then(() => fn());
  lockChains[name] = run.catch(() => {});
  return run;
}

/* ------------------------------------------------------------------ */
/* Sent history                                                        */
/* Shape: { "hr@x.com": { email, company, status, sentAt, ... } }      */
/* Stored under its own key so "Clear Settings" never wipes it.        */
/* ------------------------------------------------------------------ */

const HISTORY_KEY = 'sentHistory';

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function getSentHistory() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([HISTORY_KEY], (items) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(items[HISTORY_KEY] || {});
    });
  });
}

function writeSentHistory(history) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [HISTORY_KEY]: history }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

// Read-modify-write under a lock. fn receives the history map and returns a result.
function updateHistory(fn) {
  return withLock('history', async () => {
    const history = await getSentHistory();
    const result = await fn(history);
    await writeSentHistory(history);
    return result;
  });
}

// Call right after every successful send so nothing is lost if the window closes.
// extra: { threadId, messageId, subject, template, cv }
function addSentRecord(email, company, extra) {
  const key = normalizeEmail(email);
  return updateHistory((history) => {
    history[key] = {
      ...(history[key] || {}),
      ...(extra || {}),
      email: key,
      company: company || '',
      sentAt: new Date().toISOString(),
      status: 'sent'
    };
    return history[key];
  });
}

function clearSentHistory() {
  return withLock('history', () => writeSentHistory({}));
}

// Replaces the whole map (used by Drive sync after merging).
function replaceSentHistory(history) {
  return withLock('history', () => writeSentHistory(history));
}

// items: [{ email, reason, bouncedAt }]. Returns how many were newly marked as bounced.
function markBounced(items) {
  return updateHistory((history) => {
    let newly = 0;
    items.forEach((item) => {
      const key = normalizeEmail(item.email);
      if (!key.includes('@')) return;
      const existing = history[key];
      if (existing && existing.status === 'bounced') return;
      history[key] = {
        ...(existing || {}),
        email: key,
        company: existing ? existing.company : '',
        sentAt: existing ? existing.sentAt : null,
        status: 'bounced',
        bounceReason: item.reason || 'address_not_found',
        bouncedAt: item.bouncedAt || new Date().toISOString()
      };
      newly++;
    });
    return newly;
  });
}

// items: [{ email, repliedAt }]. Returns how many were newly marked as replied.
function markReplied(items) {
  return updateHistory((history) => {
    let newly = 0;
    items.forEach((item) => {
      const key = normalizeEmail(item.email);
      const existing = history[key];
      if (!existing || existing.repliedAt || existing.status === 'bounced') return;
      existing.repliedAt = item.repliedAt || new Date().toISOString();
      newly++;
    });
    return newly;
  });
}

function recordFollowUp(email) {
  const key = normalizeEmail(email);
  return updateHistory((history) => {
    if (!history[key]) return null;
    history[key].followUpCount = (history[key].followUpCount || 0) + 1;
    history[key].lastFollowUpAt = new Date().toISOString();
    return history[key];
  });
}

// What the dashboard calls each contact: Replied / Bounced / Follow-up due / ...
function deriveStatus(rec, options) {
  const opts = options || {};
  const followUpDays = opts.followUpDays || 5;
  const maxFollowUps = opts.maxFollowUps === undefined ? 1 : opts.maxFollowUps;
  const now = opts.now || Date.now();
  if (rec.status === 'bounced') return 'Bounced';
  if (rec.repliedAt) return 'Replied';
  const count = rec.followUpCount || 0;
  const last = Date.parse(rec.lastFollowUpAt || rec.sentAt || '');
  if (!Number.isNaN(last) && now - last >= followUpDays * 86400000) {
    return count < maxFollowUps ? 'Follow-up due' : 'No reply';
  }
  return count > 0 ? 'Followed up' : 'Sent';
}

function countFollowUpsDue(history, settings, now) {
  const opts = { followUpDays: settings.followUpDays, maxFollowUps: settings.maxFollowUps, now };
  return Object.values(history).filter((rec) => deriveStatus(rec, opts) === 'Follow-up due').length;
}

function buildHistoryExport(history) {
  const sent = Object.values(history)
    .map((rec) => {
      const bounced = rec.status === 'bounced';
      const out = {
        email: rec.email,
        company: rec.company || '',
        status: bounced ? 'bounced' : 'sent',
        sentAt: rec.sentAt || null
      };
      ['threadId', 'messageId', 'subject', 'repliedAt', 'followUpCount', 'lastFollowUpAt'].forEach((k) => {
        if (rec[k]) out[k] = rec[k];
      });
      if (bounced) {
        out.emailExists = false; // Gmail said this address does not exist / could not receive mail
        out.bounceReason = rec.bounceReason || 'address_not_found';
        out.bouncedAt = rec.bouncedAt || null;
      }
      return out;
    })
    .sort((x, y) => String(x.sentAt || x.bouncedAt || '').localeCompare(String(y.sentAt || y.bouncedAt || '')));
  return {
    app: 'unity-job-mailer',
    version: 3,
    exportedAt: new Date().toISOString(),
    count: sent.length,
    bouncedCount: sent.filter((r) => r.status === 'bounced').length,
    repliedCount: sent.filter((r) => r.repliedAt).length,
    sent
  };
}

// Accepts our own export file, a plain array of objects, or a plain array of email strings.
function parseHistoryImport(rawText) {
  let data;
  try {
    data = JSON.parse(String(rawText).replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new Error('That file is not valid JSON.');
  }
  const list = Array.isArray(data) ? data : data && Array.isArray(data.sent) ? data.sent : null;
  if (!list) {
    throw new Error('Unrecognised history file. Expected the file exported from this extension.');
  }
  const now = new Date().toISOString();
  const out = [];
  list.forEach((item) => {
    const isObj = item && typeof item === 'object';
    const email = normalizeEmail(isObj ? item.email : item);
    if (!email || !email.includes('@')) return;
    const bounced = isObj && (item.status === 'bounced' || item.emailExists === false);
    const rec = {
      email,
      company: (isObj && item.company) || '',
      sentAt: (isObj && item.sentAt) || (bounced ? null : now),
      status: bounced ? 'bounced' : 'sent'
    };
    if (isObj) {
      ['threadId', 'messageId', 'subject', 'repliedAt', 'followUpCount', 'lastFollowUpAt'].forEach((k) => {
        if (item[k]) rec[k] = item[k];
      });
    }
    if (bounced) {
      rec.bounceReason = item.bounceReason || 'address_not_found';
      rec.bouncedAt = item.bouncedAt || now;
    }
    out.push(rec);
  });
  return out;
}

// Combines two records for the same address (used by file import and Drive sync).
// Bounced beats sent; earliest send date, latest follow-up and any reply are kept.
function mergeRecord(a, b) {
  if (!a) return b;
  if (!b) return a;
  const out = { ...b, ...a };
  const bounced = a.status === 'bounced' || b.status === 'bounced';
  out.status = bounced ? 'bounced' : 'sent';
  if (bounced) {
    const src = a.status === 'bounced' ? a : b;
    out.bounceReason = src.bounceReason;
    out.bouncedAt = src.bouncedAt;
  }
  const dates = (key, pick) => {
    const values = [a[key], b[key]].filter(Boolean).sort();
    return values.length ? (pick === 'min' ? values[0] : values[values.length - 1]) : null;
  };
  out.sentAt = dates('sentAt', 'min');
  const replied = dates('repliedAt', 'min');
  if (replied) out.repliedAt = replied;
  const lastFollow = dates('lastFollowUpAt', 'max');
  if (lastFollow) out.lastFollowUpAt = lastFollow;
  const follows = Math.max(a.followUpCount || 0, b.followUpCount || 0);
  if (follows) out.followUpCount = follows;
  ['company', 'threadId', 'messageId', 'subject'].forEach((k) => {
    out[k] = a[k] || b[k] || out[k];
  });
  return out;
}

async function mergeSentHistory(records) {
  return updateHistory((history) => {
    let added = 0;
    let updated = 0;
    records.forEach((rec) => {
      const existing = history[rec.email];
      if (!existing) {
        history[rec.email] = rec;
        added++;
        return;
      }
      const merged = mergeRecord(existing, rec);
      if (JSON.stringify(merged) !== JSON.stringify(existing)) {
        history[rec.email] = merged;
        updated++;
      }
    });
    return { added, updated, skipped: records.length - added - updated, total: Object.keys(history).length };
  });
}

/* ------------------------------------------------------------------ */
/* Small stored values                                                 */
/* ------------------------------------------------------------------ */

function getLastBounceCheck() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['lastBounceCheck'], (items) => resolve(items.lastBounceCheck || 0));
  });
}

function setLastBounceCheck(ms) {
  return saveSettings({ lastBounceCheck: ms });
}

function getLastReplyCheck() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['lastReplyCheck'], (items) => resolve(items.lastReplyCheck || 0));
  });
}

function setLastReplyCheck(ms) {
  return saveSettings({ lastReplyCheck: ms });
}

function todayKey(date) {
  const d = date || new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function getSentToday() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['sentToday'], (items) => {
      const value = items.sentToday;
      resolve(value && value.date === todayKey() ? value.count : 0);
    });
  });
}

// Counts every email that leaves your account today (bulk, single, follow-up, test).
function bumpSentToday() {
  return withLock('sentToday', async () => {
    const count = (await getSentToday()) + 1;
    await saveSettings({ sentToday: { date: todayKey(), count } });
    return count;
  });
}

function getDnsCache() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['dnsCache'], (items) => resolve(items.dnsCache || {}));
  });
}

function setDnsCache(cache) {
  return saveSettings({ dnsCache: cache });
}
