# Chrome Web Store listing: Application Autofill

Everything the developer dashboard asks for, ready to paste. Assets in this folder: `screenshot-1-fill.png`,
`screenshot-2-options.png`, `screenshot-3-learned.png` (1280x800) and `promo-small-440x280.png`, rendered from the
fake-data pages in `src/` by `tools/screenshots.ps1`. The package is `dist/application-autofill-<version>.zip`, built by
`node tools/build.js`.

## Store listing

**Name**: Application Autofill

**Short description** (130 characters):

> Fills job applications on Workday, Greenhouse, Ashby, Lever, Gem, iCIMS and Rippling from a profile on your device. Never submits.

**Category**: Productivity (Workflow & Planning). **Language**: English.

**Long description**:

> Application Autofill fills job application forms from a profile you keep in the extension's Options page: contact details, work experience, education, links, your resume, and your fixed answers to the questions every application asks (work authorization, sponsorship, relocation, clearance, how you heard about the job, and more). Start dates, pay and other questions that are yours alone are always left for you.
>
> It works on Workday, Greenhouse, Ashby, Lever, Gem, iCIMS and Rippling, including application forms embedded on a company's own careers site. On YC Work at a Startup it drafts the note to the founder for you to rewrite.
>
> How it decides
> 1. Your profile and a long list of rules answer first. A rule either answers from your Options or leaves the field for you and says why in the console. It never hands a question on silently.
> 2. Answers you give yourself to a skipped question are saved, wait for your review in Options, and are reused for that question later. Questions that name a company are reused only for that company.
> 3. Optional: with your own Anthropic API key, questions no rule answers are sent to Claude, and open-ended questions ("Why this company?") get a short first-person draft written from your own materials and the job description, outlined for you to edit.
>
> Every field it touches is outlined so you can review it: blue means answered by a rule or Claude, double-check it; yellow means it needs you; red marks a question about using AI on this application, which you answer yourself. A Done summary tells you how many fields need you. The extension never clicks Submit, Next, Continue, Save or Apply.
>
> Some questions are never answered by AI, whatever the settings: legal attestations and signatures, EEO and demographic questions (only your Options answers fill them), compensation, start dates and availability, notice periods, relationships and conflicts of interest, accommodation requests, and AI-usage disclosures. Forms that forbid AI-written answers get no drafts. Experience questions are answered Yes only when Claude cites a quote that really is in your resume or notes.
>
> Privacy: your profile, key, resume and learned answers stay in the browser's local storage on your device. The only data that leaves it goes to the Anthropic API, with your key, when you turn Claude on. No analytics, no telemetry, no server of ours.
>
> Not affiliated with Workday, Greenhouse, Ashby, Lever, Gem, iCIMS, Rippling, Y Combinator or Anthropic. Portals change their markup, so always review before you submit.

**Website / support URL**: https://github.com/nusyislam/application-autofill (issues: https://github.com/nusyislam/application-autofill/issues)

**Privacy policy URL**: https://github.com/nusyislam/application-autofill/blob/main/PRIVACY.md

**Screenshots** (1280x800):
1. `screenshot-1-fill.png`: A filled application: plain profile fields, blue outlines on rule answers and the draft, yellow on the pay question, red on the AI-usage question, and the Done summary.
2. `screenshot-2-options.png`: The Options page where the profile lives (fake data).
3. `screenshot-3-learned.png`: Learned answers waiting for review, each tagged with its category and the company it is scoped to.

**Small promo tile** (440x280): `promo-small-440x280.png`.

## Privacy practices tab

**Single purpose description**:

> Fills job application forms on supported job portals (Workday, Greenhouse, Ashby, Lever, Gem, iCIMS, Rippling, YC Work at a Startup) from a profile the user maintains in the extension's Options page, and outlines every field it filled for the user to review before they submit.

**Permission justifications**:

| Permission | Justification |
| --- | --- |
| `storage` | Keeps the user's profile, settings, resume file, learned answers and small caches in `chrome.storage.local` on the device. There is no server. |
| `unlimitedStorage` | The resume file is stored as a data URL (a PDF or Word file of several MB), next to pasted resume and LinkedIn text; together they can exceed the default `chrome.storage.local` quota. |
| `activeTab` | Filling from the toolbar popup or the keyboard shortcut (Alt+Shift+F) on a form embedded in a company's own careers site: the form is an iframe from a supported portal, but the top page is the company's site, which the extension has no host permission for. activeTab lets it inject only the small "Done" summary and the progress panel into that top frame, on the user's gesture. |
| `scripting` | Two uses: injecting the extension's own content scripts into a supported portal tab that was already open when the extension was installed or updated (so the user does not have to reload), and injecting the "Done" summary / progress panel function into the top frame of an embedded form (see activeTab). Only files packaged in the extension are injected; never remote code. |
| `notifications` | An optional desktop notification ("Done on <site>. N need you.") when the fill finishes while the user is on another tab or window. Off in Options with one checkbox. |
| Host permissions, job portals (`*.myworkdayjobs.com`, `*.myworkday.com`, `*.myworkdaysite.com`, `boards.greenhouse.io`, `job-boards.greenhouse.io` and their `.eu.` variants, `jobs.ashbyhq.com`, `jobs.lever.co`, `jobs.eu.lever.co`, `jobs.gem.com`, `*.icims.com`, `ats.rippling.com`, `workatastartup.com`, `www.ycombinator.com/companies/*`) | The sites the extension fills forms on; the content scripts run there and read the form and the job posting. Wildcard subdomains are needed because each employer has its own Workday (`<tenant>.wd5.myworkdayjobs.com`) and iCIMS (`careers-<tenant>.icims.com`) host. No other sites. |
| Host permission `api.anthropic.com` | The one network endpoint the extension calls: Anthropic's Messages API, from the background service worker, with the user's own key, when the user has turned Claude on. |
| Remote code | **No.** All code is packaged. The extension uses no `eval`, loads no remote scripts, and treats Claude's replies as data (JSON answers), never as code. |

**Data usage** (what the extension collects or uses):

- [x] **Personally identifiable information**: name, email, phone, address, work and education history, links, the user's own answers to application questions. Entered by the user in Options; stored locally; a text summary is sent to the Anthropic API when the user has turned Claude on and a page has questions no rule answers.
- [x] **Authentication information**: the user's own Anthropic API key, stored locally and sent only to api.anthropic.com as the request header.
- [x] **Website content**: the labels, options and job description of the application page being filled, sent to the Anthropic API for the questions no rule answers (and only then).
- [ ] Health information
- [ ] Financial and payment information (compensation questions are never filled or sent)
- [ ] Personal communications
- [ ] Location (the home address is part of the profile above; the extension reads no device location)
- [ ] Web history
- [ ] User activity (the extension records which fields it filled, in the tab's session storage, to avoid overwriting the user's edits; nothing leaves the device)

**Certifications** (all three):
- [x] I do not sell or transfer user data to third parties, outside of the approved use cases.
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes.

## Notes for the reviewer

- The AI part is optional and needs the user's own Anthropic API key (Options, "Claude API"). Without a key the rules still fill everything they can and the rest is outlined yellow.
- To test: open a public posting on any supported portal (for example a job-boards.greenhouse.io posting), fill the profile in Options, then click the floating "Autofill page" button, the popup's "Fill this page", or press Alt+Shift+F. The extension outlines what it filled and never clicks Submit, Next or Save.
- The background service worker makes one kind of network request: `https://api.anthropic.com/v1/messages` (host permission `api.anthropic.com`). The content scripts read the job posting's location and description from the portal they run on: the posting page (same origin) and, on Greenhouse and Lever, the portal's public, CORS-enabled job-board API (`boards-api.greenhouse.io/v1/boards/<board>/jobs/<id>`, `api.lever.co/v0/postings/<company>/<id>` or `api.eu.lever.co`). Those public APIs allow cross-origin reads, so no host permission is needed for them, and the requests carry no user data; a failed read just leaves the location unknown.
- The test pages and screenshots use fake data and fictional companies.
