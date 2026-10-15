<!--
  README.md -- SMS CTA reply tagging for HubSpot + Aloware
  Author:  Jibril Sulaiman
  What:    A HubSpot workflow with a Data Hub custom code step that tags every contact who replies
           to a marketing text on an Aloware short code, skips opt-outs and replies to a person, and
           assigns unowned repliers by round robin. Two more workflows keep a "needs reply" flag on
           every contact who texted in until a person answers. Six shared contact views split
           campaign replies, reps' own conversations and unanswered texts.
  Why:     One short code carries marketing blasts, support and sales replies. Aloware can't tag
           broadcast replies, and HubSpot opens a new inbox conversation for every reply, so reps
           lose the people they were already talking to every time a blast goes out.
-->

# SMS CTA reply tagging (HubSpot + Aloware)

When a marketing text goes out to thousands of people on an Aloware short code, the replies bury the
conversations your sales reps were already having. This guide builds three HubSpot workflows and six
shared contact views:

- **SMS - Tag CTA reply** tags each contact who replies **to a marketing text** and gives the ones
  with no owner to the next rep by round robin. Opt-outs and replies to a text from a person (support
  or a rep) are never tagged.
- **SMS - Needs reply ON / OFF** keep a **needs reply** flag on everyone who texted in, on any line,
  until a person answers them by text or by phone. Blasts and automatic replies don't count as an
  answer.
- **Six views** put each rep's own conversations, their new campaign replies, today's texts and their
  unanswered texts into separate lists.

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
6. **A tag that lasts a few days isn't "until someone answers".** Nothing in HubSpot or Aloware marks
   a texted-in contact as unanswered. **Last Outbound SMS - Date** changes for blasts and automatic
   replies too, so it can't tell you whether a person ever wrote back. On one busy night, about 4 in 10
   people who replied to a blast had no human answer yet.
7. **Replies from people with no owner reach no rep.** Every rep view filters on *Contact owner is
   Me*, so an unowned replier shows up only in a shared list someone has to watch.

So the checks run in Data Hub custom code steps. The code reads the conversation and the SMS log, and
the workflows' normal **Edit record** and **Rotate record to owner** steps do all the writing.

## How it works

```
SMS - Tag CTA reply
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
           -> no owner? rotate to the next rep on the team (existing owners are kept)
```

```
SMS - Needs reply ON                                      SMS - Needs reply OFF
Contact texts in (any line), and the text is from today   We text or call a contact whose flag is Yes
  -> opt-out word or SMS Opt-out = Yes? -> stop             -> wait 1 minute (lets the SMS log entry land)
  -> SMS Needs Reply = Yes                                  -> custom code:
                                                                 a call after their last text?   -> answered
                                                                 our text typed by a person
                                                                 (Creator Type "Manual")?        -> answered
                                                                 a blast, sequence or auto-reply -> not answered
                                                            -> answered: SMS Needs Reply = No
```

## What's in this repo

| Path | What it is | Where it goes |
|---|---|---|
| [`workflow-action/`](workflow-action/) | The two custom code steps | Pasted into the workflows in Step 4 and Step 5 |
| [`test/`](test/) | Tests that run both code steps against a fake HubSpot (`npm test`) | Local only |

## Table of contents

1. [Requirements](#1-requirements)
2. [Setup, step by step](#2-setup-step-by-step)
   - [Step 1: Find your short code's two identifiers](#step-1-find-your-short-codes-two-identifiers)
   - [Step 2: Create the read-only service key](#step-2-create-the-read-only-service-key)
   - [Step 3: Create the three contact properties](#step-3-create-the-three-contact-properties)
   - [Step 4: Build the CTA workflow](#step-4-build-the-cta-workflow)
   - [Step 5: Build SMS - Needs reply OFF](#step-5-build-sms---needs-reply-off)
   - [Step 6: Build SMS - Needs reply ON](#step-6-build-sms---needs-reply-on)
   - [Step 7: Build the six views](#step-7-build-the-six-views)
   - [Step 8: Roll it out to the reps](#step-8-roll-it-out-to-the-reps)
   - [Step 9: Check the first real blast](#step-9-check-the-first-real-blast)
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
    Outbound SMS - Date** (`last_outbound_sms___date`), **Last Outbound SMS - Message**
    (`last_outbound_sms__message`), **Last Outbound Call Date/Time** (`last_outbound_call_date_time`)
    and **SMS Opt-out** (`sms_optout`);
  - the **Aloware SMS** custom channel connected to a HubSpot inbox, so replies open conversations;
  - SMS activity logging to the HubSpot timeline turned on (the default).
- A **separate sales line** in Aloware (a toll-free or local number) that reps use for their own
  conversations. Replies on it are never tagged as CTA replies, but they do set the needs-reply flag.
- A HubSpot **team** holding the reps who should get unowned CTA replies (**Settings → Users & Teams →
  Teams**, wording may differ). Leave out anyone who shouldn't get new leads.
- **Node.js 20+** only if you want to run the tests (`npm test`).

## 2. Setup, step by step

### Step 1: Find your short code's two identifiers

About 10 minutes. The CTA code needs two values that only your portal knows.

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

The needs-reply code ([`workflow-action/sms-needs-reply-clear-action.js`](workflow-action/sms-needs-reply-clear-action.js))
has no placeholders. It looks at every line.

✅ **Check:** two different `originalChannelAccountId` values for a short code reply and a sales-line
reply, and the line name you copied matches the timeline entry exactly.

### Step 2: Create the read-only service key

About 5 minutes. Both code steps read and never write. The CTA code reads conversations, to know which
line a reply came in on, and the contact's SMS log, to know who sent the last text. The needs-reply code
reads the same SMS log. So one key with two read scopes covers both.

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

> ⚠️ **Keep this key to this guide.** The two code steps here share it, and nothing else should. If
> you rotate a key that other automations also use, every one of them fails with a 401 that names no
> workflow. Write down that both **SMS - Tag CTA reply** and **SMS - Needs reply OFF** use it.

✅ **Check:** the key page lists exactly `conversations.read` and `crm.objects.contacts.read`.

### Step 3: Create the three contact properties

About 5 minutes. **Settings → Properties**, object **Contact**, then **Create property**. Put all three
in a group such as **Aloware / SMS** (create it if needed).

| Label | Internal name | Field type | Description |
|---|---|---|---|
| SMS CTA Reply Date | `sms_cta_reply_date` | Date and time picker (wording may differ) | When the contact last replied to a marketing text on the short code, opt-outs excluded. Set by the workflow SMS - Tag CTA reply. Don't edit by hand. |
| SMS CTA Replied To | `sms_cta_replied_to` | Multi-line text | The marketing text the contact replied to. Set by the same workflow. |
| SMS Needs Reply | `sms_needs_reply` | Single checkbox | Yes when the contact has texted in and no person has answered yet. Set by the SMS - Needs reply workflows. |

Check that the internal names come out exactly as shown. The workflows and views refer to them.

✅ **Check:** all three properties appear under the group, SMS CTA Reply Date shows a time, not just a
date, when you edit a test contact, and SMS Needs Reply offers **Yes** and **No**.

### Step 4: Build the CTA workflow

About 35 minutes. Leave it **off** until the test in 4f passes.

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
| **= Yes** | The two Edit record steps and the rotate step below |
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

**4j. Round robin for unowned repliers.** Click **+** under 4i, search `Rotate` and choose **Rotate
record to owner** (*"Assign which team member should be the owner"*).
1. **Record to rotate:** **Enrolled contact**. **HubSpot user property:** **Contact owner**.
2. Leave **Overwrite if contact has an existing owner** **unchecked**. Anyone who already has an owner
   keeps them; only contacts with no owner are assigned.
3. **Rotate between:** choose **Teams**, open **Choose teams** and pick your sales team. Under the box
   HubSpot explains it will *"evenly distribute contacts as they enter the workflow"*. Click **Save**.
   The card reads *"Rotate contact within 1 team."*

> ⚠️ **The team is the rotation list.** Adding someone to the team, or taking them off, changes who
> gets the next replier, with no edit to the workflow. HubSpot rotates evenly through the team and
> doesn't check who's online or working.

> ⚠️ **Owner and texting line are separate.** Check that your Aloware setup sends the contact's
> next texts and calls to their new HubSpot owner. If it routes by its own contact owner instead, the
> rep will see the contact in HubSpot but not in Aloware.

**4k. Name it.** Click the pencil next to the workflow name. In **About this workflow**, set **Name** to
`SMS - Tag CTA reply`, add a description, and click **Save**.

**4l. Turn it on.** Click **Review and turn on**.
1. **Step 1: Enrollment.** For *"Do you want to enroll contacts that currently meet the enrollment
   criteria when the workflow turns on?"*, choose **No, only enroll contacts who meet the enrollment
   criteria after the workflow is turned on**. Then click **Next**. Enrolling everyone would run the
   code on every past text, and all of them are outside the 15-minute window anyway.
2. **Step 2: Timing & Performance** and **Step 3: Connections:** leave as is and click **Next**.
3. **Step 4: Workflow details:** check the name, then click **Turn on workflow**. The header shows
   **ON**.

✅ **Check:** within two minutes of the next short code reply, **Performance history → Enrollment
history** lists contacts, a contact who replied YES to a blast has **SMS CTA Reply Date** and **SMS
CTA Replied To** filled in, and an unowned replier now has a **Contact owner** from your team.

### Step 5: Build SMS - Needs reply OFF

About 25 minutes. Build OFF before ON, and turn it on first, so that every flag ON sets can be cleared
from the start.

**5a. Create it.** **Automation → Workflows → Create workflow → From scratch**.

**5b. Two triggers.**
1. **Data values → Property value changed → One property value changed**, object **Contact**,
   property **Last Outbound SMS - Date**. The card reads *"... Property name is Last Outbound SMS - Date,
   New value: Last Outbound SMS - Date is known"*.
2. Add a second trigger group with the **or** control below the first group (wording may differ) and
   set it up the same way with **Last Outbound Call Date/Time**. The trigger card then shows **Group 1**
   and **Group 2** joined by **or**.

**5c. Eligible records.** Click **Next**. Under **Only enroll contacts that meet these conditions
(optional)**, click **Add criteria** and add **SMS Needs Reply** *is equal to* **True**.

> ⚠️ **Don't skip the eligible-records filter.** Without it, every blast to every contact enrolls
> them all. With it, only contacts who are already waiting for an answer are checked.

**5d. Re-enrollment.** Click **Next**, turn on **Re-enroll**, then **Save and continue**.

**5e. Delay.** **+** → **Delay** → **For a set amount of time**, **Minutes** `1`, **Save**. The minute
lets Aloware's SMS log entry for the text land on the timeline before the code looks for it.

**5f. The custom code step.**
1. **+** → **Custom code**. **Language:** **Node.js 20.x**.
2. **Secrets:** select the existing `SMS_CTA_READ`. No new key or scope is needed.
3. **Property to include in code:**

   | Key (left box) | Property (right box) |
   |---|---|
   | `last_inbound_sms___date` | **Enrolled contact → Last Inbound SMS - Date** |
   | `last_outbound_sms___date` | **Enrolled contact → Last Outbound SMS - Date** |
   | `last_outbound_call_date_time` | **Enrolled contact → Last Outbound Call Date/Time** |

4. Delete the sample code and paste in **all** of
   [`workflow-action/sms-needs-reply-clear-action.js`](workflow-action/sms-needs-reply-clear-action.js).
   It has no placeholders.
5. **Data outputs** (keep the default `hs_execution_state` row):

   | Name | Data type |
   |---|---|
   | `person_replied` | Boolean |
   | `sender` | String |
   | `reason` | String |

6. Click **Save**, and again if the panel stays open (see the ⚠️ under 4e).

**5g. Test the step.** Open **Test action** in the panel.
1. Pick a contact a rep texted back by hand after their last text. Expect `person_replied` *true*,
   `sender` the rep (e.g. *Alex Rep (Browser / Apps)*), and `reason` *answered by Alex Rep (Browser /
   Apps) on <line>*.
2. Pick a contact whose newest text from you was a workflow or a blast. Expect `person_replied` *false*
   and `reason` *last text was HubSpot Workflow, not a person*.

**5h. Branch.** **+** → **Branch** → **One property or action output** → **person_replied (2. Custom
code)** → **Next**. **Branch 1:** **is equal to** → **Yes**. Leave *None met* empty. **Save**.

**5i. Edit record.** On **= Yes**: **Edit record**, **Contact (Current object)**, **SMS Needs Reply**,
**Replace**, **Choose a value** → **No**. **Save**. The card reads *"Set SMS Needs Reply to false."*

**5j. Name it** `SMS - Needs reply OFF`. **Review and turn on** → **No, only enroll contacts who meet
the enrollment criteria after the workflow is turned on** → **Next** through the steps → **Turn on
workflow**.

✅ **Check:** the workflow reads, in order: two triggers joined by **or**, *SMS Needs Reply is equal to
True*, **Re-enroll on**, **1. Delay**, **2. Custom code**, **3. Branch** on person_replied, **4. Edit
record**.

### Step 6: Build SMS - Needs reply ON

About 15 minutes. No code: one trigger, one branch, one edit.

**6a. Create it**, then **Data values → Property value changed → One property value changed**, object
**Contact**, property **Last Inbound SMS - Date**.

**6b. Eligible records: only today's texts.** Click **Next**. Under **Only enroll contacts that meet
these conditions (optional)**, click **Add criteria**, pick **Last Inbound SMS - Date**, operator
**is**, value **Today** (*"All of today"*). HubSpot shows *"Includes records timestamped <today's
date>"*.

> ⚠️ **Aloware can write an old text as the newest one.** When Aloware syncs a contact into HubSpot,
> it can write that contact's last text from weeks ago into **Last Inbound SMS - Date**. The property
> changes, so the trigger fires, and without this filter that person is flagged as waiting for an
> answer. *Is less than 1 day ago* reaches back to the start of yesterday, and the filter offers no
> hours, so **Today** is the tightest choice.

**6c. Re-enrollment.** **Next**, turn on **Re-enroll**, **Save and continue**. Every new text must be
able to flag the contact again.

**6d. Opt-out branch.** **+** → **Branch** → **AND/OR logic**.
1. **Branch name:** `Opt-out`. Click **Add criteria**, pick **Last Inbound SMS - Message**, operator
   **is equal to any of**, and in **Add values** type each word and press Enter: `stop`, `stopall`,
   `stop all`, `unsubscribe`, `cancel`, `end`, `quit`, `remove`, `remove me`. These are the same words
   the CTA code treats as opt-outs. Matching ignores case, so *Stop* and *STOP* match too.
2. Click the **or** side's **Add criteria** to start **Group 2**: **SMS Opt-out** *is equal to*
   **True**.
3. Under **If none of the criteria are met, go here:**, set **Branch name** to `Needs reply`. **Save**.
4. Leave **Opt-out** empty, so it ends there.

No delay is needed before the branch: Aloware writes **Last Inbound SMS - Message** and **Last Inbound
SMS - Date** in the same update.

**6e. Edit record.** On **Needs reply**: **Edit record**, **Contact (Current object)**, **SMS Needs
Reply**, **Replace**, **Choose a value** → **Yes**. **Save**.

**6f. Name it** `SMS - Needs reply ON`. **Review and turn on** → **No, only enroll contacts who meet
the enrollment criteria after the workflow is turned on** → **Turn on workflow**. Choosing *Yes* would
flag everyone who ever texted in.

✅ **Check:** text your own test contact from a personal phone. Within a minute **SMS Needs Reply** is
**Yes**. Reply to yourself by hand in Aloware: about a minute later it is **No**. Send yourself a
workflow text instead: it stays **Yes**.

### Step 7: Build the six views

About 30 minutes. **Contacts**, then the **+** to the right of the view tabs (*"Add view"*) → **Create
new view** → **Table**. Name it in the tab, then open **Advanced filters**. The CTA window below is 3
days; use your own follow-up window if it's different, and keep the number the same in every view.

| View | Filters (Advanced filters) | Sort | For |
|---|---|---|---|
| **My texts - newest first** | **Group 1:** Contact owner *is any of Me* · Last Inbound SMS - Date *is known* · SMS Opt-out *is not equal to True* · SMS CTA Reply Date *is unknown*. **Or Group 2:** the same first three, plus SMS CTA Reply Date *is more than 3 days ago* | Last Inbound SMS - Date, newest first | Each rep: their own conversations |
| **My CTA replies - last 3 days** | Contact owner *is any of Me* · SMS CTA Reply Date *is less than 3 days ago* | SMS CTA Reply Date, newest first | Each rep: new campaign replies |
| **My texts - today** | Contact owner *is any of Me* · Last Inbound SMS - Date *is Today* | Last Inbound SMS - Date, newest first | Each rep: everything that came in today |
| **My texts - needs reply** | Contact owner *is any of Me* · SMS Needs Reply *is equal to True* · SMS Opt-out *is not equal to True* | Last Inbound SMS - Date, **oldest first** | Each rep: everyone still waiting for an answer, with no time limit |
| **All CTA replies - last 3 days** | SMS CTA Reply Date *is less than 3 days ago* | SMS CTA Reply Date, newest first | The sales manager |
| **Unowned CTA replies - last 3 days** | SMS CTA Reply Date *is less than 3 days ago* · Contact owner *is unknown* | SMS CTA Reply Date, newest first | Whoever assigns new leads. With round robin on, it should stay nearly empty |

For each view:
1. **Advanced filters → Add filter**, search the property, pick the operator. For *is less than 3 days
   ago*, choose **is less than**, type `3`, and leave the unit as **days ago**.
2. For the OR in the first view, click **Add filter group** and repeat the first three filters in the
   second group.
3. Sort by the column shown.
4. Columns (wording may differ: **Edit columns**): Name, Phone, Last Inbound SMS - Message, Last
   Inbound SMS - Date, SMS CTA Replied To, Lead status, Contact owner.
5. Click **Save** at the bottom right, then share the view with everyone or with the sales team
   (the sharing control's wording may differ).

> ⚠️ **Dates count in calendar days.** *Less than 3 days ago* means "since the start of the day three
> days back", and *more than 3 days ago* means "before then". HubSpot shows a hint under the filter,
> e.g. *"Includes records timestamped before the start of ..."*. Neither filter offers hours, so "last 2
> hours" isn't possible. Use **Today** and the newest-first sort.

> ⚠️ **"Is not equal to True" keeps contacts with no value.** That's what you want for SMS Opt-out.
> Contacts who have never been set either way still show.

> ⚠️ **Nothing falls out after the window.** A contact whose CTA reply is older than 3 days matches
> Group 2 of **My texts - newest first**, so they move back into the rep's own list by themselves.

✅ **Check:** open **My texts - newest first** yourself. You see only contacts you own, newest reply at
the top, and the SMS CTA Replied To column is empty for them. **My texts - needs reply** shows your
oldest unanswered text at the top.

### Step 8: Roll it out to the reps

About 2 minutes per rep, once.
1. Each rep opens **Contacts**, clicks **+** → **Add existing view**, and adds **My texts - newest
   first**, **My CTA replies - last 3 days**, **My texts - today** and **My texts - needs reply**.
2. Nobody needs their own version: *Contact owner is any of Me* means each person sees only their own
   contacts.
3. A rep who wants different columns or filters clicks **Clone** at the bottom of the view and changes
   the copy. Ask everyone not to click **Save** after changing a shared view, because that changes it
   for the whole team.
4. To look at one rep's list, open view 2 or 4, switch **Contact owner** in the filter bar from **Me**
   to that rep, and don't save.

Tell the reps how a contact leaves **My texts - needs reply**: a text typed by a person in Aloware, on
any line, or a call. A blast or an automatic reply doesn't take them off.

To pull everyone who replied to one blast, open **All CTA replies - last 3 days** and filter **SMS
CTA Reply Date** to the hours after that send.

✅ **Check:** two reps open **My CTA replies - last 3 days** and each sees a different list.

### Step 9: Check the first real blast

About 10 minutes, right after the next blast.
1. Open **All CTA replies - last 3 days** and spot-check ten contacts. Each should have replied on the
   short code, and SMS CTA Replied To should show the blast (or *Keyword reply: YES | <blast>*).
2. In the CTA workflow, open **Performance history → Enrollment history** and click **View logs** on a
   few contacts that weren't tagged. The custom code step's `reason` says why: *opt-out*, *not the
   short code*, *reply to a person: ...*.
3. If any reason starts with *short code reply (SMS log unavailable*, fix the key's scopes (Step 2).
4. Open **Unowned CTA replies - last 3 days**. New repliers should not pile up there: round robin
   gives each one an owner.
5. Have a rep answer a few people in **My texts - needs reply**, then check they're gone a minute or
   two later.

✅ **Check:** no STOP replies and no replies to a rep's text appear in the CTA views, and contacts leave
the needs-reply view once a rep answers them.

## 3. Reference: what the code returns

**CTA code** ([`workflow-action/sms-cta-tag-action.js`](workflow-action/sms-cta-tag-action.js)):

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

**Needs-reply code** ([`workflow-action/sms-needs-reply-clear-action.js`](workflow-action/sms-needs-reply-clear-action.js)):

| `reason` | `person_replied` | Meaning |
|---|---|---|
| `a rep called after their last text` | true | Last Outbound Call Date/Time is after Last Inbound SMS - Date. `sender` is *call* |
| `answered by <name> on <line>` | true | A text you sent within 2 minutes of Last Outbound SMS - Date, after their last text, has Creator Type *Manual* |
| `no outbound text to check` | false | Last Outbound SMS - Date is empty and there was no call after their text |
| `our last text is older than their reply` | false | They texted after your newest text, so nobody has answered the newest one |
| `text not found in the SMS log yet` | false | No log entry within 2 minutes of the outbound date and after their text. Usually the log was slow; the next text or call checks again |
| `last text was <Creator Type>, not a person` | false | The text was a HubSpot Workflow, Broadcast, Sequence or App Notification |

How the SMS log is read: Aloware writes each text to the contact's timeline as a communication like
`<b>Alex Rep (Browser / Apps) has sent an SMS to <b>+1 ...</b></b><br><b>Line:</b> Acme Shortcode - 12345
<br><b>Creator Type: </b>Manual<br><b>Message:</b><br>...`. Incoming texts read `+1 ... has sent an SMS`
without "to". Both codes read the contact's newest 100 log entries. The CTA code keeps those on the
short code line, finds the reply's own entry and takes the last outgoing text before it, skipping *App
Notification* entries and Aloware's opt-in and opt-out confirmations. The needs-reply code looks at
outgoing entries on every line. Creator Types seen in practice: **HubSpot Workflow**, **Broadcast**,
**Sequence** (the sender shows the sequence name), **Manual** (a person) and **App Notification**
(Aloware's automatic replies).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Nothing is ever tagged | Workflow off, re-enrollment off, or the trigger property is wrong | Step 4b, 4c, 4l |
| Every run errors with 401 | Secret missing or the key was rotated | Step 4e.3, Step 5f.2 |
| Sales-line replies get tagged | Wrong channel account id | Step 1b |
| Replies to reps get tagged | Line name doesn't match, or the key can't read the SMS log | Step 1a, Step 2 |
| SMS CTA Replied To shows Aloware's "You have successfully been subscribed" text | The SMS log couldn't be read and it fell back | Step 2 (add `crm.objects.contacts.read`) |
| A rep sees other reps' contacts | The view's owner filter was saved as a specific person | Step 7, set *Contact owner is any of Me* |
| A rep's view changed for everyone | Someone clicked Save on a shared view | Step 8.3, use Clone |
| A contact stays in a CTA view after a rep starts talking to them | Expected: the tag lasts 3 calendar days | Limits |
| Unowned repliers still pile up | Rotate step missing, or it isn't on the **= Yes** branch | Step 4j |
| Someone who last texted weeks ago shows in **My texts - needs reply** | ON is missing the *is Today* filter, and Aloware wrote an old text during a sync | Step 6b. Set that contact's SMS Needs Reply to No by hand |
| A contact stays in **My texts - needs reply** after a rep answered | The rep's text isn't Creator Type *Manual* (for example, it was sent from somewhere other than Aloware), or the log entry was slow | Check the contact's timeline. The next text or call checks again |
| Nobody's flag ever clears | OFF is off, its eligible-records filter is wrong, or the secret isn't selected | Step 5c, 5f.2, 5j |

## Limits

- **Three calendar days, not 72 hours.** HubSpot's view filters count whole days.
- **No hour filter.** "Last 2 hours" isn't possible in contact views. Use **Today** and newest first.
- **15-minute window.** If HubSpot delays a run by more than 15 minutes (a very large blast), that
  reply isn't tagged. Raise `LOOKBACK_MS` if you see *newest reply is too old* during big sends.
- **Tags don't clear on their own.** A contact who replied to a blast stays in the CTA views for three
  days, even after a rep starts the conversation. **My texts - needs reply** is the list that clears.
- **Opt-outs must match exactly.** *Stop.* or *Stop please* isn't an exact match, so it sets the
  flag. The views hide it once Aloware sets **SMS Opt-out**.
- **Reactions count as texts.** An iPhone reaction (*Liked "..."*) arrives as an inbound text, so it
  sets the flag until someone answers.
- **The flag starts empty.** Only texts after ON is turned on set it. Contacts who were waiting before
  that aren't in **My texts - needs reply** unless you set their flag by hand or with a one-off import.
- **A text that crosses midnight.** A text that arrives seconds before midnight can be checked just
  after it, miss the *is Today* filter, and not be flagged. It still shows in the rep's other views.
- **AI replies.** If an Aloware AI agent answers on one of your lines, check which Creator Type its
  texts get in the SMS log. Unless it's *Manual*, an AI answer doesn't clear the flag, which keeps the
  contact in front of a human.
- **Round robin doesn't know who's working.** It rotates evenly through the team you pick.
- **The SMS log format is Aloware's.** If Aloware changes the wording of its timeline entries (*has
  sent an SMS to*, *Line:*, *Creator Type:*), the person checks stop matching. The CTA code falls back
  to tagging and the needs-reply code stops clearing, and both reasons will show it.
- **Load.** The CTA workflow runs on every incoming text on every line. Opt-outs end before any API
  call. Other replies make three or four read calls each. OFF runs only for flagged contacts and makes
  two read calls. Both codes retry HubSpot 429s twice.

## Security

- The key is read-only, holds only the two scopes above, and is used by the two code steps in this
  guide alone.
- The code writes nothing. All writes happen in the Edit record and Rotate record to owner steps, so
  the workflow history shows every change.
- Never paste the key into the code, a ticket or a chat. It lives only in the workflow secret.
- Message text is copied into **SMS CTA Replied To** on the contact. It's the text you sent, not the
  contact's reply.

Related: [filtered-sms-inboxes-auto-update-outbound-channel](https://github.com/carljibrilsulaimanii/filtered-sms-inboxes-auto-update-outbound-channel)
covers moving buyers from the short code to a sales line with an AloAi reply router.

Built by [Jibril Sulaiman](https://github.com/carljibrilsulaimanii).
