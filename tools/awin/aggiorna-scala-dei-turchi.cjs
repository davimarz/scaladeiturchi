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

async function downloadScript(revision, name, destination, category) {
  const response = await fetch(rawBase + revision + '/tools/awin/' + name, {
    redirect: 'error',
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error('Impossibile scaricare ' + name + ' da GitHub (HTTP ' + response.status + ')');
  let script = await response.text();
  const summary = "    console.log('Listini salvati: ' + completed + ' di ' + targets.length);";
  if (script.split(summary).length !== 2) throw new Error('Versione dello scaricatore Awin non riconosciuta.');
  const hook = 'const active = await readJoinedAdvertisers(page);';
  if (script.split(hook).length !== 2) throw new Error('Punto di selezione categoria Awin non riconosciuto.');
  const requestHook = 'const requested = process.argv.slice(3).map(name => name.trim().toLowerCase());';
  if (script.split(requestHook).length !== 2) throw new Error('Punto di selezione dei listini Awin non riconosciuto.');
  script = script.replace(hook, () => 'let selection; try { selection = await (' + readCategoryAdvertisers.toString() +
    ')(page, ' + JSON.stringify(category) + ', ' + JSON.stringify(categories) + '); } catch (error) { console.error("Awin | " + error.message); process.exitCode = 1; return; }' +
    ' const active = selection.joined;' +
    ' console.log("Awin | Iscritto / " + ' + JSON.stringify(category) + ' + ": " + (selection.targets.join(", ") || "nessun advertiser"));' +
    ' if (process.env.SCALA_AWIN_SOLO_VERIFICA === "1") return;' +
    ' if (!selection.targets.length) { console.error("Nessun listino da scaricare."); process.exitCode = 1; return; }')
    .replace(requestHook, 'const requested = selection.targets.map(name => name.trim().toLowerCase());');
  // The shared downloader can exit successfully with only part of the batch.
  fs.writeFileSync(destination, script.replace(summary, summary +
    '\n    if (completed !== targets.length) process.exitCode = 1;'), { flag: 'wx' });
  run(process.execPath, ['--check', destination]);
}

function keepLocalFeeds(staging, local) {
  const feeds = fs.readdirSync(staging, { withFileTypes: true }).filter(entry => entry.isFile());
  if (!feeds.length || feeds.some(entry => !feedExtension.test(entry.name))) {
    throw new Error('Scaricamento incompleto o formato non supportato. Sono attesi CSV, TSV, gzip o JSONL.');
  }
  fs.mkdirSync(local, { recursive: true });
  for (const { name } of feeds) {
    const temporary = path.join(local, '.' + randomUUID() + '.part');
    try {
      fs.copyFileSync(path.join(staging, name), temporary, fs.constants.COPYFILE_EXCL);
      fs.renameSync(temporary, path.join(local, name));
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  return feeds.length;
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
  const snapshot = () => page.evaluate(inspectPersonalAdvertisers, false);
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

function categoryChoice(input) {
  const number = input.trim();
  if (number === '0') return null;
  if (!/^[1-9]\d*$/.test(number) || Number(number) > categories.length) {
    throw new Error('Scegli un numero da 0 a ' + categories.length + '.');
  }
  return categories[Number(number) - 1];
}

async function chooseCategory() {
  console.log('0. Aggiorna il catalogo con tutti i listini già salvati');
  categories.forEach((name, i) => console.log((i + 1) + '. ' + name));
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try { return categoryChoice(await prompt.question('Scegli la sottocategoria da scaricare: ')); }
  finally { prompt.close(); }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--solo-verifica');
  const [choice, ...extra] = args.filter(arg => arg !== '--solo-verifica');
  if (extra.length) throw new Error('Uso: node aggiorna-scala-dei-turchi.cjs [numero sottocategoria] [--solo-verifica]');
  const category = choice === undefined ? await chooseCategory() : categoryChoice(choice);
  if (dryRun && !category) throw new Error('Per la verifica scegli una sottocategoria diversa da 0.');
  const publisher = '3150312';
  const local = path.join(__dirname, 'LISTINI');
  const working = fs.mkdtempSync(path.join(os.tmpdir(), 'scala-awin-'));
  const staging = path.join(working, 'listini');
  const repo = path.join(working, 'sito');
  const downloadPath = path.join(__dirname, '.scarica-awin-' + randomUUID() + '.cjs');
  let preserveWorking = false;
  try {
    if (category) {
      fs.mkdirSync(staging);
      await downloadScript('a4bf3cc0ebecadc7450c6180d42a2d2af6407bc2', 'scarica-listini-awin.cjs', downloadPath, category);
      console.log((dryRun ? 'Verifico il filtro Awin: ' : 'Scarico i listini Awin degli advertiser attivi: ') + category);
      try {
        run(process.execPath, [downloadPath, publisher], { env: { ...process.env, AWIN_LISTINI_DIR: staging, SCALA_AWIN_SOLO_VERIFICA: dryRun ? '1' : '' } });
        if (dryRun) return;
        const destination = path.join(local, category);
        const count = keepLocalFeeds(staging, destination);
        console.log('Listini aggiornati: ' + count + ' | ' + destination);
      } catch (error) {
        if (fs.readdirSync(staging).some(name => feedExtension.test(name))) {
          preserveWorking = true;
          console.error('Download incompleto. Listini parziali conservati qui: ' + staging);
        }
        throw error;
      }
    }
    if (!fs.existsSync(local)) throw new Error('Cartella listini non trovata: ' + local);
    console.log('Aggiorno il catalogo con tutti i listini e le sottocartelle di ' + local);
    run('git', ['clone', '--depth', '1', '--single-branch', '--branch', 'main', repository, repo]);
    run(process.execPath, [path.join(repo, 'tools', 'awin', 'importa-listini-awin.cjs'), repo, local, publisher]);
    publish(repo);
    if (!await verifyOnline(repo)) {
      console.warn('GitHub aggiornato, ma il nuovo catalogo non è ancora verificabile su GitHub Pages.');
      process.exitCode = 2;
      return;
    }
    console.log('Catalogo verificato online: ' + publicSite);
  } finally {
    fs.rmSync(downloadPath, { force: true });
    if (!preserveWorking) fs.rmSync(working, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error('Aggiornamento interrotto: ' + error.message);
  process.exitCode = 1;
});
