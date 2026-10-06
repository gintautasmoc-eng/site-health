// Site health monitor — checks that homepage loads AND the hero CTA button
// actually opens a form with a phone input and a submit button. This catches
// the exact failure mode that broke naprawa-okna24.pl on 2026-10-02 (dead-code
// cleanup removed a translation key wired to the CTA onClick handler).
//
// The probe does NOT submit the form, so it cannot pollute the CRM or send
// test emails. If anything is wrong, an email is sent via Gmail SMTP.

import { chromium } from 'playwright'
import nodemailer from 'nodemailer'
import fs from 'node:fs/promises'

const SITES = [
  {
    name: 'langu-remontas.lt',
    url: 'https://langu-remontas.lt/',
    // "KVIESTI MEISTRĄ" — avoid matching the diacritic to be more forgiving
    heroButtonText: /KVIESTI\s+MEISTR/i,
    locale: 'lt-LT',
  },
  {
    name: 'naprawa-okna24.pl',
    url: 'https://naprawa-okna24.pl/',
    // "UMÓW WIZYTĘ" — allow both Ó and O; stop before the Ę
    heroButtonText: /UM[OÓ]W\s+WIZYT/i,
    locale: 'pl-PL',
  },
]

const STATE_FILE = 'state.json'
const REMINDER_HOURS = 4
const RETRY_DELAY_MS = 120_000 // 2 min — covers transient CDN/cold-start blips
const USER_AGENT = 'site-health-monitor/1.0 (+https://github.com/langmita/site-health; health check, no CRM writes)'

async function probe(site) {
  const errors = []
  const browser = await chromium.launch({ headless: true })
  try {
    const ctx = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1280, height: 800 },
      locale: site.locale,
    })
    const page = await ctx.newPage()

    page.on('pageerror', e => errors.push(`pageerror: ${e.message.slice(0, 200)}`))
    page.on('console', msg => {
      if (msg.type() !== 'error') return
      const text = msg.text()
      // Filter third-party noise that is not our bug
      if (/favicon|preload|third-party cookie|cookiebot|googletagmanager|clarity|facebook|tiktok|hcaptcha/i.test(text)) return
      errors.push(`console: ${text.slice(0, 200)}`)
    })
    page.on('response', r => {
      if (r.status() >= 500) errors.push(`${r.status()} ${r.url().slice(0, 150)}`)
    })

    // 1. Homepage loads
    const resp = await page.goto(site.url, {
      waitUntil: 'load',
      timeout: 25_000,
    })
    if (!resp) throw new Error('no response from homepage')
    if (resp.status() >= 400) throw new Error(`homepage returned ${resp.status()}`)

    // 1b. Wait for the page to settle — React hydration must finish before
    // clicks are wired up. networkidle is best-effort (some sites have
    // long-polling trackers); fall back to a short fixed wait.
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {})
    await page.waitForTimeout(500)

    // 2. Hero CTA button is visible. Scope to <button> and visible-only to
    // skip hidden mobile-nav duplicates and non-interactive anchors.
    const btn = page.locator('button:visible').filter({ hasText: site.heroButtonText }).first()
    await btn.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {
      throw new Error('hero CTA button not visible (selector did not match any visible <button> with the expected text on homepage)')
    })

    // 3. Clicking the button opens the form modal
    await btn.click()

    // 4. Modal has a telephone input
    const telInput = page.locator('input[type="tel"]').first()
    await telInput.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {
      throw new Error('after clicking CTA, no <input type="tel"> appeared (modal did not open or form missing phone field)')
    })

    // 5. Modal has a submit button
    const submit = page.locator('button[type="submit"]').first()
    await submit.waitFor({ state: 'visible', timeout: 3_000 }).catch(() => {
      throw new Error('form modal is missing a submit button')
    })

    // 6. Give lazy things a moment to error out
    await page.waitForTimeout(500)
    if (errors.length > 0) {
      throw new Error('page emitted errors: ' + errors.slice(0, 3).join(' | '))
    }

    return { ok: true }
  } catch (e) {
    return {
      ok: false,
      error: e.message,
      stepErrors: errors.slice(0, 5),
    }
  } finally {
    await browser.close()
  }
}

async function probeWithRetry(site) {
  const first = await probe(site)
  if (first.ok) return { ...first, attempts: 1 }

  console.log(`  … first attempt failed (${first.error}), waiting ${RETRY_DELAY_MS / 1000}s and retrying`)
  await new Promise(r => setTimeout(r, RETRY_DELAY_MS))
  const second = await probe(site)
  return {
    ...second,
    attempts: 2,
    firstError: first.error,
  }
}

async function loadState() {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, 'utf8'))
  } catch {
    return {}
  }
}

async function saveState(state) {
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2) + '\n')
}

function sendMail(subject, body) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    console.log('  (skipping email — GMAIL_USER/GMAIL_APP_PASSWORD not set)')
    return Promise.resolve()
  }
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  })
  return transporter.sendMail({
    from: `"Site Health Monitor" <${process.env.GMAIL_USER}>`,
    to: process.env.ALERT_EMAIL || process.env.GMAIL_USER,
    subject,
    text: body,
  })
}

function minutesSince(iso) {
  return Math.round((Date.now() - new Date(iso).getTime()) / 60_000)
}

function formatDuration(mins) {
  if (mins < 60) return `${mins} min`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return `${h}h ${m}min`
}

function buildAlert(kind, site, result, state) {
  const now = new Date().toISOString()
  if (kind === 'DOWN') {
    return {
      subject: `[DOWN] ${site.name} — hero CTA broken`,
      body: [
        `Site: ${site.name}`,
        `URL: ${site.url}`,
        `Status: FAILING`,
        `First detected: ${now}`,
        '',
        `Error: ${result.error}`,
        result.firstError && result.firstError !== result.error ? `First attempt: ${result.firstError}` : null,
        result.stepErrors?.length ? `Page errors: ${result.stepErrors.join(' | ')}` : null,
        '',
        `What was checked:`,
        `  1. Homepage returns 200`,
        `  2. Hero CTA button visible`,
        `  3. Clicking it opens the form modal`,
        `  4. Modal has <input type="tel">`,
        `  5. Modal has submit button`,
        `  6. No JS errors or 5xx responses on page`,
        '',
        `Next check: in ~1 hour. You will get a reminder every ${REMINDER_HOURS}h while this is broken, and a RECOVERED email when fixed.`,
      ].filter(Boolean).join('\n'),
    }
  }
  if (kind === 'REMINDER') {
    const dur = formatDuration(minutesSince(state.failureStart))
    return {
      subject: `[STILL DOWN] ${site.name} — ${dur}`,
      body: [
        `${site.name} is still failing.`,
        `Down since: ${state.failureStart}`,
        `Duration: ${dur}`,
        '',
        `Latest error: ${result.error}`,
        '',
        `Next reminder in ${REMINDER_HOURS}h if still broken.`,
      ].join('\n'),
    }
  }
  if (kind === 'RECOVERED') {
    const dur = formatDuration(minutesSince(state.failureStart))
    return {
      subject: `[RECOVERED] ${site.name} — back online`,
      body: [
        `${site.name} is working again.`,
        `Was down: ${state.failureStart}`,
        `Recovered: ${now}`,
        `Total downtime: ${dur}`,
      ].join('\n'),
    }
  }
}

async function main() {
  const state = await loadState()
  const now = new Date().toISOString()
  let anyFailed = false

  for (const site of SITES) {
    console.log(`\n→ Checking ${site.name}`)
    const result = await probeWithRetry(site)
    const prev = state[site.name] || { status: 'ok', failureStart: null, lastAlertSent: null, lastError: null }

    if (result.ok) {
      if (prev.status === 'fail') {
        const alert = buildAlert('RECOVERED', site, result, prev)
        try {
          await sendMail(alert.subject, alert.body)
          console.log(`  ✓ RECOVERED email sent`)
        } catch (e) {
          console.error(`  ! RECOVERED email failed: ${e.message}`)
        }
      }
      state[site.name] = { status: 'ok', failureStart: null, lastAlertSent: null, lastError: null }
      console.log(`  ✓ OK (${result.attempts} attempt${result.attempts === 1 ? '' : 's'})`)
    } else {
      anyFailed = true
      if (prev.status === 'ok' || !prev.failureStart) {
        state[site.name] = { status: 'fail', failureStart: now, lastAlertSent: now, lastError: result.error }
        const alert = buildAlert('DOWN', site, result, state[site.name])
        try {
          await sendMail(alert.subject, alert.body)
          console.log(`  ! DOWN email sent`)
        } catch (e) {
          console.error(`  ! DOWN email failed: ${e.message}`)
        }
      } else {
        const hoursSinceLastAlert = (Date.now() - new Date(prev.lastAlertSent).getTime()) / 3600_000
        if (hoursSinceLastAlert >= REMINDER_HOURS) {
          state[site.name] = { ...prev, lastAlertSent: now, lastError: result.error }
          const alert = buildAlert('REMINDER', site, result, state[site.name])
          try {
            await sendMail(alert.subject, alert.body)
            console.log(`  ! REMINDER email sent (${hoursSinceLastAlert.toFixed(1)}h since last)`)
          } catch (e) {
            console.error(`  ! REMINDER email failed: ${e.message}`)
          }
        } else {
          state[site.name] = { ...prev, lastError: result.error }
          const next = (REMINDER_HOURS - hoursSinceLastAlert).toFixed(1)
          console.log(`  ! Still failing (next reminder in ${next}h)`)
        }
      }
      console.log(`    error: ${result.error}`)
    }
  }

  await saveState(state)
  console.log('\n' + (anyFailed ? 'One or more sites failing — see state.json' : 'All sites healthy'))
  // Always exit 0: the health check script itself succeeded. Site status is
  // communicated via email + state.json, not via workflow red/green.
  process.exit(0)
}

main().catch(err => {
  console.error('FATAL:', err)
  // Try to notify about monitor infrastructure failure
  sendMail(
    '[MONITOR BROKEN] site-health probe crashed',
    `The probe script itself crashed. Site status unknown.\n\n${err.stack || err.message}`
  ).catch(() => {}).finally(() => process.exit(2))
})
