# real-estate-whatsapp-agent

A WhatsApp AI sales agent for real estate. It answers a property enquiry in seconds,
qualifies the buyer, and books the site visit — in the language the buyer actually
writes in.

## Multilingual by necessity

Property buyers in Gujarat do not write in clean English. They write in Gujarati script,
in transliterated Gujarati, in Hinglish, and in English, frequently switching mid-message.
The agent handles **English, Hinglish and Gujarati** and replies in whichever the buyer
used, because a reply in the wrong language reads as a wrong number and the lead is gone.

## What it does

- Answers instantly, at any hour, which is the entire value proposition — most enquiries
  arrive outside office hours and go cold before anyone opens a laptop
- Qualifies on budget, possession timeline and intent
- Captures **structured lead data**, not chat transcripts, so the output is a row a sales
  team can sort and filter rather than a conversation someone has to read
- Books site visits directly into Google Calendar
- Logs every lead to a Google Sheet the owner already knows how to use
- Hands the thread to a human the moment the conversation needs one
- Serves the owner a leads dashboard at `/dashboard`

## Deploying for a business

Configuration only. The system prompt reads business name, context and operating hours
from the environment, so no source changes are needed per deployment. `CLIENT_SETUP.md`
walks through the Sheet, Calendar, Apps Script and Meta credential setup end to end.

## Testing without WhatsApp

```bash
npm run simulate
```

Chats with the agent in the terminal against the real prompt and qualification logic —
no Meta account, no webhook, no phone. This is how the conversation design gets iterated;
going through WhatsApp for every prompt change would make the loop unusably slow.

```bash
npm test        # unit tests
npm run dev     # local server
```

## Stack

Node.js 20 (ESM) · Express · better-sqlite3 for conversation state · OpenAI-compatible
LLM API · Google Apps Script bridging Sheets and Calendar · deploys to Render

## Layout

```
src/           agent, qualification, WhatsApp client, dashboard
apps-script/   Code.gs — the Sheets + Calendar bridge, deployed to the client's account
CLIENT_SETUP.md
```
