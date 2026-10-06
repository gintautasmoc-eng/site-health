# site-health

Hourly synthetic monitor for `langu-remontas.lt` and `naprawa-okna24.pl`.

## What it checks

Every hour, for each site, a headless Chromium:

1. Loads the homepage (expects HTTP 200)
2. Finds the hero CTA button (`KVIESTI MEISTRĄ` / `UMÓW WIZYTĘ`)
3. Clicks it
4. Verifies a form modal opens with `<input type="tel">`
5. Verifies the modal has a submit button
6. Watches for JS errors and 5xx responses on the page

**The probe never submits the form.** No CRM writes, no test emails.

## Alerts

Sent to `ALERT_EMAIL` via Gmail SMTP (`GMAIL_USER` + `GMAIL_APP_PASSWORD`):

- `[DOWN]` — only on transition OK → FAIL (not every hour)
- `[STILL DOWN]` — reminder every 4h while still failing
- `[RECOVERED]` — when the site is working again
- `[MONITOR BROKEN]` — if the probe script itself crashes

Transient failures (CDN cold start, network blip) are filtered by a 2-minute
retry inside each check — only confirmed failures alert.

## Not disturbing the sites

- Custom User-Agent `site-health-monitor/1.0` — add this to the GA4 developer
  traffic exclusion filter if you want to keep analytics clean
- Form is never submitted → no CRM pollution, no sent emails to the business
- ~24 requests/day/site is negligible bandwidth

## State

`state.json` tracks per-site status (`ok` / `fail`), when the failure started,
and when the last alert was sent. It is committed back to the repo after each
run so transitions are correctly detected across cron runs.

## Running locally

```bash
npm ci
npx playwright install chromium
GMAIL_USER=... GMAIL_APP_PASSWORD=... ALERT_EMAIL=... node probe.mjs
```

Omit the env vars to skip email and just print to stdout.

## Manual trigger

GitHub → Actions → Site Health Check → Run workflow.

## Adjusting cadence

Edit `.github/workflows/health.yml` → `cron`.
Current: `0 * * * *` (hourly). Half-hourly would be `0,30 * * * *`.

## When something fires

1. Open the site in a browser and reproduce the failure manually
2. Check recent deploys on Vercel (both projects)
3. Check `state.json` to see when the failure started — correlate with deploy time
4. Fix the bug, redeploy, next hourly check will send `[RECOVERED]`
