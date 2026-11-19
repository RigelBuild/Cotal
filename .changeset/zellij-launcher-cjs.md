---
"@cotal-ai/zellij": patch
---

The zellij launcher script is now `<agent>.cjs`. Node took an extensionless script's module type from the nearest `package.json`, so a parent with `"type": "module"` made every launcher fail with `require is not defined` and the seat never started. The `.cjs` extension fixes CommonJS at the file.
