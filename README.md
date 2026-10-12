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
unity-job-mailer/
├── manifest.json      Manifest V3 configuration
├── popup.html          Popup UI markup
├── popup.css           Popup UI styling
├── popup.js             Popup UI logic (auth, single send, bulk send)
├── options.html        Settings page markup
├── options.css         Settings page styling
├── options.js           Settings page logic
├── gmail.js              Gmail API + OAuth + MIME building
├── template.js           Template variable replacement + JSON reading/validation
├── timer-worker.js    Delay timer for bulk sends (not throttled in background tabs)
├── storage.js             chrome.storage.local helpers
├── README.md
└── assets/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## 2. Google Cloud Setup (required before Gmail sending works)

Because a Google OAuth Client ID is tied to your own Google Cloud project and
your extension's unique ID, it **cannot be pre-generated for you**. You must
create your own. Follow these steps exactly.

### Step 1 — Create a Google Cloud project
1. Go to [Google Cloud Console](https://console.cloud.google.com/).
2. Click the project dropdown at the top, then **New Project**.
3. Give it a name (e.g. `Unity Job Mailer`) and click **Create**.

### Step 2 — Enable the Gmail API
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

### Settings (Options page)
Right-click the extension icon → **Options**, or click the gear icon in the
popup. Configure:
- **Sender Name** — used to replace `{{name}}` in templates.
- **Default Subject** — pre-fills the subject field.
- **Default Email Template** — pre-fills the template textarea.
- **CV Attachment (PDF)** — uploaded and stored locally; attached to every
  email you send.
- **Delay Between Bulk Emails** — seconds to wait between each email in a
  bulk send (default: 5). This exists to prevent an entire recipient list
  from being emailed instantly by accident.

Click **Save Settings** to persist, or **Clear Settings** to wipe everything
(this does not sign you out of Gmail).

### Single Email
1. Fill in Recipient Email, Company Name, Subject, and Template.
2. Click **Preview Email** to see the rendered text with variables replaced.
3. Click **Send Email**.

### Bulk JSON
1. Paste a JSON array like:
   ```json
   [
     { "email": "hr@spodstechnologies.com", "company": "SPODS Technologies" },
     { "email": "info@progaindia.com", "company": "Proga India" }
   ]
   ```
2. Click **Preview List** to validate the JSON and see a Company / Email /
   Status table.
3. Click **Send All**, confirm the dialog, and watch the status column update
   per recipient: `Pending → Sending... → Sent` or `Failed` (with an error
   message). If one recipient fails, the rest still get processed.

### Bulk JSON (v1.1)
- Click the **&#10530;** button (top right) to open the mailer in a **full tab**. Use this for
  big lists: the small popup closes when you click outside it, which would stop a running send.
- Either **upload a .json file** or **paste** the list (1000+ entries is fine). These all work:
  a normal `[ ... ]` array, a list without the brackets, one object per line, and trailing commas.
  Field names are case-insensitive (`email`/`Email`, `company`/`Company`).
- **Preview List** shows a summary: to send / already sent / duplicate / invalid.
- **Send All** skips anything already in History, shows a progress bar, and has a **Stop** button.
- If Gmail's daily limit is reached, sending stops by itself. Paste the same list the next day;
  addresses already sent are skipped automatically.

### Bounces (v1.2)
Gmail accepts a message first and only later mails you a *"Delivery Status Notification
(Failure)"* if the address does not exist. So "sent" in this extension means "Gmail accepted it".
- **History tab → Check Gmail for bounces** reads those notices, and marks the addresses as
  bounced. Run it a few minutes after a bulk send, and again the next day.
  Temporary "(Delay)" notices are ignored.
- **Mark as bounced** lets you paste addresses (or the whole bounce text) by hand, no extra
  permission needed.
- Bounced addresses are skipped everywhere with *"Bounced last time: address does not exist"*.
- **Upgrading from 1.1:** add the `gmail.readonly` scope on the OAuth consent screen, reload the
  extension, then click **Sign Out** and **Connect Gmail** again and approve the new permission.

### History (v1.1)
Every successful send is saved immediately (matched by email address, ignoring upper/lower case).
If the same address appears again (Bulk or Single Email) it is **not sent** and shows
**"Already sent previously"**. Failed sends are not saved, so they can be retried.
- **Download history (.json)** saves a backup file. This also happens automatically when a bulk
  send finishes (can be turned off with the checkbox).
- **Load an old history file** merges an earlier backup into the current history, so a new
  browser/computer still knows who was already emailed.
- **Clear history** forgets everything (it asks first). "Clear Settings" on the options page
  does **not** touch history.

History file format:
```json
{
  "app": "unity-job-mailer", "version": 2, "count": 2, "bouncedCount": 1,
  "sent": [
    { "email": "hr@company.com", "company": "Company", "status": "sent", "sentAt": "2026-10-10T09:00:00.000Z" },
    { "email": "jobs@techland.pl", "company": "Techland", "status": "bounced", "sentAt": "2026-10-11T09:00:00.000Z",
      "emailExists": false, "bounceReason": "address_not_found", "bouncedAt": "2026-10-11T09:02:00.000Z" }
  ]
}
```
A plain array of emails (`["a@x.com", "b@y.com"]`) is also accepted when loading.

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
- Gmail scopes requested: `gmail.send` (sending) and `gmail.readonly` (only used by the bounce
  check, which searches for mailer-daemon notices; remove it from the manifest if you do not want
  it). The extension does not access contacts, Drive, or Calendar. A second, non-sensitive `userinfo.email` scope is requested only
  to show which address you're connected as.
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
