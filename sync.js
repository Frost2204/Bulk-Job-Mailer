/*
 * Keeps your sent history in step across computers using a hidden file in YOUR OWN Google Drive
 * ("app data" folder; only this extension can see it, it does not show up in your Drive).
 * Needs the drive.appdata scope and the Google Drive API enabled in your Cloud project.
 */

const SYNC_FILE_NAME = 'job-mailer-history.json';
const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';

async function driveRequest(state, url, options) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(url, {
      ...options,
      headers: { ...(options && options.headers), Authorization: `Bearer ${state.token}` }
    });
    if (response.ok) return response;
    let details = '';
    try {
      const body = await response.json();
      details = body && body.error ? body.error.message : '';
    } catch (err) {
      details = '';
    }
    const missingScope = response.status === 403 && /insufficient|scope/i.test(details);
    if ((response.status === 401 || missingScope) && attempt === 0) {
      await removeCachedAuthToken(state.token);
      state.token = await getAuthToken(state.interactive !== false);
      continue;
    }
    if (missingScope) {
      throw new Error('Google Drive permission is missing. Click Sign Out, add the "drive.appdata" scope in Google Cloud (see README), then Connect Gmail again.');
    }
    if (response.status === 403 && /not been used|disabled/i.test(details)) {
      throw new Error('The Google Drive API is not enabled in your Google Cloud project (APIs & Services > Library > Google Drive API > Enable).');
    }
    throw new Error(details || `Google Drive request failed (${response.status}).`);
  }
  throw new Error('Google Drive request failed.');
}

async function findSyncFileId(state) {
  const q = encodeURIComponent(`name='${SYNC_FILE_NAME}'`);
  const response = await driveRequest(state, `${DRIVE_FILES_URL}?spaces=appDataFolder&q=${q}&fields=files(id,name)`);
  const body = await response.json();
  return body.files && body.files[0] ? body.files[0].id : null;
}

async function uploadSyncFile(state, fileId, content) {
  if (fileId) {
    await driveRequest(state, `${DRIVE_UPLOAD_URL}/${fileId}?uploadType=media`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: content
    });
    return fileId;
  }
  const boundary = `sync_${Date.now()}`;
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify({ name: SYNC_FILE_NAME, parents: ['appDataFolder'] }) +
    `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${boundary}--`;
  const response = await driveRequest(state, `${DRIVE_UPLOAD_URL}?uploadType=multipart&fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body
  });
  return (await response.json()).id;
}

// Merges two history maps record by record (see mergeRecord in storage.js).
function mergeHistoryMaps(local, remote) {
  const out = {};
  const keys = new Set([...Object.keys(local), ...Object.keys(remote)]);
  keys.forEach((key) => {
    out[key] = mergeRecord(local[key], remote[key]);
  });
  return out;
}

// interactive=true lets Google show the permission screen (only from a page the user clicked in).
async function syncHistoryWithDrive(interactive) {
  const state = { token: await getAuthToken(!!interactive), interactive: !!interactive };
  const fileId = await findSyncFileId(state);

  let remote = {};
  if (fileId) {
    const response = await driveRequest(state, `${DRIVE_FILES_URL}/${fileId}?alt=media`);
    const text = await response.text();
    try {
      parseHistoryImport(text).forEach((rec) => {
        remote[rec.email] = rec;
      });
    } catch (err) {
      remote = {}; // unreadable remote copy: it gets replaced by the merged one below
    }
  }

  // Merge and save under the history lock so a send happening right now is not lost.
  const result = await updateHistory((local) => {
    const merged = mergeHistoryMaps(local, remote);
    const before = Object.keys(local).length;
    Object.keys(local).forEach((k) => delete local[k]);
    Object.assign(local, merged);
    return { total: Object.keys(merged).length, addedFromDrive: Object.keys(merged).length - before, merged };
  });

  await uploadSyncFile(state, fileId, JSON.stringify(buildHistoryExport(result.merged)));
  return { total: result.total, addedFromDrive: result.addedFromDrive, at: Date.now() };
}
