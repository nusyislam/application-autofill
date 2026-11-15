# Changelog

Company names in this file are fictional stand-ins for the job postings that taught each fix.

## 1.1.0 (unreleased)

- Options: a setup guide the first time Options opens with an empty profile, one section at a time over the real fields: resume and LinkedIn, contact info and links, work experience, education, work authorization and fixed answers, self-identification (optional), the Claude API key (optional, with what gets sent), and a summary of what is filled and what is blank. Back / Next / Skip step on each step, Next saves; "Skip setup" ends it, "Walk through setup" restarts it, and closing the tab resumes where you left off.
- Options: a PDF resume and LinkedIn's "Save to PDF" are read in the browser by a bundled copy of pdf.js (no network, no remote code), and their text goes into Resume text / LinkedIn profile (text) for you to review. Text you typed yourself is kept unless you choose to replace it.
- Options: "Clear fields" in the bottom bar clears the profile, the saved resume and the materials after a confirmation (with "Export backup first"); the API key and learned answers stay unless you tick them. The setup guide starts again afterwards.
- Options: follows the system's light or dark mode.
- Options: during setup every change is saved as you go, so a reload resumes the step with nothing lost; outside setup, "Unsaved changes" shows next to Save and leaving the page asks first.
- Options: fill the profile from your resume and LinkedIn text, in the setup guide (the API key is now step 2) or with "Suggest fields from my resume". Contact details, links, city / state and skills come from the text itself; with a key, Claude reads work history, education, languages and certifications. Every value must appear in your text (anything else is left out and listed), dates that differ between the resume and LinkedIn are flagged, fields you already filled are never changed ("Replace" is offered), and nothing is saved until you accept it. Work authorization, sponsorship, citizenship, clearance, relocation, pay, start dates and self-identification are never filled this way. A job whose LinkedIn description differs from the resume's offers a toggle between the two (with their lengths, and a warning above 2,000 characters); LinkedIn's Top Skills are suggested separately from the resume's skills.

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
