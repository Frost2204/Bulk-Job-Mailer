const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

function getAuthToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        const message = chrome.runtime.lastError
          ? chrome.runtime.lastError.message
          : 'Google authentication was cancelled.';
        reject(new Error(message));
        return;
      }
      resolve(token);
    });
  });
}

function removeCachedAuthToken(token) {
  return new Promise((resolve) => {
    if (!token) {
      resolve();
      return;
    }
    chrome.identity.removeCachedAuthToken({ token }, () => resolve());
  });
}

function revokeGoogleToken(token) {
  return fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  }).catch(() => {});
}

async function fetchAuthenticatedUserEmail(token) {
  const response = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    throw new Error('Unable to retrieve your Gmail address. Please reconnect Gmail.');
  }
  const data = await response.json();
  if (!data.email) {
    throw new Error('Unable to retrieve your Gmail address. Please reconnect Gmail.');
  }
  return data.email;
}

async function signInToGmail() {
  const token = await getAuthToken(true);
  const email = await fetchAuthenticatedUserEmail(token);
  return { token, email };
}

async function signOutOfGmail() {
  let token = null;
  try {
    token = await getAuthToken(false);
  } catch (err) {
    token = null;
  }
  await removeCachedAuthToken(token);
  if (token) {
    await revokeGoogleToken(token);
  }
}

function base64UrlEncode(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function stringToUtf8Bytes(str) {
  return new TextEncoder().encode(str);
}

function binaryStringFromBytes(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return binary;
}

function encodeBase64FromBinaryString(binaryString) {
  return btoa(binaryString);
}

function foldBase64(base64String) {
  const chunks = [];
  for (let i = 0; i < base64String.length; i += 76) {
    chunks.push(base64String.substring(i, i + 76));
  }
  return chunks.join('\r\n');
}

function buildMimeMessage({ fromEmail, senderName, toEmail, subject, bodyText, attachment }) {
  const boundary = `unity_job_mailer_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const fromHeader = senderName
    ? `${senderName.replace(/"/g, '')} <${fromEmail}>`
    : fromEmail;

  const encodedSubject = `=?UTF-8?B?${btoa(unescape(encodeURIComponent(subject)))}?=`;

  const headers = [
    `From: ${fromHeader}`,
    `To: ${toEmail}`,
    `Subject: ${encodedSubject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`
  ].join('\r\n');

  const bodyPart = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    foldBase64(btoa(binaryStringFromBytes(stringToUtf8Bytes(bodyText)))),
    ''
  ].join('\r\n');

  let attachmentPart = '';
  if (attachment && attachment.base64Data) {
    const foldedData = foldBase64(attachment.base64Data);
    attachmentPart = [
      `--${boundary}`,
      `Content-Type: ${attachment.mimeType || 'application/pdf'}; name="${attachment.fileName}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${attachment.fileName}"`,
      '',
      foldedData,
      ''
    ].join('\r\n');
  }

  const closing = `--${boundary}--`;

  const rawMessage = `${headers}\r\n\r\n${bodyPart}${attachmentPart}${closing}`;
  return base64UrlEncode(stringToUtf8Bytes(rawMessage));
}

async function sendGmailMessage({ token, fromEmail, senderName, toEmail, subject, bodyText, attachment }) {
  const raw = buildMimeMessage({ fromEmail, senderName, toEmail, subject, bodyText, attachment });

  const response = await fetch(GMAIL_SEND_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ raw })
  });

  if (response.status === 401) {
    throw new Error('TOKEN_EXPIRED');
  }

  if (!response.ok) {
    let details = '';
    let reason = '';
    try {
      const errorBody = await response.json();
      details = errorBody && errorBody.error ? errorBody.error.message : '';
      reason = errorBody && errorBody.error && errorBody.error.errors && errorBody.error.errors[0]
        ? errorBody.error.errors[0].reason || ''
        : '';
    } catch (err) {
      details = '';
    }
    const isQuota =
      response.status === 429 ||
      (response.status === 403 && /rate|quota|limit/i.test(`${reason} ${details}`));
    const error = new Error(
      isQuota
        ? `Gmail sending limit reached. (${details || 'rate limited'})`
        : details
          ? `Unable to send email. Please check Gmail permissions. (${details})`
          : 'Unable to send email. Please check Gmail permissions.'
    );
    error.isQuota = isQuota;
    throw error;
  }

  return response.json();
}

// Returns { data, token }. Use the returned token for the next send so a refreshed
// token is not thrown away during a long bulk run.
async function sendEmailWithRetry(params) {
  try {
    const data = await sendGmailMessage(params);
    return { data, token: params.token };
  } catch (err) {
    if (err.message === 'TOKEN_EXPIRED') {
      await removeCachedAuthToken(params.token);
      const freshToken = await getAuthToken(true);
      const data = await sendGmailMessage({ ...params, token: freshToken });
      return { data, token: freshToken };
    }
    throw err;
  }
}


/* ------------------------------------------------------------------ */
/* Bounce detection (needs the gmail.readonly scope)                   */
/* Gmail accepts a message first and reports bad addresses later by    */
/* mailing a "Delivery Status Notification" to your inbox. We read     */
/* only those mailer-daemon messages.                                  */
/* ------------------------------------------------------------------ */

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

const MISSING_READ_PERMISSION =
  'Gmail read permission is missing. Click Sign Out, add the "gmail.readonly" scope in Google Cloud (see README), then Connect Gmail again.';

async function gmailGetJson(state, path) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(`${GMAIL_API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${state.token}` }
    });
    if (response.ok) {
      return response.json();
    }
    let details = '';
    try {
      const body = await response.json();
      details = body && body.error ? body.error.message : '';
    } catch (err) {
      details = '';
    }
    const missingScope = response.status === 403 && /insufficient|scope/i.test(details);
    if ((response.status === 401 || missingScope) && attempt === 0) {
      // Drop the cached token and ask Chrome for a new one (re-prompts if the scope is new).
      await removeCachedAuthToken(state.token);
      state.token = await getAuthToken(true);
      continue;
    }
    if (missingScope) {
      throw new Error(MISSING_READ_PERMISSION);
    }
    throw new Error(details || `Gmail request failed (${response.status}).`);
  }
  throw new Error('Gmail request failed.');
}

function classifyBounceReason(text) {
  const notFound =
    /address (couldn't|could not|not) be found|unable to receive mail|doesn't exist|does not exist|no such user|user unknown|unknown user|recipient not found|invalid (recipient|address)|domain (name )?(not found|couldn't be found|could not be found)|nxdomain|5\.1\.1/i;
  return notFound.test(text || '') ? 'address_not_found' : 'delivery_failed';
}

// Returns [{ email, reason, bouncedAt }] for one mailer-daemon message (empty if it is not a failure).
function parseBounceMessage(message, knownEmails) {
  const headers = (message.payload && message.payload.headers) || [];
  const header = (name) => {
    const found = headers.find((h) => h.name.toLowerCase() === name);
    return found ? found.value : '';
  };

  const subject = header('subject');
  if (/\(delay\)|delayed|warning/i.test(subject)) {
    return []; // temporary problem, Gmail is still retrying
  }

  const snippet = message.snippet || '';
  const reason = classifyBounceReason(snippet);
  const bouncedAt = message.internalDate
    ? new Date(Number(message.internalDate)).toISOString()
    : new Date().toISOString();

  let emails = header('x-failed-recipients')
    .split(/[,\s;]+/)
    .map(normalizeEmail)
    .filter((e) => e.includes('@'));

  if (emails.length === 0) {
    // Fallback: only trust addresses we know we emailed, to avoid false positives.
    const found = snippet.match(/[^\s<>()"',;:]+@[^\s<>()"',;:]+\.[^\s<>()"',;:]+/g) || [];
    emails = found.map((e) => normalizeEmail(e.replace(/\.+$/, ''))).filter((e) => knownEmails[e]);
  }

  return emails.map((email) => ({ email, reason, bouncedAt }));
}

async function scanBounces({ token, query, knownEmails, onProgress }) {
  const state = { token };
  const ids = [];
  let pageToken = '';
  do {
    const page = await gmailGetJson(
      state,
      `/messages?maxResults=500&q=${encodeURIComponent(query)}${pageToken ? `&pageToken=${pageToken}` : ''}`
    );
    (page.messages || []).forEach((m) => ids.push(m.id));
    pageToken = page.nextPageToken || '';
  } while (pageToken && ids.length < 3000);

  const bounces = [];
  let cursor = 0;
  let done = 0;
  const worker = async () => {
    while (cursor < ids.length) {
      const id = ids[cursor++];
      const message = await gmailGetJson(
        state,
        `/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=X-Failed-Recipients`
      );
      bounces.push(...parseBounceMessage(message, knownEmails));
      done++;
      if (onProgress) onProgress(done, ids.length);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker(), worker()]);
  return { token: state.token, scanned: ids.length, bounces };
}
