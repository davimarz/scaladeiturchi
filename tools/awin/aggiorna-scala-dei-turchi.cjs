const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createInterface } = require('node:readline/promises');
const { setTimeout: delay } = require('node:timers/promises');

const repository = 'https://github.com/davimarz/scaladeiturchi.git';
const publicSite = 'https://davimarz.github.io/scaladeiturchi/';
const rawBase = 'https://raw.githubusercontent.com/davimarz/archivioscarpe/';
const filesToPublish = ['catalogo'];
const feedExtension = /\.(?:(?:csv|tsv|jsonl|ndjson)(?:\.gz)?|gz)$/i;

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

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw new Error('Impossibile avviare ' + path.basename(command) + ': ' + result.error.code);
  if (result.status !== 0) {
    throw new Error(path.basename(command) + ' ha restituito un errore. Il dettaglio è riportato sopra.');
  }
}

function chooseItalianListedFeed(name, links, matches, columns, urlIndex, log = console.log) {
  if (links.length === 1) return links[0];
  const normalize = value => String(value ?? '').trim().toLowerCase().replace(/_/g, '-');
  const language = columns.indexOf('language');
  const id = columns.indexOf('feed id');
  const feedName = columns.indexOf('feed name');
  const allowed = new Set(links);
  const rows = matches.filter(row => allowed.has(row[urlIndex]?.trim()));
  const tag = row => normalize(row[language]);
  const italian = rows.filter(row => /^(?:italian|italiano|it(?:-it)?)$/i.test(tag(row)));
  const italy = italian.filter(row => tag(row) === 'it-it');
  const best = [...new Set((italy.length ? italy : italian).map(row => row[urlIndex].trim()))];
  if (best.length === 1) {
    log(name + ' | feed italiano identificato nella lista Awin');
    return best[0];
  }
  const clean = value => String(value ?? '').replace(/https?:\/\/\S+/gi, '[link omesso]').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 90);
  for (const row of italian.length ? italian : rows) {
    log(name + ' | feed ' + clean(row[id]) + ' | ' + clean(row[feedName]) + ' | lingua: ' + (clean(row[language]) || 'non indicata'));
  }
  if (!italian.length && rows.length && rows.every(row => /^(?:english|german|spanish|french)$/i.test(tag(row)))) {
    throw Object.assign(new Error('Nessun feed italiano nella lista Awin.'), { code: 'SCALA_AWIN_NO_ITALIAN' });
  }
  throw new Error(italian.length
    ? 'Più feed italiani per questo advertiser: impossibile identificare un solo listino.'
    : 'Nessun feed italiano identificabile tra i link disponibili.');
}

async function reuseRecentFeed(root, destination, basename, supported, now = Date.now()) {
  const files = await fs.readdir(root, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const cutOff = now - 24 * 60 * 60 * 1000;
  const candidates = [];
  for (const folder of [root, ...files.filter(entry => entry.isDirectory()).map(entry => path.join(root, entry.name))]) {
    const entries = folder === root ? files : await fs.readdir(folder, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !supported.test(entry.name) ||
          entry.name.replace(supported, '').toLowerCase() !== basename.toLowerCase()) continue;
      const source = path.join(folder, entry.name);
      const info = await fs.stat(source);
      if (info.size > 0 && info.mtimeMs >= cutOff && info.mtimeMs <= now) candidates.push({ source, info, name: entry.name });
    }
  }
  candidates.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);
  const latest = candidates[0];
  if (!latest) return null;
  await fs.mkdir(destination, { recursive: true });
  const target = path.join(destination, latest.name);
  try {
    await fs.copyFile(latest.source, target);
    await fs.utimes(target, latest.info.atime, latest.info.mtime);
    return latest.source;
  } catch (error) {
    await fs.rm(target, { force: true });
    throw error;
  }
}

async function readAllPersonalAdvertisers(page, _category, categoryNames) {
  const excluded = new Set(['Erotico', 'Vini, alcolici e tabacchi']);
  const state = async () => page.evaluate(names => {
    const normalize = value => (value ?? '').normalize('NFD').replace(/\p{M}/gu, '')
      .replace(/\s*\([\d.,]+\)\s*$/, '').replace(/\s+/g, ' ').trim().toLowerCase();
    const labels = new Map(names.map(name => [normalize(name), name]));
    const result = {};
    const ambiguous = new Set();
    const control = 'input[type="checkbox"], [role="checkbox"], [aria-checked]';
    for (const node of document.querySelectorAll('label, span, a, div, li, [role="checkbox"], [aria-label]')) {
      if (!node.getClientRects().length) continue;
      const key = normalize(node.getAttribute('aria-label') || node.textContent);
      const name = labels.get(key);
      if (!name || [...node.children].some(child => normalize(child.textContent) === key)) continue;
      const linked = node.closest('label')?.control;
      let checkbox = linked?.matches(control) ? linked : node.closest(control);
      let row;
      if (!checkbox) {
        for (let box = node; box && box !== document.body; box = box.parentElement) {
          const controls = box.querySelectorAll(control);
          if (controls.length > 1) break;
          if (controls.length === 1) { checkbox = controls[0]; break; }
          if (box.matches('li.checkbox, [role="treeitem"], .checkbox')) { row = box; break; }
        }
      }
      const own = checkbox || row;
      if (!own) continue;
      const aria = own.getAttribute('aria-checked');
      const value = own.indeterminate || aria === 'mixed' ? null :
        typeof own.checked === 'boolean' ? own.checked :
        aria === 'true' || aria === 'false' ? aria === 'true' :
        own.matches('.selected, .checked');
      if (Object.hasOwn(result, name) && result[name] !== value) ambiguous.add(name);
      else result[name] = value;
    }
    for (const name of ambiguous) delete result[name];
    return result;
  }, categoryNames);
  const heading = page.getByText(/^Advertiser personali(?:\s*\(\s*\d+\s*\))?$/i)
    .filter({ visible: true }).first();
  await heading.waitFor({ timeout: 30000 });
  const reset = page.getByText('Reimposta ricerca', { exact: true }).filter({ visible: true });
  if (await reset.count() !== 1) throw new Error('Comando «Reimposta ricerca» non identificabile in Iscritto.');
  await reset.click({ timeout: 8000 });
  await heading.waitFor({ timeout: 20000 });
  const correct = selection => categoryNames.every(name => selection[name] === !excluded.has(name));
  let selection = await state();
  if (!correct(selection)) {
    const retail = page.getByText(/^Retail\s*&\s*Shopping(?:\s*\([\d.,]+\))?$/i).filter({ visible: true });
    if (!await retail.count()) {
      const sector = page.getByText(/^Settori?:?$/i).filter({ visible: true });
      if (await sector.count() === 1) await sector.click({ timeout: 3000 });
    }
    if (await retail.count() !== 1) throw new Error('Retail & Shopping non identificabile in Iscritto.');
    if (!categoryNames.every(name => selection[name] === true)) {
      await retail.click({ timeout: 5000 });
      await page.waitForTimeout(800);
      selection = await state();
    }
    const settle = async (ready, timeout = 4000) => {
      const deadline = Date.now() + timeout;
      do {
        selection = await state();
        if (ready(selection)) return;
        await page.waitForTimeout(250);
      } while (Date.now() < deadline && !page.isClosed());
    };
    const clickIfNeeded = async (name, desired) => {
      selection = await state();
      if (selection[name] === desired) return;
      const pattern = new RegExp('^' + RegExp.escape(name) + '(?:\\s*\\([\\d.,]+\\))?$', 'i');
      const checkbox = page.getByRole('checkbox', { name: pattern }).filter({ visible: true });
      const label = page.getByText(pattern).filter({ visible: true });
      if (await checkbox.count() === 1) {
        // setChecked verifies the target state and avoids toggling an already selected box.
        await checkbox.setChecked(desired, { timeout: 2500 }).catch(() => {});
      } else if (typeof selection[name] === 'boolean' && await label.count() === 1) {
        await label.click({ timeout: 2500 }).catch(() => {});
      }
      await settle(value => value[name] === desired, 1200);
    };
    const allowed = categoryNames.filter(name => !excluded.has(name));
    await settle(value => allowed.every(name => value[name] === true));
    for (const name of excluded) await clickIfNeeded(name, false);
    await settle(correct);
    // Repair only entries still missing after the bulk update and the exclusions.
    for (const name of allowed) {
      if (selection[name] !== true) await clickIfNeeded(name, true);
    }
    await settle(correct, 1500);
    if (!correct(selection)) {
      const unverified = categoryNames.filter(name => selection[name] !== !excluded.has(name))
        .map(name => name + (typeof selection[name] === 'boolean' ? ' (spunta errata)' : ' (stato non leggibile)'));
      throw new Error('Selezione Retail & Shopping non confermata: ' + unverified.join(', ') + '. Nessun listino scaricato.');
    }
  }
  await page.waitForTimeout(1200);
  const first = await readAdvertiserPage(page);
  if (!Number.isInteger(first.total) || first.total < first.names.length || !first.names.length) {
    throw new Error('Elenco Iscritto vuoto o totale non verificabile.');
  }
  const joinedNames = new Set(first.names);
  let pageRows = first.rowCount ?? first.names.length;

  async function waitForNewRows(timeout = 10000) {
    const deadline = Date.now() + timeout;
    do {
      const current = await page.evaluate(inspectPersonalAdvertisers, false).catch(() => null);
      const additions = current?.total === first.total ? current.names?.filter(name => !joinedNames.has(name)) : [];
      if (additions?.length) {
        pageRows = current.rowCount ?? current.names.length;
        return additions;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    } while (!page.isClosed() && Date.now() < deadline);
    return [];
  }

  async function expandResults() {
    const sizeLabel = page.getByText(/^Risultati per pagina\s*:?$/i).filter({ visible: true });
    if (await sizeLabel.count() === 1) {
      const currentValue = sizeLabel.locator('xpath=..').getByText(String(first.names.length), { exact: true })
        .filter({ visible: true });
      try {
        await (await currentValue.count() === 1 ? currentValue : sizeLabel).click({ timeout: 5000 });
        for (const size of [100, 50, 25, 20]) {
          if (size <= first.names.length) continue;
          const value = page.getByText(String(size), { exact: true }).filter({ visible: true });
          if (await value.count() !== 1) continue;
          await value.click({ timeout: 5000 });
          const additions = await waitForNewRows();
          return additions;
        }
      } catch {
        // Manual recovery remains available.
      }
    }
    return [];
  }

  if (joinedNames.size < first.total) {
    const additions = await expandResults();
    if (additions.length) additions.forEach(name => joinedNames.add(name));
  }
  const pageSize = pageRows;
  const lastPage = Math.ceil(first.total / pageSize);
  scalaStatus('Lettura: ' + joinedNames.size + '/' + first.total + ' advertiser');
  for (let number = 2; number <= lastPage && first.total > joinedNames.size; number++) {
    const nextLabel = /^(successiv[ao]|next)(?:\s*[›»→])?$/i;
    const pageLabel = new RegExp('^' + number + '$');
    const controls = [
      ['Successivo', page.getByText(nextLabel).filter({ visible: true })],
      ['Successivo', page.getByRole('button', { name: nextLabel }).or(
        page.getByRole('link', { name: nextLabel })
      ).filter({ visible: true })],
      ['numero ' + number, page.getByText(String(number), { exact: true }).filter({ visible: true })],
      ['pagina ' + number, page.getByRole('link', { name: pageLabel }).or(
        page.getByRole('button', { name: pageLabel })
      ).filter({ visible: true })]
    ];
    let additions = [];
    for (const [, control] of controls) {
      if (await control.count() !== 1) continue;
      try {
        await control.click({ timeout: 5000 });
        additions = await waitForNewRows();
        if (additions.length) break;
      } catch {
        // If the control changed, try the next visible control.
      }
    }
    if (!additions.length && !page.isClosed()) {
      scalaStatus('Awin: apri pagina ' + number + ' in «Iscritto» o aumenta i risultati per pagina. Attendo fino a 2 minuti.');
      additions = await waitForNewRows(120000);
    }
    if (!additions.length) {
      throw new Error('Pagina ' + number + ': nessun nuovo advertiser. Letti ' + joinedNames.size +
        ' di ' + first.total + '. Interrompo per evitare di scaricare listini non filtrati.');
    }
    if (joinedNames.size + additions.length > first.total) throw new Error('Il totale degli iscritti è cambiato durante la lettura.');
    additions.forEach(name => joinedNames.add(name));
    scalaStatus('Lettura: ' + joinedNames.size + '/' + first.total + ' advertiser');
  }
  if (joinedNames.size < first.total && !page.isClosed()) {
    scalaStatus('Letti ' + joinedNames.size + '/' + first.total +
      '. In «Iscritto», aumenta «Risultati per pagina», poi torna alla prima pagina. Attendo fino a 2 minuti.');
    let until = Date.now() + 120000;
    while (joinedNames.size < first.total && Date.now() < until && !page.isClosed()) {
      const additions = await waitForNewRows(Math.min(1000, until - Date.now()));
      if (additions.length && joinedNames.size + additions.length <= first.total) {
        additions.forEach(name => joinedNames.add(name));
        scalaStatus('Lettura: ' + joinedNames.size + '/' + first.total + ' advertiser');
      }
    }
  }
  if (joinedNames.size !== first.total) {
    throw new Error('Elenco incompleto: ' + joinedNames.size + '/' + first.total +
      ' nomi distinti. Possibili righe ripetute o omonimi; nessun download avviato.');
  }
  if (!correct(await state())) throw new Error('I filtri di categoria sono cambiati. Nessun listino scaricato.');
  const selected = [...joinedNames];
  return { joined: selected, targets: selected };
}

async function openAwinRoute(page, route) {
  const label = route.startsWith('/merchant-directory') ? 'Iscritto' : 'Create-a-Feed';
  const temporary = /^(?:HTTP (?:408|429|5\d\d)|ERR_(?:ABORTED|TIMED_OUT|CONNECTION_RESET|CONNECTION_CLOSED|CONNECTION_TIMED_OUT|NETWORK_CHANGED|INTERNET_DISCONNECTED|NAME_NOT_RESOLVED)|TIMEOUT)$/;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let reason;
    try {
      const response = await page.goto(account + route, { waitUntil: 'domcontentloaded', timeout: 20000 });
      if (response?.ok()) return;
      const status = response?.status();
      reason = Number.isInteger(status) ? 'HTTP ' + status : 'nessuna risposta HTTP';
    } catch (error) {
      const info = String(error?.message);
      reason = info.match(/\bERR_[A-Z0-9_]+\b/)?.[0] ||
        (error?.name === 'TimeoutError' ? 'TIMEOUT' : page.isClosed() ? 'finestra chiusa' : 'errore del browser');
    }
    const message = 'Navigazione Awin — ' + label + ': ' + reason;
    if (attempt === 3 || page.isClosed() || !temporary.test(reason)) throw new Error(message);
    console.log(message + ' (tentativo ' + attempt + ' di 3; riprovo).');
    await new Promise(resolve => setTimeout(resolve, attempt * 2000));
  }
}

async function readFeedEligibleAdvertisers(page, targets) {
  await open(page, '/datafeed/step-one');
  const url = await getFeedListUrl(page);
  if (!url) throw new Error('Lista ufficiale dei feed Awin non disponibile.');
  const response = await page.request.get(url, { timeout: 25000, maxRedirects: 0 });
  try {
    if (!response.ok()) throw new Error('Lista ufficiale dei feed Awin: HTTP ' + response.status() + '.');
    const [header = [], ...rows] = readCsvRows(await response.text());
    const fields = header.map(value => value.trim().toLowerCase());
    const advertiser = fields.indexOf('advertiser name');
    const membership = fields.indexOf('membership status');
    const urlIndex = fields.findIndex(field => field === 'url' || /^(?:download|data feed) (?:url|link)$/.test(field));
    if (advertiser < 0 || membership < 0 || urlIndex < 0) throw new Error('Formato della lista dei feed Awin non riconosciuto.');
    const key = value => value?.trim().replace(/\s+/g, ' ').toLowerCase();
    const available = new Set(rows.filter(row => key(row[membership]) === 'active' &&
      /^https?:\/\//i.test(row[urlIndex]?.trim() ?? '')).map(row => key(row[advertiser])));
    return targets.filter(name => available.has(key(name)));
  } finally {
    await response.dispose();
  }
}

async function feedFingerprint(filename) {
  const hash = require('node:crypto').createHash('sha256');
  for await (const chunk of require('node:fs').createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function publishedFeedHashes() {
  try {
    const response = await fetch(new URL('catalogo/indice.json', publicSite), {
      cache: 'no-store', signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) return [];
    const index = await response.json();
    return Array.isArray(index.importedFeedHashes)
      ? index.importedFeedHashes.filter(hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))
      : [];
  } catch {
    return [];
  }
}

async function downloadScript(revision, name, destination, category) {
  const response = await fetch(rawBase + revision + '/tools/awin/' + name, {
    redirect: 'error',
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error('Impossibile scaricare ' + name + ' da GitHub (HTTP ' + response.status + ')');
  let script = await response.text();
  const inspectedRows = 'return { names: [...new Set(names)], total: count ? Number(count[1]) : null };';
  if (!script.includes(inspectedRows)) throw new Error('Conteggio righe Awin non riconosciuto.');
  script = script.replace(inspectedRows,
    'return { names: [...new Set(names)], rowCount: names.length, total: count ? Number(count[1]) : null };');
  const openFunction = /^async function open\(page, route\) \{[\s\S]*?^\}/m;
  if (!openFunction.test(script)) throw new Error('Navigazione Awin non riconosciuta.');
  script = script.replace(openFunction, () => openAwinRoute.toString().replace('function openAwinRoute(', 'function open('));
  const summary = "    console.log('Listini salvati: ' + completed + ' di ' + targets.length);";
  if (script.split(summary).length !== 2) throw new Error('Versione dello scaricatore Awin non riconosciuta.');
  const hook = 'const active = await readJoinedAdvertisers(page);';
  if (script.split(hook).length !== 2) throw new Error('Punto di selezione categoria Awin non riconosciuto.');
  const requestHook = 'const requested = process.argv.slice(3).map(name => name.trim().toLowerCase());';
  if (script.split(requestHook).length !== 2) throw new Error('Punto di selezione dei listini Awin non riconosciuto.');
  script = script.replace(hook, () => 'let selection; try { selection = await (' + (category === null ? readAllPersonalAdvertisers : readCategoryAdvertisers).toString() +
    ')(page, ' + JSON.stringify(category) + ', ' + JSON.stringify(categories) + '); } catch (error) { console.error("Awin | " + error.message); process.exitCode = 1; return; }' +
    (category === null ? ' const seen = selection.targets.length; try { selection.targets = await (' +
      readFeedEligibleAdvertisers.toString() + ')(page, selection.targets); } catch (error) { console.error(error.message); process.exitCode = 1; return; }' +
      ' scalaStatus("Feed disponibili: " + selection.targets.length + "/" + seen + " advertiser filtrati.");' : '') +
    ' const active = selection.joined;' +
    ' console.log("Awin | Iscritto / " + ' + JSON.stringify(category ?? 'Advertiser personali') + ' + ": " + (selection.targets.join(", ") || "nessun advertiser"));' +
    ' if (process.env.SCALA_AWIN_SOLO_VERIFICA === "1") return;' +
    ' if (!selection.targets.length) { console.log("Nessun advertiser iscritto da elaborare."); return; }')
    .replace(requestHook, 'const requested = selection.targets.map(name => name.trim().toLowerCase());');
  const listedStart = '    if (links.length !== 1) {';
  const listedEnd = '    return links[0];';
  const listedAt = script.indexOf(listedStart);
  const listedStop = script.indexOf(listedEnd, listedAt);
  if (listedAt < 0 || listedStop < 0) throw new Error('Selettore della lista Awin non riconosciuto.');
  script = script.slice(0, listedAt) +
    '    return (' + chooseItalianListedFeed.toString() + ')(name, links, matches, columns, url);' +
    script.slice(listedStop + listedEnd.length);
  // Reuse the pinned helper's validation and saving for the official-list fallback.
  const saveStart = "  setStage('Verifica del nome del file');";
  const saveEnd = '\n}\n\nfunction inspectPersonalAdvertisers';
  const start = script.indexOf(saveStart);
  const end = script.indexOf(saveEnd, start);
  const loopStart = '    let completed = 0;\n    for (const name of targets) {';
  if (script.split(loopStart).length !== 2) throw new Error('Contatore dei listini Awin non riconosciuto.');
  script = script.replace(loopStart, () => '    let skippedNoItalian = 0, current = 0;\n' + loopStart + `
      const progress = ++current + '/' + targets.length + ' advertiser | ' + name;
      scalaStatus(progress);

      try {
        const reused = await (` + reuseRecentFeed.toString() + `)(path.join(__dirname, 'LISTINI'), output,
          advertiserFilename(name), ` + feedExtension + `);
        if (reused) {
          await scalaFeedStatus(path.basename(reused));
          completed++;
          continue;
        }
      } catch {
        console.warn(name + ' | riutilizzo non riuscito, provo a scaricare da Awin.');
      }
`);
  const failure = '        reportFailure(name, stage, error);';
  if (start < 0 || end < 0 || script.split(failure).length !== 2) {
    throw new Error('Percorso di recupero dei feed Awin non riconosciuto.');
  }
  script = script.slice(0, start) + '  await saveScalaExport(exportFile, name, setStage);\n}\n\n' +
    'async function saveScalaExport(exportFile, name, setStage) {\n' + script.slice(start);
  const saved = "    console.log(name + ' | scaricato | ' + file.size + ' byte | ' + filename);";
  if (script.split(saved).length !== 2) throw new Error('Conferma del file Awin non riconosciuta.');
  script = script.replace(saved, '    await scalaFeedStatus(filename);');
  script = script.replace(failure, () => `        if (stage === 'Attesa della riga del feed') {
          try {
            await open(page, '/datafeed/step-one');
            setStage('Recupero tramite Scarica lista Feed');
            console.log(name + ' | cerco un listino attivo nella lista ufficiale Awin');
            const listed = await findListedFeed(page, await getFeedListUrl(page), name);
            const file = await fetchGeneratedExport(page, name, enhancedUiExportUrl(listed) || listed);
            await saveScalaExport(file, name, setStage);
            completed++;
            continue;
          } catch (fallbackError) {
            if (fallbackError.code === 'SCALA_AWIN_NO_ITALIAN') {
              skippedNoItalian++;
              console.warn(name + ' | saltato: Awin non offre un feed italiano.');
              continue;
            }
            reportFailure(name, stage, fallbackError);
            continue;
          }
        }
` + failure);
  const quietOutput = `
const scalaStatus = console.log.bind(console);
const scalaError = console.error.bind(console);
if (process.env.SCALA_AWIN_DETTAGLI !== '1') {
  console.log = (...args) => { if (String(args[0]).includes(' | errore al passaggio')) scalaStatus(...args); };
  console.warn = () => {};
  console.error = message => scalaError(String(message).replace(/^Awin [|] /, ''));
}
const scalaPublished = new Set(JSON.parse(process.env.SCALA_AWIN_HASH_PUBBLICATI || '[]'));
let scalaUnchanged = 0;
async function scalaFeedStatus(filename) {
  const hash = await (` + feedFingerprint.toString() + `)(path.join(output, filename)).catch(() => null);
  if (scalaPublished.has(hash)) {
    scalaUnchanged++;
    scalaStatus('  Identico al catalogo pubblicato.');
  }
}
`;
  fs.writeFileSync(destination, quietOutput + script.replace(summary,
    '    scalaStatus("Listini disponibili: " + completed + "/" + targets.length + " | identici: " + scalaUnchanged + " | senza feed italiano: " + skippedNoItalian + " | errori: " + (targets.length - completed - skippedNoItalian));' +
    '\n    if (completed + skippedNoItalian !== targets.length) process.exitCode = 1;'), { flag: 'wx' });
  run(process.execPath, ['--check', destination]);
}

async function keepLocalFeeds(staging, local) {
  const feeds = fs.readdirSync(staging, { withFileTypes: true }).filter(entry => entry.isFile());
  if (!feeds.length || feeds.some(entry => !feedExtension.test(entry.name))) {
    throw new Error('Scaricamento incompleto o formato non supportato. Sono attesi CSV, TSV, gzip o JSONL.');
  }
  fs.mkdirSync(local, { recursive: true });
  let changed = 0;
  for (const { name } of feeds) {
    const temporary = path.join(local, '.' + randomUUID() + '.part');
    try {
      const source = path.join(staging, name);
      const target = path.join(local, name);
      if (fs.existsSync(target) && await feedFingerprint(source) === await feedFingerprint(target)) continue;
      const info = fs.statSync(source);
      fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
      fs.utimesSync(temporary, info.atime, info.mtime);
      fs.renameSync(temporary, target);
      changed++;
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  return changed;
}

function publish(repo) {
  const git = (...args) => run('git', ['-C', repo, ...args]);
  git('add', '--', ...filesToPublish);
  const diff = spawnSync('git', ['-C', repo, 'diff', '--cached', '--quiet', '--', ...filesToPublish], { stdio: 'inherit' });
  if (diff.status === 0) {
    console.log('Il catalogo su GitHub è già identico.');
    return;
  }
  if (diff.status !== 1) throw new Error('Impossibile verificare le modifiche Git.');
  git('commit', '-m', 'Aggiorna catalogo offerte Awin', '--', ...filesToPublish);
  git('push', 'origin', 'HEAD:main');
}

async function verifyOnline(repo) {
  const hashes = new Map(['catalogo/indice.json'].map(name => [
    name, createHash('sha256').update(fs.readFileSync(path.join(repo, name))).digest('hex')
  ]));
  async function matches(name, expected) {
    try {
      const url = new URL(name, publicSite);
      url.searchParams.set('verifica', Date.now().toString());
      const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
      if (!response.ok) {
        await response.body?.cancel();
        return false;
      }
      const actual = createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');
      return actual === expected;
    } catch {
      return false;
    }
  }
  for (let attempt = 0; attempt < 12; attempt++) {
    const confirmed = await Promise.all([...hashes].map(([name, expected]) => matches(name, expected)));
    if (confirmed.every(Boolean)) return true;
    if (attempt < 11) await delay(10000);
  }
  return false;
}

// Filter inside Iscritto; never leave the joined advertiser view.
async function readCategoryAdvertisers(page, category, categoryNames) {
  const emptyHeading = page.getByText(/^Advertiser personali\s*\(\s*0\s*\)$/i).filter({ visible: true });
  const snapshot = async () => await emptyHeading.count() === 1
    ? { names: [], total: 0 } : page.evaluate(inspectPersonalAdvertisers, false);
  async function stableRows(accept, message, timeout = 25000) {
    const until = Date.now() + timeout;
    let signature, since;
    while (Date.now() < until) {
      const rows = await snapshot();
      const key = JSON.stringify(rows);
      if (!rows?.names || !await accept(rows)) signature = undefined;
      else if (signature !== key) { signature = key; since = Date.now(); }
      else if (Date.now() - since >= 1200) return rows;
      await page.waitForTimeout(250);
    }
    throw new Error(message);
  }
  await page.getByText(/^Advertiser personali(?:\s*\(\s*\d+\s*\))?$/i)
    .filter({ visible: true }).first().waitFor({ timeout: 20000 });
  if (process.env.SCALA_AWIN_TUTTE === '1') {
    const clear = page.getByText('Reimposta ricerca', { exact: true }).filter({ visible: true });
    if (await clear.count() === 1) await clear.click();
  }
  const sector = page.getByText('Settore', { exact: true }).filter({ visible: true });
  const retail = page.getByText(/^Retail\s*&\s*Shopping(?:\s*\([\d.]+\))?$/i).filter({ visible: true });
  const label = page.getByText(new RegExp('^' + category.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
    '(?:\\s*\\([\\d.]+\\))?$', 'i')).filter({ visible: true });
  if (!await label.isVisible() && !await retail.isVisible() && await sector.count() === 1) {
    await sector.click({ timeout: 3500 }).catch(() => {});
  }
  // On the signed-in profile the sector is open, but the retail branch can be collapsed.
  if (!await label.isVisible() && await retail.count() === 1) {
    const branch = retail.locator('xpath=ancestor-or-self::li[./ul or ./*[contains(concat(" ",normalize-space(@class)," ")," hitarea ")]][1]');
    const expand = branch.locator(':scope > .hitarea, :scope > [aria-expanded="false"]')
      .filter({ visible: true });
    if (await expand.count() === 1) await expand.click({ timeout: 3000 }).catch(() => {});
    else await retail.click({ timeout: 3000 }).catch(() => {});
    await label.waitFor({ timeout: 5000 }).catch(() => {});
  }
  if (!await label.isVisible()) {
    console.log('Awin | Nella scheda «Iscritto», apri il ramo «Retail & Shopping» dentro «Settore». Lascia deselezionata la sottocategoria.');
    await label.waitFor({ timeout: 90000 }).catch(() => {
      throw new Error('Sottocategoria «' + category + '» non trovata in «Iscritto». Nessun listino scaricato.');
    });
  }
  const selection = async () => {
    if (await label.count() !== 1 || await retail.count() !== 1) return { valid: false };
    return label.evaluate((element, allowed) => {
      const normalize = value => (value ?? '').replace(/\s+/g, ' ').trim().replace(/\s*\([\d.]+\)$/, '').toLowerCase();
      const names = new Set(allowed.map(normalize));
      const retailName = normalize('Retail & Shopping');
      const role = '[role="checkbox"], input[type="checkbox"]';
      const row = 'li.checkbox, [role="treeitem"]';
      const controlFor = text => {
        const native = text.closest('label')?.control;
        if (native?.matches(role)) return native;
        const direct = text.closest(role);
        if (direct) return direct;
        for (let box = text; box && box !== document.body; box = box.parentElement) {
          const controls = box.querySelectorAll(role);
          if (controls.length > 1) break;
          if (controls.length === 1) return controls[0];
          if (box.matches(row)) return box;
        }
        return null;
      };
      const checked = node => node && !node.indeterminate && !node.matches('[aria-checked="mixed"], .indeterminate') &&
        (node.checked === true || node.matches('[aria-checked="true"], .selected'));
      const own = controlFor(element);
      if (!own) return { valid: false };
      const byCaption = new Map();
      for (const node of document.body.querySelectorAll('label, span, a, div, li, [role="checkbox"]')) {
        const title = normalize(node.textContent);
        if (!names.has(title) || [...node.children].some(child => normalize(child.textContent) === title)) continue;
        const control = controlFor(node);
        if (!control) continue;
        if (!byCaption.has(title)) byCaption.set(title, new Set());
        byCaption.get(title).add(control);
      }
      if (byCaption.get(retailName)?.size !== 1) return { valid: false };
      const broader = [...(byCaption.get(retailName) ?? [])].some(checked);
      const other = [...byCaption.values()].some(controls => [...controls].some(node => node !== own && checked(node)));
      return { valid: true, selected: checked(own), other, broader };
    }, [...categoryNames, 'Retail & Shopping', 'Finance & Insurance', 'Telecoms & Services', 'Travel']);
  };
  let initial = await selection();
  if (initial.valid && initial.broader) {
    await retail.click();
    if (!await label.isVisible()) {
      throw new Error('Awin ha richiuso il ramo deselezionando Retail & Shopping. Nessun listino scaricato.');
    }
    initial = await selection();
  }
  if (!initial.valid || initial.other) throw new Error('I controlli di categoria non sono verificabili o ci sono altri settori selezionati.');
  if (initial.selected) await label.click();
  const unfiltered = await stableRows(async () => {
    const state = await selection();
    return state.valid && !state.selected && !state.other;
  }, 'Elenco generale iniziale non verificabile.');
  await label.click();
  const categoryOnly = async () => {
    const state = await selection();
    return state.valid && state.selected && !state.other;
  };
  let current = await stableRows(rows => {
    const reduced = Number.isSafeInteger(rows.total) && Number.isSafeInteger(unfiltered.total)
      ? rows.total < unfiltered.total
      : rows.names.length < unfiltered.names.length && rows.names.every(name => unfiltered.names.includes(name));
    return reduced ? categoryOnly() : false;
  },
    'Awin non ha confermato un elenco più ristretto per «' + category + '». Nessun listino scaricato.');
  const expected = current.total;
  if (expected === null) {
    const next = page.getByText(/^(?:pagina )?successiv[ao](?:\s*[›»])?$/i).filter({ visible: true });
    if (await next.count()) throw new Error('La paginazione degli advertiser filtrati non è verificabile.');
    return { joined: [...new Set([...unfiltered.names, ...current.names])], targets: current.names };
  }
  const seen = new Set();
  const names = new Set();
  while (names.size < expected) {
    if (!await categoryOnly()) throw new Error('Il filtro di categoria è cambiato durante la lettura.');
    const key = JSON.stringify(current.names);
    if (seen.has(key)) throw new Error('Awin ha ripetuto una pagina della categoria.');
    seen.add(key);
    for (const name of current.names) names.add(name);
    if (names.size === expected) break;
    if (names.size > expected) throw new Error('Il totale della categoria non corrisponde alle righe.');
    const nextLabel = /^(?:pagina )?successiv[ao](?:\s*[›»])?$/i;
    const next = page.getByRole('link', { name: nextLabel }).or(page.getByRole('button', { name: nextLabel }))
      .or(page.getByText(nextLabel)).filter({ visible: true }).first();
    if (!await next.isVisible() || !await next.isEnabled()) throw new Error('Non riesco a leggere tutte le pagine della categoria.');
    await next.click();
    current = await stableRows(rows =>
      rows.total === expected && JSON.stringify(rows.names) !== key ? categoryOnly() : false,
    'La pagina successiva della categoria non è stata confermata.');
  }
  const targets = [...names];
  console.log('Awin | Iscritto / ' + category + ': ' + targets.length + ' advertiser.');
  return { joined: [...new Set([...unfiltered.names, ...targets])], targets };
}

const excludedCategories = new Set(['Erotico', 'Vini, alcolici e tabacchi']);

function categoryChoice(input) {
  const number = input.trim();
  if (number === '0') return null;
  if (number.toLowerCase() === 'p') return 'personali';
  if (number.toLowerCase() === 'l') return 'locale';
  if (!/^[1-9]\d*$/.test(number) || Number(number) > categories.length) {
    throw new Error('Scegli un numero da 0 a ' + categories.length + ' oppure P o L.');
  }
  const category = categories[Number(number) - 1];
  if (excludedCategories.has(category)) throw new Error('Categoria esclusa: ' + category);
  return category;
}

async function chooseCategory() {
  console.log('0. Scarica i listini degli iscritti in tutte le sottocategorie');
  console.log('P. Scarica tutti gli advertiser personali senza pubblicare');
  console.log('L. Aggiorna solo dai listini già salvati');
  categories.forEach((name, i) => { if (!excludedCategories.has(name)) console.log((i + 1) + '. ' + name); });
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try { return categoryChoice(await prompt.question('Scegli la sottocategoria da scaricare: ')); }
  finally { prompt.close(); }
}

async function main() {
  const args = process.argv.slice(2).map(arg => arg === '--tutti-iscritti' ? 'P' : arg);
  const dryRun = args.includes('--solo-verifica');
  const skipEmpty = args.includes('--salta-listini-vuoti');
  const localFlag = args.includes('--solo-locali');
  const [choice, ...extra] = args.filter(arg => !['--solo-verifica', '--salta-listini-vuoti', '--solo-locali'].includes(arg));
  if (extra.length) throw new Error('Uso: node aggiorna-scala-dei-turchi.cjs [numero sottocategoria | P | --tutti-iscritti | L | --solo-locali] [--solo-verifica | --salta-listini-vuoti]');
  const selection = choice === undefined && (localFlag || skipEmpty) ? 'locale'
    : choice === undefined ? await chooseCategory() : categoryChoice(choice);
  const localOnly = selection === 'locale' || localFlag || (selection === null && skipEmpty);
  if (localOnly && selection !== null && selection !== 'locale') throw new Error('Usa --solo-locali senza un numero di sottocategoria.');
  const personal = selection === 'personali';
  if (personal && skipEmpty) throw new Error('Per scaricare gli advertiser personali usa P senza --salta-listini-vuoti.');
  const allCategories = selection === null && !localOnly;
  if (dryRun && (localOnly || allCategories)) throw new Error('Per la verifica scegli una sottocategoria diversa da 0.');
  const requestedCategories = localOnly ? [] : allCategories ? categories.filter(name => !excludedCategories.has(name)) : [personal ? 'Advertiser personali' : selection];
  const publisher = '3150312';
  const local = path.join(__dirname, 'LISTINI');
  const working = fs.mkdtempSync(path.join(os.tmpdir(), 'scala-awin-'));
  const repo = path.join(working, 'sito');
  const downloadPath = path.join(__dirname, '.scarica-awin-' + randomUUID() + '.cjs');
  const failures = [];
  let preserveWorking = false;
  let downloaded = 0;
  let hasLocalResults = false;
  try {
    const hashes = requestedCategories.length && !dryRun ? await publishedFeedHashes() : [];
    for (const [index, category] of requestedCategories.entries()) {
      const staging = path.join(working, 'listini', category);
      fs.mkdirSync(staging, { recursive: true });
      if (allCategories) console.log('Categoria ' + (index + 1) + '/' + requestedCategories.length + ': ' + category);
      try {
        await downloadScript('a4bf3cc0ebecadc7450c6180d42a2d2af6407bc2', 'scarica-listini-awin.cjs', downloadPath, personal ? null : category);
        console.log((dryRun ? 'Verifico il filtro Awin: ' : 'Scarico i listini Awin degli advertiser attivi: ') + category);
        run(process.execPath, [downloadPath, publisher], {
          env: { ...process.env, AWIN_LISTINI_DIR: staging, SCALA_AWIN_SOLO_VERIFICA: dryRun ? '1' : '',
            SCALA_AWIN_HASH_PUBBLICATI: JSON.stringify(hashes), SCALA_AWIN_TUTTE: allCategories ? '1' : '' }
        });
        if (dryRun) return;
        if (!fs.readdirSync(staging).length) {
          console.log('Nessun listino da salvare per ' + category + '.');
          if (!allCategories) return;
          continue;
        }
        const destination = path.join(local, category);
        const count = await keepLocalFeeds(staging, destination);
        downloaded += count;
        hasLocalResults = true;
        console.log('Listini aggiornati: ' + count + ' | ' + destination);
      } catch (error) {
        if (personal && fs.readdirSync(staging).some(name => feedExtension.test(name))) {
          preserveWorking = true;
          const destination = path.join(local, category);
          const count = await keepLocalFeeds(staging, destination);
          preserveWorking = false;
          console.warn('Listini disponibili salvati: ' + count + ' | ' + destination);
          console.warn('Scaricamento parziale. Controlla gli errori sopra e riprova; nessun aggiornamento pubblicato.');
          throw error;
        }
        if (fs.readdirSync(staging).some(name => feedExtension.test(name))) {
          preserveWorking = true;
          console.error('Download incompleto. Listini parziali conservati qui: ' + staging);
        }
        if (!allCategories) throw error;
        failures.push(category);
        console.error('Categoria non completata: ' + category + ' | ' + error.message);
      } finally {
        fs.rmSync(downloadPath, { force: true });
      }
    }
    if (personal) {
      console.log('Scaricamento terminato. Nessun aggiornamento pubblicato.');
      return;
    }
    if (allCategories) {
      console.log('Listini salvati nelle cartelle di categoria: ' + downloaded);
      if (failures.length) console.warn('Categorie da riprovare: ' + failures.join(', '));
      if (!hasLocalResults) {
        if (failures.length) process.exitCode = 1;
        return;
      }
    }
    if (!fs.existsSync(local)) throw new Error('Cartella listini non trovata: ' + local);
    console.log('Aggiorno il catalogo con tutti i listini e le sottocartelle di ' + local);
    run('git', ['clone', '--depth', '1', '--single-branch', '--branch', 'main', repository, repo]);
    run(process.execPath, [path.join(repo, 'tools', 'awin', 'importa-listini-awin.cjs'), repo, local, publisher], {
      env: { ...process.env, SCALA_AWIN_SALTA_LISTINI_VUOTI: skipEmpty || allCategories ? '1' : '' }
    });
    publish(repo);
    if (!await verifyOnline(repo)) {
      console.warn('GitHub aggiornato, ma il nuovo catalogo non è ancora verificabile su GitHub Pages.');
      process.exitCode = 2;
      return;
    }
    console.log('Catalogo verificato online: ' + publicSite);
    if (failures.length) process.exitCode = 1;
  } finally {
    fs.rmSync(downloadPath, { force: true });
    if (!preserveWorking) fs.rmSync(working, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error('Aggiornamento interrotto: ' + error.message);
  process.exitCode = 1;
});
