/*
 * Checks recipient addresses BEFORE sending, to cut down on bounces.
 *  1. Typos in popular domains (gmial.com -> gmail.com)
 *  2. The domain exists and can receive mail (DNS lookup through Google's public DNS).
 * It cannot tell whether a specific mailbox exists; only the receiving server knows that.
 * Those still show up as bounces later and are handled by "Check bounces".
 */

const COMMON_DOMAIN_TYPOS = {
  'gmial.com': 'gmail.com', 'gmai.com': 'gmail.com', 'gmail.con': 'gmail.com', 'gmail.co': 'gmail.com',
  'gamil.com': 'gmail.com', 'gmal.com': 'gmail.com', 'gnail.com': 'gmail.com', 'gmail.cm': 'gmail.com',
  'gmaill.com': 'gmail.com', 'gmail.om': 'gmail.com',
  'hotmial.com': 'hotmail.com', 'hotmal.com': 'hotmail.com', 'hotmail.con': 'hotmail.com',
  'yaho.com': 'yahoo.com', 'yahooo.com': 'yahoo.com', 'yahoo.con': 'yahoo.com', 'yahho.com': 'yahoo.com',
  'outlok.com': 'outlook.com', 'outlook.con': 'outlook.com', 'outloook.com': 'outlook.com'
};

const DNS_CACHE_DAYS = 7;

function domainOf(email) {
  const at = String(email || '').lastIndexOf('@');
  return at >= 0 ? String(email).slice(at + 1).trim().toLowerCase() : '';
}

function checkDomainTypo(email) {
  const suggestion = COMMON_DOMAIN_TYPOS[domainOf(email)];
  return suggestion ? `Possible typo: did you mean ...@${suggestion}?` : null;
}

async function dnsQuery(domain, type, fetchFn) {
  const response = await fetchFn(`https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=${type}`);
  if (!response.ok) throw new Error(`DNS lookup failed (${response.status})`);
  return response.json();
}

// Returns 'ok' | 'no-domain' | 'no-mail' | 'unknown'
async function lookupDomain(domain, fetchFn) {
  try {
    const mx = await dnsQuery(domain, 'MX', fetchFn);
    if (mx.Status === 3) return 'no-domain'; // NXDOMAIN
    if (mx.Status !== 0) return 'unknown'; // server trouble, do not block anyone because of it

    const records = (mx.Answer || []).filter((a) => a.type === 15);
    if (records.length > 0) {
      // A single "0 ." record is the standard way of saying "this domain accepts no mail".
      const nullMx = records.every((a) => /^\s*0\s+\.?\s*$/.test(a.data || ''));
      return nullMx ? 'no-mail' : 'ok';
    }

    // No MX: mail can still be delivered to the domain's own address (A / AAAA record).
    const a = await dnsQuery(domain, 'A', fetchFn);
    if ((a.Answer || []).some((r) => r.type === 1)) return 'ok';
    const aaaa = await dnsQuery(domain, 'AAAA', fetchFn);
    if ((aaaa.Answer || []).some((r) => r.type === 28)) return 'ok';
    return 'no-mail';
  } catch (err) {
    return 'unknown';
  }
}

/*
 * Marks Pending entries as Failed when the address is clearly undeliverable.
 * cache: { domain: { r: result, t: timestamp } } (updated in place; caller saves it).
 */
async function verifyEntries(entries, options) {
  const opts = options || {};
  const fetchFn = opts.fetchFn || fetch.bind(globalThis);
  const cache = opts.cache || {};
  const nowMs = opts.now ? opts.now() : Date.now();
  const maxAge = DNS_CACHE_DAYS * 86400000;

  // typos first (no network needed)
  entries.forEach((entry) => {
    if (entry.status !== 'Pending') return;
    const typo = checkDomainTypo(entry.email);
    if (typo) {
      entry.status = 'Failed';
      entry.error = typo;
    }
  });

  const domains = [...new Set(entries.filter((e) => e.status === 'Pending').map((e) => domainOf(e.email)))];
  const results = {};
  const todo = [];
  domains.forEach((d) => {
    const cached = cache[d];
    if (cached && nowMs - cached.t < maxAge) results[d] = cached.r;
    else todo.push(d);
  });

  let done = domains.length - todo.length;
  if (opts.onProgress) opts.onProgress(done, domains.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < todo.length) {
      const domain = todo[cursor++];
      const result = await lookupDomain(domain, fetchFn);
      results[domain] = result;
      if (result !== 'unknown') cache[domain] = { r: result, t: nowMs };
      done++;
      if (opts.onProgress) opts.onProgress(done, domains.length);
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency || 8 }, worker));

  let flagged = 0;
  entries.forEach((entry) => {
    if (entry.status !== 'Pending') return;
    const r = results[domainOf(entry.email)];
    if (r === 'no-domain') {
      entry.status = 'Failed';
      entry.error = `Domain "${domainOf(entry.email)}" does not exist`;
      flagged++;
    } else if (r === 'no-mail') {
      entry.status = 'Failed';
      entry.error = `Domain "${domainOf(entry.email)}" cannot receive email`;
      flagged++;
    }
  });
  return { checked: domains.length, flagged, unknown: domains.filter((d) => results[d] === 'unknown').length, cache };
}
