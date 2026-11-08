# Privacy policy: Application Autofill

Last updated: 2026-11-08. Applies to the Chrome extension "Application Autofill" (the "extension"), published from
https://github.com/nusyislam/application-autofill.

## Summary

- Everything you enter is stored on your own device, in the extension's local browser storage. There is no account,
  no server run by the developer, no sync, no analytics, no advertising, no crash reporting and no telemetry.
- The only data that ever leaves your device goes to Anthropic's API (api.anthropic.com), with the API key you paste
  into Options, and only when you have turned "Use Claude" on. What is sent is described below.
- Your data is never sold, rented, shared or transferred to the developer or to anyone else.
- You can delete everything at any time by removing the extension, or piece by piece in Options.

## What the extension stores, and where

All of it lives in `chrome.storage.local` for this extension, on the device where you installed it. Chrome does not sync
this storage area, and the developer has no access to it.

| Data | What it is | Why |
| --- | --- | --- |
| Profile | Name, email, phone, address, links (LinkedIn, GitHub, website), work experience, education, languages, skills, the answers you set for fixed questions (work authorization, sponsorship, relocation, clearance, travel, government / military history and so on), optional self-identification answers (gender, race, veteran status, disability, orientation, pronouns, birth month and year), resume text, LinkedIn profile text, extra notes, projects to highlight. | To fill application forms. |
| Anthropic API key | The key you paste into Options. | To call Anthropic's API on your behalf. It is sent only to api.anthropic.com, as the `x-api-key` header. Backups exported from Options leave it out. |
| Resume file | The file you choose in Options, stored as a data URL. | To upload it into resume fields. |
| Settings | Toggles (use Claude, learn, drafts, notification), the confidence threshold, model names. | Behaviour. |
| Learned answers | Questions you answered yourself on an application page and the answer you gave, with the company a question names; entries you delete stay in "Recently deleted" for 30 days, then disappear. | To reuse your own answer when the same question comes up again. Whole categories are never learned (pay, availability, EEO, attestations, passwords, dates, AI-usage questions; see Options). |
| Caches | The category a question was sorted into (question text only, never your answer); skills a Workday site's list did not have (kept 7 days). | So the same question is handled the same way on a rerun, without another API call. |
| Per-tab notes | In the tab's `sessionStorage`: which fields the extension filled on that page and which drafts it used, so a rerun does not overwrite your edits. | Cleared when the tab closes. |

The extension reads the application page it is filling (field labels, options, the job's title, location and
description) to decide what to fill. It does not record your browsing, and it runs only on the job-portal sites listed
in its manifest.

## What is sent, and where

Nothing is sent anywhere unless "Use Claude" is on and an API key is set. Then, and only for questions no built-in rule
could answer, the extension calls `https://api.anthropic.com/v1/messages` directly from your browser with your key.
There is no intermediary: the developer runs no server and never sees these requests.

What a request can contain:

- The text of the unanswered questions on the page, their options, the page title or company name, and the job
  description (page content, marked as data so that instructions hidden in a page are not followed).
- A text summary of your profile (name, location, education, work history, skills, fixed answers), and, for drafts of
  open-ended answers, your resume text, LinkedIn profile text, extra notes and projects to highlight.
- For "Do you have experience with X?" questions: the question and the same materials, so the model can quote them.
- For the learning classifier: the question text only, never your answer.
- For option mapping: the question's options and the preferences you checked in Options.

Some questions are never sent, whatever the settings: legal attestations and signatures, EEO / demographic questions,
compensation, start date and availability, notice period, relationships and conflicts of interest, accommodation
requests, questions about using AI or tools on the application, and any field the extension treats as sensitive
(passwords, social security numbers, dates of birth, bank and card numbers, licence and passport numbers). The resume
file itself is never sent.

How Anthropic handles API inputs is governed by Anthropic's own terms and privacy policy for API users
(https://www.anthropic.com/legal/privacy), under the account that owns your key. You can revoke the key at any time in
your Anthropic console.

The extension also reads the job posting from the portal you are on (the posting page, or the portal's public
job-board API, such as Greenhouse's or Lever's) to learn the job's location and description. These are requests to
the portal itself, carry none of your data, and happen only when a question on the page needs the job's location or
when there are drafts to write.

## What the extension does not do

- No analytics, usage statistics, telemetry, error reporting or tracking of any kind.
- No data is sent to the developer or to any third party other than Anthropic, at your instruction, as described above.
- No selling, renting, sharing or transferring of user data; no use for advertising, credit, lending or any purpose
  other than filling the application in front of you.
- It never submits an application, clicks Next / Continue / Save, or navigates a page. You review and submit.

## Chrome Web Store user data policy and Limited Use

The extension's use of user data complies with the Chrome Web Store User Data Policy, including its Limited Use
requirements:

- User data is used only to provide the single purpose the extension describes: filling job application forms from
  the profile you maintain.
- User data is transferred only to the AI provider you configured (Anthropic), to answer questions on the page in front
  of you; otherwise only if required for security purposes or to comply with applicable law.
- User data is never used or transferred for advertising, for determining creditworthiness or for lending purposes.
- No human reads your data: the developer has no access to it.

## How to delete everything

- **All of it**: open `chrome://extensions` and remove the extension. Chrome deletes the extension's `chrome.storage.local`
  (profile, key, resume file, learned answers, caches) with it. Export a backup from Options first if you want one.
- **The API key**: clear the "API key" field in Options and Save.
- **The resume file**: choose a different file in Options, or remove the extension.
- **Learned answers**: delete single entries, or "Clear all"; both move entries to "Recently deleted", where "Delete
  permanently" removes them at once (otherwise after 30 days).
- **Data held by Anthropic**: subject to Anthropic's retention policy for API usage under your own account; manage it
  from your Anthropic console.

## Changes and contact

Changes to this policy are published in this file in the repository, with the date above. Questions and reports:
open an issue at https://github.com/nusyislam/application-autofill/issues.
