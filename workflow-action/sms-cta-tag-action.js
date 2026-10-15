/*
  sms-cta-tag-action.js
  Author:  Jibril Sulaiman
  Deploy:  HubSpot contact workflow "SMS - Tag CTA reply" > Custom code step (Data Hub)
           Secret: SMS_CTA_READ (a service key with conversations.read and crm.objects.contacts.read)
           Properties to include in code: last_inbound_sms__message, last_outbound_sms__message, sms_optout
           Data outputs: is_cta_reply (Boolean), reply_at (Datetime), cta_text (String), reason (String)
  What:    After a contact texts in, finds the HubSpot conversation that received the newest
           incoming text. If that conversation is on your marketing short code and the text is not
           an opt-out, it reads the SMS log Aloware writes to the contact's timeline and finds the
           last text you sent on the short code before the reply. If a person sent it (support or a
           rep, Creator Type "Manual"), the reply is a conversation, not a CTA reply. Otherwise it
           returns is_cta_reply = true, the reply time, and the marketing text they answered. A
           keyword reply (YES etc.) is shown as "Keyword reply: YES | <marketing text>". Reads only;
           the workflow's Edit record steps do the writing.
  Why:     Marketing texts go out and come back on the short code, and only the HubSpot inbox
           records which line a text came in on. Support and reps can text from the short code too,
           so the line alone would tag their conversations as campaign replies.
*/

const SHORT_CODE_CHANNEL_ACCOUNT_ID = 'REPLACE_WITH_SHORT_CODE_CHANNEL_ACCOUNT_ID'; // see README step 1
const SHORT_CODE_LINE_NAME = 'REPLACE_WITH_SHORT_CODE_LINE_NAME'; // how Aloware names the short code in its SMS log
const LOOKBACK_MS = 15 * 60 * 1000; // the reply must be from the last 15 minutes
const OPT_OUT_WORDS = ['stop', 'stopall', 'stop all', 'unsubscribe', 'cancel', 'end', 'quit', 'remove', 'remove me'];
const HUBSPOT = 'https://api.hubapi.com';
const API = `${HUBSPOT}/conversations/v3/conversations`;
// Aloware's automatic keyword and opt-in/opt-out confirmations, not marketing copy
const AUTO_REPLY_MARKERS = ['you have successfully been', 'reply help for help', 'msg&data rates may apply'];
const isAutoReply = text => AUTO_REPLY_MARKERS.some(m => (text || '').toLowerCase().includes(m));

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

// One Aloware SMS log entry on the HubSpot timeline, e.g.
// "<b>Alex Rep (Browser / Apps) has sent an SMS to <b>+1 ...</b></b><br><b>Line:</b> Acme Shortcode - 12345
//  <br><b>Creator Type: </b>Manual<br><b>Message:</b><br>Hi Sam, ..."
function parseSmsLog(body, timestamp) {
  if (!body || !body.includes('has sent an SMS')) return null;
  const outbound = body.includes('has sent an SMS to');
  const sender = ((body.match(/^<b>(.*?) has sent an SMS/) || [])[1] || '').replace(/<[^>]+>/g, '').trim();
  const line = ((body.match(/<b>Line:<\/b>\s*([^<]+)/) || [])[1] || '').trim();
  const creator = ((body.match(/Creator Type:\s*<\/b>\s*([^<]+)/) || [])[1] || '').trim();
  const text = (body.split(/<b>Message:<\/b>/)[1] || '')
    .split('<a ')[0]
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .trim();
  return { at: Date.parse(timestamp), outbound, sender, line, creator, text };
}

// The contact's short code SMS log, oldest first (newest 100 log entries)
async function shortCodeSmsLog(contactId, token) {
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
    .filter(e => e && e.line.includes(SHORT_CODE_LINE_NAME))
    .sort((a, b) => a.at - b.at);
}

exports.main = async (event, callback) => {
  const token = process.env.SMS_CTA_READ;
  const contactId = event.object.objectId;
  const inboundText = (event.inputFields['last_inbound_sms__message'] || '').trim();
  const lastInbound = inboundText.toLowerCase();
  const lastOutbound = event.inputFields['last_outbound_sms__message'] || '';
  const optedOut = String(event.inputFields['sms_optout']) === 'true';

  const notCta = reason =>
    callback({ outputFields: { is_cta_reply: false, reply_at: null, cta_text: '', reason } });

  // Opt-outs end here, before any API call
  if (optedOut || OPT_OUT_WORDS.includes(lastInbound)) return notCta('opt-out');

  // Conversations for this contact with a message in the lookback window
  const since = new Date(Date.now() - LOOKBACK_MS).toISOString();
  const threads = await callJson(
    `${API}/threads?associatedContactId=${contactId}` +
      `&latestMessageTimestampAfter=${encodeURIComponent(since)}` +
      `&sort=latestMessageTimestamp&limit=50`,
    token
  );

  // The conversation that received the newest incoming text
  const received = (threads.results || [])
    .filter(t => t.latestMessageReceivedTimestamp)
    .sort((a, b) => Date.parse(b.latestMessageReceivedTimestamp) - Date.parse(a.latestMessageReceivedTimestamp));
  const newest = received[0];
  if (!newest) return notCta('no recent incoming conversation');

  const receivedAt = Date.parse(newest.latestMessageReceivedTimestamp);
  if (Date.now() - receivedAt > LOOKBACK_MS) return notCta('newest reply is too old');
  if (String(newest.originalChannelAccountId) !== SHORT_CODE_CHANNEL_ACCOUNT_ID) {
    return notCta('not the short code');
  }

  // Who sent the last text on the short code before this reply. If the SMS log can't be read,
  // fall back to tagging by line alone (the behaviour before this check existed).
  let log = null;
  let logError = '';
  try {
    log = await shortCodeSmsLog(contactId, token);
  } catch (err) {
    logError = String(err.message || err).slice(0, 200);
  }

  let ctaText = lastOutbound;
  let reason = 'short code reply';
  if (log) {
    // The reply as Aloware logged it; its time is the cut-off for "sent before the reply"
    const reply = log.filter(e => !e.outbound && e.at <= receivedAt + 120000).pop();
    const cutoff = reply ? reply.at : receivedAt;
    const sentBefore = log.filter(e => e.outbound && e.at < cutoff && e.creator !== 'App Notification' && !isAutoReply(e.text));
    const last = sentBefore.pop();
    if (last && last.creator === 'Manual') {
      return notCta(`reply to a person: ${last.sender || 'unknown'}`);
    }
    if (last) {
      ctaText = last.text;
      reason = `short code reply to ${last.creator || 'marketing'}`;
    } else {
      ctaText = '';
      reason = 'short code reply, nothing sent before it';
    }
    // A keyword reply (YES etc.) gets an Aloware confirmation right after it
    const keyword = isAutoReply(lastOutbound) ||
      log.some(e => e.outbound && e.creator === 'App Notification' && e.at >= cutoff && e.at <= cutoff + 120000);
    if (keyword) ctaText = `Keyword reply: ${inboundText}` + (ctaText ? ` | ${ctaText}` : '');
  } else {
    reason = `short code reply (SMS log unavailable: ${logError})`;
    if (isAutoReply(ctaText)) ctaText = `Keyword reply: ${inboundText}`;
  }

  callback({
    outputFields: {
      is_cta_reply: true,
      reply_at: receivedAt,
      cta_text: (ctaText || 'Texted the short code first (no earlier text from us)').slice(0, 5000),
      reason
    }
  });
};
