/**
 * The posting, verbatim.
 *
 * This is the actual LinkedIn posting body (job id 4444969099, captured 2026-07-28), not a
 * reconstruction. LinkedIn chrome — tracking URLs, Easy Apply buttons, the applicant count — is
 * stripped; every sentence from "About Arootah" onward is theirs, unedited, including the
 * AI-in-hiring disclosure. The pay/hours header line is assembled from the posting's own figures.
 *
 * Two figures here ("700+ vetted advisors", "600+ coaches") do not appear on arootah.com — earlier
 * research checked — but they appear in this posting, so they are primary-sourced from the company
 * itself and safe to quote with that attribution. tests/seed-integrity.test.ts encodes exactly that
 * rule: allowed here, still banned from our own prose in raw/.
 */

export const SAMPLE_POSTING_LABEL = 'AI Product Engineer · Arootah (actual posting, 2026-07-28)';

export const SAMPLE_POSTING = `AI Product Engineer
Arootah · Remote · $60/hr - $80/hr · part-time, approximately 20 to 25 hours per week

About Arootah
Arootah is a talent solutions firm purpose-built for the alternative investment industry. We advise and
we execute, covering the full talent spectrum from entry to exit across five services: Talent
Acquisition, Fractional Leadership, Talent Development, Retention & Compensation, and Transition.

Most talent firms solve one problem. Because we cover the full spectrum, we can help clients identify
and solve the right one. We start with diagnosis, then deliver.

Our team has run alternative investment firms at the highest levels as COOs, CFOs, and CCOs. That
operator experience, combined with 15+ years of alternatives-specific recruiting and a network of 700+
vetted advisors across 18 functional disciplines, is what makes the advice credible and the execution
reliable. We also draw on a network of 600+ coaches, deploying those with specific experience guiding
senior executives in the alternatives industry.

One industry. One talent partner. Entry to exit.

Learn more: https://arootah.com/

What We Need
The AI Product Engineer will own the design, development, and optimization of Arootah's web properties,
internal tools, and client-facing applications. This role builds and maintains full-stack web and
application experiences across a mixed low-code and custom-code environment, integrating third-party
and AI services where they add value. Working closely with leadership and the Tech Project Manager,
often as the sole engineer on a given project, you will also document systems and reduce single-owner
risk so that critical tools stay maintainable over time. The position requires strong full-stack web
and application development skills, hands-on experience integrating AI and LLM services, and comfort
working across both low-code platforms and custom code. This is a part-time, remote engagement of
approximately 20 to 25 hours per week.

What You'll Do:

- Build and maintain full-stack web and mobile-friendly applications, including React-based front ends and their supporting data layers
- Design and maintain Airtable bases (schema, automations, interfaces, and data quality) that back internal and client-facing tools
- Build workflow automations in n8n and Zapier that connect the CRM, forms, databases, and other services
- Integrate third-party and AI services (for example, LLM APIs such as Anthropic's Claude) into applications and workflows where they add value
- Test, debug, and optimize applications for performance, reliability, and usability
- Collaborate with leadership, the Tech Project Manager, and external vendors to scope work and ship in tight, disciplined cycles
- Document systems and establish maintainable patterns so no single tool depends on one person

Key Skills and Qualifications:

- Bachelor's or Master's degree in Computer Science, Software Engineering, or a related field, or equivalent practical experience
- Demonstrated experience shipping full-stack web and application projects, including a modern JavaScript framework (React preferred)
- Strong front-end skills (HTML, CSS, JavaScript) and experience building responsive, user-friendly interfaces
- Strong experience using Airtable as an application backend (linked records, automations, interfaces)
- Experience with workflow automation platforms (n8n and/or Zapier) and integrating third-party APIs
- Hands-on experience integrating AI or LLM services (for example, Anthropic's Claude) into applications
- Familiarity with Claude Code (Anthropic's agentic coding tool), or a willingness to adopt it to ship quickly
- Comfort operating as a sole or near-sole engineer: self-directed, and disciplined about scope and documentation
- Strong problem-solving skills, with the ability to communicate effectively with technical and non-technical stakeholders

We may use artificial intelligence (AI) tools to support parts of the hiring process, such as reviewing
applications, analyzing resumes, or assessing responses and identifying potential inconsistencies or
verification signals in application materials based on available information. These tools assist our
recruitment team but do not replace human judgment. Final hiring decisions are ultimately made by
humans. If you would like more information about how your data is processed, please contact us.`;
