const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createInterface } = require('node:readline');

const directory = 'https://ui.awin.com/awin/affiliate/3150312/merchant-directory/index/tab/active/page/1';
const site = 'https://davimarz.github.io/scaladeiturchi/';
const attemptsFile = path.join(__dirname, '.candidature-scala.jsonl');
const message = 'Salve, gestisco la web app "Scala dei Turchi" (https://davimarz.github.io/scaladeiturchi/), un portale interattivo dedicato alla pubblicazione di prodotti in offerta. Il nostro pubblico è composto da appassionati e acquirenti alla ricerca di offerte e nuove uscite. Intendiamo promuovere i prodotti e le vostre campagne tramite banner display dedicati e link affiliati diretti alle offerte del catalogo. Grazie.';

const categories = [
  'Abbigliamento', 'Abbigliamento bambini', 'Abbigliamento femminile', 'Abbigliamento sportivo',
  'Abbigliamento uomo', 'Accessori Elettronica', 'Accessori abbigliamento', 'Acquisti di gruppo',
  'Attrezzature sportive', 'Audio-video', 'Auto e motori', 'Bambini e bebè', 'Biancheria intima',
  'Bricolage', 'Calzature', 'Casa e giardinaggio', 'Elettrodomestici', 'Entertainment Superstore',
  'Erotico', 'Forniture per ufficio', 'Fotografia', 'Gadget', 'Giochi', 'Gioielleria', 'Grandi magazzini',
  'Green (Eco friendly)', 'Informatica', 'Lead generation', 'Libri e abbonamenti', 'Mobili e Arredamento',
  'Musica e DVD', 'PC & Videogame', 'Prodotti Largo Consumo', 'Prodotti farmaceutici', 'Regali e fiori',
  'Salute e bellezza', 'Stampa e foto', 'Supermercati di elettronica', 'Veterinaria e animali',
  'Vini, alcolici e tabacchi',
];

const joinLabel = /^\s*\+?\s*Iscriviti\s*$/i;

function joinByRole(scope) {
  return scope.getByRole('button', { name: joinLabel })
    .or(scope.getByRole('link', { name: joinLabel }));
}

async function joinControl(row) {
  const byRole = joinByRole(row).filter({ visible: true });
  if (await byRole.count() === 1) return byRole;
  const label = row.getByText(joinLabel).filter({ visible: true });
  if (await label.count() !== 1) return null;

  const action = label.locator('xpath=ancestor-or-self::*[self::button or self::a or @role="button" or @role="link" or @tabindex][1]')
    .and(row.locator('*')).filter({ visible: true });
  return await action.count() === 1 ? action : label;
}

function unjoinedView(page) {
  const title = /^Non iscritt[oi]\s*\(\s*[\d.,\s]+\)$/i;
  const join = joinByRole(page).or(page.getByText(joinLabel));
  const promote = page.getByText('Promuovi', { exact: true });
  const listing = page.getByRole('table')
    .filter({ has: page.getByRole('columnheader', { name: /feed prodotto/i }) })
    .filter({ has: page.getByRole('row').filter({ has: join }) })
    .filter({ hasNot: promote });

  return page.getByText(title).or(listing).filter({ visible: true }).first();
}

async function hasProductFeed(row) {
  return row.evaluate(element => {
    const table = element.closest('table, [role="table"], [role="grid"]');
    if (!table) return false;
    const label = value => (value ?? '').replace(/\s+/g, ' ').trim();
    const headers = [...table.querySelectorAll('thead tr:last-child th, [role="columnheader"]')];
    const column = headers.findIndex(header => /^(feed prodotto|product feed)$/i.test(label(header.innerText)));
    const cells = [...element.children].filter(cell => cell.matches('td, [role="cell"], [role="gridcell"]'));
    return column >= 0 && /^(s[ìi]|yes)$/i.test(label(cells[column]?.innerText));
  });
}

const siteOptionLabel = /(?:^|[\s(\[])(?:https:\/\/)?davimarz\.github\.io\/scaladeiturchi\/?(?=$|[\s)\]])/i;

async function selectWebsite(page, form) {
  const nativeMatches = [];
  for (const select of await form.locator('select:visible').all()) {
    const matches = await select.locator('option:not([disabled])').evaluateAll((items, pattern) =>
      items.flatMap((item, index) => new RegExp(pattern, 'i').test(item.textContent) ? [index] : []), siteOptionLabel.source);
    for (const index of matches) nativeMatches.push({ select, index });
  }
  if (nativeMatches.length !== 0) {
    if (nativeMatches.length !== 1) return false;
    const { select, index } = nativeMatches[0];
    const value = await select.locator('option:not([disabled])').nth(index).evaluate(item => item.index);
    await select.selectOption({ index: value });
    return true;
  }

  const menu = form.getByRole('combobox').filter({ visible: true });
  if (await menu.count() !== 1) return false;
  await menu.click({ timeout: 7000 });
  // Awin can render the options outside the application form.
  const options = page.getByRole('option', { name: siteOptionLabel }).filter({ visible: true });
  if (!await options.first().waitFor({ timeout: 8000 }).then(() => true, () => false)) return false;
  if (await options.count() !== 1 || !await options.isEnabled()) return false;
  await options.click({ timeout: 7000 });
  return true;
}

const submissionReceipt = /(?:richiest[ae]|candidatur[ae]|domand[ae])\b(?:(?!\b(?:non|mai|errore|impossibile)\b)[^.!?]){0,100}\binviat[ae]\b|\binvio (?:avvenuto|completato) con successo\b/i;

async function acknowledgeSubmission(page) {
  const receipt = page.getByText(submissionReceipt).filter({ visible: true }).first();
  try {
    await receipt.waitFor({ timeout: 20000 });
  } catch {
    return false;
  }

  const popup = receipt.locator('xpath=ancestor::*[.//*[translate(normalize-space(.), "ok", "OK")="OK"]][1]');
  const ok = popup.getByText(/^OK$/i).filter({ visible: true });
  await ok.click({ timeout: 7000 });
  await receipt.waitFor({ state: 'hidden', timeout: 7000 });
  return true;
}

async function readWindowsCredential() {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) return null;
  const credentialPath = path.join(process.env.LOCALAPPDATA, 'AwinPlaywright', 'login.xml');
  try {
    await fs.access(credentialPath);
  } catch {
    return null;
  }
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$file = Join-Path $env:LOCALAPPDATA 'AwinPlaywright\\login.xml'",
    "$credential = Import-Clixml -LiteralPath $file",
    "if ($credential -isnot [System.Management.Automation.PSCredential]) { throw 'Credenziale non valida' }",
    "$json = @{ email = $credential.UserName; password = $credential.GetNetworkCredential().Password } | ConvertTo-Json -Compress",
    "[Console]::Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)))"
  ].join('; ');
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const { stdout } = await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true,
    timeout: 10000,
    maxBuffer: 16384
  });
  return JSON.parse(Buffer.from(stdout.trim(), 'base64').toString('utf8'));
}

function isAwinLoginUrl(value) {
  const url = new URL(value);
  if (url.origin === 'https://id.awin.com') {
    return /^\/u\/login(?:\/|$)/i.test(url.pathname);
  }
  return url.origin === 'https://ui.awin.com' &&
    /^\/(?:login(?:\/|$)|idp\/[^/]+\/awin\/login(?:\/|$))/i.test(url.pathname);
}

async function validateLoginAction(button, withPassword) {
  return button.evaluate((element, protectedPassword) => {
    const form = element.form ?? element.closest('form');
    const action = new URL(element.getAttribute('formaction') || form?.getAttribute('action') ||
      location.href, location.href);
    const allowedOrigins = ['https://ui.awin.com', 'https://id.awin.com'];
    if (!allowedOrigins.includes(location.origin) || action.origin !== location.origin) return false;
    if (!protectedPassword || !form || element.type === 'button') return true;
    const method = element.getAttribute('formmethod') || form.getAttribute('method');
    return method?.toLowerCase() === 'post';
  }, withPassword);
}

async function submitSavedLogin(page) {
  if (!isAwinLoginUrl(page.url())) return 'Pagina di accesso Awin non riconosciuta.';
  const credential = await readWindowsCredential();
  if (!credential?.email || !credential?.password) return 'Credenziale Windows non configurata.';

  const password = page.locator('input[type="password"]').filter({ visible: true });
  const email = page.locator('input[type="email"], input[autocomplete="username"], input[name="email"], input[name="username"], input[name="identifier"]').filter({ visible: true });
  const continueButton = page.getByRole('button', { name: /^(continua|continue|avanti|next)$/i }).filter({ visible: true });
  const loginButtons = page.getByRole('button', { name: /^(accedi|login|log in|sign in|entra)$/i }).filter({ visible: true });
  await password.or(email).first().waitFor({ timeout: 8000 });

  if (await password.count() === 0) {
    await continueButton.first().waitFor({ timeout: 5000 });
    if (await email.count() !== 1 || await continueButton.count() !== 1 ||
        !isAwinLoginUrl(page.url()) || !await validateLoginAction(continueButton, false)) {
      return 'Schermata email o pulsante Continua non riconosciuto.';
    }
    await email.fill(credential.email);
    await continueButton.click();
    console.log('Awin | email inserita, premuto Continua.');
    try {
      await password.first().waitFor({ timeout: 10000 });
    } catch {
      return 'Awin non ha mostrato il campo password dopo Continua.';
    }
  } else if (await email.count() === 1 && isAwinLoginUrl(page.url())) {
    await email.fill(credential.email);
  }

  await loginButtons.or(continueButton).first().waitFor({ timeout: 5000 });
  const loginButton = await loginButtons.count() ? loginButtons : continueButton;
  if (await password.count() !== 1 || await loginButton.count() !== 1 ||
      !isAwinLoginUrl(page.url()) || !await validateLoginAction(loginButton, true)) {
    return 'Schermata password o pulsante Accedi non riconosciuto.';
  }
  await password.fill(credential.password);
  if (!isAwinLoginUrl(page.url()) || !await validateLoginAction(loginButton, true)) {
    return 'Destinazione del login Awin non riconosciuta.';
  }
  await loginButton.click();
  return null;
}

async function runPass(confirmed, category, attempted) {
  const selection = { sector: 'Retail & Shopping', category };
  console.log('Scala dei Turchi | Italia | Feed prodotto: Sì | Retail & Shopping / ' + category);
  let browser;
  try {
    browser = await chromium.launchPersistentContext(path.join(__dirname, '.awin-profile'), { headless: false });
    const page = browser.pages()[0] ?? await browser.newPage();
    page.setDefaultTimeout(7000);
    await page.goto(directory, { waitUntil: 'domcontentloaded' });
    const unjoinedLabel = /^Non iscritt[oi]$/i;
    const tabText = page.getByText(unjoinedLabel).filter({ visible: true });
    const tabAction = tabText.locator('xpath=ancestor-or-self::*[self::a or self::button or @role="tab" or @role="button"][1]')
      .filter({ visible: true }).first();
    const nonIscritto = tabText.first();
    if (!isAwinLoginUrl(page.url())) {
      await Promise.any([
        nonIscritto.waitFor({ timeout: 8000 }),
        page.waitForURL(url => isAwinLoginUrl(url.href), { timeout: 8000 })
      ]).catch(() => {});
    }
    if (isAwinLoginUrl(page.url())) {
      const issue = await submitSavedLogin(page).catch(() => 'Accesso automatico non completato.');
      if (issue) throw new Error(issue);
    }
    await nonIscritto.waitFor({ timeout: 15000 }).catch(() => {
      throw new Error('La pagina advertiser non è disponibile dopo l’accesso. Verifica eventuali richieste di sicurezza in Awin.');
    });
    const unjoined = unjoinedView(page);
    if (!await unjoined.isVisible()) {
      const target = await nonIscritto.evaluate(element => {
        const action = element.closest('a, button, [role="tab"], [role="button"]') ?? element;
        const href = action.getAttribute('href');
        return { tag: action.tagName, role: action.getAttribute('role'), href: href && !href.startsWith('#') ? action.href : null };
      });
      const waitForListing = () => unjoined.waitFor({ timeout: 6000 }).then(() => true, () => false);
      await nonIscritto.click();
      console.log('Awin | clic sull’etichetta «Non iscritto».');
      let opened = await waitForListing();

      if (!opened && target.href) {
        const link = new URL(target.href);
        const current = new URL(page.url());
        const directoryPath = new URL(directory).pathname.split('/tab/')[0];
        if (link.origin === new URL(directory).origin &&
            link.pathname.startsWith(directoryPath + '/') &&
            (link.pathname !== current.pathname || link.search !== current.search)) {
          console.log('Awin | apro il collegamento di «Non iscritto» presente nella pagina.');
          await page.goto(link.href, { waitUntil: 'domcontentloaded' });
          opened = await waitForListing();
        }
      }

      if (!opened && await tabAction.isVisible()) {
        console.log('Awin | attivo il controllo «Non iscritto» con Invio nel browser.');
        await tabAction.press('Enter');
        opened = await waitForListing();
      }

      if (!opened) {
        const personal = await page.getByText(/^Advertiser personali\b/i).filter({ visible: true }).first().isVisible();
        const control = target.tag + (target.role ? '/' + target.role : '');
        throw new Error('«Non iscritto» non confermata. Controllo Awin: ' + control +
          (personal ? '. La pagina mostra ancora «Advertiser personali».' : '. La tabella attesa non è comparsa.'));
      }
    }
    console.log('Awin | scheda Non iscritto verificata. Controllo i candidati e il feed prodotto per riga.');

    const exactVisible = label => page.getByText(label, { exact: true }).filter({ visible: true });
    const filterItem = label => label.locator('xpath=ancestor-or-self::li[contains(concat(" ", normalize-space(@class), " "), " checkbox ")][1]');
    const selected = item => item.evaluate(node => node.classList.contains('selected'));
    const branchItem = label => label.locator('xpath=ancestor-or-self::li[./ul or ./*[contains(concat(" ", normalize-space(@class), " "), " hitarea ")]][1]');
    async function openBranch(label, child) {
      if (await child.count() === 1 && await child.isVisible()) return;
      const toggle = branchItem(label).locator('xpath=./*[contains(concat(" ", normalize-space(@class), " "), " hitarea ") or @aria-expanded="false"]')
        .filter({ visible: true });
      if (await toggle.count() === 1) {
        await toggle.click();
      } else {
        const item = filterItem(label);
        const wasSelected = await item.count() === 1 && await selected(item);
        await label.click();
        if (!wasSelected && await item.count() === 1 && await selected(item)) {
          await label.click();
          await item.and(page.locator(':not(.selected)')).waitFor();
        }
      }
      try {
        await child.waitFor({ timeout: 5000 });
      } catch {
        const details = await label.evaluate(element => {
          const result = [];
          for (let node = element, depth = 0; node && depth < 4; node = node.parentElement, depth++) {
            const describe = entry => [entry.tagName, entry.className, entry.getAttribute('aria-expanded')];
            result.push([describe(node), [...node.children].slice(0, 6).map(describe)]);
          }
          return result;
        });
        console.log('Awin | struttura ramo: ' + JSON.stringify(details));
        throw new Error('Sottocategoria ancora nascosta nel ramo ' + await label.innerText());
      }
    }
    const italyText = exactVisible('Italia').first();
    const europeText = exactVisible('Europa').first();
    if (!await italyText.isVisible()) {
      if (!await europeText.isVisible()) {
        await exactVisible('Regioni').first().click();
        await europeText.waitFor();
      }
      await openBranch(europeText, italyText);
    }
    const europeGroup = europeText.locator('xpath=ancestor::*[.//*[normalize-space(.)="Italia"] and .//*[normalize-space(.)="Irlanda"]][1]');
    const italyLabel = europeGroup.getByText('Italia', { exact: true }).filter({ visible: true });
    const feedTitle = page.getByText(/^Feed prodotto$/i).filter({ visible: true })
      .and(page.locator(':not(th):not(th *)'));
    const feedGroup = feedTitle.locator('xpath=ancestor::*[.//*[normalize-space(.)="No"] and .//li[contains(concat(" ", normalize-space(@class), " "), " checkbox ")]][1]');
    const feedYes = feedGroup.getByText(/^(sì|si)$/i).filter({ visible: true });
    const feedNo = feedGroup.getByText('No', { exact: true }).filter({ visible: true });
    const italyItem = filterItem(italyLabel);
    const yesItem = filterItem(feedYes);
    const noItem = filterItem(feedNo);
    for (const [label, item, checked, name] of [
      [italyLabel, italyItem, true, 'Italia'],
      [feedNo, noItem, false, 'Feed prodotto: No'],
      [feedYes, yesItem, true, 'Feed prodotto: Sì']
    ]) {
      if (await label.count() !== 1 || await item.count() !== 1) {
        throw new Error('Filtro non identificabile: ' + name);
      }
      if (await selected(item) !== checked) await label.click();
      await item.and(page.locator(checked ? '.selected' : ':not(.selected)')).waitFor();
    }
    const requiredFiltersActive = async () =>
      await selected(italyItem) && await selected(yesItem) && !await selected(noItem);
    console.log('Awin | Italia e Feed prodotto: Sì selezionati.');

    const sectorLabel = page.getByText(selection.sector, { exact: true }).filter({ visible: true });
    await sectorLabel.waitFor();
    const sectorGroup = branchItem(sectorLabel);
    const scopedCategory = sectorGroup.getByText(selection.category, { exact: true }).filter({ visible: true });
    const categoryText = scopedCategory;
    await openBranch(sectorLabel, categoryText);
    const categoryItem = filterItem(categoryText);
    if (await categoryItem.count() !== 1) throw new Error('Casella della sottocategoria non identificabile.');
    if (!await selected(categoryItem)) {
      const listing = page.getByRole('table')
        .filter({ has: page.getByRole('columnheader', { name: /feed prodotto/i }) })
        .filter({ visible: true }).first();
      const before = await listing.textContent();
      await categoryText.click();
      const deadline = Date.now() + 7000;
      while (await listing.isVisible() && await listing.textContent() === before) {
        if (Date.now() >= deadline) {
          throw new Error('Awin ha selezionato la sottocategoria, ma il contenuto dei risultati è rimasto identico. Riprova con il filtro già selezionato.');
        }
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    }
    if (!await selected(categoryItem)) throw new Error('Awin non ha applicato la sottocategoria richiesta.');
    await unjoined.waitFor();
    console.log('Awin | filtro applicato: ' + selection.sector + ' / ' + selection.category);

    const table = page.getByRole('table').filter({ has: page.getByRole('columnheader', { name: /feed prodotto/i }) }).filter({ visible: true });
    const rows = table.locator('tbody tr:visible').filter({ has: joinByRole(page).or(page.getByText(joinLabel)) });
    const overlay = page.locator('.blockUI.blockOverlay:visible');
    const waitForResults = () => overlay.first().waitFor({ state: 'hidden', timeout: 30000 });
    const seen = new Set();
    let submitted = 0;
    let skipped = 0;
    const visitedPages = new Set();
    while (true) {
      await waitForResults();
      if (!await requiredFiltersActive() || !await selected(categoryItem) || !await unjoined.isVisible()) {
        throw new Error('La scheda o uno dei filtri richiesti non sono più attivi.');
      }
      const names = (await rows.locator('td:first-child').allTextContents()).map(name => name.trim()).filter(Boolean);
      const name = names.find(candidate => !seen.has(candidate));
      if (!name) {
        const nextLabel = /^(?:pagina )?successiv[ao]$/i;
        const next = page.getByRole('link', { name: nextLabel })
          .or(page.getByRole('button', { name: nextLabel }))
          .or(page.getByText(nextLabel)).filter({ visible: true });
        const controls = await next.count();
        if (controls > 1) throw new Error('Più controlli Successivo visibili. Paginazione da verificare.');
        if (!controls || !await next.isEnabled() || await next.getAttribute('aria-disabled') === 'true') break;
        const previous = await table.locator('tbody').allTextContents().then(JSON.stringify);
        if (visitedPages.has(previous)) throw new Error('La paginazione Awin è tornata a una pagina già esaminata.');
        visitedPages.add(previous);
        await next.click();
        await waitForResults();
        const deadline = Date.now() + 7000;
        while (Date.now() < deadline) {
          const current = await table.locator('tbody').allTextContents().then(JSON.stringify);
          if (current !== '[]' && current !== previous) break;
          await new Promise(resolve => setTimeout(resolve, 150));
        }
        if (Date.now() >= deadline) {
          throw new Error('Awin non ha mostrato una pagina diversa dopo Successivo. Scansione incompleta.');
        }
        continue;
      }
      seen.add(name);
      if (attempted.has(name) && !confirmed.has(name)) {
        console.log(name + ' | Tentativo già registrato. Verifica lo stato in Awin.');
        skipped++;
        continue;
      }
      if (confirmed.has(name)) {
        throw new Error(name + ' | candidatura già confermata, ma Awin mostra ancora Iscriviti. Controlla In attesa.');
      }
      const row = rows.filter({ has: page.getByText(name, { exact: true }) });
      if (await row.count() !== 1 || !await hasProductFeed(row)) {
        console.log(name + ' | riga ambigua o feed prodotto non confermato');
        skipped++;
        continue;
      }
      const join = await joinControl(row);
      if (!join) {
        console.log(name + ' | controllo «+ Iscriviti» assente o ambiguo nella riga');
        skipped++;
        continue;
      }
      if (!await join.isEnabled()) {
        console.log(name + ' | controllo «+ Iscriviti» disabilitato');
        skipped++;
        continue;
      }
      try {
        await join.click({ timeout: 30000 });
      } catch (error) {
        if (error.name !== 'TimeoutError') throw error;
        await waitForResults();
        if (await row.count() === 0) {
          console.log(name + ' | riga rimossa dopo l’aggiornamento della tabella.');
          continue;
        }
        throw new Error(name + ' | il controllo Iscriviti è rimasto bloccato o non cliccabile.', { cause: error });
      }
      const title = page.getByText('Iscriviti al programma', { exact: true }).filter({ visible: true });
      await title.waitFor();
      const form = title.locator('xpath=ancestor::*[.//textarea and .//*[self::button or self::a or @role="button"][normalize-space(.)="Iscriviti"]][1]');
      const field = form.locator('textarea:visible');
      const terms = form.getByRole('checkbox').filter({ visible: true });
      const submit = form.getByRole('button', { name: 'Iscriviti', exact: true })
        .or(form.getByRole('link', { name: 'Iscriviti', exact: true })).filter({ visible: true });
      await field.waitFor();
      if (await terms.count() !== 1 || await submit.count() !== 1 ||
          !await form.getByText(/accetti di rispettare le condizioni specifiche/i).first().isVisible()) {
        throw new Error(name + ' | Condizioni o pulsante Iscriviti non identificati nel modulo.');
      }
      if (!await selectWebsite(page, form)) {
        const detail = name + ' | Il sito ' + site + ' non compare come opzione selezionabile in Promozione. Nessuna richiesta inviata per questo advertiser.';
        console.error(detail);
        if (process.stdin.isTTY && !page.isClosed()) {
          console.log('Controlla il menu nel browser. Premi Invio per chiudere (attesa massima: 2 minuti).');
          const inspection = createInterface({ input: process.stdin });
          const timer = setTimeout(() => inspection.close(), 120000);
          try { for await (const line of inspection) break; }
          finally { clearTimeout(timer); inspection.close(); }
        }
        throw new Error(detail);
      }
      await field.fill(message);
      await terms.check();
      await fs.appendFile(attemptsFile, JSON.stringify({ name, category, status: 'invio-avviato', at: new Date().toISOString() }) + '\n');
      attempted.add(name);
      try {
        await submit.click();
        if (!await acknowledgeSubmission(page)) {
          throw new Error('Ricevuta Awin non riconosciuta.');
        }
        confirmed.add(name);
        await fs.appendFile(attemptsFile, JSON.stringify({ name, category, status: 'confermato', at: new Date().toISOString() }) + '\n');
      } catch (error) {
        const detail = name + ' | ' + error.message + ' Controlla «In attesa». Il tentativo è registrato per evitare il reinvio.';
        console.error(detail);
        console.log('Candidature confermate in questa esecuzione: ' + confirmed.size);
        if (process.stdin.isTTY && !page.isClosed()) {
          console.log('Il browser resta aperto per 2 minuti. Premi Invio per chiudere.');
          const inspection = createInterface({ input: process.stdin });
          const timer = setTimeout(() => inspection.close(), 120000);
          try { for await (const line of inspection) break; }
          finally { clearTimeout(timer); inspection.close(); }
        }
        throw new Error(detail);
      }
      submitted++;
      console.log(name + ' | richiesta inviata, ricevuta Awin verificata');
    }
    console.log('Invii confermati da Awin: ' + submitted + ' su ' + seen.size + ' advertiser esaminati.');
    return { submitted, skipped };
  } finally {
    await browser?.close();
  }
}

async function runCategory(category, attempted) {
  const confirmed = new Set();
  for (;;) {
    const { submitted, skipped } = await runPass(confirmed, category, attempted);
    if (submitted) {
      console.log('Awin | ricontrollo dalla prima pagina: i risultati possono essersi spostati dopo gli invii.');
      continue;
    }
    console.log('Totale candidature confermate: ' + confirmed.size);
    if (skipped) {
      console.log('Scansione terminata. Advertiser da verificare manualmente: ' + skipped);
      process.exitCode = 2;
    } else {
      console.log('Nessun altro advertiser candidabile con i filtri impostati.');
    }
    return;
  }
}

function parseCategoryChoice(value) {
  const input = value.trim();
  if (!/^(?:0|[1-9]\d*)$/.test(input)) return null;
  const number = Number(input);
  return number === 0 ? categories : number <= categories.length ? [categories[number - 1]] : null;
}

async function chooseCategories(value) {
  if (value !== undefined) {
    const chosen = parseCategoryChoice(value);
    if (!chosen) throw new Error('Scegli un numero da 0 a ' + categories.length + '.');
    return chosen;
  }
  console.log('\nRetail & Shopping\n0. Tutte le sottocategorie');
  categories.forEach((category, index) => console.log((index + 1) + '. ' + category));
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  prompt.setPrompt('Inserisci il numero della sottocategoria: ');
  try {
    prompt.prompt();
    for await (const line of prompt) {
      const chosen = parseCategoryChoice(line);
      if (chosen) return chosen;
      console.log('Numero non valido. Scegli da 0 a ' + categories.length + '.');
      prompt.prompt();
    }
    throw new Error('Nessuna sottocategoria selezionata.');
  } finally { prompt.close(); }
}

async function main() {
  const chosen = await chooseCategories();
  const previous = await fs.readFile(attemptsFile, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const attempted = new Set(previous.split('\n').filter(Boolean).map(line => JSON.parse(line).name));
  for (const category of chosen) {
    console.log('Sottocategoria selezionata: ' + category);
    await runCategory(category, attempted);
  }
}

main().catch(error => {
  console.error('Preparazione interrotta: ' + error.message);
  process.exitCode = 1;
});
