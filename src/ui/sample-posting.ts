/**
 * A sample posting, so the Match screen has something in it before anyone types.
 *
 * ## What this is, precisely
 *
 * It is a **reconstruction**, not a copy. The requirement list is what the real posting asks for; the
 * company description is assembled from copy verified on arootah.com on 2026-07-27. It is here so the
 * demo has a realistic starting point, and the intended use is to paste the actual posting over it.
 *
 * ## What was deliberately left out
 *
 * Two figures often quoted alongside this company — "700+ vetted advisors" and "600+ coaches" — could
 * not be found on the site and are therefore not used anywhere in this project. "18 functional
 * disciplines" and "18 core disciplines" both appear on the site and are used. The site says
 * **time-to-hire**, not time-to-fill.
 *
 * Getting this wrong would be a strange own goal: quoting a company's own numbers back at them
 * incorrectly, inside a demo whose entire argument is that its numbers are verifiable.
 */

export const SAMPLE_POSTING_LABEL = 'AI Product Engineer · Arootah (reconstructed)';

export const SAMPLE_POSTING = `AI Product Engineer
Arootah — part-time, remote, 20-25 hrs/week

Arootah is an executive coaching and business advisory firm working with financial executives and their
teams across alternative investments — hedge funds, private equity firms and family offices. Our
practice spans 18 functional disciplines, covering talent acquisition, fractional leadership, executive
and team coaching, and talent development.

We are looking for an AI Product Engineer to build and maintain the internal tools our advisory and
talent teams run on.

Requirements
- React
- TypeScript
- Airtable as an application backend
- n8n and/or Zapier for workflow automation
- Integrating large language models into production features, including Anthropic's Claude
- Designing prompts and structured outputs that downstream systems can rely on
- Building internal tools that connect systems our team already uses
- REST API integration
- Documented, maintainable systems that someone else can pick up

Nice to have
- Experience with retrieval or vector search
- Familiarity with alternative investments or the hedge fund industry
- Prior work reducing time-to-hire in a talent acquisition workflow
- Cloud deployment experience
- Comfort working directly with non-technical stakeholders

You will work directly with our operations and talent teams, ship in small increments, and own the
tools you build end to end.`;
