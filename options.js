const els = {};
let templates = [];
let cvs = [];
let notificationTimer = null;

function cacheElements() {
  [
    'notification', 'senderName', 'dailyLimit', 'delayMin', 'delayMax', 'templateList', 'addTemplateBtn', 'cvList',
    'cvFile', 'followUpDays', 'maxFollowUps', 'followUpTemplate', 'autoCheck', 'autoSync', 'verifyDomains',
    'saveBtn', 'clearBtn'
  ].forEach((id) => {
    els[id] = document.getElementById(id);
  });
}

function showNotification(message, type) {
  els.notification.textContent = message;
  els.notification.className = `notification ${type}`;
  clearTimeout(notificationTimer);
  notificationTimer = setTimeout(() => {
    els.notification.className = 'notification hidden';
  }, 5000);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Unable to read the selected file.'));
    reader.readAsDataURL(file);
  });
}

function makeId() {
  return `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function el(tag, props, children) {
  const node = document.createElement(tag);
  Object.assign(node, props || {});
  (children || []).forEach((c) => node.appendChild(c));
  return node;
}

/* ---------------- templates ---------------- */

function renderTemplates() {
  els.templateList.innerHTML = '';
  templates.forEach((template, index) => {
    const nameInput = el('input', { type: 'text', value: template.name, placeholder: 'Template name (e.g. unity)' });
    nameInput.addEventListener('input', () => {
      template.name = nameInput.value;
    });

    const head = el('div', { className: 'item-head' }, [nameInput]);
    if (index === 0) head.appendChild(el('span', { className: 'badge-default', textContent: 'DEFAULT' }));
    if (templates.length > 1) {
      const del = el('button', { type: 'button', className: 'btn btn-danger btn-small', textContent: 'Delete' });
      del.addEventListener('click', () => {
        templates.splice(index, 1);
        renderTemplates();
      });
      head.appendChild(del);
    }

    const subject = el('input', { type: 'text', value: template.subject, placeholder: 'Subject, e.g. Application for Unity Developer - {{company}}' });
    subject.addEventListener('input', () => {
      template.subject = subject.value;
    });
    const body = el('textarea', { rows: 8, value: template.body });
    body.addEventListener('input', () => {
      template.body = body.value;
    });

    els.templateList.appendChild(
      el('div', { className: 'item' }, [
        head,
        el('label', { className: 'field' }, [el('span', { textContent: 'Subject' }), subject]),
        el('label', { className: 'field' }, [el('span', { textContent: 'Email text' }), body])
      ])
    );
  });
}

function addTemplate() {
  const base = templates[0] || { subject: '', body: '' };
  templates.push({ id: makeId(), name: `template${templates.length + 1}`, subject: base.subject, body: base.body });
  renderTemplates();
}

/* ---------------- CVs ---------------- */

function renderCvs() {
  els.cvList.innerHTML = '';
  if (cvs.length === 0) {
    els.cvList.appendChild(el('p', { className: 'hint', textContent: 'No CV uploaded yet.' }));
    return;
  }
  cvs.forEach((cv, index) => {
    const nameInput = el('input', { type: 'text', value: cv.name, placeholder: 'CV name' });
    nameInput.addEventListener('input', () => {
      cv.name = nameInput.value;
    });
    const row = el('div', { className: 'cv-row' }, [nameInput, el('span', { className: 'cv-file', textContent: cv.fileName })]);
    if (index === 0) row.appendChild(el('span', { className: 'badge-default', textContent: 'DEFAULT' }));
    const del = el('button', { type: 'button', className: 'btn btn-danger btn-small', textContent: 'Delete' });
    del.addEventListener('click', () => {
      cvs.splice(index, 1);
      renderCvs();
    });
    row.appendChild(del);
    els.cvList.appendChild(row);
  });
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
    const data = await readFileAsDataUrl(file);
    const suggested = file.name.replace(/\.pdf$/i, '').replace(/\s+/g, '-').toLowerCase();
    cvs.push({ id: makeId(), name: suggested, fileName: file.name, data });
    els.cvFile.value = '';
    renderCvs();
  } catch (err) {
    showNotification(err.message, 'error');
  }
}

/* ---------------- load / save ---------------- */

async function loadSettingsIntoForm() {
  const s = await getSettingsResolved();
  els.senderName.value = s.senderName || '';
  els.dailyLimit.value = s.dailyLimit;
  els.delayMin.value = s.delayMin;
  els.delayMax.value = s.delayMax;
  els.followUpDays.value = s.followUpDays;
  els.maxFollowUps.value = s.maxFollowUps;
  els.followUpTemplate.value = s.followUpTemplate || '';
  els.autoCheck.checked = s.autoCheck !== false;
  els.autoSync.checked = !!s.autoSync;
  els.verifyDomains.checked = s.verifyDomains !== false;
  templates = s.templates.map((t) => ({ ...t }));
  cvs = s.cvs.map((c) => ({ ...c }));
  renderTemplates();
  renderCvs();
}

function validateNames(list, label) {
  const seen = new Set();
  for (const item of list) {
    const name = String(item.name || '').trim();
    if (!name) return `Every ${label} needs a name.`;
    if (name.toLowerCase() === 'none' && label === 'CV') return 'A CV cannot be named "none" (that word means "no attachment").';
    if (seen.has(name.toLowerCase())) return `Two ${label}s are named "${name}". Names must be different.`;
    seen.add(name.toLowerCase());
  }
  return null;
}

async function handleSave() {
  if (!els.senderName.value.trim()) {
    showNotification('Sender Name is required.', 'error');
    return;
  }
  if (templates.length === 0) {
    showNotification('Add at least one email template.', 'error');
    return;
  }
  const nameError = validateNames(templates, 'template') || validateNames(cvs, 'CV');
  if (nameError) {
    showNotification(nameError, 'error');
    return;
  }
  const emptyTemplate = templates.find((t) => !t.subject.trim() || !t.body.trim());
  if (emptyTemplate) {
    showNotification(`Template "${emptyTemplate.name}" needs a subject and some text.`, 'error');
    return;
  }

  const num = (el, fallback, min) => {
    const v = Number(el.value);
    return Number.isFinite(v) && v >= min ? v : fallback;
  };
  const delayMin = num(els.delayMin, 20, 1);
  const delayMax = Math.max(delayMin, num(els.delayMax, 60, 1));

  try {
    await saveSettings({
      senderName: els.senderName.value.trim(),
      templates: templates.map((t) => ({ id: t.id, name: t.name.trim(), subject: t.subject.trim(), body: t.body })),
      cvs: cvs.map((c) => ({ id: c.id, name: c.name.trim(), fileName: c.fileName, data: c.data })),
      dailyLimit: num(els.dailyLimit, 400, 0),
      delayMinSeconds: delayMin,
      delayMaxSeconds: delayMax,
      followUpDays: num(els.followUpDays, 5, 1),
      maxFollowUps: num(els.maxFollowUps, 1, 0),
      followUpTemplate: els.followUpTemplate.value,
      autoCheck: els.autoCheck.checked,
      autoSync: els.autoSync.checked,
      verifyDomains: els.verifyDomains.checked
    });
    await loadSettingsIntoForm();
    showNotification('Settings saved.', 'success');
  } catch (err) {
    showNotification(err.message || 'Unable to save settings.', 'error');
  }
}

async function handleClear() {
  const confirmed = window.confirm('This will clear all saved settings, including templates and CVs. Your sent history is kept. Continue?');
  if (!confirmed) return;
  try {
    await clearSettings();
    await loadSettingsIntoForm();
    showNotification('Settings cleared.', 'success');
  } catch (err) {
    showNotification(err.message || 'Unable to clear settings.', 'error');
  }
}

async function init() {
  cacheElements();
  els.cvFile.addEventListener('change', handleCvFileChange);
  els.addTemplateBtn.addEventListener('click', addTemplate);
  els.saveBtn.addEventListener('click', handleSave);
  els.clearBtn.addEventListener('click', handleClear);
  await loadSettingsIntoForm();
}

document.addEventListener('DOMContentLoaded', init);
