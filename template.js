const PLACEHOLDER = /{{\s*([\w.-]+)\s*(?:\|([^}]*))?}}/g;

function lowerKeys(variables) {
  const out = {};
  Object.keys(variables || {}).forEach((k) => {
    out[k.toLowerCase()] = variables[k];
  });
  return out;
}

/*
 * Replaces {{field}} with a value. Works for company / name / email and for ANY extra field
 * from the JSON entry (e.g. {{hrName}}). {{hrName|Hiring Team}} uses the text after | when
 * the field is empty or missing. A field that is unknown and has no fallback is left as-is
 * (see findMissingPlaceholders).
 */
function renderTemplate(template, variables) {
  const vars = lowerKeys(variables);
  return String(template || '').replace(PLACEHOLDER, (match, key, fallback) => {
    const name = key.toLowerCase();
    const has = Object.prototype.hasOwnProperty.call(vars, name);
    const value = has && vars[name] !== undefined && vars[name] !== null ? String(vars[name]) : '';
    if (value.trim() !== '') return value;
    if (fallback !== undefined) return fallback.trim();
    return has ? '' : match;
  });
}

// Names of {{fields}} that have no value and no fallback, so the email would go out with "{{field}}" in it.
function findMissingPlaceholders(text, variables) {
  const vars = lowerKeys(variables);
  const missing = new Set();
  String(text || '').replace(PLACEHOLDER, (match, key, fallback) => {
    if (fallback === undefined && !Object.prototype.hasOwnProperty.call(vars, key.toLowerCase())) {
      missing.add(key);
    }
    return match;
  });
  return [...missing];
}

const EMAIL_PATTERN = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

function pickField(entry, names) {
  if (!entry || typeof entry !== 'object') return '';
  for (const key of Object.keys(entry)) {
    if (names.includes(key.toLowerCase())) {
      const value = entry[key];
      return value === null || value === undefined ? '' : String(value).trim();
    }
  }
  return '';
}

function validateBulkEntry(email, company) {
  if (!email || !EMAIL_PATTERN.test(email)) {
    return 'Recipient email is missing or invalid.';
  }
  if (!company) {
    return 'Company name is missing.';
  }
  return null;
}

/*
 * Lenient JSON reader. Accepts:
 *   [ {...}, {...} ]            normal array
 *   { "recipients": [ ... ] }   object holding an array
 *   {...}, {...}                list pasted without the [ ]
 *   {...}\n{...}                one object per line (JSONL)
 * Also tolerates a trailing comma, a BOM and ``` code fences.
 */
function readLooseJson(rawText) {
  let text = String(rawText || '')
    .replace(/^\uFEFF/, '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();

  if (!text) {
    throw new Error('Nothing to read. Paste JSON or upload a .json file.');
  }

  let firstError;
  try {
    return JSON.parse(text);
  } catch (err) {
    firstError = err;
  }

  const trimmed = text.replace(/[,\s]+$/, '');
  const noTrailingCommas = (str) => str.replace(/,\s*([\]}])/g, '$1');
  const attempts = [
    () => JSON.parse(noTrailingCommas(trimmed)),
    () => JSON.parse(`[${noTrailingCommas(trimmed)}]`),
    () => JSON.parse(`[${trimmed.replace(/}\s*{/g, '},{')}]`),
    () => trimmed.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line.replace(/,\s*$/, '')))
  ];
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    for (const attempt of attempts) {
      try {
        return attempt();
      } catch (err) {
        /* try next */
      }
    }
  }
  throw new Error(`Invalid JSON: ${firstError.message}`);
}

function extractEntryList(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    const arrayValue = Object.values(parsed).find((value) => Array.isArray(value));
    if (arrayValue) return arrayValue;
    return [parsed];
  }
  throw new Error('Invalid JSON format. Expected an array of objects.');
}

/*
 * Turns a history record into a skip reason, or null if the address is free to email.
 * Status values used by the UI: Already sent | Bounced
 */
function historyBlock(record) {
  if (!record) return null;
  if (record.status === 'bounced') {
    const when = record.bouncedAt ? new Date(record.bouncedAt).toLocaleDateString() : '';
    const why = record.bounceReason === 'address_not_found' ? 'address does not exist' : 'delivery failed';
    return { status: 'Bounced', error: `Bounced last time: ${why}${when ? ` (${when})` : ''}. Not sent.` };
  }
  const when = record.sentAt ? new Date(record.sentAt).toLocaleDateString() : '';
  return { status: 'Already sent', error: `Already sent previously${when ? ` (${when})` : ''}` };
}

/*
 * historyMap: result of getSentHistory(), used to flag already-sent emails.
 * Status values: Pending | Failed | Already sent | Bounced | Duplicate
 */
function parseBulkJson(rawText, historyMap) {
  const list = extractEntryList(readLooseJson(rawText));
  const history = historyMap || {};
  const seen = new Set();

  return list.map((entry) => {
    const email = pickField(entry, ['email', 'mail', 'to', 'recipient', 'emailid', 'email_id']);
    const company = pickField(entry, ['company', 'companyname', 'company_name', 'organization']);
    const key = normalizeEmail(email);

    const fields = {};
    if (entry && typeof entry === 'object') {
      Object.keys(entry).forEach((k) => {
        const v = entry[k];
        if (v !== null && v !== undefined && typeof v !== 'object') fields[k] = String(v).trim();
      });
    }
    const base = {
      email,
      company,
      template: pickField(entry, ['template', 'templatename']),
      cv: pickField(entry, ['cv', 'resume', 'cvname']),
      fields,
      kind: 'new',
      status: 'Pending',
      error: null
    };

    const invalid = validateBulkEntry(email, company);
    if (invalid) {
      return { ...base, status: 'Failed', error: invalid };
    }
    const blocked = historyBlock(history[key]);
    if (blocked) {
      return { ...base, status: blocked.status, error: blocked.error };
    }
    if (seen.has(key)) {
      return { ...base, status: 'Duplicate', error: 'Duplicate of an earlier row in this list' };
    }
    seen.add(key);
    return base;
  });
}


/*
 * Chooses the template + CV for each Pending entry and makes sure the email can really be built.
 * An entry may name its own with "template": "unity" and "cv": "unity" ("cv": "none" = no attachment).
 * Anything that cannot be built is marked Failed with the reason, so it is never sent half-filled.
 */
function resolveBulkEntries(entries, settings, defaults) {
  const dflt = defaults || {};
  entries.forEach((entry) => {
    if (entry.status !== 'Pending') return;

    const templateName = entry.template || dflt.template || '';
    const template = findByName(settings.templates, templateName);
    if (!template) {
      entry.status = 'Failed';
      entry.error = `Unknown template "${templateName}"`;
      return;
    }

    const cvName = entry.cv || dflt.cv || '';
    let cv = null;
    if (String(cvName).toLowerCase() !== 'none') {
      cv = findByName(settings.cvs, cvName);
      if (!cv) {
        entry.status = 'Failed';
        entry.error = cvName ? `Unknown CV "${cvName}"` : 'No CV added yet (add one in Settings)';
        return;
      }
    }

    const vars = { ...entry.fields, company: entry.company, name: settings.senderName || '', email: entry.email };
    const missing = findMissingPlaceholders(`${template.subject}\n${template.body}`, vars);
    if (missing.length) {
      entry.status = 'Failed';
      entry.error = `Missing field: ${missing.join(', ')}`;
      return;
    }

    entry.template = template.name;
    entry.cv = cv ? cv.name : 'none';
  });
  return entries;
}
