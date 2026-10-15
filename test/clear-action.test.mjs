// clear-action.test.mjs
// ---------------------------------------------------------------------------
// Author:  Jibril Sulaiman
// Deploy:  Local only: `npm test`. Never pasted into HubSpot.
// What:    Runs workflow-action/sms-needs-reply-clear-action.js in a sandbox with
//          HubSpot's CRM APIs faked. Checks the call rule, the "our text is older
//          than their reply" rule, a person's text vs a blast or an automatic
//          reply, texts on another line, the 2-minute match window and both date
//          formats HubSpot can hand to custom code.
// Why:     A wrong rule here either clears the flag on someone nobody answered,
//          so they vanish from the rep's list, or never clears it, so the list
//          fills with people who were already handled.
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../workflow-action/sms-needs-reply-clear-action.js', import.meta.url), 'utf8');

const INBOUND_AT = Date.parse('2030-01-15T20:00:00Z'); // their last text
const TEXT_AT = INBOUND_AT + 5 * 60 * 1000;           // the text we sent five minutes later
const iso = ms => new Date(ms).toISOString();

// One Aloware SMS log entry, in the HTML shape Aloware writes to the HubSpot timeline
function smsLog(id, at, { outbound = true, sender = 'Alex Rep (Browser / Apps)', line = 'Acme Shortcode - 12345', creator = 'Manual' } = {}) {
  const head = outbound
    ? `<b>${sender} has sent an SMS to <b>+1 555-010-0000</b></b>`
    : `<b><b>+1 555-010-0000</b> has sent an SMS</b>`;
  return {
    id,
    properties: {
      hs_timestamp: iso(at),
      hs_communication_body: `${head}<br><b>Line:</b> ${line}<br><b>Creator Type: </b>${creator}<br><b>Message:</b><br>Hello`
    }
  };
}

function run({ inbound = iso(INBOUND_AT), text = iso(TEXT_AT), call = '', log = [] }) {
  const calls = [];
  const fetch = async (url, opts = {}) => {
    calls.push(url);
    let body;
    if (url.includes('/associations/communications')) {
      body = { results: log.map(e => ({ toObjectId: Number(e.id) })) };
    } else if (url.includes('/communications/batch/read')) {
      const wanted = new Set(JSON.parse(opts.body).inputs.map(i => i.id));
      body = { results: log.filter(e => wanted.has(e.id)) };
    } else {
      throw new Error('unexpected URL ' + url);
    }
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  const context = vm.createContext({ exports: {}, fetch, setTimeout, process: { env: { SMS_CTA_READ: 'test-token' } } });
  vm.runInContext(SOURCE, context);
  const event = {
    object: { objectId: 101 },
    inputFields: { last_inbound_sms___date: inbound, last_outbound_sms___date: text, last_outbound_call_date_time: call }
  };
  return new Promise((resolve, reject) => {
    context.exports.main(event, r => resolve({ out: r.outputFields, calls })).catch(reject);
  });
}

test('a call after their last text counts as answered, with no API call', async () => {
  const { out, calls } = await run({ call: iso(INBOUND_AT + 60 * 1000) });
  assert.equal(out.person_replied, true);
  assert.equal(out.sender, 'call');
  assert.equal(calls.length, 0);
});

test('a call before their last text does not count', async () => {
  const { out } = await run({ call: iso(INBOUND_AT - 60 * 1000), text: '' });
  assert.equal(out.person_replied, false);
  assert.equal(out.reason, 'no outbound text to check');
});

test('our last text older than their reply is not an answer, and makes no API call', async () => {
  const { out, calls } = await run({ text: iso(INBOUND_AT - 60 * 1000) });
  assert.equal(out.person_replied, false);
  assert.equal(out.reason, 'our last text is older than their reply');
  assert.equal(calls.length, 0);
});

test('a text typed by a person clears the flag and names the sender and line', async () => {
  const { out } = await run({ log: [smsLog('5001', INBOUND_AT, { outbound: false }), smsLog('5002', TEXT_AT)] });
  assert.equal(out.person_replied, true);
  assert.equal(out.sender, 'Alex Rep (Browser / Apps)');
  assert.equal(out.reason, 'answered by Alex Rep (Browser / Apps) on Acme Shortcode - 12345');
});

test('a person on another line counts too', async () => {
  const { out } = await run({ log: [smsLog('5002', TEXT_AT, { line: 'Sales Line - (555) 010-0100' })] });
  assert.equal(out.person_replied, true);
  assert.match(out.reason, /on Sales Line/);
});

for (const creator of ['HubSpot Workflow', 'Broadcast', 'Sequence', 'App Notification']) {
  test(`a ${creator} text does not clear the flag`, async () => {
    const { out } = await run({ log: [smsLog('5002', TEXT_AT, { creator, sender: 'Automation' })] });
    assert.equal(out.person_replied, false);
    assert.equal(out.reason, `last text was ${creator}, not a person`);
  });
}

test('a person and an automatic reply at the same moment: the person wins', async () => {
  const log = [
    smsLog('5002', TEXT_AT - 30 * 1000, { creator: 'Manual' }),
    smsLog('5003', TEXT_AT, { creator: 'App Notification', sender: 'Automation' })
  ];
  const { out } = await run({ log });
  assert.equal(out.person_replied, true);
});

test('a person\'s text from before their reply is ignored', async () => {
  // The rep's text sits inside the 2-minute window of the outbound date but before the inbound text
  const inbound = INBOUND_AT;
  const text = INBOUND_AT + 30 * 1000;
  const log = [smsLog('5002', INBOUND_AT - 30 * 1000)];
  const { out } = await run({ inbound: iso(inbound), text: iso(text), log });
  assert.equal(out.person_replied, false);
  assert.equal(out.reason, 'text not found in the SMS log yet');
});

test('a log entry more than 2 minutes from the outbound date is not matched', async () => {
  const { out } = await run({ log: [smsLog('5002', TEXT_AT + 3 * 60 * 1000)] });
  assert.equal(out.person_replied, false);
  assert.equal(out.reason, 'text not found in the SMS log yet');
});

test('no log entries at all', async () => {
  const { out } = await run({ log: [] });
  assert.equal(out.person_replied, false);
  assert.equal(out.reason, 'text not found in the SMS log yet');
});

test('epoch milliseconds work as well as ISO dates', async () => {
  const { out } = await run({ inbound: String(INBOUND_AT), text: String(TEXT_AT), log: [smsLog('5002', TEXT_AT)] });
  assert.equal(out.person_replied, true);
});
