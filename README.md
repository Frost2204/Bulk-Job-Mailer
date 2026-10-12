# Unity Job Mailer

A private, personal Chrome Extension (Manifest V3) for sending Unity job
application emails directly through **your own Gmail account**, using the
official Gmail API and Google OAuth 2.0.

It does **not**:
- Store your Gmail password.
- Use any third-party email-sending service.
- Use a backend server.
- Contain any hardcoded OAuth client secrets, access tokens, or refresh
  tokens.

All emails are sent directly from your browser to Google's Gmail API using a
token issued by Chrome's built-in `chrome.identity` API.

> **Note on the CV file:** your CV is uploaded from the Settings page and
> stored locally in the extension's `chrome.storage.local` (never uploaded
> anywhere else). It is not bundled as a static `assets/cv.pdf` file in the
> package, because a personal document like your CV should never ship inside
> a shareable ZIP. The `assets/` folder only contains the extension icons.

---

## 1. Project Structure

```
├── manifest.json      Manifest V3 configuration (permissions, OAuth scopes, background worker)
├── background.js      Service worker: sends from the queue in the background, auto-checks bounces/replies
├── queue.js           Queue engine: daily limit, random delay, follow-ups, check scheduling
├── popup.html/.css/.js     Popup + full-tab mailer (single email, bulk JSON, history)
├── dashboard.html/.css/.js All companies, statuses, filters, follow-ups, CSV download
├── options.html/.css/.js   Settings (templates, CVs, limits, follow-up text, automation)
├── gmail.js           Gmail API, OAuth, MIME, bounce + reply scanning
├── storage.js         Settings, locks, sent history, merge logic
├── template.js        {{fields}}, JSON reading, template/CV resolution
├── verify.js          Address check (typos + DNS) before sending
├── sync.js            Optional history sync through a hidden Google Drive file
├── README.md
└── assets/
```

## 2. Google Cloud Setup (required before Gmail sending works)

Because a Google OAuth Client ID is tied to your own Google Cloud project and
your extension's unique ID, it **cannot be pre-generated for you**. You must
create your own. Follow these steps exactly.

### Step 1 — Create a Google Cloud project
1. Go to [Google Cloud Console](https://console.cloud.google.com/).
2. Click the project dropdown at the top, then **New Project**.
3. Give it a name (e.g. `Unity Job Mailer`) and click **Create**.

### Step 2 — Enable the Gmail API (and the Google Drive API, for sync)
1. In the left sidebar, go to **APIs & Services → Library**.
2. Search for **Gmail API**.
3. Click it, then click **Enable**.

### Step 3 — Configure the OAuth consent screen
1. Go to **APIs & Services → OAuth consent screen**.
2. Choose **External** (or **Internal** if you have a Google Workspace
   account restricted to your organization).
3. Fill in the required fields: app name (`Unity Job Mailer`), your email as
   the support email, and your email again as a developer contact.
4. On the **Scopes** step, click **Add or Remove Scopes** and add both:
   ```
   https://www.googleapis.com/auth/gmail.send
   https://www.googleapis.com/auth/gmail.readonly
   https://www.googleapis.com/auth/drive.appdata
   https://www.googleapis.com/auth/userinfo.email
   ```
   `gmail.send` is the minimum scope required to send email.
   `gmail.readonly` (added in v1.2) is only needed for the **Check Gmail for bounces**
   button. Google does not offer a narrower "read bounce messages only" permission, so
   this grants read access to your mailbox; the extension only searches for
   `mailer-daemon` / `postmaster` messages. If you prefer not to grant it, remove it from
   `manifest.json` and use **Mark as bounced** (paste addresses) instead.
   `userinfo.email` is a separate, non-sensitive scope used only so the
   extension can display which Gmail address you're connected as (Gmail's
   own profile endpoint needs a broader read scope than sending requires,
   so the extension asks Google's standard identity endpoint instead).
5. On the **Test users** step, add your own Gmail address as a test user
   (required while the app is in "Testing" publishing status).
6. Save and continue through the remaining steps.

### Step 4 — Load the unpacked extension first (to get its ID)
Chrome extension OAuth clients need to know the extension's ID in advance.
1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked**.
4. Select the `unity-job-mailer` folder (this project).
5. The extension will load with a placeholder Client ID (it will not be able
   to sign in yet — that's expected). Copy the **ID** shown under the
   extension's name (a long string like `abcdefghijklmnopabcdefghijklmnop`).

### Step 5 — Create the OAuth Client ID
1. Back in Google Cloud Console, go to **APIs & Services → Credentials**.
2. Click **Create Credentials → OAuth client ID**.
3. For **Application type**, choose **Chrome Extension**.
4. Paste the extension ID you copied in Step 4 into the **Item ID** field.
5. Click **Create**. Google will show you a **Client ID** — copy it.

### Step 6 — Put the Client ID into the extension
1. Open `manifest.json` in this project.
2. Find this section:
   ```json
   "oauth2": {
     "client_id": "PASTE_YOUR_OAUTH_CLIENT_ID_HERE.apps.googleusercontent.com",
     "scopes": [
       "https://www.googleapis.com/auth/gmail.send",
       "https://www.googleapis.com/auth/userinfo.email"
     ]
   }
   ```
3. Replace `PASTE_YOUR_OAUTH_CLIENT_ID_HERE.apps.googleusercontent.com` with
   the Client ID from Step 5.
4. Save the file.

### Step 7 — Reload the extension
1. Go back to `chrome://extensions`.
2. Click the **Reload** icon on the Unity Job Mailer card.

### Step 8 — Connect Gmail
1. Click the Unity Job Mailer icon in the Chrome toolbar to open the popup.
2. Click **Connect Gmail**.
3. Complete the Google sign-in and consent screen (you'll see a warning that
   the app is unverified — this is expected for a personal/testing app; click
   **Continue** since you added yourself as a test user).
4. You should now see **Connected: your-email@gmail.com** in the popup.

---

## 3. Using the Extension

### Upgrading from 1.2
1. In Google Cloud: **APIs & Services > Library > Google Drive API > Enable** (only needed for Drive sync).
2. **OAuth consent screen > Scopes**: add `.../auth/drive.appdata` next to the existing scopes.
3. `chrome://extensions` > **Reload** the extension, then open the popup, click **Sign Out** and **Connect Gmail** again, and approve the new permission.
4. Open **Settings** and check your templates, CV and limits. Your old template and CV appear as "default".
   The old fixed delay is replaced by a random 20-60 second delay and a daily limit of 400 (change them in Settings).

### Settings
- **Sending limits**: daily limit (0 = none) and a random delay between min and max seconds.
- **Templates**: any number. The first is the default. A JSON entry can choose one with `"template": "name"`.
- **CVs**: any number of PDFs. The first is the default. `"cv": "name"` picks one, `"cv": "none"` sends no attachment.
- **Follow-ups**: days to wait, max follow-ups per contact, and the follow-up message.
- **Automation**: auto-check bounces/replies, auto-sync to Google Drive.

### Single Email
Pick a template and CV, edit the text if you like, add optional extra fields as JSON
(`{"hrName":"Anita"}`), then **Preview**, **Send test to me** (goes to your own address, tagged
`[TEST]`, not saved to history) or **Send Email**.

### Bulk JSON (background sending)
1. Upload a `.json` file or paste the list (1000+ entries is fine). A normal `[ ... ]` array, a list without
   the brackets, one object per line and trailing commas all work.
2. Only `email` and `company` are required. Every other field can be used in your template as `{{field}}`:
   ```json
   [
     { "email": "hr@acme.com", "company": "Acme", "hrName": "Anita", "role": "Unity Developer" },
     { "email": "jobs@beta.io", "company": "Beta", "template": "web", "cv": "web" }
   ]
   ```
   `{{hrName|Hiring Team}}` uses the text after `|` when the field is empty. An email whose template needs a
   field that is missing is **not sent** (it shows "Missing field: role") instead of going out half-filled.
3. **Preview List** checks every address: typos in popular domains (gmial.com), domains that do not exist, domains
   that cannot receive mail, duplicates, and anyone already sent or bounced. (It cannot tell if one specific mailbox
   exists; those show up as bounces later.)
4. **Send test to me**, then **Start sending**. Emails go into a queue that runs in the background, so you can close
   the popup. **Chrome itself must stay open.** The queue survives restarts, and you can add more lists any time.
5. The queue card shows progress with **Pause / Resume / Cancel remaining**. When the daily limit is reached it waits
   and continues the next day by itself. If Gmail's own limit is hit it retries after an hour.

### Bounces and replies
Gmail accepts a message first and only later mails you "Address not found". The extension reads those notices
(searching only `mailer-daemon` / `postmaster` messages) and marks the addresses as bounced, so they are never emailed
again. It also finds replies by matching your inbox to the Gmail thread of each email you sent (out-of-office
auto-replies do not count). This runs by itself 5 minutes after a batch and every 3 hours for 3 days, or press
**Check bounces & replies now**. Emails sent with version 1.3+ are matched by Gmail thread (so a reply from any address of the company is found). Older emails are matched by the exact address you wrote to.
No Gmail read permission? Remove `gmail.readonly` from `manifest.json` and use **Mark as bounced** (paste addresses).

### Follow-ups
A contact becomes **Follow-up due** after N days without a reply (default 5). **Queue follow-ups** (History tab or
Dashboard) sends one in the same Gmail thread as "Re: original subject", without the CV, and skips anyone who
replied or bounced in the meantime. The toolbar icon shows how many are due.

### Dashboard
Click the chart icon in the popup. Shows every company with its status (Sent, Replied, Follow-up due, Followed up,
No reply, Bounced, Queued, Failed), search and filters, live queue progress, and **Download CSV** (opens in Excel).

### History and backup
Every successful send is saved immediately (matched by email address, ignoring upper/lower case). A repeated address
is **not sent** and shows "Already sent previously" or "Bounced last time". Failed sends are not saved, so they can be retried.
- **Download history (.json)** is a backup file (also saved automatically when a batch finishes, if enabled).
- **Load an old history file** merges an older backup into the current history.
- **Sync with Google Drive** merges your history with a hidden file in your own Drive, so every computer knows who was
  already emailed. Only this extension can see that file.
- "Clear Settings" never touches history.

History file format:
```json
{
  "app": "unity-job-mailer", "version": 3, "count": 2, "bouncedCount": 1, "repliedCount": 1,
  "sent": [
    { "email": "hr@acme.com", "company": "Acme", "status": "sent", "sentAt": "2026-10-10T09:00:00.000Z",
      "threadId": "18c...", "repliedAt": "2026-10-12T08:00:00.000Z" },
    { "email": "jobs@techland.pl", "company": "Techland", "status": "bounced", "sentAt": "2026-10-11T09:00:00.000Z",
      "emailExists": false, "bounceReason": "address_not_found", "bouncedAt": "2026-10-11T09:02:00.000Z" }
  ]
}
```
A plain array of emails (`["a@x.com"]`) is also accepted when loading.

---

## 4. Testing Checklist

1. **Connect Gmail** — click Connect Gmail and confirm the popup shows
   `Connected: <your address>`.
2. **Send a test email to yourself** — in Single Email, enter your own
   address as the recipient, fill Company Name, and click Send Email. Check
   your inbox.
3. **Verify the PDF attachment** — open the received test email and confirm
   the CV PDF is attached and opens correctly.
4. **Test template replacement** — confirm `{{company}}`, `{{name}}`, and
   `{{email}}` in the preview are replaced with the correct values.
5. **Test invalid JSON** — paste malformed JSON (e.g. missing a bracket) into
   Bulk JSON and click Preview List; confirm you see "Invalid JSON format."
6. **Test multiple recipients** — paste a JSON array with 2–3 real addresses
   you control and run Send All; confirm each one is delivered with the
   configured delay between sends.
7. **Test a failed recipient** — include an entry with a missing `email` or
   `company` field; confirm it's marked `Failed` in the preview table and
   that valid entries still send.
8. **Verify no tokens/passwords are exposed** — inspect the popup UI and
   confirm no OAuth token, refresh token, or password ever appears on
   screen; only your Gmail address is shown.

---

## 5. Security Notes

- No password is ever requested or stored.
- OAuth tokens are managed exclusively through `chrome.identity`; the
  extension never writes tokens to `chrome.storage` or any file.
- Scopes: `gmail.send` (sending), `gmail.readonly` (bounce/reply check; searches mailer-daemon notices and your inbox thread IDs), `drive.appdata` (optional hidden sync file), `userinfo.email`. Remove the ones you do not want from `manifest.json`; the matching button then simply reports a missing permission.
- The domain check sends only the recipient's **domain** (not the full address) to Google's public DNS (dns.google).
- Your CV and other settings are stored only in `chrome.storage.local` on
  your machine and are never transmitted anywhere except as an attachment
  in emails you explicitly choose to send.
- Signing out revokes the cached Google token via Google's revoke endpoint
  and clears it from Chrome's token cache.

---

## 6. Troubleshooting

| Problem | Likely cause |
|---|---|
| "Google authentication was cancelled." | You closed the consent popup, or your Google account isn't listed as a test user on the OAuth consent screen. |
| "Unable to send email. Please check Gmail permissions." | The OAuth client ID/scopes are misconfigured, or the Gmail API isn't enabled on your Cloud project. |
| Popup shows placeholder Client ID errors on Connect | You haven't replaced `PASTE_YOUR_OAUTH_CLIENT_ID_HERE...` in `manifest.json`, or haven't reloaded the extension after editing it. |
| Extension ID changed after re-loading | Reloading an unpacked extension normally keeps the same ID as long as the folder path doesn't change. If it does change, update the **Item ID** on your OAuth Client ID in Google Cloud Console to match. |
| "Unable to retrieve your Gmail address. Please reconnect Gmail." | The `userinfo.email` scope isn't added to your OAuth consent screen yet (see Step 3), or you connected before adding it and need to reconnect. Click **Sign Out**, add the scope on the consent screen if you haven't, then **Connect Gmail** again to re-grant permissions. |

### Background sending (v1.3)
- **Nothing is sending:** Chrome must be open (the queue resumes by itself when you start it). Check the queue card:
  it may be Paused, waiting for tomorrow (daily limit), or showing "Connect Gmail". Open `chrome://extensions`, click
  *service worker* under the extension to see its log.
- **"Gmail read permission is missing" / "Google Drive permission is missing":** add the scope in Google Cloud, then
  **Sign Out** and **Connect Gmail** again.
- **"The Google Drive API is not enabled":** Google Cloud > APIs & Services > Library > Google Drive API > Enable.
- **A row says "Interrupted while sending":** the browser closed at the exact moment of a send. It is not retried
  automatically (it might have gone out). Look in your Gmail Sent folder before re-adding that address.
- **Replies are not detected:** you must have reconnected Gmail with the read permission and pressed **Check bounces & replies**. Older emails are only matched when the reply comes from the exact address you wrote to; a reply from another address of the same company is found only for emails sent with 1.3+. The first check looks back 90 days.
