#!/usr/bin/env node
/**
 * Mise à jour de la BDD One Piece Card Game pour TCG Arena, depuis optcgapi.com.
 *
 *  1. Télécharge toutes les cartes : boosters (allSetCards), starter decks (allSTCards), promos (allPromos)
 *     et cartes DON!! (allDonCards) — une requête par liste, chaque semaine
 *  2. Génère OnePieceCards.json au format TCG Arena (id, face.front, name, type, cost, rarity, colors, subtypes, power, set)
 *     - id   = card_image_id (OP01-077, OP01-077_p1 pour la version Parallel / Box Topper…)
 *     - name = "Perona OP01-077" : les versions alternatives (et les promos réimprimées) ont le même nom
 *              que la carte de base → TCG Arena les regroupe comme skins de la même carte
 *     - les cartes sans image sont ignorées
 *  3. Une carte disparue de l'API est conservée telle quelle (aucune carte perdue pour les decks existants)
 *  4. Rapport détaillé dans Scripts/update-report.md
 *
 * Emplacement : Scripts/Update.js (les chemins partent de la racine du repo)
 * Usage       : node Scripts/Update.js
 * Dépendances : aucune (Node 18+)
 */
'use strict';

const fsp = require('fs/promises');
const path = require('path');

// ─────────────────────────────── Configuration ───────────────────────────────

const CONFIG = {
    apiBase: trimSlash(process.env.API_BASE || 'https://www.optcgapi.com/api'),
    repoRoot: path.resolve(process.env.REPO_ROOT || path.join(__dirname, '..')),

    cardsFile: 'OnePieceCards.json',       // fichier du jeu, à la racine du repo
    reportPath: path.join(__dirname, 'update-report.md'),

    // listes téléchargées ; "don" = cartes DON!! (toutes nommées "DON!!" → une seule carte avec plein de skins)
    sources: [
        { path: '/allSetCards/', label: 'Boosters', kind: 'card' },
        { path: '/allSTCards/', label: 'Starter decks', kind: 'card' },
        { path: '/allPromos/', label: 'Promos', kind: 'card' },
        { path: '/allDonCards/', label: 'DON!!', kind: 'don' },
    ],
    // noms officiels des sets (champ "set" de OnePieceCards.json)
    setNameSources: [
        { path: '/allSets/', id: 'set_id', name: 'set_name' },
        { path: '/allDecks/', id: 'structure_deck_id', name: 'structure_deck_name' },
    ],

    timeoutMs: 120_000,                     // les listes complètes sont grosses
    retries: 3,
    minRatioVsPrevious: 0.8,                // refuse d'écrire si on perd >20% des cartes (FORCE=1 pour forcer)
    userAgent: 'TCG-Arena-OnePiece-updater (+https://tcg-arena.fr)',
};

/**
 * Découpage des sous-types (l'API les colle avec des espaces : "Land of Wano Kouzuki Clan").
 * Le script s'appuie sur les types cités dans le texte des cartes ("Kouzuki Clan" type) et sur les cartes
 * qui n'ont qu'un sous-type. Pour les cas qu'il ne peut pas deviner (listés dans le rapport) :
 *  - EXTRA_SUBTYPES : sous-types à reconnaître, ex: 'Kouzuki Clan'
 *  - KEEP_WHOLE     : valeurs à ne jamais découper, ex: 'Animal Kingdom Pirates'
 */
const EXTRA_SUBTYPES = [
];
const KEEP_WHOLE = [
];

/** Raretés écrites en toutes lettres dans OnePieceCards.json (un code inconnu est gardé tel quel et signalé) */
const RARITY_NAMES = {
    C: 'Common',
    UC: 'Uncommon',
    R: 'Rare',
    SR: 'Super Rare',
    SEC: 'Secret Rare',
    L: 'Leader',
    P: 'Promo',
    PR: 'Promo',
    SP: 'Special',
    'SP CARD': 'Special',
    TR: 'Treasure Rare',
    DON: 'DON!!',
};

// ─────────────────────────────── Rapport d'erreurs ───────────────────────────────

const issues = []; // { level: 'error' | 'warning', category, id, message }

function report(level, category, id, message) {
    issues.push({ level, category, id, message });
}

class FatalError extends Error { }

// ─────────────────────────────── Utilitaires ───────────────────────────────

function trimSlash(s) { return s.replace(/\/+$/, ''); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function rel(...p) { return path.join(CONFIG.repoRoot, ...p); }
function clean(s) { return String(s ?? '').replace(/\s+/g, ' ').trim(); }
function toInt(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; }

async function readJsonIfExists(file, fallback) {
    try {
        return JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch (e) {
        if (e.code !== 'ENOENT') report('warning', 'Fichiers locaux illisibles (ignorés)', path.relative(CONFIG.repoRoot, file), e.message);
        return fallback;
    }
}

async function writeFileAtomic(file, content) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    await fsp.writeFile(tmp, content);
    await fsp.rename(tmp, file);
}

/** GET JSON avec retries sur erreurs réseau / 429 / 5xx → { data } | { error } */
async function getJson(url) {
    let lastError = 'erreur inconnue';
    for (let attempt = 1; attempt <= CONFIG.retries; attempt++) {
        try {
            const res = await fetch(url, {
                headers: { 'User-Agent': CONFIG.userAgent, Accept: 'application/json' },
                signal: AbortSignal.timeout(CONFIG.timeoutMs),
            });
            if (res.status === 429 || res.status >= 500) {
                try { await res.body?.cancel(); } catch { }
                lastError = `HTTP ${res.status}`;
            } else if (!res.ok) {
                try { await res.body?.cancel(); } catch { }
                return { error: `HTTP ${res.status}` };
            } else {
                const text = await res.text();
                try {
                    return { data: JSON.parse(text) };
                } catch (e) {
                    return { error: `JSON invalide (${e.message})` };
                }
            }
        } catch (e) {
            lastError = e.name === 'TimeoutError' ? `timeout après ${CONFIG.timeoutMs / 1000}s` : (e.cause?.code || e.message);
        }
        if (attempt < CONFIG.retries) await sleep(2000 * 2 ** (attempt - 1));
    }
    return { error: lastError };
}

// ─────────────────────────────── Sous-types ───────────────────────────────

/**
 * Types cités dans le texte des cartes : Add up to 1 "Straw Hat Crew" type…, "Supernovas" or "Heart Pirates" type…
 * Ce sont les noms officiels des sous-types : la meilleure source pour savoir où couper.
 */
function extractTextTypes(texts) {
    const types = new Set();
    const groupBeforeType = /((?:"[^"\n]{2,80}"\s*(?:,|\bor\b|\band\b|\/)?\s*)+)type/gi;
    for (const t of texts) {
        if (!t) continue;
        for (const m of String(t).matchAll(groupBeforeType)) {
            for (const q of m[1].matchAll(/"([^"\n]{2,80})"/g)) types.add(clean(q[1]));
        }
        for (const q of String(t).matchAll(/\{([^{}\n]{2,80})\}/g)) types.add(clean(q[1]));
    }
    return types;
}

/**
 * L'API colle les sous-types avec de simples espaces ("Animal Straw Hat Crew"), alors que certains
 * font plusieurs mots. Vocabulaire : types cités dans les textes de cartes + cartes qui n'ont qu'un sous-type
 * + déductions ; puis chaque valeur est découpée en sous-types connus (le moins de morceaux possible).
 */
function buildSubtypeSplitter(rawValues, textTypes) {
    const raws = [...new Set(rawValues.map(clean).filter(Boolean))];
    const rawWords = new Set(raws.flatMap(v => v.split(' ')));
    // types officiels utiles : ceux qui apparaissent vraiment dans les sous-types des cartes
    const official = new Set([...textTypes, ...EXTRA_SUBTYPES.map(clean)].filter(t => t.split(' ').every(w => rawWords.has(w)) && raws.some(v => (' ' + v + ' ').includes(' ' + t + ' '))));
    const keepWhole = new Set(KEEP_WHOLE.map(clean));
    const protectedValue = v => official.has(v) || keepWhole.has(v);

    // découpe "words" en morceaux du vocabulaire, le moins de morceaux possible ; null si impossible
    const segment = (value, vocab, maxPhraseWords) => {
        const words = value.split(' ');
        const best = Array(words.length + 1).fill(null);
        best[0] = [];
        for (let i = 0; i < words.length; i++) {
            if (!best[i]) continue;
            for (let j = i + 1; j <= Math.min(words.length, i + maxPhraseWords); j++) {
                const phrase = words.slice(i, j).join(' ');
                if (!vocab.has(phrase)) continue;
                const candidate = [...best[i], phrase];
                if (!best[j] || candidate.length < best[j].length) best[j] = candidate;
            }
        }
        return best[words.length];
    };

    // vocabulaire de base : types officiels + valeurs qui ne se découpent pas en d'autres valeurs existantes
    const all = new Set([...raws, ...official, ...keepWhole]);
    const maxWords = Math.max(1, ...[...all].map(v => v.split(' ').length));
    const base = new Set([...official, ...keepWhole]);
    for (const v of raws) {
        if (protectedValue(v)) continue;
        const others = new Set(all);
        others.delete(v);
        const parts = segment(v, others, maxWords);
        if (!parts || parts.length < 2) base.add(v);
    }

    // sous-type qui n'apparaît jamais seul ("Land of Wano The Akazaya Nine") : on retire les sous-types connus
    // au début ou à la fin ; si le même reste ("The Akazaya Nine") revient dans au moins 2 valeurs différentes,
    // c'est un sous-type à part entière. Exception : un mot seul toujours placé en tête ("Former" de "Former Navy",
    // "Former Whitebeard Pirates"…) fait partie du sous-type suivant, ce n'en est pas un.
    const inferred = new Map(); // sous-type déduit → exemples
    const contains = (outer, inner) => (' ' + outer + ' ').includes(' ' + inner + ' ');
    // valeur qui sert de base à d'autres ("Whitebeard Pirates Allies" dans "Giant Whitebeard Pirates Allies") : jamais découpée seule
    const rawSet = new Set(raws);
    const isBuildingBlock = v => rawSet.has(v) && raws.some(w => w !== v && contains(w, v));
    // sous-type "carrefour" : présent dans au moins 2 autres valeurs ("Animal Kingdom Pirates", "Land of Wano"…)
    const isHub = (anchor, v) => raws.filter(w => w !== v && w !== anchor && contains(w, anchor)).length >= 2;
    for (let round = 0; round < 8; round++) {
        const remainders = new Map(); // reste → { values, kinds, anchors }
        const addRemainder = (r, v, kind, anchor) => {
            if (!remainders.has(r)) remainders.set(r, { values: new Set(), kinds: new Set(), anchors: [] });
            remainders.get(r).values.add(v);
            remainders.get(r).kinds.add(kind);
            remainders.get(r).anchors.push({ v, anchor });
        };
        // plus long sous-type connu (autre que la valeur elle-même) qui commence (step=1) ou finit (step=-1) à cet endroit
        const longestKnown = (words, from, to, step) => {
            const whole = words.join(' ');
            for (let len = to - from; len >= 1; len--) {
                const phrase = step === 1 ? words.slice(from, from + len).join(' ') : words.slice(to - len, to).join(' ');
                if (phrase !== whole && base.has(phrase)) return len;
            }
            return 0;
        };
        for (const v of base) {
            if (protectedValue(v)) continue;
            const w = v.split(' ');
            if (w.length < 2) continue;
            let i = 0, lastLen = 0;
            for (let len; i < w.length && (len = longestKnown(w, i, w.length, 1)); i += len) lastLen = len;
            if (i > 0 && i < w.length) addRemainder(w.slice(i).join(' '), v, 'end', w.slice(i - lastLen, i).join(' '));
            let j = w.length, firstLen = 0;
            for (let len; j > 0 && (len = longestKnown(w, 0, j, -1)); j -= len) firstLen = len;
            if (j < w.length && j > 0) addRemainder(w.slice(0, j).join(' '), v, 'start', w.slice(j, j + firstLen).join(' '));
        }
        const accepted = [...remainders]
            .filter(([r, x]) => {
                if (base.has(r)) return false;
                // un mot seul toujours en tête ("Former") n'est pas un sous-type
                if (r.split(' ').length === 1 && x.kinds.size === 1 && x.kinds.has('start')) return false;
                // revient dans au moins 2 valeurs différentes
                if (x.values.size >= 2) return true;
                // une seule valeur : accepté à côté d'un sous-type carrefour, si la valeur ne sert pas de base à d'autres
                return x.anchors.some(({ v, anchor }) => !protectedValue(v) && !isBuildingBlock(v) && isHub(anchor, v));
            })
            .map(([r, x]) => { inferred.set(r, [...x.values].slice(0, 3)); return r; });
        if (!accepted.length) break;
        accepted.forEach(r => base.add(r));
        for (const v of [...base]) {
            if (protectedValue(v)) continue;
            const others = new Set(base);
            others.delete(v);
            const parts = segment(v, others, maxWords);
            if (parts && parts.length >= 2) base.delete(v);
        }
    }

    // un reste déduit puis lui-même redécoupé ("Drake Pirates Navy" → "Drake Pirates" + "Navy") n'est plus un sous-type
    for (const t of [...inferred.keys()]) if (!base.has(t)) inferred.delete(t);

    const cache = new Map();
    const split = value => {
        const v = clean(value);
        if (!v) return [];
        if (!cache.has(v)) cache.set(v, segment(v, base, maxWords) || [v]);
        return cache.get(v);
    };

    // valeurs restées entières qui contiennent un sous-type connu au début ou à la fin : sûrement deux sous-types collés
    const suspicious = [...base].filter(v => {
        if (protectedValue(v)) return false;
        const w = v.split(' ');
        if (w.length < 2) return false;
        for (let k = 1; k < w.length; k++) {
            if (base.has(w.slice(0, k).join(' '))) return true;
            // "Former Navy" : un seul mot devant un sous-type connu = un seul sous-type, pas suspect
            if (base.has(w.slice(k).join(' ')) && k >= 2) return true;
        }
        return false;
    });
    return { split, vocabulary: base, suspicious, inferred, officialCount: official.size };
}

// ─────────────────────────────── Format OnePieceCards.json ───────────────────────────────

/** URL d'image exploitable (ni vide, ni ".../None", ni ".../null") */
function hasImage(url) {
    const u = clean(url);
    if (!/^https?:\/\//i.test(u)) return false;
    const file = u.split('?')[0].split('/').pop() || '';
    return !!file && !/^(none|null|undefined)(\.[a-z0-9]+)?$/i.test(file);
}

/** Nom du fichier image sans extension : ".../OP09-077_r1.jpg" → "OP09-077_r1" */
function imageBaseName(url) {
    return clean(url).split('?')[0].split('/').pop()?.replace(/\.[a-z0-9]+$/i, '') || '';
}

/** Les promos écrivent "OP09" là où les boosters écrivent "OP-09" : un seul code par set */
function normalizeSet(s) {
    const v = clean(s);
    const m = v.match(/^([A-Z]+)-?(\d+)$/i);
    return m ? `${m[1].toUpperCase()}-${m[2]}` : (v || undefined);
}

/** "Crocodile (067) (Parallel)" → "Crocodile" ; "DON!! Card // Green Compass" → "DON!! Card" */
function baseName(name) {
    let n = clean(name);
    let prev;
    do {
        prev = n;
        n = n.replace(/\s*\([^()]*\)\s*$/, '').trim();
    } while (n !== prev && n);
    return n || clean(name);
}

const unknownRarities = new Map(); // code → nb de cartes

function rarityName(code) {
    const c = clean(code);
    if (!c) return undefined;
    const name = RARITY_NAMES[c.toUpperCase()];
    if (!name) unknownRarities.set(c, (unknownRarities.get(c) || 0) + 1);
    return name || c;
}

function buildCardEntry(c, splitSubtypes, setName) {
    const id = clean(c.card_image_id) || clean(c.card_set_id);
    const number = clean(c.card_set_id) || id.replace(/_.*$/, '');
    const name = `${baseName(c.card_name)} ${number}`;
    const type = clean(c.card_type) || 'Unknown';
    const cost = toInt(c.card_cost);
    return {
        id,
        face: {
            front: { name, type, cost, image: clean(c.card_image), isHorizontal: false },
        },
        name,
        type,
        cost,
        rarity: rarityName(c.rarity),
        colors: clean(c.card_color).split(' ').filter(Boolean),
        subtypes: splitSubtypes(c.sub_types),
        power: toInt(c.card_power),
        set: setName,
    };
}

/** Cartes DON!! : même nom pour toutes → une seule carte "DON!!" avec ses différentes illustrations en skins */
function buildDonEntry(c, setName) {
    const image = clean(c.card_image);
    // l'ID séquentiel de l'API (don_1, don_2…) change quand une nouvelle DON est ajoutée en tête de liste :
    // on utilise le nom du fichier image, stable
    const file = image.split('/').pop()?.replace(/\.[a-z0-9]+$/i, '');
    const id = file ? `DON-${file.replace(/^DON_Card_*/i, '').replace(/_img$/i, '')}` : clean(c.card_image_id) || clean(c.don_id);
    const type = 'DON!!';
    return {
        id,
        face: {
            front: { name: 'DON!!', type, cost: 0, image, isHorizontal: false },
        },
        name: 'DON!!',
        type,
        cost: 0,
        rarity: rarityName(c.rarity) || 'DON!!',
        colors: [],
        subtypes: [],
        power: 0,
        set: setName,
    };
}

// ─────────────────────────────── Rapport ───────────────────────────────

function buildReport(summary) {
    const errors = issues.filter(i => i.level === 'error');
    const warnings = issues.filter(i => i.level === 'warning');
    const lines = [];
    lines.push(`# Mise à jour des cartes One Piece — ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC`, '');
    lines.push('| | |', '|---|---|');
    for (const s of summary.sources) lines.push(`| ${s.label} | ${s.error ? '❌ ' + s.error : `${s.count} cartes`} |`);
    lines.push(`| Cartes dans ${CONFIG.cardsFile} | ${summary.cardCount} (avant : ${summary.previousCount}) |`);
    lines.push(`| Nouvelles cartes | ${summary.added.length} |`);
    lines.push(`| Cartes disparues de l'API (conservées) | ${summary.kept.length} |`);
    lines.push(`| Cartes ignorées faute d'image | ${summary.noImage} |`);
    lines.push(`| Sous-types différents | ${summary.subtypeCount} (dont ${summary.officialTypes} cités dans les textes de cartes, ${summary.inferred.length} déduits) |`);
    lines.push(`| ❌ Erreurs | ${errors.length} |`);
    lines.push(`| ⚠️ Avertissements | ${warnings.length} |`, '');

    if (summary.fatal) lines.push('## 💥 Erreur bloquante', '', summary.fatal, '', `${CONFIG.cardsFile} n'a PAS été modifié.`, '');

    const section = (title, list) => {
        if (!list.length) return;
        lines.push(`## ${title} (${list.length})`, '');
        const byCat = new Map();
        for (const i of list) byCat.set(i.category, [...(byCat.get(i.category) || []), i]);
        for (const [cat, items] of byCat) {
            lines.push(`### ${cat} — ${items.length}`, '');
            items.slice(0, 300).forEach(i => lines.push(`- \`${i.id}\` — ${i.message}`));
            if (items.length > 300) lines.push(`- … et ${items.length - 300} autre(s)`);
            lines.push('');
        }
    };
    section('❌ Erreurs', errors);
    section('⚠️ Avertissements', warnings);

    if (summary.inferred.length) {
        lines.push(`## 🧩 Sous-types déduits (${summary.inferred.length})`, '');
        lines.push('Jamais cités seuls ni dans un texte de carte : trouvés en retirant les sous-types connus. À mettre dans KEEP_WHOLE si un découpage est faux.', '');
        summary.inferred.forEach(x => lines.push(`- **${x.type}** — ex : ${x.examples.map(e => `\`${e}\``).join(', ')}`));
        lines.push('');
    }
    if (summary.added.length) {
        lines.push(`## ➕ Nouvelles cartes (${summary.added.length})`, '');
        const bySet = new Map();
        for (const id of summary.added) bySet.set(summary.setOf[id] || '?', (bySet.get(summary.setOf[id] || '?') || 0) + 1);
        lines.push([...bySet].map(([s, n]) => `\`${s}\` ${n}`).join(' · '), '');
    }
    return lines.join('\n');
}

async function writeReport(summary) {
    const md = buildReport(summary);
    await writeFileAtomic(CONFIG.reportPath, md);
    if (process.env.GITHUB_STEP_SUMMARY) {
        const limited = md.length > 900_000 ? md.slice(0, 900_000) + '\n\n_(tronqué, voir Scripts/update-report.md)_' : md;
        await fsp.appendFile(process.env.GITHUB_STEP_SUMMARY, limited + '\n');
    }
    if (process.env.GITHUB_OUTPUT) {
        const nErr = issues.filter(i => i.level === 'error').length;
        const nWarn = issues.filter(i => i.level === 'warning').length;
        await fsp.appendFile(process.env.GITHUB_OUTPUT, `errors=${nErr}\nwarnings=${nWarn}\n`);
    }
}

function printIssuesToConsole() {
    const print = (icon, list) => {
        const byCat = new Map();
        list.forEach(i => byCat.set(i.category, [...(byCat.get(i.category) || []), i]));
        for (const [cat, items] of byCat) {
            console.log(`\n${icon} ${cat} (${items.length})`);
            items.slice(0, 30).forEach(i => console.log(`   - ${i.id} : ${i.message}`));
            if (items.length > 30) console.log(`   … et ${items.length - 30} autre(s), voir le rapport`);
        }
    };
    const errors = issues.filter(i => i.level === 'error');
    const warnings = issues.filter(i => i.level === 'warning');
    if (errors.length) { console.log(`\n════════ ❌ ${errors.length} ERREUR(S) ════════`); print('❌', errors); }
    if (warnings.length) { console.log(`\n════════ ⚠️  ${warnings.length} AVERTISSEMENT(S) ════════`); print('⚠️ ', warnings); }
    if (!errors.length && !warnings.length) console.log('\n✨ Aucune erreur, aucun avertissement.');
}

// ─────────────────────────────── Main ───────────────────────────────

async function main() {
    const summary = { sources: [], cardCount: 0, previousCount: 0, added: [], kept: [], subtypeCount: 0, officialTypes: 0, inferred: [], noImage: 0, setOf: {}, fatal: null };

    try {
        const cardsPath = rel(CONFIG.cardsFile);
        const previousCards = await readJsonIfExists(cardsPath, {});
        summary.previousCount = Object.keys(previousCards).length;

        // ── 1. Téléchargement des listes ──
        const raw = [];
        for (const src of CONFIG.sources) {
            process.stdout.write(`📥 ${src.label} (${CONFIG.apiBase}${src.path})… `);
            const res = await getJson(`${CONFIG.apiBase}${src.path}`);
            if (res.error || !Array.isArray(res.data)) {
                const why = res.error || 'la réponse n\'est pas une liste';
                console.log(`❌ ${why}`);
                summary.sources.push({ label: src.label, error: why });
                report('error', 'Liste inaccessible (ses cartes déjà connues sont conservées)', src.label, why);
                continue;
            }
            console.log(`${res.data.length} cartes`);
            summary.sources.push({ label: src.label, count: res.data.length });
            for (const c of res.data) if (c && typeof c === 'object') raw.push({ c, src });
        }
        if (!raw.length) throw new FatalError('Aucune carte téléchargée');

        // ── Noms des sets : listes officielles (boosters + starter decks), sinon le nom le plus fréquent sur les cartes ──
        const setNameById = new Map();
        for (const src of CONFIG.setNameSources) {
            const res = await getJson(`${CONFIG.apiBase}${src.path}`);
            if (res.error || !Array.isArray(res.data)) {
                report('warning', 'Liste des noms de sets inaccessible (noms pris sur les cartes)', src.path, res.error || 'réponse inattendue');
                continue;
            }
            for (const s of res.data) {
                const id = normalizeSet(s?.[src.id]);
                if (id && clean(s?.[src.name])) setNameById.set(id, clean(s[src.name]));
            }
        }
        const nameVotes = new Map(); // set_id → { nom → nb de cartes }
        for (const { c, src } of raw) {
            if (src.kind !== 'card' || src.path.includes('Promo')) continue;
            const id = normalizeSet(c.set_id), n = clean(c.set_name);
            if (!id || !n) continue;
            if (!nameVotes.has(id)) nameVotes.set(id, {});
            nameVotes.get(id)[n] = (nameVotes.get(id)[n] || 0) + 1;
        }
        const setNameOf = (c, src) => {
            // promos : le set de la carte réimprimée n'est pas le bon, on garde le nom de la promo ("One Piece Promotion Cards")
            if (src.path.includes('Promo')) return clean(c.set_name) || 'Promo';
            const id = normalizeSet(c.set_id);
            const votes = nameVotes.get(id);
            const majority = votes && Object.entries(votes).sort((a, b) => b[1] - a[1])[0][0];
            return setNameById.get(id) || majority || clean(c.set_name) || id;
        };

        // ── 2. Construction des cartes ──
        const cardRaws = raw.filter(r => r.src.kind === 'card').map(r => r.c);
        const splitter = buildSubtypeSplitter(cardRaws.map(c => c.sub_types), extractTextTypes(cardRaws.map(c => c.card_text)));
        summary.subtypeCount = splitter.vocabulary.size;
        summary.officialTypes = splitter.officialCount;
        for (const v of splitter.suspicious) {
            report('warning', 'Sous-types peut-être collés (ajoute la partie manquante dans EXTRA_SUBTYPES, ou la valeur dans KEEP_WHOLE si elle est correcte)', v, '');
        }
        summary.inferred = [...splitter.inferred].map(([t, ex]) => ({ type: t, examples: ex }));

        const out = {};
        const noImageIds = new Set();
        const noImageBySource = {};
        for (const { c, src } of raw) {
            const entry = src.kind === 'don' ? buildDonEntry(c, setNameOf(c, src)) : buildCardEntry(c, splitter.split, setNameOf(c, src));
            if (!entry.id) { report('error', 'Carte sans identifiant (ignorée)', src.label, clean(c.card_name)); continue; }
            if (!hasImage(entry.face.front.image)) {
                // pas d'image → pas de carte
                if (!out[entry.id]) noImageIds.add(entry.id);
                noImageBySource[src.label] = [...(noImageBySource[src.label] || []), entry.id];
                continue;
            }
            if (out[entry.id]) {
                if (out[entry.id].face.front.image === entry.face.front.image) continue; // même carte listée deux fois
                // même ID, autre image (ex: promo réimprimée) : skin supplémentaire, ID tiré du nom de fichier (stable)
                const altId = imageBaseName(entry.face.front.image);
                if (!altId || out[altId]) {
                    report('warning', 'Même ID avec deux images différentes (première gardée)', entry.id, `${src.label} : ${entry.face.front.image}`);
                    continue;
                }
                entry.id = altId;
            }
            if (src.kind === 'card' && !c.card_set_id) report('warning', 'Carte sans numéro (card_set_id)', entry.id, clean(c.card_name));
            out[entry.id] = entry;
            noImageIds.delete(entry.id);
        }
        for (const [code, n] of unknownRarities) {
            report('warning', 'Raretés inconnues (gardées telles quelles, à ajouter dans RARITY_NAMES)', code, `${n} carte(s)`);
        }
        for (const [label, ids] of Object.entries(noImageBySource)) {
            report('warning', 'Cartes sans image (ignorées)', label, `${ids.length} carte(s) : ${ids.slice(0, 15).join(', ')}${ids.length > 15 ? '…' : ''}`);
        }
        summary.noImage = Object.values(noImageBySource).reduce((n, l) => n + l.length, 0);

        const realIds = Object.keys(out);
        if (summary.previousCount && realIds.length < summary.previousCount * CONFIG.minRatioVsPrevious && process.env.FORCE !== '1') {
            throw new FatalError(`Seulement ${realIds.length} cartes contre ${summary.previousCount} dans le ${CONFIG.cardsFile} actuel. ` +
                'Probable problème côté API. Relancer avec FORCE=1 pour écraser quand même.');
        }

        // ── 3. Comparaison avec la semaine précédente ──
        summary.added = realIds.filter(id => !(id in previousCards));
        for (const id of summary.added) summary.setOf[id] = out[id].set;
        for (const [id, prev] of Object.entries(previousCards)) {
            if (out[id]) continue;
            // carte encore dans l'API mais sans image, ou ancienne entrée sans image : pas conservée
            if (noImageIds.has(id) || !hasImage(prev?.face?.front?.image)) continue;
            out[id] = prev; // aucune carte perdue pour les decks existants
            summary.kept.push(id);
            report('warning', 'Cartes disparues de l\'API (conservées telles quelles)', id, prev?.name || '');
        }

        // ── 4. Écriture (triée par set puis numéro, versions alternatives après la carte de base) ──
        const sortKey = id => {
            const e = out[id];
            const m = String(e.name).match(/([A-Z]+)(\d+)-(\d+)$/);
            return m ? [m[1], Number(m[2]), Number(m[3]), id] : ['~', 0, 0, id];
        };
        const sorted = Object.keys(out).sort((a, b) => {
            const ka = sortKey(a), kb = sortKey(b);
            return ka[0].localeCompare(kb[0]) || ka[1] - kb[1] || ka[2] - kb[2] || ka[3].localeCompare(kb[3]);
        });
        await writeFileAtomic(cardsPath, JSON.stringify(Object.fromEntries(sorted.map(k => [k, out[k]])), null, 2) + '\n');
        summary.cardCount = sorted.length;
        console.log(`\n💾 ${CONFIG.cardsFile} écrit : ${summary.cardCount} cartes (${summary.added.length} nouvelles, ${summary.kept.length} disparues de l'API conservées)`);
    } catch (e) {
        summary.fatal = e instanceof FatalError ? e.message : `Erreur inattendue : ${e.stack || e.message}`;
        console.error(`\n💥 ${summary.fatal}`);
    }

    printIssuesToConsole();
    await writeReport(summary).catch(e => console.error('Impossible d\'écrire le rapport :', e.message));
    console.log(`\n📄 Rapport : ${path.relative(CONFIG.repoRoot, CONFIG.reportPath)}`);
    if (summary.fatal) process.exitCode = 1;
}

main();
