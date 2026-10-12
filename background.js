// Service worker: keeps sending in the background, even when the popup is closed.
importScripts('storage.js', 'template.js', 'gmail.js', 'verify.js', 'sync.js', 'queue.js');

const ALARM_NAME = 'jobMailerTick';

function ensureAlarm() {
  chrome.alarms.get(ALARM_NAME, (existing) => {
    if (!existing) {
      chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 }); // Chrome may round this up to 1 minute
    }
  });
}

// During the delay between emails, touching an extension API stops Chrome from putting the worker to sleep.
async function sleepKeepAlive(ms) {
  let remaining = ms;
  while (remaining > 0) {
    const step = Math.min(remaining, 20000);
    await new Promise((resolve) => setTimeout(resolve, step));
    remaining -= step;
    try {
      await chrome.runtime.getPlatformInfo();
    } catch (err) {
      /* ignore */
    }
  }
}

const workerEnv = {
  now: () => Date.now(),
  sleep: sleepKeepAlive,
  getToken: () => getAuthToken(false),
  random: () => Math.random(),
  sliceMs: SLICE_MS,
  setBadge: (text) => {
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color: '#0d9488' });
  }
};

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    await runTick(workerEnv);
  } catch (err) {
    console.error('Job Mailer tick failed:', err);
  } finally {
    ticking = false;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  tick();
});
chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  tick();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) tick();
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'kick') {
    ensureAlarm();
    tick();
    sendResponse({ ok: true });
  }
  return false;
});

ensureAlarm();
