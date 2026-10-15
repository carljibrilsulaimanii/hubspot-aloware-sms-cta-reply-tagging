/*
  sms-needs-reply-clear-action.js
  Author:  Jibril Sulaiman
  Deploy:  HubSpot contact workflow "SMS - Needs reply OFF" > Custom code step (Data Hub)
           Secret: SMS_CTA_READ (the same read-only key as "SMS - Tag CTA reply":
           conversations.read + crm.objects.contacts.read)
           Properties to include in code: last_inbound_sms___date, last_outbound_sms___date,
           last_outbound_call_date_time
           Data outputs: person_replied (Boolean), sender (String), reason (String)
  What:    Runs when you text or call a contact whose SMS Needs Reply is Yes. Decides whether a
           person answered them: a rep called after their last text, or the newest text you sent
           (on any line) was typed by a person in Aloware (Creator Type "Manual" in the SMS log
           Aloware writes to the HubSpot timeline). Marketing blasts, sequences and Aloware's
           automatic replies don't count. Reads only; the workflow's Edit record step clears the flag.
  Why:     An unanswered conversation should stay in front of its rep until a person has dealt
           with it, however old the campaign is. Last Outbound SMS - Date alone can't tell a rep's
           text from a blast.
*/

const MATCH_WINDOW_MS = 2 * 60 * 1000; // Aloware's log time and the contact field can differ by seconds
const HUBSPOT = 'https://api.hubapi.com';

async function callJson(url, token, body) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    if (res.status === 429 && attempt < 3) {
      await new Promise(resolve => setTimeout(resolve, 1500 * attempt));
      continue;
    }
    if (!res.ok) throw new Error(`HubSpot API ${res.status} on ${url.split('?')[0]}: ${await res.text()}`);
    return res.json();
  }
}

// HubSpot hands date inputs to custom code as epoch milliseconds or ISO text
function toMs(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

// One Aloware SMS log entry on the HubSpot timeline (same format as the CTA tagging code)
function parseSmsLog(body, timestamp) {
  if (!body || !body.includes('has sent an SMS')) return null;
  const outbound = body.includes('has sent an SMS to');
  const sender = ((body.match(/^<b>(.*?) has sent an SMS/) || [])[1] || '').replace(/<[^>]+>/g, '').trim();
  const line = ((body.match(/<b>Line:<\/b>\s*([^<]+)/) || [])[1] || '').trim();
  const creator = ((body.match(/Creator Type:\s*<\/b>\s*([^<]+)/) || [])[1] || '').trim();
  return { at: Date.parse(timestamp), outbound, sender, line, creator };
}

// The contact's outbound SMS log entries on every line, oldest first (newest 100 log entries)
async function outboundSmsLog(contactId, token) {
  const ids = [];
  let after;
  for (let page = 0; page < 5; page++) {
    const r = await callJson(
      `${HUBSPOT}/crm/v4/objects/contacts/${contactId}/associations/communications?limit=500` +
        (after ? `&after=${encodeURIComponent(after)}` : ''),
      token
    );
    (r.results || []).forEach(a => ids.push(String(a.toObjectId)));
    after = r.paging && r.paging.next && r.paging.next.after;
    if (!after) break;
  }
  if (!ids.length) return [];
  const newest = ids.sort((a, b) => (BigInt(b) > BigInt(a) ? 1 : -1)).slice(0, 100);
  const r = await callJson(`${HUBSPOT}/crm/v3/objects/communications/batch/read`, token, {
    properties: ['hs_communication_body', 'hs_timestamp'],
    inputs: newest.map(id => ({ id }))
  });
  return (r.results || [])
    .map(c => parseSmsLog(c.properties.hs_communication_body, c.properties.hs_timestamp))
    .filter(e => e && e.outbound)
    .sort((a, b) => a.at - b.at);
}

exports.main = async (event, callback) => {
  const token = process.env.SMS_CTA_READ;
  const contactId = event.object.objectId;
  const inboundAt = toMs(event.inputFields['last_inbound_sms___date']);
  const textAt = toMs(event.inputFields['last_outbound_sms___date']);
  const callAt = toMs(event.inputFields['last_outbound_call_date_time']);

  const done = (person_replied, sender, reason) =>
    callback({ outputFields: { person_replied, sender, reason } });

  // A call placed after their last text counts as answering them
  if (callAt && (!inboundAt || callAt > inboundAt)) {
    return done(true, 'call', 'a rep called after their last text');
  }
  if (!textAt) return done(false, '', 'no outbound text to check');
  if (inboundAt && textAt <= inboundAt) return done(false, '', 'our last text is older than their reply');

  // Which text set Last Outbound SMS - Date: find the log entries sent at about that time
  const log = await outboundSmsLog(contactId, token);
  const sentNow = log.filter(e => Math.abs(e.at - textAt) <= MATCH_WINDOW_MS && (!inboundAt || e.at > inboundAt));
  if (!sentNow.length) return done(false, '', 'text not found in the SMS log yet');

  const byPerson = sentNow.filter(e => e.creator === 'Manual').pop();
  if (byPerson) return done(true, byPerson.sender, `answered by ${byPerson.sender || 'a person'} on ${byPerson.line}`);

  const last = sentNow[sentNow.length - 1];
  return done(false, '', `last text was ${last.creator || 'automatic'}, not a person`);
};
