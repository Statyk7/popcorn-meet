---
name: verify
description: Validate the extension's JS files for syntax errors and check manifest.json structure. Use after making changes to ensure nothing is broken.
---

Run these validation steps and report any errors:

1. **JS syntax check** — run `node --check content.js` and `node --check background.js` to catch syntax errors.
2. **Manifest validation** — run `node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('manifest.json: valid JSON')"` to verify manifest.json is valid JSON.
3. **Manifest structure** — read manifest.json and verify it has required MV3 fields: `manifest_version`, `name`, `version`, `content_scripts`, `background`.

Report a summary: which checks passed, which failed, and what needs fixing.
