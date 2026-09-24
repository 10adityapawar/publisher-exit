# Application development

- The default/release branch is `production`; develop on `staging`.
- Check the working tree and current branch before editing. Preserve unrelated changes.
- Never commit application development directly to `production`.
- Keep a draft pull request from `staging` into `production` while preparing a release. Update the existing open PR instead of creating duplicates.
- Do not merge, force-push, delete either long-lived branch, or deploy unless the user explicitly authorizes that action.
- Validate changes with checks appropriate to their scope. Report what was checked and any unresolved limitations in the PR.
- After an authorized promotion, synchronize `staging` with `production` without rewriting shared history. Use a new PR for the next release.
- Keep secrets, customer source files, exports, and local machine state out of Git.
- This repository begins with a build plan. Do not imply the application exists until implemented.
