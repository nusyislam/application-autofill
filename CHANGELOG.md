# Changelog

Company names in this file are fictional stand-ins for the job postings that taught each fix.

## 1.1.0 (2026-11-15)

Setup and profile editing in Options, plus fixes from real applications since 1.0.2. No new permissions.

### New

- Setup guide: the first time Options opens with an empty profile, it walks through the real fields one step at a time: resume and LinkedIn, the Claude API key (optional, with what gets sent), contact info and links, work experience and skills, education and languages, work authorization and fixed answers, self-identification (optional), and a summary of what is filled, partly filled and blank, with a link back to each step. Back / Next / Skip step on each step, Next saves; "Skip setup" ends it, "Walk through setup" restarts it, and closing the tab resumes where you left off.
- PDF text in the browser: a PDF resume and LinkedIn's "Save to PDF" are read by a bundled copy of pdf.js (no network, no remote code), laid out by position (columns, right-aligned dates, wrapped lines, bullets, page footers), and the text goes into Resume text / LinkedIn profile text for you to review. Text you typed yourself is kept unless you choose to replace it.
- Profile from your resume, with review: in the setup guide or with "Suggest fields from my resume". Contact details, links, city / state and skills come from the text itself; with a key, Claude reads work history, education, languages and certifications. Every value must appear in your text (anything else is left out and listed), dates that differ between the resume and LinkedIn are flagged, fields you already filled are never changed ("Replace" is offered), and nothing is saved until you accept it. Work authorization, sponsorship, citizenship, clearance, relocation, pay, start dates and self-identification are never filled this way. A job whose LinkedIn description differs from the resume's offers a toggle between the two (with their lengths, and a warning above 2,000 characters); LinkedIn's Top Skills are suggested separately; certificates, bootcamps and fellowships listed under Education are suggested as certifications (one name, however it is worded); a language given with one overall level fills only the combined level.
- Clear fields: clears the profile, the saved resume and the materials after a confirmation (with "Export backup first"); the API key and learned answers stay unless you tick them. The setup guide starts again afterwards.
- Selective import: importing a backup shows what it holds and lets you choose profile fields, materials, settings and learned answers, and whether to fill only empty fields or replace yours (with a warning listing what would change). Jobs, schools and languages are merged without duplicates, learned answers you deleted or that are never learned are skipped, and the API key is never imported.
- Autosave: during setup every change is saved as you go, so a reload resumes the step with nothing lost; outside setup, "Unsaved changes" shows next to Save and leaving the page asks first.
- Options redesign: light and dark mode; the Resume section split into Resume, LinkedIn and For Claude cards (each upload right above its text); text boxes that grow with their text and show a character count; short labels with the explanation underneath; controls that line up in each row; checkbox text that wraps beside its box; the contact fields work with the browser's address autofill.

### Fixes

- Lever and every other portal: self-identification radios and checkboxes whose options carry a description after the title ("Asian (Not Hispanic or Latino)" followed by "A person having origins in ...") are matched on the title only. The description names other groups, so the race answer used to find no acceptable option and the field was left empty.
## 1.0.2 (2026-11-14)

Fixes from real applications, batched since 1.0.1.

- Greenhouse: "Are you located in San Francisco, New York or London?" is read as three cities, so an address in one of them answers Yes. "City, State" pairs stay together and are judged by the city ("Albany, New York" is not New York City).
- Greenhouse: a question about how you use AI tools no longer counts as an AI-use policy; only a form that prohibits or restricts AI, or requires disclosing it, turns drafts off. The log names the phrase that matched.
- Greenhouse (job-boards UI): the Employment section is filled as repeatable experience entries, matched to your work history by company, title and dates: dates and "Current role" are filled, a missing job is added with "Add another", and the Education section's dates stay in Education.
- Workday and Greenhouse: after "I currently work here" / "Current role" is toggled, the To / End date the form reveals is filled from the matching job; the reverse (your profile says current) ticks the box and drops the end date.
- Workday: sections that render late on a page prefilled by "Use my last application" (the Skills box) are found by a second scan after the panels, and a Skills box that never appears on My Experience is logged instead of silently skipped.
- Ashby: "What is the location where you permanently reside?" and other home-location questions on a type-to-search picker get your application location, like the Location field.
- Ashby: "Current Company" / "Current Job Title" take your most recent job (the one marked current, else the latest end date), never the first entry in your list.
- Ashby: "Which of our office locations would you be open to working from? (Select all that apply)" checks only the office that matches where you live or your office locations; a rule's Yes / No is never handed to the AI mapper as a bare word any more, and a mapper pick that contradicts the rule's meaning is rejected.
- The first log line of every fill, and the popup footer, say which build is running (version, store or unpacked, and the git commit for an unpacked clone).

## 1.0.1 (2026-11-08)

- Store listing resubmitted: the supported portals are named once, in the long description.
- New extension icon.

## 1.0.0 (2026-11-08)

- First Chrome Web Store submission.
