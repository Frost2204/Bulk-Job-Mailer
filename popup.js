let currentToken = null;
let currentUserEmail = '';
let previewEntries = [];
let previewRun = 0; // bumps on every new preview so a slow older one cannot overwrite a newer one
let verifying = false;
let confirmAction = null;
let queueTimer = null;

const IS_FULL_TAB = new URLSearchParams(location.search).get('tab') === '1';

const els = {};

function $(id) {
  return document.getElementById(id);
}

function cacheElements() {
  [
    'notification', 'authStatusText', 'authHintText', 'connectBtn', 'signOutBtn', 'openOptionsBtn', 'openTabBtn',
    'openDashboardBtn', 'openDashboardBtn2', 'popupModeTip', 'singlePanel', 'bulkPanel', 'historyPanel',
    'recipientEmail', 'companyName', 'singleTemplateSelect', 'singleCvSelect', 'emailSubject', 'emailTemplate',
    'extraFields', 'previewBtn', 'testSendBtn', 'sendBtn', 'previewBox', 'previewContent',
    'queueCard', 'queueStateText', 'queueCountsText', 'queueProgressBar', 'queueNote', 'pauseBtn', 'resumeBtn',
    'cancelQueueBtn', 'queueDashboardBtn',
    'bulkTemplateSelect', 'bulkCvSelect', 'bulkJsonFile', 'bulkJsonInput', 'bulkInputInfo', 'verifyDomainsCheck',
    'validateJsonBtn', 'bulkTestBtn', 'sendAllBtn', 'verifyProgress', 'bulkSummary', 'bulkTableWrap', 'bulkTableBody',
    'historyCountBadge', 'historyCount', 'repliedCount', 'bouncedCount', 'autoExportCheck', 'exportHistoryBtn',
    'clearHistoryBtn', 'importHistoryFile', 'checkBouncesBtn', 'bounceProgress', 'manualBounceInput', 'markBouncedBtn',
    'followUpInfo', 'queueFollowUpsBtn', 'syncBtn', 'syncInfo',
    'confirmModal', 'confirmModalTitle', 'confirmModalText', 'confirmModalWarn', 'confirmCancelBtn', 'confirmSendBtn'
  ].forEach((id) => {
    els[id] = $(id);
  });
  els.tabs = document.querySelectorAll('.tab');
}

function showNotification(message, type) {
  els.notification.textContent = message;
  els.notification.className = `notification ${type}`;
}

function clearNotification() {
  els.notification.className = 'notification hidden';
}

function kickWorker() {
  try {
    chrome.runtime.sendMessage({ type: 'kick' }, () => void chrome.runtime.lastError);
  } catch (err) {
    /* worker wakes on its own alarm anyway */
  }
}

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

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
    // A queue that paused because Gmail was disconnected can carry on now.
    const meta = await getQueueMeta();
    if (meta.state === 'paused' && /connect/i.test(meta.lastError || '')) {
      await resumeQueue();
      kickWorker();
    }
  } catch (err) {
    const msg = String(err.message).toLowerCase();
    if (msg.includes('cancelled') || msg.includes('user did not approve')) {
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
  els.tabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === tabName));
  els.singlePanel.classList.toggle('hidden', tabName !== 'single');
  els.bulkPanel.classList.toggle('hidden', tabName !== 'bulk');
  els.historyPanel.classList.toggle('hidden', tabName !== 'history');
  if (tabName === 'history') refreshHistoryPanel();
  if (tabName === 'bulk') renderQueueCard();
}

/* ------------------------------------------------------------------ */
/* Templates / CV pickers                                              */
/* ------------------------------------------------------------------ */

function fillSelect(select, options, selected) {
  select.innerHTML = '';
  options.forEach(([value, label]) => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    select.appendChild(opt);
  });
  if (selected !== undefined && options.some(([v]) => v === selected)) select.value = selected;
}

async function populateSelects() {
  const settings = await getSettingsResolved();
  const templateOptions = settings.templates.map((t) => [t.name, t.name]);
  const cvOptions = settings.cvs.map((c) => [c.name, c.name]).concat([['none', 'No attachment']]);
  fillSelect(els.singleTemplateSelect, templateOptions, els.singleTemplateSelect.value);
  fillSelect(els.bulkTemplateSelect, templateOptions, els.bulkTemplateSelect.value);
  fillSelect(els.singleCvSelect, cvOptions, els.singleCvSelect.value);
  fillSelect(els.bulkCvSelect, cvOptions, els.bulkCvSelect.value);
  return settings;
}

async function loadTemplateIntoSingleForm() {
  const settings = await getSettingsResolved();
  const template = findByName(settings.templates, els.singleTemplateSelect.value);
  if (template) {
    els.emailSubject.value = template.subject || '';
    els.emailTemplate.value = template.body || '';
  }
}

/* ------------------------------------------------------------------ */
/* Single email                                                        */
/* ------------------------------------------------------------------ */

function parseExtraFields() {
  const raw = els.extraFields.value.trim();
  if (!raw) return {};
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error('Extra fields must be valid JSON, like {"hrName":"Anita"}.');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Extra fields must be a JSON object, like {"hrName":"Anita"}.');
  }
  return data;
}

function singleVariables(settings) {
  return {
    ...parseExtraFields(),
    company: els.companyName.value.trim(),
    name: settings.senderName || '',
    email: els.recipientEmail.value.trim()
  };
}

function selectedCv(settings, select) {
  if (select.value === 'none') return { cv: null, error: null };
  const cv = findByName(settings.cvs, select.value);
  if (!cv) return { cv: null, error: 'No CV added yet. Add one in Settings, or choose "No attachment".' };
  return { cv, error: null };
}

async function handlePreview() {
  clearNotification();
  try {
    if (!els.companyName.value.trim()) {
      showNotification('Company name is missing.', 'error');
      return;
    }
    const settings = await getSettingsResolved();
    const vars = singleVariables(settings);
    const missing = findMissingPlaceholders(`${els.emailSubject.value}\n${els.emailTemplate.value}`, vars);
    if (missing.length) {
      showNotification(`Missing field: ${missing.join(', ')}. Add it in Extra fields.`, 'error');
      return;
    }
    els.previewContent.textContent = `Subject: ${renderTemplate(els.emailSubject.value, vars)}\n\n${renderTemplate(els.emailTemplate.value, vars)}`;
    els.previewBox.classList.remove('hidden');
  } catch (err) {
    showNotification(err.message, 'error');
  }
}

function validateSingleForm() {
  if (!currentUserEmail) return 'Please connect your Gmail account first.';
  if (!els.recipientEmail.value.trim()) return 'Recipient email is missing.';
  if (!EMAIL_PATTERN.test(els.recipientEmail.value.trim())) return 'Recipient email does not look valid.';
  if (!els.companyName.value.trim()) return 'Company name is missing.';
  if (!els.emailSubject.value.trim()) return 'Subject is missing.';
  if (!els.emailTemplate.value.trim()) return 'The email text is empty.';
  return null;
}

async function ensureFreshToken() {
  const token = await getAuthToken(true);
  currentToken = token;
  return token;
}

async function handleSend() {
  clearNotification();
  const validationError = validateSingleForm();
  if (validationError) {
    showNotification(validationError, 'error');
    return;
  }

  els.sendBtn.disabled = true;
  els.sendBtn.textContent = 'Sending...';
  try {
    const settings = await getSettingsResolved();
    const blocked = historyBlock((await getSentHistory())[normalizeEmail(els.recipientEmail.value)]);
    if (blocked) {
      showNotification(`${blocked.error} Email was NOT sent.`.replace('.. ', '. '), 'error');
      return;
    }
    if (settings.dailyLimit > 0 && (await getSentToday()) >= settings.dailyLimit) {
      showNotification(`Daily limit of ${settings.dailyLimit} reached. Change it in Settings if you want to send more today.`, 'error');
      return;
    }
    const vars = singleVariables(settings);
    const missing = findMissingPlaceholders(`${els.emailSubject.value}\n${els.emailTemplate.value}`, vars);
    if (missing.length) {
      showNotification(`Missing field: ${missing.join(', ')}. Add it in Extra fields.`, 'error');
      return;
    }
    const { cv, error } = selectedCv(settings, els.singleCvSelect);
    if (error) {
      showNotification(error, 'error');
      return;
    }

    const token = await ensureFreshToken();
    const subject = renderTemplate(els.emailSubject.value, vars).trim();
    const result = await sendEmailWithRetry({
      token,
      fromEmail: currentUserEmail,
      senderName: settings.senderName,
      toEmail: els.recipientEmail.value.trim(),
      subject,
      bodyText: renderTemplate(els.emailTemplate.value, vars),
      attachment: attachmentFromCv(cv)
    });

    await addSentRecord(els.recipientEmail.value, els.companyName.value.trim(), {
      threadId: result.data && result.data.threadId,
      messageId: result.data && result.data.id,
      subject,
      template: els.singleTemplateSelect.value,
      cv: cv ? cv.name : 'none'
    });
    await bumpSentToday();
    refreshHistoryPanel();
    showNotification('Email sent successfully.', 'success');
  } catch (err) {
    showNotification(err.message || 'Unable to send email. Please check Gmail permissions.', 'error');
  } finally {
    els.sendBtn.disabled = false;
    els.sendBtn.textContent = 'Send Email';
  }
}

// Sends an email to YOUR OWN address so you can check wording, CV and layout. Not saved to history.
async function sendTestEmail({ subject, bodyText, cv, settings }) {
  const token = await ensureFreshToken();
  await sendEmailWithRetry({
    token,
    fromEmail: currentUserEmail,
    senderName: settings.senderName,
    toEmail: currentUserEmail,
    subject: `[TEST] ${subject}`,
    bodyText,
    attachment: attachmentFromCv(cv)
  });
  await bumpSentToday();
  showNotification(`Test email sent to ${currentUserEmail}. Check your inbox.`, 'success');
}

async function handleSingleTest() {
  clearNotification();
  if (!currentUserEmail) {
    showNotification('Please connect your Gmail account first.', 'error');
    return;
  }
  els.testSendBtn.disabled = true;
  try {
    const settings = await getSettingsResolved();
    const vars = singleVariables(settings);
    if (!vars.company) vars.company = 'Test Company';
    if (!vars.email) vars.email = currentUserEmail;
    const missing = findMissingPlaceholders(`${els.emailSubject.value}\n${els.emailTemplate.value}`, vars);
    if (missing.length) {
      showNotification(`Missing field: ${missing.join(', ')}. Add it in Extra fields.`, 'error');
      return;
    }
    const { cv, error } = selectedCv(settings, els.singleCvSelect);
    if (error) {
      showNotification(error, 'error');
      return;
    }
    await sendTestEmail({
      subject: renderTemplate(els.emailSubject.value, vars),
      bodyText: renderTemplate(els.emailTemplate.value, vars),
      cv,
      settings
    });
  } catch (err) {
    showNotification(err.message || 'Unable to send the test email.', 'error');
  } finally {
    els.testSendBtn.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* Bulk: preview table                                                 */
/* ------------------------------------------------------------------ */

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
  if (!entry.error) return entry.status === 'Pending' ? 'Ready' : entry.status;
  return entry.status === 'Failed' ? `Failed: ${entry.error}` : entry.error;
}

function buildPill(entry) {
  const pill = document.createElement('span');
  pill.className = `status-pill status-${STATUS_CLASS[entry.status] || 'pending'}`;
  pill.textContent = pillText(entry);
  return pill;
}

function renderPreviewTable() {
  els.bulkTableBody.innerHTML = '';
  const fragment = document.createDocumentFragment();
  previewEntries.forEach((entry, index) => {
    const row = document.createElement('tr');
    const companyCell = document.createElement('td');
    companyCell.textContent = entry.company || '(missing)';
    const emailCell = document.createElement('td');
    emailCell.textContent = entry.email || '(missing)';
    const statusCell = document.createElement('td');
    statusCell.appendChild(buildPill(entry));
    row.append(companyCell, emailCell, statusCell);
    row.dataset.index = String(index);
    fragment.appendChild(row);
  });
  els.bulkTableBody.appendChild(fragment);
}

function updateSummary() {
  const c = { Pending: 0, Failed: 0, 'Already sent': 0, Bounced: 0, Duplicate: 0 };
  previewEntries.forEach((e) => {
    c[e.status] = (c[e.status] || 0) + 1;
  });
  const chips = [
    [`${previewEntries.length} in list`, 'status-duplicate', true],
    [`${c.Pending} to send`, 'status-pending', c.Pending > 0],
    [`${c['Already sent']} already sent`, 'status-already', c['Already sent'] > 0],
    [`${c.Bounced} bounced before`, 'status-bounced', c.Bounced > 0],
    [`${c.Duplicate} duplicate`, 'status-duplicate', c.Duplicate > 0],
    [`${c.Failed} won't send`, 'status-failed', c.Failed > 0]
  ];
  els.bulkSummary.innerHTML = '';
  chips.forEach(([label, cls, show]) => {
    if (!show) return;
    const chip = document.createElement('span');
    chip.className = `chip ${cls}`;
    chip.textContent = label;
    els.bulkSummary.appendChild(chip);
  });
  els.bulkSummary.classList.remove('hidden');
}

function pendingPreviewCount() {
  return previewEntries.filter((e) => e.status === 'Pending').length;
}

function clearPreview() {
  previewEntries = [];
  previewRun++;
  verifying = false;
  els.bulkTableWrap.classList.add('hidden');
  els.bulkSummary.classList.add('hidden');
  els.verifyProgress.textContent = '';
  els.sendAllBtn.disabled = true;
}

async function previewFromText(text) {
  clearNotification();
  const run = ++previewRun;
  els.verifyProgress.textContent = '';

  let history = {};
  let settings;
  try {
    history = await getSentHistory();
    settings = await getSettingsResolved();
  } catch (err) {
    showNotification(err.message, 'error');
    return;
  }

  let entries;
  try {
    entries = parseBulkJson(text, history);
  } catch (err) {
    clearPreview();
    showNotification(err.message, 'error');
    return;
  }
  if (entries.length === 0) {
    clearPreview();
    showNotification('The JSON list is empty.', 'error');
    return;
  }

  resolveBulkEntries(entries, settings, { template: els.bulkTemplateSelect.value, cv: els.bulkCvSelect.value });
  previewEntries = entries;
  renderPreviewTable();
  updateSummary();
  els.bulkTableWrap.classList.remove('hidden');
  els.sendAllBtn.disabled = true; // enabled once the address check has finished

  if (els.verifyDomainsCheck.checked && pendingPreviewCount() > 0) {
    verifying = true;
    els.verifyProgress.textContent = 'Checking domains...';
    try {
      const cache = await getDnsCache();
      await verifyEntries(entries, {
        cache,
        onProgress: (done, total) => {
          if (run === previewRun) els.verifyProgress.textContent = `Checking domains: ${done} / ${total}`;
        }
      });
      await setDnsCache(cache);
    } catch (err) {
      /* a failed check never blocks sending */
    }
    if (run !== previewRun) return; // a newer preview took over
    verifying = false;
    renderPreviewTable();
    updateSummary();
    const flagged = entries.filter((e) => e.status === 'Failed' && /domain|typo/i.test(e.error || '')).length;
    els.verifyProgress.textContent = flagged ? `Domain check: ${flagged} address(es) will not be sent.` : 'Domain check: all good.';
  }

  els.sendAllBtn.disabled = pendingPreviewCount() === 0;
  if (pendingPreviewCount() === 0) {
    showNotification('Nothing to send: every entry is already sent, bounced, a duplicate, or cannot be sent.', 'info');
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

async function handleBulkTest() {
  clearNotification();
  if (!currentUserEmail) {
    showNotification('Please connect your Gmail account first.', 'error');
    return;
  }
  const entry = previewEntries.find((e) => e.status === 'Pending');
  if (!entry) {
    showNotification('Preview a list first. The test uses the first email that is ready to send.', 'error');
    return;
  }
  els.bulkTestBtn.disabled = true;
  try {
    const settings = await getSettingsResolved();
    const template = findByName(settings.templates, entry.template);
    const cv = entry.cv === 'none' ? null : findByName(settings.cvs, entry.cv);
    const vars = { ...entry.fields, company: entry.company, name: settings.senderName || '', email: entry.email };
    await sendTestEmail({
      subject: renderTemplate(template.subject, vars),
      bodyText: renderTemplate(template.body, vars),
      cv,
      settings
    });
  } catch (err) {
    showNotification(err.message || 'Unable to send the test email.', 'error');
  } finally {
    els.bulkTestBtn.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* Confirm dialog + start sending                                      */
/* ------------------------------------------------------------------ */

function openConfirm({ title, text, warn, confirmLabel, onConfirm }) {
  els.confirmModalTitle.textContent = title;
  els.confirmModalText.textContent = text;
  els.confirmModalWarn.textContent = warn || '';
  els.confirmModalWarn.classList.toggle('hidden', !warn);
  els.confirmSendBtn.textContent = confirmLabel;
  confirmAction = onConfirm;
  els.confirmModal.classList.remove('hidden');
}

function closeConfirmModal() {
  els.confirmModal.classList.add('hidden');
  confirmAction = null;
}

function describeDuration(count, settings) {
  const avgSeconds = (settings.delayMin + settings.delayMax) / 2;
  const totalMinutes = Math.ceil((count * avgSeconds) / 60);
  const days = settings.dailyLimit > 0 ? Math.ceil(count / settings.dailyLimit) : 1;
  const time = totalMinutes >= 90 ? `about ${(totalMinutes / 60).toFixed(1)} hours` : `about ${totalMinutes} minute(s)`;
  let text = `Sending takes ${time} in total`;
  if (days > 1) text += `, spread over ${days} days because of your daily limit of ${settings.dailyLimit}`;
  return `${text}. It runs in the background: you can close this window, but Chrome itself must stay open.`;
}

async function handleStartClick() {
  const pending = pendingPreviewCount();
  if (pending === 0 || verifying) return;
  const settings = await getSettingsResolved();
  const skipped = previewEntries.length - pending;
  openConfirm({
    title: 'Start sending?',
    text:
      `This will queue ${pending} email(s)` +
      (skipped ? ` and skip ${skipped} (already sent, bounced, duplicate or cannot be sent)` : '') +
      '.',
    warn: describeDuration(pending, settings),
    confirmLabel: 'Start sending',
    onConfirm: startSending
  });
}

async function startSending() {
  closeConfirmModal();
  clearNotification();
  if (!currentUserEmail) {
    showNotification('Please connect your Gmail account first.', 'error');
    return;
  }
  const jobs = previewEntries
    .filter((e) => e.status === 'Pending')
    .map((e) => ({ kind: 'new', email: e.email, company: e.company, fields: e.fields, template: e.template, cv: e.cv }));
  try {
    const result = await enqueueJobs(jobs);
    kickWorker();
    clearPreview();
    els.bulkJsonInput.value = '';
    els.bulkJsonFile.value = '';
    els.bulkInputInfo.textContent = 'Queued. You can paste another list at any time; it is added to the queue.';
    showNotification(
      `Queued ${result.added} email(s)${result.duplicates ? ` (${result.duplicates} already waiting)` : ''}. Sending continues in the background.`,
      'success'
    );
    renderQueueCard();
  } catch (err) {
    showNotification(err.message || 'Unable to start sending.', 'error');
  }
}

/* ------------------------------------------------------------------ */
/* Queue card                                                          */
/* ------------------------------------------------------------------ */

async function renderQueueCard() {
  const [items, meta, settings, sentToday] = await Promise.all([
    getQueueItems(),
    getQueueMeta(),
    getSettingsResolved(),
    getSentToday()
  ]);
  const c = countQueue(items);
  if (c.total === 0) {
    els.queueCard.classList.add('hidden');
    return;
  }
  els.queueCard.classList.remove('hidden');

  const waiting = c.pending + c.sending;
  const done = c.sent + c.failed + c.skipped + c.cancelled;
  let state;
  if (meta.state === 'paused') {
    state = 'Paused';
  } else if (meta.state === 'running' && waiting > 0) {
    if (meta.waitReason === 'limit') state = `Daily limit reached (${sentToday}/${settings.dailyLimit}). Continues tomorrow`;
    else if (meta.waitReason === 'quota') state = `Gmail limit reached. Retrying at ${new Date(meta.nextSendAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    else if (meta.nextSendAt > Date.now()) state = `Sending: next email in ${Math.ceil((meta.nextSendAt - Date.now()) / 1000)}s`;
    else state = 'Sending...';
  } else {
    state = waiting > 0 ? 'Stopped' : 'Finished';
  }
  els.queueStateText.textContent = state;

  const parts = [`${c.sent} sent`, `${waiting} waiting`];
  if (c.failed) parts.push(`${c.failed} failed`);
  if (c.skipped) parts.push(`${c.skipped} skipped`);
  if (c.cancelled) parts.push(`${c.cancelled} cancelled`);
  els.queueCountsText.textContent = parts.join(' · ');
  els.queueProgressBar.style.width = `${Math.round((done / c.total) * 100)}%`;

  const notes = [`Today: ${sentToday}${settings.dailyLimit > 0 ? ` / ${settings.dailyLimit}` : ''} emails sent.`];
  if (meta.lastError) notes.push(meta.lastError);
  els.queueNote.textContent = notes.join(' ');

  els.pauseBtn.classList.toggle('hidden', meta.state !== 'running' || waiting === 0);
  els.resumeBtn.classList.toggle('hidden', !(waiting > 0 && meta.state !== 'running'));
  els.cancelQueueBtn.classList.toggle('hidden', waiting === 0);
}

async function handlePause() {
  await pauseQueue();
  renderQueueCard();
}

async function handleResume() {
  await resumeQueue();
  kickWorker();
  renderQueueCard();
}

async function handleCancelQueue() {
  const items = await getQueueItems();
  const c = countQueue(items);
  openConfirm({
    title: 'Cancel remaining emails?',
    text: `${c.pending + c.sending} email(s) that have not been sent yet will be cancelled. Emails already sent are not affected.`,
    confirmLabel: 'Cancel remaining',
    onConfirm: async () => {
      closeConfirmModal();
      await cancelRemaining();
      renderQueueCard();
    }
  });
}

/* ------------------------------------------------------------------ */
/* History tab                                                         */
/* ------------------------------------------------------------------ */

async function refreshHistoryPanel() {
  try {
    const [history, settings, items, meta] = await Promise.all([getSentHistory(), getSettingsResolved(), getQueueItems(), getQueueMeta()]);
    const records = Object.values(history);
    els.historyCount.textContent = String(records.length);
    els.historyCountBadge.textContent = String(records.length);
    els.bouncedCount.textContent = String(records.filter((r) => r.status === 'bounced').length);
    els.repliedCount.textContent = String(records.filter((r) => r.repliedAt).length);

    const due = buildFollowUpJobs(history, settings, items, Date.now());
    els.followUpInfo.textContent = due.length
      ? `${due.length} contact(s) have not replied after ${settings.followUpDays}+ days. Follow-ups are sent in the same Gmail thread (max ${settings.maxFollowUps} each).`
      : `Nothing due. A follow-up becomes due ${settings.followUpDays} days after sending if there is no reply.`;
    els.queueFollowUpsBtn.disabled = due.length === 0 || settings.maxFollowUps === 0;
    els.queueFollowUpsBtn.textContent = due.length ? `Queue ${due.length} follow-up(s)` : 'Queue follow-ups';

    els.syncInfo.textContent = meta.lastSyncAt ? `Last synced: ${new Date(meta.lastSyncAt).toLocaleString()}` : 'Not synced yet.';
  } catch (err) {
    /* ignore */
  }
}

// Re-checks the open preview against history (after an import, a bounce check or a sync).
async function applyHistoryToPreview() {
  if (previewEntries.length === 0) return;
  const history = await getSentHistory();
  let changed = 0;
  previewEntries.forEach((entry) => {
    if (entry.status !== 'Pending') return;
    const blocked = historyBlock(history[normalizeEmail(entry.email)]);
    if (blocked) {
      entry.status = blocked.status;
      entry.error = blocked.error;
      changed++;
    }
  });
  if (changed) {
    renderPreviewTable();
    updateSummary();
    els.sendAllBtn.disabled = verifying || pendingPreviewCount() === 0;
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
  const stamp = todayKey();
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
    await refreshHistoryPanel();
    await applyHistoryToPreview();
    showNotification(
      `Loaded ${records.length} record(s): ${result.added} new, ${result.updated} updated, ${result.skipped} already known. History now has ${result.total}.`,
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
  await refreshHistoryPanel();
  showNotification('History cleared.', 'info');
}

async function handleCheckBounces() {
  clearNotification();
  if (!currentUserEmail) {
    showNotification('Please connect your Gmail account first.', 'error');
    return;
  }
  els.checkBouncesBtn.disabled = true;
  els.bounceProgress.textContent = 'Looking for bounce notices and replies in Gmail...';
  try {
    const token = await getAuthToken(true);
    const result = await runChecks(token, (text) => {
      els.bounceProgress.textContent = text;
    });
    els.bounceProgress.textContent = '';
    await refreshHistoryPanel();
    await applyHistoryToPreview();
    const found = [];
    if (result.bounced) found.push(`${result.bounced} new bounce(s)`);
    if (result.replied) found.push(`${result.replied} new repl${result.replied === 1 ? 'y' : 'ies'}`);
    showNotification(
      found.length
        ? `Found ${found.join(' and ')}.`
        : 'Nothing new. Bounces can take a few minutes to arrive. Replies from a different address than the one you wrote to are only found for emails sent with version 1.3 or later.',
      found.length ? 'success' : 'info'
    );
  } catch (err) {
    els.bounceProgress.textContent = '';
    showNotification(err.message || 'Unable to check Gmail.', 'error');
  } finally {
    els.checkBouncesBtn.disabled = false;
  }
}

async function handleMarkBounced() {
  clearNotification();
  const found = els.manualBounceInput.value.match(/[^\s<>()"',;:]+@[^\s<>()"',;:]+\.[^\s<>()"',;:]+/g) || [];
  const emails = [...new Set(found.map((e) => normalizeEmail(e.replace(/\.+$/, ''))))];
  if (emails.length === 0) {
    showNotification('No email addresses found in what you pasted.', 'error');
    return;
  }
  try {
    const newly = await markBounced(emails.map((email) => ({ email, reason: 'address_not_found' })));
    els.manualBounceInput.value = '';
    await refreshHistoryPanel();
    await applyHistoryToPreview();
    showNotification(`Marked ${newly} address(es) as bounced (${emails.length - newly} were already marked).`, 'success');
  } catch (err) {
    showNotification(err.message || 'Unable to save.', 'error');
  }
}

async function handleQueueFollowUps() {
  clearNotification();
  if (!currentUserEmail) {
    showNotification('Please connect your Gmail account first.', 'error');
    return;
  }
  const [history, settings, items] = await Promise.all([getSentHistory(), getSettingsResolved(), getQueueItems()]);
  const jobs = buildFollowUpJobs(history, settings, items, Date.now());
  if (jobs.length === 0) {
    showNotification('No follow-ups are due.', 'info');
    return;
  }
  openConfirm({
    title: 'Send follow-ups?',
    text: `${jobs.length} follow-up email(s) will be queued. Anyone who has replied or bounced is skipped automatically.`,
    warn: describeDuration(jobs.length, settings),
    confirmLabel: 'Queue follow-ups',
    onConfirm: async () => {
      closeConfirmModal();
      const result = await enqueueJobs(jobs);
      kickWorker();
      showNotification(`Queued ${result.added} follow-up(s). Sending continues in the background.`, 'success');
      switchTab('bulk');
    }
  });
}

async function handleSync() {
  clearNotification();
  if (!currentUserEmail) {
    showNotification('Please connect your Gmail account first.', 'error');
    return;
  }
  els.syncBtn.disabled = true;
  els.syncInfo.textContent = 'Syncing...';
  try {
    const result = await syncHistoryWithDrive(true);
    await patchQueueMeta({ lastSyncAt: result.at });
    await refreshHistoryPanel();
    await applyHistoryToPreview();
    showNotification(`Synced. History now has ${result.total} contact(s) (${result.addedFromDrive} new from Google Drive).`, 'success');
  } catch (err) {
    els.syncInfo.textContent = '';
    showNotification(err.message || 'Sync failed.', 'error');
  } finally {
    els.syncBtn.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

function openPage(file) {
  chrome.tabs.create({ url: chrome.runtime.getURL(file) });
}

function attachEventListeners() {
  els.connectBtn.addEventListener('click', handleConnect);
  els.signOutBtn.addEventListener('click', handleSignOut);
  els.openOptionsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());
  els.openTabBtn.addEventListener('click', () => {
    openPage('popup.html?tab=1');
    window.close();
  });
  els.openDashboardBtn.addEventListener('click', () => openPage('dashboard.html'));
  els.openDashboardBtn2.addEventListener('click', () => openPage('dashboard.html'));
  els.queueDashboardBtn.addEventListener('click', () => openPage('dashboard.html'));

  els.tabs.forEach((tab) => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));

  els.singleTemplateSelect.addEventListener('change', loadTemplateIntoSingleForm);
  els.previewBtn.addEventListener('click', handlePreview);
  els.testSendBtn.addEventListener('click', handleSingleTest);
  els.sendBtn.addEventListener('click', handleSend);

  els.validateJsonBtn.addEventListener('click', handleValidateJson);
  els.bulkJsonFile.addEventListener('change', handleBulkFileChange);
  els.bulkTestBtn.addEventListener('click', handleBulkTest);
  els.sendAllBtn.addEventListener('click', handleStartClick);
  els.pauseBtn.addEventListener('click', handlePause);
  els.resumeBtn.addEventListener('click', handleResume);
  els.cancelQueueBtn.addEventListener('click', handleCancelQueue);

  els.confirmCancelBtn.addEventListener('click', closeConfirmModal);
  els.confirmSendBtn.addEventListener('click', () => {
    const action = confirmAction;
    if (action) action();
  });

  els.checkBouncesBtn.addEventListener('click', handleCheckBounces);
  els.markBouncedBtn.addEventListener('click', handleMarkBounced);
  els.queueFollowUpsBtn.addEventListener('click', handleQueueFollowUps);
  els.syncBtn.addEventListener('click', handleSync);
  els.exportHistoryBtn.addEventListener('click', handleExportHistory);
  els.clearHistoryBtn.addEventListener('click', handleClearHistory);
  els.importHistoryFile.addEventListener('change', handleImportHistory);
  els.autoExportCheck.addEventListener('change', () => saveSettings({ autoExportHistory: els.autoExportCheck.checked }));
  els.verifyDomainsCheck.addEventListener('change', () => saveSettings({ verifyDomains: els.verifyDomainsCheck.checked }));
}

// Live updates: the background worker changes storage while this window is open.
let lastFinishedBatchKey = '';
function listenForStorageChanges() {
  if (!chrome.storage.onChanged) return;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area && area !== 'local') return;
    if (changes.queueItems || changes.queueMeta || changes.sentToday) {
      renderQueueCard();
      maybeAutoExport();
    }
    if (changes.sentHistory) refreshHistoryPanel();
  });
}

// When a batch finishes while this window is open, optionally save the history file.
async function maybeAutoExport() {
  const [items, meta, settings] = await Promise.all([getQueueItems(), getQueueMeta(), getSettings()]);
  const c = countQueue(items);
  if (!settings.autoExportHistory || c.total === 0 || c.pending + c.sending > 0 || meta.state !== 'idle' || c.sent === 0) return;
  const key = `${meta.startedAt || 0}:${c.sent}`;
  if (key === lastFinishedBatchKey) return;
  lastFinishedBatchKey = key;
  await downloadHistoryFile();
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
  await populateSelects();
  await loadTemplateIntoSingleForm();
  const settings = await getSettings();
  els.autoExportCheck.checked = settings.autoExportHistory !== false;
  els.verifyDomainsCheck.checked = settings.verifyDomains !== false;
  await refreshHistoryPanel();
  await renderQueueCard();
  listenForStorageChanges();
  queueTimer = setInterval(() => {
    if (!els.bulkPanel.classList.contains('hidden')) renderQueueCard();
  }, 2000);
}

document.addEventListener('DOMContentLoaded', init);
