/**
 * The bundled sample posting — a real posting's requirements, an invented company.
 *
 * This started as a verbatim capture of the posting this project was built against. That was the right
 * call while the audience was one hiring manager reading their own words back. It stopped being the
 * right call the moment the demo went public at proof.viralhostdigital.com, where recruiters at other
 * companies open it: a named company and its "About" blurb sitting in a shipped fixture reads as
 * leftover personal data, not as a designed sample.
 *
 * So the company is now Northwind Systems, which does not exist, and everything that identified the
 * original — the About paragraphs, the headcount figures, the industry description, the learn-more URL
 * and the AI-in-hiring disclosure — is gone. That was corporate boilerplate, not role content: the
 * parser skipped every line of it and no requirement ever came from it.
 *
 * EVERY REQUIREMENT BULLET IS BYTE-IDENTICAL to the original. They are what the reader parses and what
 * the pinned regression anchor stands on — 16 requirements, scoring 75 for the seeded applicant
 * (tests/resume.test.ts). tests/seed-integrity.test.ts pins both halves of that: the bullets intact,
 * and no company-identifying figure anywhere in the sample or in our own prose in raw/.
 */

export const SAMPLE_POSTING_LABEL = 'AI Product Engineer · Northwind Systems (sample posting)';

export const SAMPLE_POSTING = `AI Product Engineer
Northwind Systems · Remote · $60/hr - $80/hr · part-time, approximately 20 to 25 hours per week

What We Need
The AI Product Engineer will own the design, development, and optimization of Northwind Systems' web
properties, internal tools, and client-facing applications. This role builds and maintains full-stack
web and application experiences across a mixed low-code and custom-code environment, integrating
third-party and AI services where they add value. Working closely with leadership and the Tech Project
Manager, often as the sole engineer on a given project, you will also document systems and reduce
single-owner risk so that critical tools stay maintainable over time. The position requires strong
full-stack web and application development skills, hands-on experience integrating AI and LLM services,
and comfort working across both low-code platforms and custom code. This is a part-time, remote
engagement of approximately 20 to 25 hours per week.

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
- Strong problem-solving skills, with the ability to communicate effectively with technical and non-technical stakeholders`;
