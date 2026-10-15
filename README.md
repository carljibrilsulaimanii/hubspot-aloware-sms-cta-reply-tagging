<!--
  README.md -- SMS CTA reply tagging for HubSpot + Aloware
  Author:  Jibril Sulaiman
  What:    A HubSpot workflow with one Data Hub custom code step that tags every contact who replies
           to a marketing text on an Aloware short code, skips opt-outs and replies to a person, and
           five shared contact views that split campaign replies from reps' own conversations.
  Why:     One short code carries marketing blasts, support and sales replies. Aloware can't tag
           broadcast replies, and HubSpot opens a new inbox conversation for every reply, so reps
           lose the people they were already talking to every time a blast goes out.
-->

# SMS CTA reply tagging (HubSpot + Aloware)

When a marketing text goes out to thousands of people on an Aloware short code, the replies bury the
conversations your sales reps were already having. This guide adds one HubSpot workflow that tags each
contact who replies **to a marketing text**, and five shared contact views that put each rep's own
conversations, their new campaign replies and today's texts into separate lists, newest first. Opt-outs
and replies to a text from a person (support or a rep) are never tagged.

## Why it exists

A short code is usually the line for every marketing blast. People reply to it with "YES", questions,
"STOP", and sometimes real buying intent. In practice:

1. **Aloware can't tag a contact from a broadcast reply.** Its support confirmed there is no setting for
   it and logged it as a feature request. Aloware also can't filter its shared inbox by "replied to
   campaign X".
2. **HubSpot opens a new inbox conversation for every reply.** With the Aloware SMS channel connected,
   each blast reply becomes its own open conversation. Sorted oldest first, reps scroll through weeks of
   history. Sorted newest first, their own customers are buried under blast replies. Right after a blast,
   about 9 in 10 replies are opt-outs.
3. **Only the HubSpot inbox knows which line a text came in on.** Aloware writes "Last Inbound SMS"
   fields onto the contact within seconds, but no line. Each Aloware line is a separate *channel account*
   in HubSpot, and both may show the same name ("Aloware SMS"), so you tell them apart by id.
4. **Support and reps text from the short code too.** If you tag by line alone, a reply to a rep's
   own text looks like a campaign reply. In this build's first half hour, about 1 in 5 replies tagged by
   line alone were answers to a rep's text. Texts typed by a person in Aloware don't appear in the
   HubSpot conversation at all. The only record of who sent them is the SMS log Aloware writes to the
   contact's activity timeline, which names the sender, the line and a *Creator Type*.
5. **HubSpot's no-code options don't cover it.** Conversation-based workflows (Beta) can filter on
   *Originating channel account*, but only fire when a conversation is created, so they miss replies in a
   thread that's already open. Contact view date filters only go down to days, not hours.

So the check runs in a Data Hub custom code step. The code reads the conversation and the SMS log, and
the workflow's normal **Edit record** steps do all the writing.

## How it works

```
Contact texts in (any line)
  -> Aloware updates "Last Inbound SMS - Date"           (workflow trigger, re-enrollment on)
  -> wait 1 minute                                         (lets Aloware set SMS Opt-out after a STOP)
  -> custom code:
       opt-out word or SMS Opt-out = Yes?                  -> not tagged, no API call
       newest incoming conversation on the short code?     -> no: not tagged
       last text WE sent on the short code before it       (from the SMS log, keyword confirmations skipped)
         sent by a person (Creator Type "Manual")?         -> not tagged ("reply to a person: <name>")
         a workflow, broadcast or sequence, or nothing?    -> tagged
  -> branch on is_cta_reply
       Yes -> SMS CTA Reply Date = reply time, SMS CTA Replied To = the marketing text
  -> views read those two properties
```

## What's in this repo

| Path | What it is | Where it goes |
|---|---|---|
| [`workflow-action/`](workflow-action/) | The custom code step | Pasted into the workflow in Step 4 |
| [`test/`](test/) | Tests that run the code against a fake HubSpot (`npm test`) | Local only |

## Table of contents

1. [Requirements](#1-requirements)
2. [Setup, step by step](#2-setup-step-by-step)
   - [Step 1: Find your short code's two identifiers](#step-1-find-your-short-codes-two-identifiers)
   - [Step 2: Create the read-only service key](#step-2-create-the-read-only-service-key)
   - [Step 3: Create the two contact properties](#step-3-create-the-two-contact-properties)
   - [Step 4: Build the workflow](#step-4-build-the-workflow)
   - [Step 5: Build the five views](#step-5-build-the-five-views)
   - [Step 6: Roll it out to the reps](#step-6-roll-it-out-to-the-reps)
   - [Step 7: Check the first real blast](#step-7-check-the-first-real-blast)
3. [Reference: what the code returns](#3-reference-what-the-code-returns)
4. [Troubleshooting](#troubleshooting)
5. [Limits](#limits)
6. [Security](#security)

## 1. Requirements

- **HubSpot** with **Data Hub** (formerly Operations Hub) Professional or higher, for custom code in
  workflows. Super admin, or permission to edit workflows, properties and service keys.
- **Aloware** connected to HubSpot, with:
  - the HubSpot integration writing the contact fields **Last Inbound SMS - Date**
    (`last_inbound_sms___date`), **Last Inbound SMS - Message** (`last_inbound_sms__message`), **Last
    Outbound SMS - Message** (`last_outbound_sms__message`) and **SMS Opt-out** (`sms_optout`);
  - the **Aloware SMS** custom channel connected to a HubSpot inbox, so replies open conversations;
  - SMS activity logging to the HubSpot timeline turned on (the default).
- A **separate sales line** in Aloware (a toll-free or local number) that reps use for their own
  conversations. Replies on it are never tagged.
- **Node.js 20+** only if you want to run the tests (`npm test`).

## 2. Setup, step by step

### Step 1: Find your short code's two identifiers

About 10 minutes. The code needs two values that only your portal knows.

**1a. The line name, as Aloware writes it.**
1. Open any contact who received a marketing text from the short code.
2. In the activity timeline, find an SMS entry from Aloware. It reads like
   *"has sent an SMS to +1 ... **Line:** Acme Shortcode - 12345 **Creator Type:** HubSpot Workflow"*.
3. Copy the line name before the ` - ` (here `Acme Shortcode`). The code checks that the log's line
   *contains* this text, so the name alone is enough.

**1b. The short code's HubSpot channel account id.** Both Aloware lines can appear in HubSpot as
**Aloware SMS**, so read the id from a conversation you know came in on the short code. This needs the
key from [Step 2](#step-2-create-the-read-only-service-key), so you can do Step 2 first and come back.
1. Find a contact who just replied to a short code blast. Open their record and copy the number at the
   end of the URL (`.../record/0-1/123456789`). That's the contact id.
2. In PowerShell, with the key from Step 2:
   ```powershell
   $h = @{ Authorization = "Bearer PASTE_THE_SERVICE_KEY" }
   $since = (Get-Date).ToUniversalTime().AddDays(-1).ToString("yyyy-MM-ddTHH:mm:ssZ")
   (Invoke-RestMethod -Headers $h -Uri "https://api.hubapi.com/conversations/v3/conversations/threads?associatedContactId=123456789&latestMessageTimestampAfter=$since&sort=latestMessageTimestamp&limit=50").results |
     Select-Object id, originalChannelAccountId, latestMessageReceivedTimestamp
   ```
3. The `originalChannelAccountId` of their newest short code conversation is the value you need, e.g.
   `9000000001`. Check one reply on your sales line too: it should show a **different** id.

> ⚠️ **Don't guess from the names.** Both Aloware lines are named **Aloware SMS** in HubSpot's channel
> lists. Picking the wrong one would tag every sales-line reply as a campaign reply.

**1c. Put both values in the code.** Open
[`workflow-action/sms-cta-tag-action.js`](workflow-action/sms-cta-tag-action.js) and replace the two
placeholders near the top:

| Placeholder | Replace with |
|---|---|
| `REPLACE_WITH_SHORT_CODE_CHANNEL_ACCOUNT_ID` | The id from 1b, as a string, e.g. `'9000000001'` |
| `REPLACE_WITH_SHORT_CODE_LINE_NAME` | The line name from 1a, e.g. `'Acme Shortcode'` |

✅ **Check:** two different `originalChannelAccountId` values for a short code reply and a sales-line
reply, and the line name you copied matches the timeline entry exactly.

### Step 2: Create the read-only service key

About 5 minutes. The code reads two things: conversations, to know which line a reply came in on, and
the contact's SMS log, to know who sent the last text. It writes nothing, so the key needs no write
scope.

**2a.** In HubSpot, go to **Settings → Integrations → Service Keys** (wording may differ) and click
**Create service key**.

**2b.** Name it `SMS_CTA_READ`. Add exactly two scopes:

| Scope | Why |
|---|---|
| `conversations.read` | Read the contact's recent inbox conversations and which channel account (line) each came in on |
| `crm.objects.contacts.read` | Read the contact's associations and the SMS log Aloware writes to the timeline (the communications object) |

**2c.** Create it. On the key's page you'll see **Service Key** with **Show | Copy**, **Scopes**,
**Rotate**, **View Logs** and **Edit**. Click **Copy**. Paste it only into the workflow secret in
Step 4e, never into chat, a doc or a ticket.

> ⚠️ **One key per automation.** Don't reuse a key another workflow already uses. If you rotate a
> shared key, every action that used it fails with a 401 that names neither workflow.

✅ **Check:** the key page lists exactly `conversations.read` and `crm.objects.contacts.read`.

### Step 3: Create the two contact properties

About 5 minutes. **Settings → Properties**, object **Contact**, then **Create property**. Put both in a
group such as **Aloware / SMS** (create it if needed).

| Label | Internal name | Field type | Description |
|---|---|---|---|
| SMS CTA Reply Date | `sms_cta_reply_date` | Date and time picker (wording may differ) | When the contact last replied to a marketing text on the short code, opt-outs excluded. Set by the workflow SMS - Tag CTA reply. Don't edit by hand. |
| SMS CTA Replied To | `sms_cta_replied_to` | Multi-line text | The marketing text the contact replied to. Set by the same workflow. |

Check that the internal names come out exactly as shown. The workflow and views refer to them.

✅ **Check:** both properties appear under the group, and SMS CTA Reply Date shows a time, not just a
date, when you edit a test contact.

### Step 4: Build the workflow

About 30 minutes. Leave it **off** until the test in 4f passes.

**4a. Create it.** **Automation → Workflows → Create workflow → From scratch**.

**4b. Trigger.**
1. In **Choose a trigger to start this workflow**, open **Data values** and click **Property value
   changed**.
2. Choose **One property value changed**.
3. **Choose an object:** **Contact**.
4. Search for and pick **Last Inbound SMS - Date**. The trigger card reads *"Property value changed has
   been completed any number of times anytime and Property name is Last Inbound SMS - Date, New value:
   Last Inbound SMS - Date is known"*.
5. Click **Next** to **Eligible records**. Leave it with no conditions, then click **Next**.

**4c. Re-enrollment.** On **Settings**, turn on **Re-enroll** (*"Allow contacts to re-enroll after
completing the workflow."*). Then click **Save and continue**. Without re-enrollment, a contact is
checked only the first time they ever text in.

**4d. Delay.**
1. Click **+** under the trigger and choose **Delay**.
2. **Delay** → **For a set amount of time**.
3. Set **Minutes** to `1`, leave **Days** and **Hours** at 0, and click **Save**.

The minute gives Aloware time to set **SMS Opt-out** after a STOP. The code skips opt-outs before it
makes any API call.

**4e. The custom code step.**
1. Click **+** under the delay. In **Search actions**, type `custom code` and choose **Custom code**
   (*"Write your own custom logic and integrate with other applications"*, under **Data ops**).
2. **Language:** **Node.js 20.x**.
3. **Secrets:** add a secret named `SMS_CTA_READ` with the key from Step 2 as its value, then make sure
   `SMS_CTA_READ` shows as selected in the **Secrets** box.
4. **Property to include in code**, one row per input. Type the key on the left. On the right, click
   **Select a property**, search in **All data tokens** and pick the token under **Enrolled contact**:

   | Key (left box) | Property (right box) |
   |---|---|
   | `last_inbound_sms__message` | **Enrolled contact → Last Inbound SMS - Message** |
   | `last_outbound_sms__message` | **Enrolled contact → Last Outbound SMS - Message** |
   | `sms_optout` | **Enrolled contact → SMS Opt-out** |

5. Delete the sample code and paste in **all** of
   [`workflow-action/sms-cta-tag-action.js`](workflow-action/sms-cta-tag-action.js), with your two
   values from Step 1c already in it.
6. **Data outputs**: leave the default **Enumeration** `hs_execution_state` row. Click **Add output**
   for each of these, then pick the **Data type** and type the **Name**:

   | Name | Data type |
   |---|---|
   | `is_cta_reply` | Boolean |
   | `reply_at` | Datetime |
   | `cta_text` | String |
   | `reason` | String |

7. Click **Save** at the top of the panel.

> ⚠️ **Save didn't take.** In the newer workflow editor, the first click on **Save** after pasting code
> sometimes does nothing, and the panel stays open with **Save** still active. Click it again until
> the panel shows **Edit action** and the card reads *"Defined by custom code."*.

**4f. Test the step before going further.** The code only counts replies from the last 15 minutes, so
test right after real replies come in.
1. In the panel, open **Test action**. Under **Contact**, search for someone who replied to a marketing
   text on the short code in the last few minutes, and click **Test**.
2. HubSpot warns *"Test action? When testing this action any edits being made will be applied to your
   contact."* This step only reads, so click **Test**.
3. Success looks like: **Status** *Success*, `is_cta_reply` *true*, `reply_at` a number such as
   `1893453600000` (the reply time), `cta_text` the marketing text, `reason` *short code reply to HubSpot
   Workflow*, and a **Logs** line such as *"Memory: 113/2048 MB Runtime: 242.89 ms"*.
4. Test again on someone who replied to a rep's text on the short code. Expect `is_cta_reply` *false* and
   `reason` *reply to a person: <rep name> (Browser / Apps)*.

| You got | Cause | Fix |
|---|---|---|
| `reason` *newest reply is too old* | The reply is more than 15 minutes old | Test on a fresher reply |
| `reason` *not the short code* on a short code reply | Wrong channel account id | Redo Step 1b |
| An error with `HubSpot API 401` | Secret missing, not selected, or wrong value | Re-add `SMS_CTA_READ` in 4e.3 |
| `reason` starting *short code reply (SMS log unavailable: HubSpot API 403* | The key lacks `crm.objects.contacts.read` | Add the scope in Step 2. Until then it tags by line alone |
| Rep replies come back *true* | Line name doesn't match the timeline | Redo Step 1a |

**4g. Branch on the result.**
1. Click **+** under the custom code step and choose **Branch**.
2. Choose **One property or action output**.
3. **Property or value to branch on:** pick **is_cta_reply (2. Custom code)**, then click **Next**.
4. **Branch 1:** **is equal to** → **Yes**. Leave **Branch 2** as *None met* (nothing goes on it), then
   click **Save**.

| Branch | What to add |
|---|---|
| **= Yes** | The two Edit record steps below |
| **None met** | Nothing. Opt-outs, sales-line replies and replies to a person end here |

**4h. Edit record: SMS CTA Reply Date.** On the **= Yes** branch, click **+**, search `Edit record` and
choose **Edit record** (*"Edit, copy, and clear CRM property values"*).
1. **Record type:** **Contact (Current object)**.
2. **Property to edit:** **SMS CTA Reply Date**. **Change type:** **Replace**.
3. **Choose a value:** **Choose a date or date property**, click the date box, then in **All data
   tokens** → **Action data** → **2. Custom code**, pick **reply_at**. Click **Save**.

**4i. Edit record: SMS CTA Replied To.** Click **+** under 4h and add another **Edit record**.
1. **Record type:** **Contact (Current object)**. **Property to edit:** **SMS CTA Replied To**.
   **Change type:** **Replace**.
2. Click in **Choose a value**, search `cta_text` in **All data tokens** and insert **cta_text (2.
   Custom code)**. Click **Save**.

**4j. Name it.** Click the pencil next to the workflow name. In **About this workflow**, set **Name** to
`SMS - Tag CTA reply`, add a description, and click **Save**.

**4k. Turn it on.** Click **Review and turn on**.
1. **Step 1: Enrollment.** For *"Do you want to enroll contacts that currently meet the enrollment
   criteria when the workflow turns on?"*, choose **No, only enroll contacts who meet the enrollment
   criteria after the workflow is turned on**. Then click **Next**. Enrolling everyone would run the
   code on every past text, and all of them are outside the 15-minute window anyway.
2. **Step 2: Timing & Performance** and **Step 3: Connections:** leave as is and click **Next**.
3. **Step 4: Workflow details:** check the name, then click **Turn on workflow**. The header shows
   **ON**.

✅ **Check:** within two minutes of the next short code reply, **Performance history → Enrollment
history** lists contacts, and a contact who replied YES to a blast has **SMS CTA Reply Date** and **SMS
CTA Replied To** filled in.

### Step 5: Build the five views

About 25 minutes. **Contacts**, then the **+** to the right of the view tabs (*"Add view"*) → **Create
new view** → **Table**. Name it in the tab, then open **Advanced filters**.

| View | Filters (Advanced filters) | Sort | For |
|---|---|---|---|
| **My texts - newest first** | **Group 1:** Contact owner *is any of Me* · Last Inbound SMS - Date *is known* · SMS Opt-out *is not equal to True* · SMS CTA Reply Date *is unknown*. **Or Group 2:** the same first three, plus SMS CTA Reply Date *is more than 2 days ago* | Last Inbound SMS - Date, newest first | Each rep: their own conversations |
| **My CTA replies - last 48 hours** | Contact owner *is any of Me* · SMS CTA Reply Date *is less than 2 days ago* | SMS CTA Reply Date, newest first | Each rep: new campaign replies |
| **My texts - today** | Contact owner *is any of Me* · Last Inbound SMS - Date *is Today* | Last Inbound SMS - Date, newest first | Each rep: everything that came in today |
| **All CTA replies - last 48 hours** | SMS CTA Reply Date *is less than 2 days ago* | SMS CTA Reply Date, newest first | The sales manager |
| **Unowned CTA replies - last 48 hours** | SMS CTA Reply Date *is less than 2 days ago* · Contact owner *is unknown* | SMS CTA Reply Date, newest first | Whoever assigns new leads |

For each view:
1. **Advanced filters → Add filter**, search the property, pick the operator. For *is less than 2 days
   ago*, choose **is less than**, type `2`, and leave the unit as **days ago**.
2. For the OR in the first view, click **Add filter group** and repeat the first three filters in the
   second group.
3. Sort by the column shown, newest first.
4. Columns (wording may differ: **Edit columns**): Name, Phone, Last Inbound SMS - Message, Last
   Inbound SMS - Date, SMS CTA Replied To, Lead status, Contact owner.
5. Click **Save** at the bottom right, then share the view with everyone or with the sales team
   (the sharing control's wording may differ).

> ⚠️ **Dates count in calendar days.** *Less than 2 days ago* means "since the start of the day before
> yesterday", and *more than 2 days ago* means "before then". HubSpot shows a hint under the filter,
> e.g. *"Includes records timestamped before the start of ..."*. Neither filter offers hours, so "last 2
> hours" isn't possible. Use **Today** and the newest-first sort.

> ⚠️ **"Is not equal to True" keeps contacts with no value.** That's what you want for SMS Opt-out.
> Contacts who have never been set either way still show.

✅ **Check:** open **My texts - newest first** yourself. You see only contacts you own, newest reply at
the top, and the SMS CTA Replied To column is empty for them.

### Step 6: Roll it out to the reps

About 2 minutes per rep, once.
1. Each rep opens **Contacts**, clicks **+** → **Add existing view**, and adds **My texts - newest
   first**, **My CTA replies - last 48 hours** and **My texts - today**.
2. Nobody needs their own version: *Contact owner is any of Me* means each person sees only their own
   contacts.
3. A rep who wants different columns or filters clicks **Clone** at the bottom of the view and changes
   the copy. Ask everyone not to click **Save** after changing a shared view, because that changes it
   for the whole team.
4. To look at one rep's list, open view 2 or 4, switch **Contact owner** in the filter bar from **Me**
   to that rep, and don't save.

To pull everyone who replied to one blast, open **All CTA replies - last 48 hours** and filter **SMS
CTA Reply Date** to the hours after that send.

✅ **Check:** two reps open **My CTA replies - last 48 hours** and each sees a different list.

### Step 7: Check the first real blast

About 10 minutes, right after the next blast.
1. Open **All CTA replies - last 48 hours** and spot-check ten contacts. Each should have replied on the
   short code, and SMS CTA Replied To should show the blast (or *Keyword reply: YES | <blast>*).
2. In the workflow, open **Performance history → Enrollment history** and click **View logs** on a few
   contacts that weren't tagged. The custom code step's `reason` says why: *opt-out*, *not the short
   code*, *reply to a person: ...*.
3. If any reason starts with *short code reply (SMS log unavailable*, fix the key's scopes (Step 2).

✅ **Check:** no STOP replies and no replies to a rep's text appear in the CTA views.

## 3. Reference: what the code returns

| `reason` | `is_cta_reply` | Meaning |
|---|---|---|
| `opt-out` | false | The whole reply was STOP, STOPALL, STOP ALL, UNSUBSCRIBE, CANCEL, END, QUIT, REMOVE or REMOVE ME (any case), or SMS Opt-out is Yes |
| `no recent incoming conversation` | false | No inbox conversation for this contact got a message in the last 15 minutes |
| `newest reply is too old` | false | The newest incoming text is more than 15 minutes old (for example, a late re-run) |
| `not the short code` | false | The newest reply came in on another line |
| `reply to a person: <name>` | false | The last text sent on the short code before the reply was typed by a person in Aloware |
| `short code reply to <Creator Type>` | true | Replied to a HubSpot Workflow, Broadcast or Sequence text. `cta_text` is that text |
| `short code reply, nothing sent before it` | true | They texted the short code first. `cta_text` is *Texted the short code first (no earlier text from us)* |
| `short code reply (SMS log unavailable: ...)` | true | The SMS log couldn't be read, so it tagged by line alone |

How the SMS log is read: Aloware writes each text to the contact's timeline as a communication like
`<b>Alex Rep (Browser / Apps) has sent an SMS to <b>+1 ...</b></b><br><b>Line:</b> Acme Shortcode - 12345
<br><b>Creator Type: </b>Manual<br><b>Message:</b><br>...`. Incoming texts read `+1 ... has sent an SMS`
without "to". The code reads the contact's newest 100 log entries and keeps those on the short code line.
It finds the reply's own entry and takes the last outgoing text before it, skipping *App Notification*
entries and Aloware's opt-in and opt-out confirmations. Creator Types seen in practice: **HubSpot
Workflow**, **Broadcast**, **Sequence** (the sender shows the sequence name), **Manual** (a person) and
**App Notification** (Aloware's automatic replies).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Nothing is ever tagged | Workflow off, re-enrollment off, or the trigger property is wrong | Step 4b, 4c, 4k |
| Every run errors with 401 | Secret missing or the key was rotated | Step 4e.3 |
| Sales-line replies get tagged | Wrong channel account id | Step 1b |
| Replies to reps get tagged | Line name doesn't match, or the key can't read the SMS log | Step 1a, Step 2 |
| SMS CTA Replied To shows Aloware's "You have successfully been subscribed" text | The SMS log couldn't be read and it fell back | Step 2 (add `crm.objects.contacts.read`) |
| A rep sees other reps' contacts | The view's owner filter was saved as a specific person | Step 5, set *Contact owner is any of Me* |
| A rep's view changed for everyone | Someone clicked Save on a shared view | Step 6.3, use Clone |
| A contact stays in a CTA view after a rep starts talking to them | Expected: the tag lasts 2 calendar days | Limits |

## Limits

- **Two calendar days, not 48 hours.** HubSpot's view filters count whole days.
- **No hour filter.** "Last 2 hours" isn't possible in contact views. Use **Today** and newest first.
- **15-minute window.** If HubSpot delays a run by more than 15 minutes (a very large blast), that
  reply isn't tagged. Raise `LOOKBACK_MS` if you see *newest reply is too old* during big sends.
- **Tags don't clear on their own.** A contact who replied to a blast stays in the CTA views for two
  days, even after a rep starts the conversation.
- **The SMS log format is Aloware's.** If Aloware changes the wording of its timeline entries (*has
  sent an SMS to*, *Line:*, *Creator Type:*), the person check falls back to tagging, and the reasons
  will show it.
- **Load.** The workflow runs on every incoming text on every line. Opt-outs end before any API call.
  Other replies make three or four read calls each. The code retries HubSpot 429s twice.

## Security

- The key is read-only, holds only the two scopes above, and is used by this workflow alone.
- The code writes nothing. All writes happen in the two Edit record steps, so the workflow history
  shows every change.
- Never paste the key into the code, a ticket or a chat. It lives only in the workflow secret.
- Message text is copied into **SMS CTA Replied To** on the contact. It's the text you sent, not the
  contact's reply.

Related: [filtered-sms-inboxes-auto-update-outbound-channel](https://github.com/carljibrilsulaimanii/filtered-sms-inboxes-auto-update-outbound-channel)
covers moving buyers from the short code to a sales line with an AloAi reply router.

Built by [Jibril Sulaiman](https://github.com/carljibrilsulaimanii).
