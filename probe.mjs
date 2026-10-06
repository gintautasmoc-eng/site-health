// Site health monitor — synthetic Playwright probes that verify the lead
// capture flow actually works. The script covers multiple scenarios (homepage
// hero CTA, inline contact form, service landing CTA) in both desktop and
// mobile viewports. It never submits a form, so there is no CRM pollution.
//
// Background: on 2026-10-02 a dead-code cleanup on naprawa-okna24.pl removed
// a translations key the "UMÓW WIZYTĘ" onClick handler depended on. The
// button rendered but did nothing, and the breakage went unnoticed for ~4
// days. /code-review and /review did not catch it because they analyze
// diffs, not runtime behavior. This probe does.

import { chromium } from 'playwright'
import nodemailer from 'nodemailer'
import fs from 'node:fs/promises'

// ─── Scenarios ───────────────────────────────────────────────────────────────
// Each scenario is one page × one interaction. If `trigger` is set, the probe
// clicks a visible <button> whose text matches the regex, then verifies that
// a form modal appears. If `trigger` is omitted, the probe treats the form
// as inline (no click needed, phone input must be visible on load).

const SCENARIOS = [
  // LT — langu-remontas.lt
  {
    site: 'langu-remontas.lt',
    name: 'homepage hero CTA',
    url: 'https://langu-remontas.lt/',
    trigger: /KVIESTI\s+MEISTR/i,
    locale: 'lt-LT',
  },
  {
    site: 'langu-remontas.lt',
    name: '/lt/kontaktai inline form',
    url: 'https://langu-remontas.lt/lt/kontaktai',
    locale: 'lt-LT',
  },
  {
    site: 'langu-remontas.lt',
    name: 'Vilnius service page CTA',
    url: 'https://langu-remontas.lt/lt/langu-remontas-vilniuje',
    trigger: /KVIESTI\s+MEISTR/i,
    locale: 'lt-LT',
  },
  // PL — naprawa-okna24.pl
  {
    site: 'naprawa-okna24.pl',
    name: 'homepage hero CTA',
    url: 'https://naprawa-okna24.pl/',
    trigger: /UM[OÓ]W\s+WIZYT/i,
    locale: 'pl-PL',
  },
  {
    site: 'naprawa-okna24.pl',
    name: '/pl/kontakt inline form',
    url: 'https://naprawa-okna24.pl/pl/kontakt',
    locale: 'pl-PL',
  },
  {
    site: 'naprawa-okna24.pl',
    name: '/pl/uslugi service page CTA',
    url: 'https://naprawa-okna24.pl/pl/uslugi',
    trigger: /UM[OÓ]W\s+WIZYT/i,
    locale: 'pl-PL',
  },
]

const VIEWPORTS = [
  {
    id: 'desktop',
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    isMobile: false,
    userAgent: 'site-health-monitor/1.0 (desktop)',
  },
  {
    id: 'mobile',
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1 site-health-monitor/1.0',
  },
]

const STATE_FILE = 'state.json'
const REMINDER_HOURS = 4
const RETRY_DELAY_MS = 120_000 // 2 min — filter transient CDN/cold-start blips

// ─── Cookiebot dismissal ─────────────────────────────────────────────────────
// Both sites use Cookiebot. On mobile the consent banner is a full-screen
// overlay that intercepts pointer events. If it is visible, click "Allow all"
// so our real test can proceed. If it is not present (consent already given
// by a previous session, or banner not shown in this geo), skip silently.

async function dismissCookieBanner(page) {
  const selectors = [
    '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
    '#CybotCookiebotDialogBodyButtonAccept',
  ]
  for (const sel of selectors) {
    const btn = page.locator(sel)
    if (await btn.isVisible({ timeout: 1_500 }).catch(() => false)) {
      await btn.click().catch(() => {})
      await page.waitForTimeout(400) // let overlay animate out
      return true
    }
  }
  return false
}

// ─── Single probe run ────────────────────────────────────────────────────────

async function probeScenario(browser, scenario, viewport) {
  const errors = []
  const ctx = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.deviceScaleFactor,
    isMobile: viewport.isMobile || false,
    hasTouch: viewport.hasTouch || false,
    userAgent: viewport.userAgent,
    locale: scenario.locale,
  })
  const page = await ctx.newPage()

  page.on('pageerror', e => errors.push(`pageerror: ${e.message.slice(0, 200)}`))
  page.on('console', msg => {
    if (msg.type() !== 'error') return
    const text = msg.text()
    // Third-party noise — not our bug surface
    if (/favicon|preload|third-party cookie|cookiebot|googletagmanager|clarity|facebook|tiktok|hcaptcha/i.test(text)) return
    errors.push(`console: ${text.slice(0, 200)}`)
  })
  page.on('response', r => {
    if (r.status() >= 500) errors.push(`${r.status()} ${r.url().slice(0, 150)}`)
  })

  try {
    const resp = await page.goto(scenario.url, { waitUntil: 'load', timeout: 25_000 })
    if (!resp) throw new Error('no response')
    if (resp.status() >= 400) throw new Error(`page returned ${resp.status()}`)

    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {})
    await page.waitForTimeout(500) // React hydration buffer

    await dismissCookieBanner(page)

    if (scenario.trigger) {
      const btn = page.locator('button:visible').filter({ hasText: scenario.trigger }).first()
      await btn.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {
        throw new Error(`CTA button not visible on page (regex ${scenario.trigger})`)
      })
      await btn.click({ timeout: 10_000 })
    }

    const telInput = page.locator('input[type="tel"]:visible').first()
    await telInput.waitFor({ state: 'visible', timeout: 7_000 }).catch(() => {
      if (scenario.trigger) {
        throw new Error('after clicking CTA, no visible <input type="tel"> (modal did not open or phone field missing)')
      }
      throw new Error('no visible <input type="tel"> on page (expected inline form)')
    })

    const submit = page.locator('button[type="submit"]:visible').first()
    await submit.waitFor({ state: 'visible', timeout: 3_000 }).catch(() => {
      throw new Error('form is missing a visible submit button')
    })

    await page.waitForTimeout(500)
    if (errors.length > 0) {
      throw new Error('page errors: ' + errors.slice(0, 3).join(' | '))
    }

    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message, stepErrors: errors.slice(0, 5) }
  } finally {
    await ctx.close()
  }
}

async function probeWithRetry(browser, scenario, viewport) {
  // Test hook: FORCE_FAIL=<comma-separated patterns> simulates failures
  // without touching selectors. Example: FORCE_FAIL=naprawa-okna24.pl matches
  // any scenario on that site. FORCE_FAIL=mobile matches any mobile check.
  const forceFail = (process.env.FORCE_FAIL || '').split(',').map(s => s.trim()).filter(Boolean)
  const stateKey = `${scenario.site} | ${scenario.name} | ${viewport.id}`
  if (forceFail.some(pat => stateKey.includes(pat))) {
    return { ok: false, error: `FORCE_FAIL env matched '${forceFail.join(',')}' — simulated failure for alert-path testing`, attempts: 0 }
  }

  const first = await probeScenario(browser, scenario, viewport)
  if (first.ok) return { ...first, attempts: 1 }

  console.log(`    … first attempt failed (${first.error}), waiting ${RETRY_DELAY_MS / 1000}s and retrying`)
  await new Promise(r => setTimeout(r, RETRY_DELAY_MS))
  const second = await probeScenario(browser, scenario, viewport)
  return { ...second, attempts: 2, firstError: first.error }
}

// ─── State ───────────────────────────────────────────────────────────────────

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

// ─── Email ───────────────────────────────────────────────────────────────────

function makeTransport() {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  })
}

async function sendMail(transport, subject, body) {
  if (!transport) {
    console.log(`  (skip email — no SMTP creds) subject: ${subject}`)
    return
  }
  await transport.sendMail({
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

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const state = await loadState()
  const now = new Date().toISOString()

  // Collected transitions, keyed by site so one email per site per transition type.
  const transitions = {
    down: {},       // { site: [ {name, viewport, error, firstError} ] }
    recovered: {},  // { site: [ {name, viewport, failureStart} ] }
    reminder: {},   // { site: [ {name, viewport, failureStart, error, lastAlertSent} ] }
  }

  const browser = await chromium.launch({ headless: true })

  try {
    for (const viewport of VIEWPORTS) {
      console.log(`\n═══ Viewport: ${viewport.id} (${viewport.width}×${viewport.height}) ═══`)

      for (const scenario of SCENARIOS) {
        const stateKey = `${scenario.site} | ${scenario.name} | ${viewport.id}`
        console.log(`\n→ ${stateKey}`)
        const result = await probeWithRetry(browser, scenario, viewport)
        const prev = state[stateKey] || { status: 'ok', failureStart: null, lastAlertSent: null, lastError: null }

        if (result.ok) {
          if (prev.status === 'fail') {
            (transitions.recovered[scenario.site] ||= []).push({
              name: scenario.name,
              viewport: viewport.id,
              failureStart: prev.failureStart,
            })
            console.log('  ✓ RECOVERED (transition fail → ok)')
          } else {
            console.log(`  ✓ OK (${result.attempts} attempt${result.attempts === 1 ? '' : 's'})`)
          }
          state[stateKey] = { status: 'ok', failureStart: null, lastAlertSent: null, lastError: null }
        } else {
          if (prev.status === 'ok' || !prev.failureStart) {
            state[stateKey] = { status: 'fail', failureStart: now, lastAlertSent: now, lastError: result.error }
            ;(transitions.down[scenario.site] ||= []).push({
              name: scenario.name,
              viewport: viewport.id,
              error: result.error,
              firstError: result.firstError,
            })
            console.log('  ! DOWN (transition ok → fail)')
          } else {
            const hoursSinceLastAlert = (Date.now() - new Date(prev.lastAlertSent).getTime()) / 3600_000
            if (hoursSinceLastAlert >= REMINDER_HOURS) {
              state[stateKey] = { ...prev, lastAlertSent: now, lastError: result.error }
              ;(transitions.reminder[scenario.site] ||= []).push({
                name: scenario.name,
                viewport: viewport.id,
                failureStart: prev.failureStart,
                error: result.error,
              })
              console.log(`  ! REMINDER (${hoursSinceLastAlert.toFixed(1)}h since last alert)`)
            } else {
              state[stateKey] = { ...prev, lastError: result.error }
              console.log(`  ! Still failing (next reminder in ${(REMINDER_HOURS - hoursSinceLastAlert).toFixed(1)}h)`)
            }
          }
          console.log(`    error: ${result.error}`)
        }
      }
    }
  } finally {
    await browser.close()
  }

  await saveState(state)

  // Email dispatch — one email per site per transition kind.
  const transport = (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) ? makeTransport() : null

  for (const [site, items] of Object.entries(transitions.down)) {
    const subject = items.length === 1
      ? `[DOWN] ${site} — ${items[0].name} (${items[0].viewport})`
      : `[DOWN] ${site} — ${items.length} checks broken`
    const body = [
      `Site: ${site}`,
      `Status: FAILING`,
      `Detected: ${now}`,
      '',
      `Failing checks:`,
      ...items.map(i => `  • ${i.name} [${i.viewport}]  →  ${i.error}` + (i.firstError && i.firstError !== i.error ? `\n     first attempt: ${i.firstError}` : '')),
      '',
      `What is checked for each scenario:`,
      `  1. Page returns 200`,
      `  2. If a CTA button is defined — it must be visible and clickable`,
      `  3. A visible <input type="tel"> must appear (modal opened, or inline form present)`,
      `  4. A visible submit button must be present`,
      `  5. No JS errors or 5xx responses`,
      '',
      `Next check: in ~1 hour. Reminder every ${REMINDER_HOURS}h while still broken. RECOVERED email when fixed.`,
    ].join('\n')
    try {
      await sendMail(transport, subject, body)
      console.log(`\n✉ sent DOWN email for ${site} (${items.length} check${items.length === 1 ? '' : 's'})`)
    } catch (e) {
      console.error(`✉ DOWN email failed for ${site}: ${e.message}`)
    }
  }

  for (const [site, items] of Object.entries(transitions.recovered)) {
    const subject = items.length === 1
      ? `[RECOVERED] ${site} — ${items[0].name} (${items[0].viewport})`
      : `[RECOVERED] ${site} — ${items.length} checks back online`
    const body = [
      `Site: ${site}`,
      `Status: WORKING`,
      `Recovered at: ${now}`,
      '',
      `Recovered checks:`,
      ...items.map(i => `  • ${i.name} [${i.viewport}]  (was down since ${i.failureStart}, duration ${formatDuration(minutesSince(i.failureStart))})`),
    ].join('\n')
    try {
      await sendMail(transport, subject, body)
      console.log(`\n✉ sent RECOVERED email for ${site} (${items.length} check${items.length === 1 ? '' : 's'})`)
    } catch (e) {
      console.error(`✉ RECOVERED email failed for ${site}: ${e.message}`)
    }
  }

  for (const [site, items] of Object.entries(transitions.reminder)) {
    const subject = `[STILL DOWN] ${site} — ${items.length} check${items.length === 1 ? '' : 's'} still broken`
    const body = [
      `Site: ${site} still has broken checks.`,
      '',
      ...items.map(i => `  • ${i.name} [${i.viewport}]  —  down ${formatDuration(minutesSince(i.failureStart))}  —  ${i.error}`),
      '',
      `Next reminder in ${REMINDER_HOURS}h if still broken.`,
    ].join('\n')
    try {
      await sendMail(transport, subject, body)
      console.log(`\n✉ sent REMINDER email for ${site} (${items.length} check${items.length === 1 ? '' : 's'})`)
    } catch (e) {
      console.error(`✉ REMINDER email failed for ${site}: ${e.message}`)
    }
  }

  const totalFailing = Object.values(state).filter(s => s.status === 'fail').length
  console.log('\n' + (totalFailing > 0
    ? `${totalFailing} check${totalFailing === 1 ? '' : 's'} failing — see state.json`
    : 'All checks healthy'))
  // Exit 0: the probe script succeeded in running. Site status is in state.json + emails.
  process.exit(0)
}

main().catch(err => {
  console.error('FATAL:', err)
  const transport = (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) ? makeTransport() : null
  sendMail(transport, '[MONITOR BROKEN] site-health probe crashed', `The probe script itself crashed. Site status unknown.\n\n${err.stack || err.message}`)
    .catch(() => {})
    .finally(() => process.exit(2))
})
