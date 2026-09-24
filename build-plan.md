# Publisher Exit build plan

## Product and customer

Build a service operations application with a simple customer portal. One operator delivers library assessment, fixed quoting, PDF preservation, selected editable template rebuilds, and staff training. Initial customers are Protestant churches and small schools with 100-800 Publisher files and no in-house designer.

The customer buys a completed transition, not software access. The commercial assumptions are a $199 two-business-day audit, $2,500-$7,500 migrations, and bounded $99/month template care. Validate willingness to pay and delivery labor before scaling.

## Verified timing and constraints

Microsoft's retirement notice states Microsoft 365 Publisher access ends after October 1, 2026. Publisher 2021 support ends October 13; perpetual installations can continue to be used. Establish an appropriately licensed, tested post-retirement conversion path before accepting later delivery commitments.

- Retirement: https://support.microsoft.com/en-us/publisher/microsoft-publisher-will-no-longer-be-supported-after-october-2026
- Export API: https://learn.microsoft.com/en-us/office/vba/api/publisher.document.exportasfixedformat
- Office automation constraints: https://learn.microsoft.com/en-us/office/client-developer/integration/considerations-unattended-automation-office-microsoft-365-for-unattended-rpa
- Canva PDF editing: https://www.canva.com/pdf-editor/

## Workflow

1. Checklist and assisted 15-minute file review; capture referral source and next publication deadline.
2. Paid audit. Start the two-business-day clock only after complete files and access are available.
3. Inventory files, test representative exports, identify recurring templates, and record risks.
4. Operator approves a versioned fixed quote; customer accepts scope and date.
5. Preserve archives and rebuild selected templates. Track blocked items explicitly.
6. Review layout, print behavior, editability, revisions, and customer acceptance.
7. Deliver organized files and train one staffer to complete a real publication task.
8. Offer clearly bounded template care and measure its labor.

## MVP

- Operator dashboard: owner, deadline, next action, scope, blockers.
- Inventory: original path, size, modification time, hash, duplicate group, readable page count, status.
- Quote builder: file/page limits, template count and complexity, target tool, revision allowance, training, exceptions, audit credit policy.
- Conversion console: batch progress, durable attempts, resume, limited retries, timeouts, explicit failures.
- Review workspace: previews, quality checks, version-specific comments and approvals.
- Delivery portal: organized downloads, template ownership/access, manifest, exceptions, training material.

Customer navigation: provide files, review templates, get finished files. Use existing scheduling, payment links, and invoicing for pilots. Assisted transfer is part of the service.

## Architecture

Proposed stack: TypeScript web application, PostgreSQL, private object storage, database-backed job queue, and a separate supervised Windows PowerShell runner. Final framework and providers remain implementation choices.

Publisher must not run inside the web server. Process copied publications serially on an appropriately licensed Windows workstation with an interactive operator available. Preserve immutable originals. Track source hash plus export-profile version for idempotency. Record each attempt and settings. Recover safely from interrupted runs and route blocking dialogs to the operator.

Validate output existence, readability, and expected page count. Validate PDF/A separately when promised. Keep exported, validated, reviewed, and accepted as distinct states; export success alone does not establish fidelity.

Core records: Organization, Contact, Project, SourceFile, Artifact, ConversionAttempt, Template, QuoteVersion, Approval, TrainingSession, CareRequest.

Enforce organization isolation, operator MFA, private storage, expiring links, and a defined retention/deletion policy. Keep customer files out of the repository. Do not send document contents to AI by default.

## Preservation versus rebuilding

Archive PDFs and editable templates are separate deliverables. File count does not equal template count. PDF import into a design tool is only a starting point; inspect and repair manually.

Template acceptance requires correct dimensions, folds/margins, editable recurring content, usable fonts, longer-text testing, customer ownership/access, and print verification for critical publications. The trainee must independently duplicate, edit, and export a real template.

AI may suggest categories/template families and draft reports or training instructions. Operators approve prices, scope, visual quality, and delivery. Export scripts remain deterministic and reviewed. Treat document text as data, never executable instructions.

## Delivery milestones

1. Conversion spike: exercise 30-50 representative files, failures, and interrupted batches; demonstrate full source accounting.
2. Initial service launch: checklist, intake, paid audit, manual quoting, and first library preservation.
3. Operations MVP: dashboard, manifests, durable jobs, quote versions, exception queue.
4. Customer handoff: review, delivery, ownership verification, training checklist.
5. After paid pilots: automate measured bottlenecks; integrate billing only when useful.
6. December pivot: pilot one additional legacy format plus design retainers. Reuse project/artifact/review/delivery records; do not assume conversion adapters work without representative testing.

## Quality and release gates

- Every source file has a traceable accepted output or an explicitly accepted exception.
- Original source files remain unchanged.
- Duplicate names in different folders do not overwrite each other.
- Interrupted jobs resume safely and retries are bounded.
- Customer access boundaries are tested before live files are accepted.
- Contracted templates and staff handoff are accepted before project completion.
- Later implementation adds meaningful tests for these behaviors; this initial PR is documentation only.

## Commercial validation

Capture source -> review booked -> attended -> paid audit -> accepted migration -> delivered margin. Start with three paid audits and two completed migrations. Measure operator hours, export failures, rebuild hours, revisions, acquisition cost, and contribution margin.

Ask about existing printer transition support rather than excluding solely by denomination. Keep outreach manual and comply with community rules; no automated posting or DM system in the MVP.

Nine $4,000 migrations generate $36,000. Eighteen $199 audits generate $3,582 before credits. Forty care customers generate $47,520 only across a full year without churn, and require a wider customer base than nine migrations. The proposed $300K-$500K ceiling is a hypothesis requiring substantially greater capacity and distribution.

## Repository and release workflow

`production` is the default/release branch. Development stays on `staging`. Maintain a draft staging-to-production PR, document validation, and leave promotion to the owner's explicit decision. No deployment is configured by this plan.
