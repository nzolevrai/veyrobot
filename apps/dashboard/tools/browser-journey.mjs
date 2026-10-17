import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import axe from 'axe-core';
import { chromium } from 'playwright';

const captureDirectory = fileURLToPath(new URL('../../../docs/dashboard-browser-captures/', import.meta.url));

function cookieParts(cookieHeader) {
  const pair = cookieHeader.split(';', 1)[0];
  const separator = pair.indexOf('=');
  assert.ok(separator > 0, 'browser fixture must receive a cookie pair');
  return { name: pair.slice(0, separator), value: pair.slice(separator + 1) };
}

async function assertNoSeriousA11y(page, label) {
  const nonce = await page.evaluate(() => [...document.scripts].map(script => script.nonce).find(value => value.length > 0) ?? null);
  assert.ok(nonce, `${label}: the page should have a request CSP nonce`);
  await page.evaluate(({ source, scriptNonce }) => {
    const script = document.createElement('script');
    script.nonce = scriptNonce;
    script.textContent = source;
    document.head.append(script);
    if (!window.axe) throw new Error('axe-core did not execute under the response CSP nonce');
  }, { source: axe.source, scriptNonce: nonce });
  const result = await page.evaluate(() => window.axe.run(document));
  const violations = result.violations.filter(item => item.impact === 'critical' || item.impact === 'serious');
  assert.deepEqual(violations.map(({ id, impact, help, nodes }) => ({ id, impact, help, nodes: nodes.map(node => node.target) })), [], `${label}: serious or critical axe-core violations`);
}

async function assertNoHorizontalOverflow(page, label) {
  const dimensions = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth }));
  assert.ok(dimensions.document <= dimensions.viewport + 1, `${label}: document overflows horizontally (${dimensions.document}px > ${dimensions.viewport}px)`);
}

async function selectByKeyboard(page, label, direction, expectedText) {
  const trigger = page.locator('.custom-select').first();
  assert.equal(await page.getByRole('combobox', { name: label }).count(), 1, `accessible ${label} trigger exists before opening`);
  await trigger.focus();
  await trigger.press('Space');
  const option = page.getByRole('option', { name: expectedText });
  await option.waitFor({ state: 'visible' });
  await page.locator('[role="option"][data-highlighted]').waitFor({ state: 'visible' });
  await page.keyboard.press(direction);
  await page.locator('[role="option"][data-highlighted]').filter({ hasText: expectedText }).waitFor({ state: 'visible' });
  await page.keyboard.press('Enter');
  await page.waitForFunction(({ accessibleName, text }) => {
    const control = [...document.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === accessibleName);
    return Boolean(control?.innerText.includes(text));
  }, { accessibleName: label, text: expectedText });
}

export async function runDashboardBrowserJourney({ baseUrl, sessionCookie, guildId, onWarningCreated = () => {} }) {
  await mkdir(captureDirectory, { recursive: true });
  const browser = await chromium.launch({ headless: true, timeout: 15_000 });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.setDefaultNavigationTimeout(15_000);
  const browserErrors = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  const step = name => console.log(JSON.stringify({ event: 'dashboard_browser_step', step: name }));

  try {
    step('guest protected-route redirect');
    const guest = await context.newPage();
    const protectedResponse = await guest.goto(`${baseUrl}/dashboard/user`);
    assert.ok(protectedResponse?.ok(), 'unauthenticated protected route should redirect to a rendered login page');
    assert.match(new URL(guest.url()).pathname, /^\/$/, 'protected route should redirect to dashboard home');
    await guest.getByRole('link', { name: /Continuer avec Discord/ }).waitFor({ state: 'visible' });
    await guest.close();

    const { name, value } = cookieParts(sessionCookie);
    await context.addCookies([{ name, value, url: baseUrl, httpOnly: true, sameSite: 'Lax' }]);

    step('authenticated account home and axe');
    await page.goto(`${baseUrl}/dashboard/user`);
    await page.getByRole('heading', { name: 'Bienvenue sur le panel VeyroBot !' }).waitFor();
    await assertNoSeriousA11y(page, 'desktop user home');
    await page.screenshot({ path: join(captureDirectory, 'desktop-user-home.png'), fullPage: true, animations: 'disabled' });

    await page.goto(`${baseUrl}/dashboard/user/profil`);
    await page.getByRole('heading', { name: 'Profil' }).waitFor();
    assert.equal(new URL(page.url()).pathname, '/dashboard/user/profil');
    await page.reload();
    await page.getByRole('heading', { name: 'Profil' }).waitFor();
    await page.goBack();
    await page.getByRole('heading', { name: 'Bienvenue sur le panel VeyroBot !' }).waitFor();
    await page.goForward();
    await page.getByRole('heading', { name: 'Profil' }).waitFor();
    await page.setViewportSize({ width: 900, height: 800 });
    await assertNoHorizontalOverflow(page, '900px account profile');
    await page.setViewportSize({ width: 1440, height: 900 });

    step('keyboard server navigation and Retry-After');
    const serverLink = page.getByRole('link', { name: /Test 1.*bot en ligne/ });
    await serverLink.focus();
    await page.getByRole('tooltip').filter({ hasText: 'Test 1' }).waitFor();
    await page.keyboard.press('Enter');
    await page.getByRole('heading', { name: 'Vue d’ensemble' }).waitFor();
    assert.match(new URL(page.url()).pathname, new RegExp(`/dashboard/${guildId}/overview$`));
    await page.reload();
    await page.getByRole('heading', { name: 'Vue d’ensemble' }).waitFor();
    let guildReads = 0;
    await page.route('**/api/guilds', async route => {
      guildReads++;
      if (guildReads === 1) await route.fulfill({ status: 429, headers: { 'content-type': 'application/json', 'retry-after': '1', 'x-request-id': 'browser-fixture-guilds-429' }, body: JSON.stringify({ error: 'Limite simulée pour le test navigateur.', requestId: 'browser-fixture-guilds-429', retryAfter: '1' }) });
      else await route.continue();
    });
    await page.reload();
    const guildError = page.getByRole('status').filter({ hasText: 'Liste des serveurs indisponible' });
    await guildError.waitFor();
    const guildRetry = page.getByRole('button', { name: /Attente de Retry-After/ });
    assert.equal(await guildRetry.isDisabled(), true, 'guild retry is blocked during the supplied Retry-After');
    await page.waitForFunction(() => {
      const button = [...document.querySelectorAll('button')].find(item => item.textContent?.includes('Réessayer la liste'));
      return Boolean(button && !button.disabled);
    }, undefined, { timeout: 5_000 });
    await page.getByRole('button', { name: 'Réessayer la liste' }).click();
    await page.getByRole('link', { name: /Test 1.*bot en ligne/ }).waitFor();
    assert.equal(guildReads, 2, 'one manual retry should follow the cooldown; no retry burst occurs');
    assert.equal(await page.evaluate(async () => (await fetch('/api/me')).status), 200, 'a guild-list 429 must preserve the browser session');
    await page.unroute('**/api/guilds');

    step('keyboard settings, color picker, save, reset and dirty navigation');
    await page.goto(`${baseUrl}/dashboard/${guildId}/settings`);
    await page.getByRole('heading', { name: 'Paramètres' }).waitFor();
    const languageTrigger = page.getByRole('combobox', { name: 'Langue du serveur' });
    const savedLanguage = (await languageTrigger.innerText()).includes('English') ? 'English' : 'Français';
    const changedLanguage = savedLanguage === 'English' ? 'Français' : 'English';
    const changedLanguageDirection = changedLanguage === 'English' ? 'ArrowDown' : 'ArrowUp';
    await selectByKeyboard(page, 'Langue du serveur', changedLanguageDirection, changedLanguage);
    await page.getByText('Attention, vous avez des modifications non enregistrées !').waitFor();

    const colorTrigger = page.getByRole('button', { name: /Choisir la couleur des embeds/ });
    await colorTrigger.focus();
    await page.keyboard.press('Enter');
    const slider = page.getByRole('slider', { name: 'Saturation et luminosité' });
    await slider.focus();
    const priorColor = await colorTrigger.innerText();
    await page.keyboard.press('ArrowRight');
    assert.notEqual(await colorTrigger.innerText(), priorColor, 'color picker slider should respond to keyboard input');
    await assertNoSeriousA11y(page, 'desktop settings with color picker open');
    await page.screenshot({ path: join(captureDirectory, 'desktop-settings-color-picker.png'), fullPage: true, animations: 'disabled' });
    await page.keyboard.press('Escape');
    await page.locator('.color-popover').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.activeElement?.classList.contains('color-trigger'));
    assert.equal(await colorTrigger.evaluate(element => element === document.activeElement), true, 'closing the color picker returns focus to its trigger');

    await page.getByRole('button', { name: 'Sauvegarder' }).click();
    await page.getByText('Modifications enregistrées.').waitFor();
    await page.reload();
    await page.getByRole('heading', { name: 'Paramètres' }).waitFor();
    assert.ok((await page.getByRole('combobox', { name: 'Langue du serveur' }).innerText()).includes(changedLanguage));

    await selectByKeyboard(page, 'Langue du serveur', savedLanguage === 'English' ? 'ArrowDown' : 'ArrowUp', savedLanguage);
    await page.getByRole('button', { name: 'Réinitialiser' }).click();
    assert.ok((await page.getByRole('combobox', { name: 'Langue du serveur' }).innerText()).includes(changedLanguage));
    assert.equal(await page.getByText('Attention, vous avez des modifications non enregistrées !').count(), 0);

    await selectByKeyboard(page, 'Langue du serveur', savedLanguage === 'English' ? 'ArrowDown' : 'ArrowUp', savedLanguage);
    let navigationDialog;
    page.once('dialog', dialog => { navigationDialog = dialog; void dialog.dismiss(); });
    await page.getByRole('link', { name: /Espace utilisateur/ }).click();
    assert.equal(navigationDialog?.type(), 'confirm', 'leaving a dirty settings draft must ask before navigation');
    assert.match(new URL(page.url()).pathname, new RegExp(`/dashboard/${guildId}/settings$`));
    assert.ok((await page.getByRole('combobox', { name: 'Langue du serveur' }).innerText()).includes(savedLanguage));
    page.once('dialog', dialog => { void dialog.accept(); });
    await page.getByRole('link', { name: /Espace utilisateur/ }).click();
    await page.getByRole('heading', { name: 'Bienvenue sur le panel VeyroBot !' }).waitFor();
    await page.goto(`${baseUrl}/dashboard/${guildId}/settings`);
    await page.getByRole('heading', { name: 'Paramètres' }).waitFor();
    assert.ok((await page.getByRole('combobox', { name: 'Langue du serveur' }).innerText()).includes(changedLanguage));

    step('module activation and isolated write followed by history 429');
    await page.goto(`${baseUrl}/dashboard/${guildId}/warnings`);
    await page.getByRole('heading', { name: 'Avertissements', exact: true }).waitFor();
    const warningsSwitch = page.getByRole('switch');
    if (!(await warningsSwitch.isChecked())) await warningsSwitch.click();
    await page.getByRole('button', { name: 'Sauvegarder' }).click();
    await page.getByText('Modifications enregistrées.').waitFor();
    assert.equal(await warningsSwitch.isChecked(), true, 'module activation should be persisted by the Dashboard');

    const casePath = `**/api/guilds/${guildId}/cases*`;
    let caseReads = 0;
    let makeRefreshFail = false;
    let history429Responses = 0;
    let warningPosts = 0;
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith(`/api/guilds/${guildId}/warnings`)) warningPosts++;
    });
    await page.route(casePath, async route => {
      caseReads++;
      if (makeRefreshFail) {
        makeRefreshFail = false;
        history429Responses++;
        step(`history request ${caseReads}: simulated 429`);
        await route.fulfill({ status: 429, headers: { 'content-type': 'application/json', 'retry-after': '5', 'x-request-id': 'browser-fixture-history-429' }, body: JSON.stringify({ error: 'Limite simulée pour le test navigateur.', requestId: 'browser-fixture-history-429', retryAfter: '5' }) });
      } else {
        const response = await route.fetch();
        const body = await response.json();
        step(`history request ${caseReads}: ${response.status()}`);
        await route.fulfill({ status: response.status(), headers: response.headers(), body: JSON.stringify(body) });
      }
    });
    const firstCaseRead = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname.endsWith(`/api/guilds/${guildId}/cases`));
    await page.reload();
    await page.getByRole('heading', { name: 'Avertissements récents' }).waitFor();
    const initialHistoryResponse = await firstCaseRead;
    assert.equal(initialHistoryResponse.status(), 200, 'initial history read must succeed before testing a post-write refresh failure');
    await initialHistoryResponse.json();
    await page.locator('.case-table tbody').waitFor();
    const readsBeforeWrites = caseReads;
    await page.getByLabel('ID utilisateur Discord').fill('123456789012345678');
    await page.getByLabel('Raison').fill('Browser warning fixture');
    const firstWrite = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith(`/api/guilds/${guildId}/warnings`));
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    const firstResponse = await firstWrite;
    assert.equal(firstResponse.status(), 201, 'first browser warning is written to the isolated PostgreSQL fixture');
    const firstWarning = await firstResponse.json();
    onWarningCreated(firstWarning.id);
    await page.getByText(`Avertissement enregistré dans le dossier ${firstWarning.id}.`).waitFor();
    assert.match(await page.locator('.case-table').innerText(), /Browser warning fixture/, 'successful warning must appear in the refreshed history');

    makeRefreshFail = true;
    await page.getByLabel('ID utilisateur Discord').fill('123456789012345679');
    await page.getByLabel('Raison').fill('Fixture après écriture réussie');
    const secondWrite = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith(`/api/guilds/${guildId}/warnings`));
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    const secondResponse = await secondWrite;
    assert.equal(secondResponse.status(), 201, 'warning write succeeds independently from history refresh');
    const secondWarning = await secondResponse.json();
    onWarningCreated(secondWarning.id);
    await page.getByText(`Avertissement enregistré dans le dossier ${secondWarning.id}.`).waitFor();
    await page.getByText(/Historique temporairement impossible à actualiser/).waitFor();
    assert.match(await page.locator('.case-table').innerText(), /Browser warning fixture/, 'history 429 must preserve the previously displayed warning');
    assert.equal(warningPosts, 2, 'history 429 must not repeat either write');
    assert.equal(caseReads, readsBeforeWrites + 2, 'each successful write causes one history refresh and the 429 causes no retry burst');
    assert.equal(history429Responses, 1, 'only the designated post-write history refresh receives a simulated 429');
    const historyRetry = page.getByRole('button', { name: /Attente de Retry-After/ });
    assert.equal(await historyRetry.isDisabled(), true, 'manual history retry remains disabled during Retry-After');
    await assertNoSeriousA11y(page, 'warnings after successful write and simulated 429 refresh');

    step('mobile navigation, focus, overflow and screenshots');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${baseUrl}/dashboard/user`);
    await page.getByRole('heading', { name: 'Bienvenue sur le panel VeyroBot !' }).waitFor();
    await assertNoHorizontalOverflow(page, '390px account home');
    const menu = page.getByRole('button', { name: 'Ouvrir la navigation' });
    await menu.focus();
    assert.notEqual(await menu.evaluate(element => getComputedStyle(element).outlineStyle), 'none', 'keyboard focus must have a visible outline');
    await page.keyboard.press('Enter');
    assert.equal(await page.getByRole('banner').getByRole('button', { name: 'Fermer la navigation' }).getAttribute('aria-expanded'), 'true');
    await page.getByRole('navigation', { name: 'Espace utilisateur' }).waitFor();
    await assertNoSeriousA11y(page, 'mobile user home with navigation open');
    await page.screenshot({ path: join(captureDirectory, 'mobile-user-navigation.png'), fullPage: true, animations: 'disabled' });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Ouvrir la navigation' }).waitFor();
    assert.equal(await page.getByRole('banner').getByRole('button', { name: 'Ouvrir la navigation' }).evaluate(element => element === document.activeElement), true, 'closing the mobile navigation returns focus to its trigger');

    await page.goto(`${baseUrl}/dashboard/${guildId}/settings`);
    await page.getByRole('heading', { name: 'Paramètres' }).waitFor();
    await page.setViewportSize({ width: 390, height: 600 });
    const pageMetrics = await page.evaluate(() => ({
      viewport: document.documentElement.clientHeight,
      document: document.documentElement.scrollHeight,
      scrollY: window.scrollY,
      scrollTop: document.documentElement.scrollTop,
      bodyClientHeight: document.body.clientHeight,
      bodyScrollHeight: document.body.scrollHeight,
      bodyScrollTop: document.body.scrollTop,
      activeElement: document.activeElement?.tagName,
      activeRole: document.activeElement?.getAttribute('role'),
      activeLabel: document.activeElement?.getAttribute('aria-label'),
      documentScrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
      bodyScrollBehavior: getComputedStyle(document.body).scrollBehavior
    }));
    assert.ok(pageMetrics.document > pageMetrics.viewport, 'mobile settings content must remain vertically scrollable');
    assert.equal(pageMetrics.activeElement, 'BODY', 'the page itself is focused before testing document keyboard scrolling');
    const beforeEndScrollY = pageMetrics.scrollY;
    await page.keyboard.press('End');
    const immediateEndScroll = await page.evaluate(() => ({ scrollY: window.scrollY, scrollTop: document.documentElement.scrollTop }));
    let endScrollObserved = immediateEndScroll.scrollY > beforeEndScrollY;
    if (!endScrollObserved) {
      endScrollObserved = await page.waitForFunction(previousY => window.scrollY > previousY, beforeEndScrollY, { timeout: 1_000 }).then(() => true, error => {
        if (error.name === 'TimeoutError') return false;
        throw error;
      });
    }
    assert.ok(endScrollObserved, `keyboard End scrolls long settings content (focus=${pageMetrics.activeElement} ${pageMetrics.activeRole ?? ''} ${pageMetrics.activeLabel ?? ''}; document ${pageMetrics.document}px / viewport ${pageMetrics.viewport}px; body ${pageMetrics.bodyScrollHeight}px / ${pageMetrics.bodyClientHeight}px; root scrollTop ${pageMetrics.scrollTop}→${immediateEndScroll.scrollTop}; window.scrollY ${beforeEndScrollY}→${immediateEndScroll.scrollY})`);
    await page.keyboard.press('Home');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: /Choisir la couleur des embeds/ }).click();
    const popover = page.locator('.color-popover');
    const box = await popover.boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= 391, 'color picker popover must stay within the mobile viewport');
    await assertNoHorizontalOverflow(page, '390px settings with color picker open');

    step('destructive confirmation focus without submitting');
    await page.goto(`${baseUrl}/dashboard/${guildId}/member-actions`);
    await page.getByRole('heading', { name: 'Nouvelle demande' }).waitFor();
    await page.locator('.form-panel select').selectOption('BAN');
    await page.getByLabel('ID utilisateur Discord').fill('123456789012345680');
    await page.getByLabel('Raison').fill('Confirmation seulement, aucun envoi');
    let actionPosts = 0;
    page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith(`/api/guilds/${guildId}/actions`)) actionPosts++; });
    await page.getByRole('button', { name: 'Envoyer la demande' }).click();
    const confirm = page.getByRole('dialog', { name: 'Confirmer le bannissement ?' });
    await confirm.waitFor();
    await page.waitForFunction(() => {
      const dialog = document.querySelector('dialog[open]');
      return Boolean(dialog && dialog.contains(document.activeElement));
    });
    assert.equal(actionPosts, 0, 'opening and cancelling a destructive-action confirmation must not submit a moderation action');
    await page.keyboard.press('Escape');
    await confirm.waitFor({ state: 'hidden' });
    assert.equal(await page.getByRole('button', { name: 'Envoyer la demande' }).evaluate(element => element === document.activeElement), true, 'closing the confirmation returns focus to its trigger');
    await page.getByRole('button', { name: 'Envoyer la demande' }).click();
    await confirm.waitFor();
    await confirm.getByRole('button', { name: 'Annuler' }).click();
    assert.equal(await page.getByRole('button', { name: 'Envoyer la demande' }).evaluate(element => element === document.activeElement), true, 'cancel button returns focus to the action trigger');
    assert.equal(actionPosts, 0);

    // Leave test configuration predictable: turn the warnings module off in the isolated DB.
    await page.goto(`${baseUrl}/dashboard/${guildId}/warnings`);
    const finalSwitch = page.getByRole('switch');
    if (await finalSwitch.isChecked()) {
      await finalSwitch.click();
      await page.getByRole('button', { name: 'Sauvegarder' }).click();
      await page.getByText('Modifications enregistrées.').waitFor();
    }

    step('logout and protected-route rejection');
    await page.goto(`${baseUrl}/dashboard/user`);
    await page.getByRole('heading', { name: 'Bienvenue sur le panel VeyroBot !' }).waitFor();
    const finalMobileMenu = page.getByRole('button', { name: 'Ouvrir la navigation' });
    if (await finalMobileMenu.count()) await finalMobileMenu.click();
    await page.getByRole('button', { name: 'Se déconnecter' }).click();
    await page.getByRole('link', { name: /Continuer avec Discord/ }).waitFor();
    const afterLogout = await page.goto(`${baseUrl}/dashboard/user`);
    assert.ok(afterLogout?.ok());
    assert.match(new URL(page.url()).pathname, /^\/$/, 'revoked browser session must not reopen a protected route');
    assert.deepEqual(browserErrors, [], 'browser must not report uncaught page errors');

    await page.unroute(casePath);
    return [firstWarning.id, secondWarning.id];
  } finally {
    await browser.close();
  }
}
