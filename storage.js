const STORAGE_KEYS = {
  SENDER_NAME: 'senderName',
  DEFAULT_SUBJECT: 'defaultSubject',
  DEFAULT_TEMPLATE: 'defaultTemplate',
  CV_NAME: 'cvName',
  CV_DATA: 'cvData',
  SEND_DELAY_SECONDS: 'sendDelaySeconds',
  USER_EMAIL: 'userEmail',
  AUTO_EXPORT: 'autoExportHistory'
};

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
  [STORAGE_KEYS.AUTO_EXPORT]: true
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

function clearSettings() {
  return new Promise((resolve, reject) => {
    const keysToRemove = Object.values(STORAGE_KEYS).filter(
      (key) => key !== STORAGE_KEYS.USER_EMAIL
    );
    chrome.storage.local.remove(keysToRemove, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
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
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove([STORAGE_KEYS.USER_EMAIL], () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}


/* ------------------------------------------------------------------ */
/* Sent history (remembers who was already emailed)                    */
/* Stored under its own key so "Clear Settings" never wipes it.        */
/* Shape: { "hr@x.com": { email, company, sentAt } }                   */
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

// Call this right after every successful send so nothing is lost if the tab closes.
async function addSentRecord(email, company) {
  const history = await getSentHistory();
  const key = normalizeEmail(email);
  history[key] = { email: key, company: company || '', sentAt: new Date().toISOString(), status: 'sent' };
  await writeSentHistory(history);
  return history;
}

async function clearSentHistory() {
  await writeSentHistory({});
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
    version: 2,
    exportedAt: new Date().toISOString(),
    count: sent.length,
    bouncedCount: sent.filter((r) => r.status === 'bounced').length,
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
    if (bounced) {
      rec.bounceReason = item.bounceReason || 'address_not_found';
      rec.bouncedAt = item.bouncedAt || now;
    }
    out.push(rec);
  });
  return out;
}

// Merges into existing history. Existing records win (keeps the original send date),
// except that a "bounced" record upgrades a "sent" one, because it is newer information.
async function mergeSentHistory(records) {
  const history = await getSentHistory();
  let added = 0;
  let updated = 0;
  records.forEach((rec) => {
    const existing = history[rec.email];
    if (!existing) {
      history[rec.email] = rec;
      added++;
    } else if (rec.status === 'bounced' && existing.status !== 'bounced') {
      history[rec.email] = { ...existing, status: 'bounced', bounceReason: rec.bounceReason, bouncedAt: rec.bouncedAt };
      updated++;
    }
  });
  await writeSentHistory(history);
  return { added, updated, skipped: records.length - added - updated, total: Object.keys(history).length };
}

// items: [{ email, reason, bouncedAt }]. Returns how many were newly marked as bounced.
async function markBounced(items) {
  const history = await getSentHistory();
  let newly = 0;
  items.forEach((item) => {
    const key = normalizeEmail(item.email);
    if (!key.includes('@')) return;
    const existing = history[key];
    if (existing && existing.status === 'bounced') return;
    history[key] = {
      email: key,
      company: existing ? existing.company : '',
      sentAt: existing ? existing.sentAt : null,
      status: 'bounced',
      bounceReason: item.reason || 'address_not_found',
      bouncedAt: item.bouncedAt || new Date().toISOString()
    };
    newly++;
  });
  await writeSentHistory(history);
  return newly;
}

function getLastBounceCheck() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['lastBounceCheck'], (items) => resolve(items.lastBounceCheck || 0));
  });
}

function setLastBounceCheck(ms) {
  return saveSettings({ lastBounceCheck: ms });
}
