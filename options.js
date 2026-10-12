const els = {};
let pendingCvName = '';
let pendingCvData = '';

function cacheElements() {
  els.notification = document.getElementById('notification');
  els.senderName = document.getElementById('senderName');
  els.defaultSubject = document.getElementById('defaultSubject');
  els.defaultTemplate = document.getElementById('defaultTemplate');
  els.cvFile = document.getElementById('cvFile');
  els.cvStatusText = document.getElementById('cvStatusText');
  els.sendDelaySeconds = document.getElementById('sendDelaySeconds');
  els.saveBtn = document.getElementById('saveBtn');
  els.clearBtn = document.getElementById('clearBtn');
}

function showNotification(message, type) {
  els.notification.textContent = message;
  els.notification.className = `notification ${type}`;
  setTimeout(() => {
    els.notification.className = 'notification hidden';
  }, 4000);
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Unable to read the selected file.'));
    reader.readAsDataURL(file);
  });
}

async function loadSettingsIntoForm() {
  const settings = await getSettings();
  els.senderName.value = settings.senderName || '';
  els.defaultSubject.value = settings.defaultSubject || '';
  els.defaultTemplate.value = settings.defaultTemplate || '';
  els.sendDelaySeconds.value = settings.sendDelaySeconds || 5;

  pendingCvName = settings.cvName || '';
  pendingCvData = settings.cvData || '';
  updateCvStatusText();
}

function updateCvStatusText() {
  els.cvStatusText.textContent = pendingCvName
    ? `Current CV: ${pendingCvName}`
    : 'No CV uploaded yet.';
}

async function handleCvFileChange() {
  const file = els.cvFile.files[0];
  if (!file) return;

  if (file.type !== 'application/pdf') {
    showNotification('Please upload a PDF file.', 'error');
    els.cvFile.value = '';
    return;
  }

  try {
    const dataUrl = await readFileAsDataUrl(file);
    pendingCvName = file.name;
    pendingCvData = dataUrl;
    updateCvStatusText();
  } catch (err) {
    showNotification(err.message, 'error');
  }
}

async function handleSave() {
  if (!els.senderName.value.trim()) {
    showNotification('Sender Name is required.', 'error');
    return;
  }
  if (!els.defaultTemplate.value.trim()) {
    showNotification('Default Email Template is required.', 'error');
    return;
  }

  const delayValue = Number(els.sendDelaySeconds.value);
  const delaySeconds = Number.isFinite(delayValue) && delayValue > 0 ? delayValue : 5;

  try {
    await saveSettings({
      senderName: els.senderName.value.trim(),
      defaultSubject: els.defaultSubject.value.trim(),
      defaultTemplate: els.defaultTemplate.value,
      cvName: pendingCvName,
      cvData: pendingCvData,
      sendDelaySeconds: delaySeconds
    });
    showNotification('Settings saved.', 'success');
  } catch (err) {
    showNotification(err.message || 'Unable to save settings.', 'error');
  }
}

async function handleClear() {
  const confirmed = window.confirm('This will clear all saved settings, including your CV. Continue?');
  if (!confirmed) return;

  try {
    await clearSettings();
    pendingCvName = '';
    pendingCvData = '';
    els.cvFile.value = '';
    await loadSettingsIntoForm();
    showNotification('Settings cleared.', 'success');
  } catch (err) {
    showNotification(err.message || 'Unable to clear settings.', 'error');
  }
}

function attachEventListeners() {
  els.cvFile.addEventListener('change', handleCvFileChange);
  els.saveBtn.addEventListener('click', handleSave);
  els.clearBtn.addEventListener('click', handleClear);
}

async function init() {
  cacheElements();
  attachEventListeners();
  await loadSettingsIntoForm();
}

document.addEventListener('DOMContentLoaded', init);
