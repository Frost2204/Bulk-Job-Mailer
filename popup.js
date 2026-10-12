let currentToken = null;
let currentUserEmail = '';
let bulkEntries = [];
let stopRequested = false;
let bulkRunning = false;

const IS_FULL_TAB = new URLSearchParams(location.search).get('tab') === '1';

const els = {};

function cacheElements() {
  els.notification = document.getElementById('notification');
  els.authStatusText = document.getElementById('authStatusText');
  els.authHintText = document.getElementById('authHintText');
  els.connectBtn = document.getElementById('connectBtn');
  els.signOutBtn = document.getElementById('signOutBtn');
  els.openOptionsBtn = document.getElementById('openOptionsBtn');
  els.openTabBtn = document.getElementById('openTabBtn');
  els.popupModeTip = document.getElementById('popupModeTip');

  els.tabs = document.querySelectorAll('.tab');
  els.singlePanel = document.getElementById('singlePanel');
  els.bulkPanel = document.getElementById('bulkPanel');
  els.historyPanel = document.getElementById('historyPanel');

  els.recipientEmail = document.getElementById('recipientEmail');
  els.companyName = document.getElementById('companyName');
  els.emailSubject = document.getElementById('emailSubject');
  els.emailTemplate = document.getElementById('emailTemplate');
  els.previewBtn = document.getElementById('previewBtn');
  els.sendBtn = document.getElementById('sendBtn');
  els.previewBox = document.getElementById('previewBox');
  els.previewContent = document.getElementById('previewContent');

  els.bulkJsonFile = document.getElementById('bulkJsonFile');
  els.bulkInputInfo = document.getElementById('bulkInputInfo');
  els.stopBtn = document.getElementById('stopBtn');
  els.bulkSummary = document.getElementById('bulkSummary');
  els.bulkProgress = document.getElementById('bulkProgress');
  els.bulkProgressBar = document.getElementById('bulkProgressBar');

  els.historyCountBadge = document.getElementById('historyCountBadge');
  els.historyCount = document.getElementById('historyCount');
  els.bouncedCount = document.getElementById('bouncedCount');
  els.checkBouncesBtn = document.getElementById('checkBouncesBtn');
  els.bounceProgress = document.getElementById('bounceProgress');
  els.manualBounceInput = document.getElementById('manualBounceInput');
  els.markBouncedBtn = document.getElementById('markBouncedBtn');
  els.autoExportCheck = document.getElementById('autoExportCheck');
  els.exportHistoryBtn = document.getElementById('exportHistoryBtn');
  els.clearHistoryBtn = document.getElementById('clearHistoryBtn');
  els.importHistoryFile = document.getElementById('importHistoryFile');

  els.bulkJsonInput = document.getElementById('bulkJsonInput');
  els.validateJsonBtn = document.getElementById('validateJsonBtn');
  els.sendAllBtn = document.getElementById('sendAllBtn');
  els.bulkTableWrap = document.getElementById('bulkTableWrap');
  els.bulkTableBody = document.getElementById('bulkTableBody');

  els.confirmModal = document.getElementById('confirmModal');
  els.confirmModalText = document.getElementById('confirmModalText');
  els.confirmModalWarn = document.getElementById('confirmModalWarn');
  els.confirmCancelBtn = document.getElementById('confirmCancelBtn');
  els.confirmSendBtn = document.getElementById('confirmSendBtn');
}

function showNotification(message, type) {
  els.notification.textContent = message;
  els.notification.className = `notification ${type}`;
}

function clearNotification() {
  els.notification.className = 'notification hidden';
}

function setAuthUi(connected, email) {
  if (connected) {
    els.authStatusText.textContent = `Connected: ${email}`;
    els.authStatusText.classList.add('connected');
    els.authHintText.textContent = 'You can now send emails from this account.';
    els.connectBtn.classList.add('hidden');
    els.signOutBtn.classList.remove('hidden');
  } else {
    els.authStatusText.textContent = 'Not connected';
    els.authStatusText.classList.remove('connected');
    els.authHintText.textContent = 'Connect your Gmail account to send emails.';
    els.connectBtn.classList.remove('hidden');
    els.signOutBtn.classList.add('hidden');
  }
}

async function refreshAuthState() {
  const savedEmail = await getUserEmail();
  if (savedEmail) {
    currentUserEmail = savedEmail;
    setAuthUi(true, savedEmail);
  } else {
    setAuthUi(false, '');
  }
}

async function handleConnect() {
  clearNotification();
  els.connectBtn.disabled = true;
  try {
    const { token, email } = await signInToGmail();
    currentToken = token;
    currentUserEmail = email;
    await setUserEmail(email);
    setAuthUi(true, email);
    showNotification('Gmail connected successfully.', 'success');
  } catch (err) {
    if (String(err.message).toLowerCase().includes('cancelled') || String(err.message).toLowerCase().includes('user did not approve')) {
      showNotification('Google authentication was cancelled.', 'error');
    } else {
      showNotification(err.message || 'Login failed. Please try again.', 'error');
    }
  } finally {
    els.connectBtn.disabled = false;
  }
}

async function handleSignOut() {
  clearNotification();
  els.signOutBtn.disabled = true;
  try {
    await signOutOfGmail();
    await clearUserEmail();
    currentToken = null;
    currentUserEmail = '';
    setAuthUi(false, '');
    showNotification('Signed out.', 'info');
  } catch (err) {
    showNotification(err.message || 'Unable to sign out.', 'error');
  } finally {
    els.signOutBtn.disabled = false;
  }
}

function switchTab(tabName) {
  els.tabs.forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.tab === tabName);
  });
  els.singlePanel.classList.toggle('hidden', tabName !== 'single');
  els.bulkPanel.classList.toggle('hidden', tabName !== 'bulk');
  els.historyPanel.classList.toggle('hidden', tabName !== 'history');
  if (tabName === 'history') {
    refreshHistoryCount();
  }
}

async function loadDefaultsIntoForm() {
  const settings = await getSettings();
  els.emailSubject.value = settings.defaultSubject || '';
  els.emailTemplate.value = settings.defaultTemplate || '';
}

function buildSinglePreviewText(senderName) {
  return renderTemplate(els.emailTemplate.value, {
    company: els.companyName.value.trim(),
    name: senderName,
    email: els.recipientEmail.value.trim()
  });
}

async function handlePreview() {
  clearNotification();
  if (!els.companyName.value.trim()) {
    showNotification('Company name is missing.', 'error');
    return;
  }
  const settings = await getSettings();
  const bodyText = buildSinglePreviewText(settings.senderName || '');
  els.previewContent.textContent = bodyText;
  els.previewBox.classList.remove('hidden');
}

function validateSingleForm() {
  if (!currentUserEmail) {
    return 'Please connect your Gmail account first.';
  }
  if (!els.recipientEmail.value.trim()) {
    return 'Recipient email is missing.';
  }
  if (!els.companyName.value.trim()) {
    return 'Company name is missing.';
  }
  if (!els.emailSubject.value.trim()) {
    return 'Subject is missing.';
  }
  return null;
}

async function ensureFreshToken() {
  const token = await getAuthToken(true);
  currentToken = token;
  return token;
}

async function buildAttachmentFromSettings(settings) {
  if (!settings.cvData || !settings.cvName) {
    return null;
  }
  const commaIndex = settings.cvData.indexOf(',');
  const base64Data = commaIndex >= 0 ? settings.cvData.substring(commaIndex + 1) : settings.cvData;
  return {
    fileName: settings.cvName,
    mimeType: 'application/pdf',
    base64Data
  };
}

async function handleSend() {
  clearNotification();
  const validationError = validateSingleForm();
  if (validationError) {
    showNotification(validationError, 'error');
    return;
  }

  const settings = await getSettings();
  if (!settings.cvName) {
    showNotification('CV is not configured. Add it in Settings.', 'error');
    return;
  }

  const blocked = historyBlock((await getSentHistory())[normalizeEmail(els.recipientEmail.value)]);
  if (blocked) {
    showNotification(`${blocked.error}. Email was NOT sent.`.replace('.. ', '. '), 'error');
    return;
  }

  els.sendBtn.disabled = true;
  els.sendBtn.textContent = 'Sending...';
  try {
    const token = await ensureFreshToken();
    const attachment = await buildAttachmentFromSettings(settings);
    const bodyText = buildSinglePreviewText(settings.senderName || '');

    await sendEmailWithRetry({
      token,
      fromEmail: currentUserEmail,
      senderName: settings.senderName,
      toEmail: els.recipientEmail.value.trim(),
      subject: els.emailSubject.value.trim(),
      bodyText,
      attachment
    });

    await addSentRecord(els.recipientEmail.value, els.companyName.value.trim());
    refreshHistoryCount();
    showNotification('Email sent successfully.', 'success');
  } catch (err) {
    showNotification(err.message || 'Unable to send email. Please check Gmail permissions.', 'error');
  } finally {
    els.sendBtn.disabled = false;
    els.sendBtn.textContent = 'Send Email';
  }
}

const STATUS_CLASS = {
  'Pending': 'pending',
  'Sending...': 'sending',
  'Sent': 'sent',
  'Failed': 'failed',
  'Already sent': 'already',
  'Bounced': 'bounced',
  'Duplicate': 'duplicate'
};

function pillText(entry) {
  if (!entry.error) return entry.status;
  return entry.status === 'Failed' ? `Failed: ${entry.error}` : entry.error;
}

function buildPill(entry) {
  const pill = document.createElement('span');
  pill.className = `status-pill status-${STATUS_CLASS[entry.status] || 'pending'}`;
  pill.textContent = pillText(entry);
  return pill;
}

function renderBulkTable() {
  els.bulkTableBody.innerHTML = '';
  const fragment = document.createDocumentFragment();
  bulkEntries.forEach((entry, index) => {
    const row = document.createElement('tr');

    const companyCell = document.createElement('td');
    companyCell.textContent = entry.company || '(missing)';

    const emailCell = document.createElement('td');
    emailCell.textContent = entry.email || '(missing)';

    const statusCell = document.createElement('td');
    statusCell.appendChild(buildPill(entry));

    row.appendChild(companyCell);
    row.appendChild(emailCell);
    row.appendChild(statusCell);
    row.dataset.index = String(index);
    fragment.appendChild(row);
  });
  els.bulkTableBody.appendChild(fragment);
}

function updateEntryStatus(index, status, error) {
  const entry = bulkEntries[index];
  entry.status = status;
  entry.error = error || null;
  const row = els.bulkTableBody.querySelector(`tr[data-index="${index}"]`);
  if (!row) return;
  const statusCell = row.children[2];
  statusCell.innerHTML = '';
  statusCell.appendChild(buildPill(entry));
  if (status === 'Sending...') {
    row.scrollIntoView({ block: 'nearest' });
  }
}

function countByStatus() {
  const counts = { total: bulkEntries.length, Pending: 0, Sent: 0, Failed: 0, 'Already sent': 0, Bounced: 0, Duplicate: 0 };
  bulkEntries.forEach((entry) => {
    const key = entry.status === 'Sending...' ? 'Pending' : entry.status;
    counts[key] = (counts[key] || 0) + 1;
  });
  return counts;
}

function updateSummary() {
  const c = countByStatus();
  const chips = [
    [`${c.total} in list`, 'status-duplicate'],
    [`${c.Pending} to send`, 'status-pending'],
    [`${c.Sent} sent`, 'status-sent'],
    [`${c['Already sent']} already sent`, 'status-already'],
    [`${c.Bounced} bounced before`, 'status-bounced'],
    [`${c.Duplicate} duplicate`, 'status-duplicate'],
    [`${c.Failed} failed / invalid`, 'status-failed']
  ].filter(([label]) => !label.startsWith('0 ') || label.endsWith('in list'));

  els.bulkSummary.innerHTML = '';
  chips.forEach(([label, cls]) => {
    const chip = document.createElement('span');
    chip.className = `chip ${cls}`;
    chip.textContent = label;
    els.bulkSummary.appendChild(chip);
  });
  els.bulkSummary.classList.remove('hidden');
}

function pendingCount() {
  return bulkEntries.filter((entry) => entry.status === 'Pending').length;
}

async function previewFromText(text) {
  clearNotification();
  els.bulkProgress.classList.add('hidden');

  let history = {};
  try {
    history = await getSentHistory();
  } catch (err) {
    history = {};
  }

  try {
    bulkEntries = parseBulkJson(text, history);
  } catch (err) {
    bulkEntries = [];
    showNotification(err.message, 'error');
    els.bulkTableWrap.classList.add('hidden');
    els.bulkSummary.classList.add('hidden');
    els.sendAllBtn.disabled = true;
    return;
  }

  if (bulkEntries.length === 0) {
    showNotification('The JSON list is empty.', 'error');
    els.bulkTableWrap.classList.add('hidden');
    els.bulkSummary.classList.add('hidden');
    els.sendAllBtn.disabled = true;
    return;
  }

  renderBulkTable();
  updateSummary();
  els.bulkTableWrap.classList.remove('hidden');
  els.sendAllBtn.disabled = pendingCount() === 0;

  if (pendingCount() === 0) {
    showNotification('Nothing to send: every entry is already sent, bounced, a duplicate, or invalid.', 'info');
  }
}

function handleValidateJson() {
  return previewFromText(els.bulkJsonInput.value);
}

async function handleBulkFileChange() {
  const file = els.bulkJsonFile.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    els.bulkJsonInput.value = '';
    els.bulkInputInfo.textContent = `Loaded file: ${file.name}`;
    await previewFromText(text);
  } catch (err) {
    showNotification('Unable to read that file.', 'error');
  }
}

/* ---- delay between sends (worker timer, so background tabs are not throttled) ---- */

let timerWorker = null;
let timerSeq = 0;
const timerResolvers = new Map();

function getTimerWorker() {
  if (timerWorker !== null) return timerWorker;
  try {
    timerWorker = new Worker('timer-worker.js');
    timerWorker.onmessage = (event) => {
      const resolve = timerResolvers.get(event.data.id);
      if (resolve) {
        timerResolvers.delete(event.data.id);
        resolve();
      }
    };
  } catch (err) {
    timerWorker = false;
  }
  return timerWorker;
}

function workerSleep(ms) {
  const worker = getTimerWorker();
  if (!worker) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  return new Promise((resolve) => {
    const id = ++timerSeq;
    timerResolvers.set(id, resolve);
    worker.postMessage({ id, ms });
  });
}

// Sleeps in short steps so the Stop button reacts quickly.
async function interruptibleSleep(totalMs) {
  let waited = 0;
  while (waited < totalMs && !stopRequested) {
    const chunk = Math.min(500, totalMs - waited);
    await workerSleep(chunk);
    waited += chunk;
  }
}

function openConfirmModal() {
  const pending = pendingCount();
  const skipped = bulkEntries.length - pending;
  els.confirmModalText.textContent =
    `This will send ${pending} email(s)` +
    (skipped ? ` and skip ${skipped} (already sent, bounced, duplicate or invalid)` : '') +
    '. Continue?';

  getSettings().then((settings) => {
    const delay = Number(settings.sendDelaySeconds) || 5;
    const minutes = Math.ceil((pending * delay) / 60);
    let warn = `Estimated time: about ${minutes} minute(s). Keep this window open.`;
    if (pending > 400) {
      warn +=
        ' A personal Gmail account can send roughly 500 emails per day. If Gmail\'s limit is hit, sending stops by itself — ' +
        'paste the same list again later and anyone already sent is skipped automatically.';
    }
    els.confirmModalWarn.textContent = warn;
    els.confirmModalWarn.classList.remove('hidden');
  });
  els.confirmModal.classList.remove('hidden');
}

function closeConfirmModal() {
  els.confirmModal.classList.add('hidden');
}

function setBulkRunning(running) {
  bulkRunning = running;
  els.sendAllBtn.disabled = running || pendingCount() === 0;
  els.validateJsonBtn.disabled = running;
  els.bulkJsonFile.disabled = running;
  els.stopBtn.classList.toggle('hidden', !running);
  els.stopBtn.disabled = false;
  els.stopBtn.textContent = 'Stop';
  window.onbeforeunload = running
    ? (event) => {
        event.preventDefault();
        event.returnValue = '';
      }
    : null;
}

function handleStop() {
  stopRequested = true;
  els.stopBtn.disabled = true;
  els.stopBtn.textContent = 'Stopping...';
}

async function runBulkSend() {
  closeConfirmModal();
  clearNotification();

  if (!currentUserEmail) {
    showNotification('Please connect your Gmail account first.', 'error');
    return;
  }

  const settings = await getSettings();
  if (!settings.cvName) {
    showNotification('CV is not configured. Add it in Settings.', 'error');
    return;
  }

  const attachment = await buildAttachmentFromSettings(settings);
  const delaySeconds = Number(settings.sendDelaySeconds) || 5;
  const subject = els.emailSubject.value.trim() || settings.defaultSubject;
  const template = els.emailTemplate.value || settings.defaultTemplate;

  stopRequested = false;
  setBulkRunning(true);

  let token;
  try {
    token = await ensureFreshToken();
  } catch (err) {
    showNotification(err.message || 'Please connect your Gmail account first.', 'error');
    setBulkRunning(false);
    return;
  }

  const queue = [];
  bulkEntries.forEach((entry, index) => {
    if (entry.status === 'Pending') queue.push(index);
  });

  let sentCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  let stopReason = '';
  let processed = 0;

  els.bulkProgress.classList.remove('hidden');
  els.bulkProgressBar.style.width = '0%';

  for (let q = 0; q < queue.length; q++) {
    if (stopRequested) {
      stopReason = 'stopped';
      break;
    }

    const i = queue[q];
    const entry = bulkEntries[i];

    // Re-check right before sending: protects against a second window or a history import.
    let latest = {};
    try {
      latest = await getSentHistory();
    } catch (err) {
      latest = {};
    }
    const blocked = historyBlock(latest[normalizeEmail(entry.email)]);
    if (blocked) {
      updateEntryStatus(i, blocked.status, blocked.error);
      skippedCount++;
      processed++;
      continue;
    }

    updateEntryStatus(i, 'Sending...');
    let sendOk = false;
    try {
      const bodyText = renderTemplate(template, {
        company: entry.company,
        name: settings.senderName || '',
        email: entry.email
      });

      const result = await sendEmailWithRetry({
        token,
        fromEmail: currentUserEmail,
        senderName: settings.senderName,
        toEmail: entry.email,
        subject,
        bodyText,
        attachment
      });
      token = result.token;
      sendOk = true;
    } catch (err) {
      if (err.isQuota) {
        updateEntryStatus(i, 'Pending');
        stopReason = 'quota';
        showNotification(`${err.message} Stopped. Try again later; already-sent emails will be skipped.`, 'error');
        break;
      }
      updateEntryStatus(i, 'Failed', err.message || 'Unknown error');
      failedCount++;
    }

    if (sendOk) {
      // Save immediately so the email can never be sent twice, even if the window closes next.
      try {
        await addSentRecord(entry.email, entry.company);
      } catch (err) {
        showNotification('Email sent, but saving it to history failed: ' + err.message, 'error');
      }
      updateEntryStatus(i, 'Sent');
      sentCount++;
      refreshHistoryCount();
    }

    processed++;
    els.bulkProgressBar.style.width = `${Math.round((processed / queue.length) * 100)}%`;
    updateSummary();

    if (q < queue.length - 1 && !stopRequested) {
      await interruptibleSleep(delaySeconds * 1000);
    }
  }

  updateSummary();
  setBulkRunning(false);

  const parts = [`${sentCount} sent`];
  if (failedCount) parts.push(`${failedCount} failed`);
  if (skippedCount) parts.push(`${skippedCount} skipped (already sent / bounced)`);
  const remaining = pendingCount();

  if (stopReason === 'quota') {
    // notification already shown above
  } else if (stopReason === 'stopped') {
    showNotification(`Stopped. ${parts.join(', ')}. ${remaining} still pending.`, 'info');
  } else {
    showNotification(`Bulk send complete. ${parts.join(', ')}.`, 'success');
  }

  if (sentCount > 0 && settings.autoExportHistory) {
    await downloadHistoryFile();
  }
}

/* ---- bounces ---- */

const BOUNCE_QUERY = 'from:(mailer-daemon OR postmaster)';

async function finishBounceUpdate(bounces) {
  const newly = await markBounced(bounces);
  await refreshHistoryCount();
  applyHistoryToEntries(await getSentHistory());
  return newly;
}

async function handleCheckBounces() {
  clearNotification();
  if (bulkRunning) {
    showNotification('Wait until the bulk send has finished (or press Stop) before checking bounces.', 'error');
    return;
  }
  if (!currentUserEmail) {
    showNotification('Please connect your Gmail account first.', 'error');
    return;
  }

  els.checkBouncesBtn.disabled = true;
  els.bounceProgress.textContent = 'Looking for bounce notices in Gmail...';
  try {
    const history = await getSentHistory();
    const last = await getLastBounceCheck();
    // Look back to one day before the last check (or 60 days the first time).
    const since = last ? `after:${Math.floor(last / 1000) - 86400}` : 'newer_than:60d';
    const startedAt = Date.now();

    const token = await getAuthToken(true);
    const result = await scanBounces({
      token,
      query: `${BOUNCE_QUERY} ${since}`,
      knownEmails: history,
      onProgress: (done, total) => {
        els.bounceProgress.textContent = `Reading bounce notices: ${done} / ${total}`;
      }
    });
    currentToken = result.token;

    const newly = await finishBounceUpdate(result.bounces);
    await setLastBounceCheck(startedAt);
    els.bounceProgress.textContent = '';
    showNotification(
      newly > 0
        ? `Found ${newly} new bounced address(es). They are marked and will not be emailed again.`
        : `No new bounces found (checked ${result.scanned} notice(s)). Bounces can take a few minutes to arrive.`,
      newly > 0 ? 'success' : 'info'
    );
  } catch (err) {
    els.bounceProgress.textContent = '';
    showNotification(err.message || 'Unable to check for bounces.', 'error');
  } finally {
    els.checkBouncesBtn.disabled = false;
  }
}

async function handleMarkBounced() {
  clearNotification();
  if (bulkRunning) {
    showNotification('Wait until the bulk send has finished before marking bounces.', 'error');
    return;
  }
  const found = els.manualBounceInput.value.match(/[^\s<>()"',;:]+@[^\s<>()"',;:]+\.[^\s<>()"',;:]+/g) || [];
  const emails = [...new Set(found.map((e) => normalizeEmail(e.replace(/\.+$/, ''))))];
  if (emails.length === 0) {
    showNotification('No email addresses found in what you pasted.', 'error');
    return;
  }
  try {
    const newly = await finishBounceUpdate(emails.map((email) => ({ email, reason: 'address_not_found' })));
    els.manualBounceInput.value = '';
    showNotification(`Marked ${newly} address(es) as bounced (${emails.length - newly} were already marked).`, 'success');
  } catch (err) {
    showNotification(err.message || 'Unable to save.', 'error');
  }
}

/* ---- history tab ---- */

async function refreshHistoryCount() {
  try {
    const records = Object.values(await getSentHistory());
    els.historyCount.textContent = String(records.length);
    els.historyCountBadge.textContent = String(records.length);
    els.bouncedCount.textContent = String(records.filter((r) => r.status === 'bounced').length);
  } catch (err) {
    /* ignore */
  }
}

function downloadJsonFile(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function downloadHistoryFile() {
  const history = await getSentHistory();
  const stamp = new Date().toISOString().slice(0, 10);
  downloadJsonFile(buildHistoryExport(history), `job-mailer-sent-history-${stamp}.json`);
}

async function handleExportHistory() {
  clearNotification();
  try {
    const count = Object.keys(await getSentHistory()).length;
    if (count === 0) {
      showNotification('History is empty. Nothing to download yet.', 'info');
      return;
    }
    await downloadHistoryFile();
    showNotification(`Downloaded history file (${count} emails).`, 'success');
  } catch (err) {
    showNotification(err.message || 'Unable to download history.', 'error');
  }
}

// Re-checks the current list against history (after an import or a bounce check).
function applyHistoryToEntries(history) {
  let changed = 0;
  bulkEntries.forEach((entry, index) => {
    if (entry.status === 'Failed' || entry.status === 'Duplicate' || entry.status === 'Sending...') return;
    const blocked = historyBlock(history[normalizeEmail(entry.email)]);
    if (!blocked) return;
    // A "Sent" row that later bounced becomes "Bounced"; pending rows become skipped.
    const worthUpdating =
      (blocked.status === 'Bounced' && entry.status !== 'Bounced') ||
      (blocked.status === 'Already sent' && entry.status === 'Pending');
    if (worthUpdating) {
      updateEntryStatus(index, blocked.status, blocked.error);
      changed++;
    }
  });
  if (changed && bulkEntries.length) {
    updateSummary();
    els.sendAllBtn.disabled = bulkRunning || pendingCount() === 0;
  }
}

async function handleImportHistory() {
  clearNotification();
  const file = els.importHistoryFile.files[0];
  if (!file) return;
  try {
    const records = parseHistoryImport(await file.text());
    if (records.length === 0) {
      showNotification('No email addresses found in that file.', 'error');
      return;
    }
    const result = await mergeSentHistory(records);
    await refreshHistoryCount();
    applyHistoryToEntries(await getSentHistory());
    showNotification(
      `Loaded ${records.length} record(s): ${result.added} new, ${result.updated} updated to bounced, ${result.skipped} already known. History now has ${result.total}.`,
      'success'
    );
  } catch (err) {
    showNotification(err.message || 'Unable to load that file.', 'error');
  } finally {
    els.importHistoryFile.value = '';
  }
}

async function handleClearHistory() {
  const count = Object.keys(await getSentHistory()).length;
  if (count === 0) {
    showNotification('History is already empty.', 'info');
    return;
  }
  const ok = window.confirm(
    `This forgets all ${count} sent emails, so they could be emailed again.\n\nDownload a backup first if unsure. Clear history?`
  );
  if (!ok) return;
  await clearSentHistory();
  await refreshHistoryCount();
  showNotification('History cleared.', 'info');
}

function attachEventListeners() {
  els.connectBtn.addEventListener('click', handleConnect);
  els.signOutBtn.addEventListener('click', handleSignOut);
  els.openOptionsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());
  els.openTabBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?tab=1') });
    window.close();
  });

  els.tabs.forEach((tab) => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  els.previewBtn.addEventListener('click', handlePreview);
  els.sendBtn.addEventListener('click', handleSend);

  els.validateJsonBtn.addEventListener('click', handleValidateJson);
  els.bulkJsonFile.addEventListener('change', handleBulkFileChange);
  els.stopBtn.addEventListener('click', handleStop);
  els.checkBouncesBtn.addEventListener('click', handleCheckBounces);
  els.markBouncedBtn.addEventListener('click', handleMarkBounced);
  els.exportHistoryBtn.addEventListener('click', handleExportHistory);
  els.clearHistoryBtn.addEventListener('click', handleClearHistory);
  els.importHistoryFile.addEventListener('change', handleImportHistory);
  els.autoExportCheck.addEventListener('change', () => {
    saveSettings({ autoExportHistory: els.autoExportCheck.checked });
  });
  els.sendAllBtn.addEventListener('click', openConfirmModal);
  els.confirmCancelBtn.addEventListener('click', closeConfirmModal);
  els.confirmSendBtn.addEventListener('click', runBulkSend);
}

async function init() {
  cacheElements();
  if (IS_FULL_TAB) {
    document.body.classList.add('full');
  } else {
    els.popupModeTip.classList.remove('hidden');
  }
  attachEventListeners();
  await refreshAuthState();
  await loadDefaultsIntoForm();
  const settings = await getSettings();
  els.autoExportCheck.checked = settings.autoExportHistory !== false;
  await refreshHistoryCount();
}

document.addEventListener('DOMContentLoaded', init);
