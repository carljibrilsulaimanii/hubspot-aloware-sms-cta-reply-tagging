// action.test.mjs
// ---------------------------------------------------------------------------
// Author:  Jibril Sulaiman
// Deploy:  Local only: `npm test`. Never pasted into HubSpot.
// What:    Runs workflow-action/sms-cta-tag-action.js in a sandbox with HubSpot's
//          Conversations and CRM APIs faked and the clock frozen. Checks opt-outs,
//          the short code check, replies to marketing vs replies to a person,
//          keyword replies, the "texted first" case and the fallback when the SMS
//          log can't be read.
// Why:     A wrong rule here either floods the reps' campaign views with their own
//          conversations or hides real campaign replies from them.
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SHORT_CODE = '900000001';
const SALES_LINE = '900000002';
const LINE_NAME = 'Acme Shortcode';
const NOW = Date.parse('2030-01-15T20:00:00Z');
const REPLY_AT = NOW - 60 * 1000; // the reply arrived a minute ago

const SOURCE = readFileSync(new URL('../workflow-action/sms-cta-tag-action.js', import.meta.url), 'utf8')
  .replace("'REPLACE_WITH_SHORT_CODE_CHANNEL_ACCOUNT_ID'", `'${SHORT_CODE}'`)
  .replace("'REPLACE_WITH_SHORT_CODE_LINE_NAME'", `'${LINE_NAME}'`);

const iso = ms => new Date(ms).toISOString();

// One Aloware SMS log entry, in the HTML shape Aloware writes to the HubSpot timeline
function smsLog(id, at, { outbound = true, sender = '', line = `${LINE_NAME} - 12345`, creator = 'HubSpot Workflow', text = '' }) {
  const head = outbound
    ? `<b>${sender} has sent an SMS to <b>+1 555-010-0000</b></b>`
    : `<b><b>+1 555-010-0000</b> has sent an SMS</b>`;
  return {
    id,
    properties: {
      hs_timestamp: iso(at),
      hs_communication_body:
        `${head}<br><b>Line:</b> ${line}<br><b>Creator Type: </b>${creator}<br><b>Message:</b><br>${text}` +
        (outbound ? '' : '<br><a target="_blank" href="https://example.com">Click here to respond</a>')
    }
  };
}

function run({ inputs = {}, threads, log = [], logStatus = 200 }) {
  const calls = [];
  const fetch = async (url, opts = {}) => {
    calls.push(url);
    let status = 200;
    let body;
    if (url.includes('/conversations/v3/conversations/threads')) {
      body = { results: threads };
    } else if (url.includes('/associations/communications')) {
      status = logStatus;
      body = { results: log.map(e => ({ toObjectId: Number(e.id) })) };
    } else if (url.includes('/communications/batch/read')) {
      const wanted = new Set(JSON.parse(opts.body).inputs.map(i => i.id));
      body = { results: log.filter(e => wanted.has(e.id)) };
    } else {
      throw new Error('unexpected URL ' + url);
    }
    return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
  };
  const context = vm.createContext({ exports: {}, fetch, setTimeout, process: { env: { SMS_CTA_READ: 'test-token' } } });
  vm.runInContext(`Date.now = () => ${NOW};`, context);
  vm.runInContext(SOURCE, context);
  const event = {
    object: { objectId: 101 },
    inputFields: { last_inbound_sms__message: 'Yes', last_outbound_sms__message: '', sms_optout: 'false', ...inputs }
  };
  return new Promise((resolve, reject) => {
    context.exports.main(event, r => resolve({ out: r.outputFields, calls })).catch(reject);
  });
}

const shortCodeThread = (receivedAt = REPLY_AT) => [{ id: '7001', originalChannelAccountId: SHORT_CODE, latestMessageReceivedTimestamp: iso(receivedAt) }];
const blast = 'Hey! Our new class starts tonight. Reply YES for the link.';

test('STOP ends before any API call', async () => {
  const { out, calls } = await run({ inputs: { last_inbound_sms__message: ' STOP ' }, threads: shortCodeThread() });
  assert.equal(out.is_cta_reply, false);
  assert.equal(out.reason, 'opt-out');
  assert.equal(calls.length, 0);
});

test('a contact already opted out is never tagged', async () => {
  const { out } = await run({ inputs: { sms_optout: 'true' }, threads: shortCodeThread() });
  assert.equal(out.reason, 'opt-out');
});

test('no recent conversation is not a CTA reply', async () => {
  const { out } = await run({ threads: [] });
  assert.equal(out.is_cta_reply, false);
  assert.equal(out.reason, 'no recent incoming conversation');
});

test('a reply older than 15 minutes is skipped', async () => {
  const { out } = await run({ threads: shortCodeThread(NOW - 20 * 60 * 1000) });
  assert.equal(out.reason, 'newest reply is too old');
});

test('a reply on the sales line is not a CTA reply', async () => {
  const threads = [{ id: '7002', originalChannelAccountId: SALES_LINE, latestMessageReceivedTimestamp: iso(REPLY_AT) }];
  const { out } = await run({ threads });
  assert.equal(out.is_cta_reply, false);
  assert.equal(out.reason, 'not the short code');
});

test('the newest reply decides: short code reply after an older sales-line reply is checked', async () => {
  const threads = [
    { id: '7002', originalChannelAccountId: SALES_LINE, latestMessageReceivedTimestamp: iso(REPLY_AT - 5 * 60 * 1000) },
    ...shortCodeThread()
  ];
  const log = [smsLog('5001', REPLY_AT - 3600000, { text: blast }), smsLog('5002', REPLY_AT - 2000, { outbound: false, creator: 'Manual', text: 'Interested' })];
  const { out } = await run({ inputs: { last_inbound_sms__message: 'Interested' }, threads, log });
  assert.equal(out.is_cta_reply, true);
});

test('a reply to a marketing workflow text is tagged with that text', async () => {
  const log = [
    smsLog('5001', REPLY_AT - 3600000, { text: blast }),
    smsLog('5002', REPLY_AT - 2000, { outbound: false, creator: 'Manual', text: 'Interested' })
  ];
  const { out } = await run({ inputs: { last_inbound_sms__message: 'Interested' }, threads: shortCodeThread(), log });
  assert.equal(out.is_cta_reply, true);
  assert.equal(out.reply_at, REPLY_AT);
  assert.equal(out.cta_text, blast);
  assert.equal(out.reason, 'short code reply to HubSpot Workflow');
});

test('a reply to a broadcast is tagged too', async () => {
  const log = [
    smsLog('5001', REPLY_AT - 600000, { creator: 'Broadcast', text: 'Checking in before class tonight.' }),
    smsLog('5002', REPLY_AT - 2000, { outbound: false, creator: 'Manual', text: 'ok' })
  ];
  const { out } = await run({ inputs: { last_inbound_sms__message: 'ok' }, threads: shortCodeThread(), log });
  assert.equal(out.is_cta_reply, true);
  assert.equal(out.reason, 'short code reply to Broadcast');
});

test('a keyword reply shows the word and the blast, not the confirmation', async () => {
  const log = [
    smsLog('5001', REPLY_AT - 3600000, { text: blast }),
    smsLog('5002', REPLY_AT - 2000, { outbound: false, creator: 'Manual', text: 'YES' }),
    smsLog('5003', REPLY_AT, { creator: 'App Notification', text: 'You have successfully been subscribed to messages from this number. Reply HELP for help.' })
  ];
  const { out } = await run({
    inputs: { last_inbound_sms__message: 'YES', last_outbound_sms__message: 'You have successfully been subscribed to messages from this number.' },
    threads: shortCodeThread(),
    log
  });
  assert.equal(out.is_cta_reply, true);
  assert.equal(out.cta_text, `Keyword reply: YES | ${blast}`);
});

test('a reply to a person on the short code is not tagged', async () => {
  const log = [
    smsLog('5001', REPLY_AT - 7200000, { text: blast }),
    smsLog('5002', REPLY_AT - 600000, { sender: 'Alex Rep (Browser / Apps)', creator: 'Manual', text: 'Hi Sam, did you get a chance to look?' }),
    smsLog('5003', REPLY_AT - 2000, { outbound: false, creator: 'Manual', text: 'Not yet' })
  ];
  const { out } = await run({ inputs: { last_inbound_sms__message: 'Not yet' }, threads: shortCodeThread(), log });
  assert.equal(out.is_cta_reply, false);
  assert.equal(out.reason, 'reply to a person: Alex Rep (Browser / Apps)');
  assert.equal(out.cta_text, '');
});

test("a person's text on another line doesn't count", async () => {
  const log = [
    smsLog('5001', REPLY_AT - 3600000, { text: blast }),
    smsLog('5002', REPLY_AT - 600000, { sender: 'Alex Rep (Browser / Apps)', creator: 'Manual', line: 'Sales Line - (555) 010-0002', text: 'Hi Sam' }),
    smsLog('5003', REPLY_AT - 2000, { outbound: false, creator: 'Manual', text: 'Yes please' })
  ];
  const { out } = await run({ inputs: { last_inbound_sms__message: 'Yes please' }, threads: shortCodeThread(), log });
  assert.equal(out.is_cta_reply, true);
  assert.equal(out.cta_text, blast);
});

test("a person's text sent after the reply doesn't count", async () => {
  const log = [
    smsLog('5001', REPLY_AT - 3600000, { text: blast }),
    smsLog('5002', REPLY_AT - 2000, { outbound: false, creator: 'Manual', text: 'YES' }),
    smsLog('5003', REPLY_AT + 30000, { sender: 'Alex Rep (Browser / Apps)', creator: 'Manual', text: 'Great, here is the link' })
  ];
  const { out } = await run({ inputs: { last_inbound_sms__message: 'YES' }, threads: shortCodeThread(), log });
  assert.equal(out.is_cta_reply, true);
  assert.equal(out.cta_text, blast);
});

test('a contact who texts the short code first is tagged and labelled', async () => {
  const log = [smsLog('5002', REPLY_AT - 2000, { outbound: false, creator: 'Manual', text: 'Hello?' })];
  const { out } = await run({ inputs: { last_inbound_sms__message: 'Hello?' }, threads: shortCodeThread(), log });
  assert.equal(out.is_cta_reply, true);
  assert.equal(out.reason, 'short code reply, nothing sent before it');
  assert.equal(out.cta_text, 'Texted the short code first (no earlier text from us)');
});

test('HTML entities and line breaks in the log are cleaned up', async () => {
  const log = [
    smsLog('5001', REPLY_AT - 3600000, { text: 'Rates &amp; fees<br>apply' }),
    smsLog('5002', REPLY_AT - 2000, { outbound: false, creator: 'Manual', text: 'ok' })
  ];
  const { out } = await run({ inputs: { last_inbound_sms__message: 'ok' }, threads: shortCodeThread(), log });
  assert.equal(out.cta_text, 'Rates & fees\napply');
});

test('if the SMS log cannot be read, it falls back to the line check', async () => {
  const { out } = await run({
    inputs: { last_outbound_sms__message: 'Last thing we sent' },
    threads: shortCodeThread(),
    log: [smsLog('5001', REPLY_AT - 3600000, { text: blast })],
    logStatus: 403
  });
  assert.equal(out.is_cta_reply, true);
  assert.match(out.reason, /^short code reply \(SMS log unavailable: HubSpot API 403/);
  assert.equal(out.cta_text, 'Last thing we sent');
});
