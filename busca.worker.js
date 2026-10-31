// Worker de busca: carrega a base, monta o indice BM25 e, em segundo plano, o modelo semantico.
// Mesma logica de testar_busca.py (BM25 + e5-small + fusao RRF), para os resultados baterem.

const MODELO = "Xenova/multilingual-e5-small";
const DIM = 384;
const STOP = new Set(("a o as os e de do da dos das em no na nos nas um uma uns umas por para pelo pela pelos pelas com sem " +
  "que se ao aos à às ou é ser como qual quais quem onde quando pode tem ter há mais seu sua seus suas este esta " +
  "isso isto esse essa me eu").split(" ").map(dobrar));

let normas = [], trechos = [], vetores = null;
let tf = [], comp = null, media = 0, inv = new Map(), idf = new Map();
let extrator = null;

function dobrar(t) {
  return t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function termos(t) {
  const out = [];
  for (let w of dobrar(t).match(/[a-z0-9]+/g) || []) {
    if (w.length < 2 || STOP.has(w)) continue;
    if (w.length > 4 && w.endsWith("s")) w = w.slice(0, -1);   // plural simples
    out.push(w);
  }
  return out;
}

function montarBM25() {
  comp = new Float32Array(trechos.length);
  trechos.forEach(([n, rot, est, txt], i) => {
    const doc = `${normas[n].nome} ${rot === "Preâmbulo" ? normas[n].ementa : ""} ${rot} ${est} ${txt}`;
    const c = new Map();
    for (const w of termos(doc)) c.set(w, (c.get(w) || 0) + 1);
    let total = 0;
    for (const [w, k] of c) {
      total += k;
      let p = inv.get(w);
      if (!p) inv.set(w, (p = []));
      p.push(i, k);
    }
    comp[i] = total;
  });
  media = comp.reduce((a, b) => a + b, 0) / comp.length;
  const N = trechos.length;
  for (const [w, p] of inv) {
    const df = p.length / 2;
    idf.set(w, Math.log(1 + (N - df + 0.5) / (df + 0.5)));
  }
}

function bm25(consulta, k1 = 1.2, b = 0.75) {
  const s = new Float32Array(trechos.length);
  for (const w of new Set(termos(consulta))) {
    const p = inv.get(w);
    if (!p) continue;
    const peso = idf.get(w);
    for (let j = 0; j < p.length; j += 2) {
      const i = p[j], n = p[j + 1];
      s[i] += peso * n * (k1 + 1) / (n + k1 * (1 - b + b * comp[i] / media));
    }
  }
  return s;
}

function topo(scores, k, filtro) {
  const idx = [];
  for (let i = 0; i < scores.length; i++) if (scores[i] > 0 && filtro(i)) idx.push(i);
  idx.sort((a, b) => scores[b] - scores[a]);
  return idx.slice(0, k);
}

function semantica(qv) {
  const s = new Float32Array(trechos.length);
  for (let i = 0; i < trechos.length; i++) {
    let d = 0;
    const o = i * DIM;
    for (let j = 0; j < DIM; j++) d += vetores[o + j] * qv[j];
    s[i] = d / 127 + 1;   // +1 deixa positivo para o filtro de topo
  }
  return s;
}

function rrf(listas, pesos, k = 60) {
  const s = new Map();
  listas.forEach((l, j) => l.forEach((i, pos) => s.set(i, (s.get(i) || 0) + pesos[j] / (k + pos + 1))));
  return [...s.entries()].sort((a, b) => b[1] - a[1]).map(([i]) => i);
}

// Dicionario de equivalencias (dados/sinonimos.json): "analista judicial" tambem busca "servidor", etc.
// A pergunta ampliada entra como uma 3a lista, com peso 0,5, so na busca por palavras (testar_busca.py, 28/10).
let sinonimos = [];
const PESO_AMPLIADA = 0.5;

function escaparRx(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function carregarSinonimos(grupos) {
  sinonimos = grupos.map((g) => [new RegExp("\\b(?:" + g.se.map(escaparRx).join("|") + ")\\b"), g.acrescenta]);
}

function expandir(consulta) {
  const f = dobrar(consulta);
  const extra = sinonimos.filter(([rx]) => rx.test(f)).map(([, a]) => a);
  return extra.length ? consulta + " " + extra.join(" ") : consulta;
}

async function carregarModelo() {
  try {
    const { pipeline, env } = await import("https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1");
    env.allowLocalModels = false;
    extrator = await pipeline("feature-extraction", MODELO, {
      dtype: "q8",
      progress_callback: (p) => {
        if (p.status === "progress" && p.file && p.file.endsWith(".onnx"))
          postMessage({ tipo: "modelo", estado: "baixando", pct: Math.round(p.progress || 0) });
      },
    });
    postMessage({ tipo: "modelo", estado: "pronto" });
  } catch (e) {
    postMessage({ tipo: "modelo", estado: "erro", msg: String(e) });
  }
}

// A base e baixada pela pagina (app.js) e chega aqui em partes, como ArrayBuffer transferido.
const leitor = new TextDecoder();
let feitos = 0;

function receberParte({ normasBuf, total, trechosBuf, vetoresBuf, n }) {
  if (normasBuf) { normas = JSON.parse(leitor.decode(normasBuf)); vetores = new Int8Array(total * DIM); return; }
  for (const t of JSON.parse(leitor.decode(trechosBuf))) trechos.push(t);
  vetores.set(new Int8Array(vetoresBuf), feitos * DIM);
  feitos += n;
}

// ---------------------------------------------------------------- remissoes entre normas
// "art. 81 do Regimento Interno", "art. 5º da Resolução nº 45/2016", "art. 3º desta Resolução":
// o texto do artigo citado vai junto no pedido a IA, para a resposta nao ficar incompleta.
const APELIDOS = [   // nomes sem numero que aparecem nas citacoes
  [/regimento interno d[ao] corregedoria/, "Provimento_21_2014"],
  [/regimento interno/, "Resolucao_02_1987"],
];
const CHAVES_EXTRA = { "Resolucoes|2|1987": "Resolucao_02_1987" };   // RI do TJPI: sem numero no indice do portal
let porChave = new Map(), porArquivo = new Map(), artigosDe = [];

function grupoTipo(t) {
  t = dobrar(t);
  if (t.startsWith("resolu")) return "Resolucoes";
  if (t.startsWith("provimento")) return "Provimentos";
  if (t.includes("complementar")) return "Leis Complementares";
  return "Leis Ordinarias";
}

function montarRemissoes() {
  normas.forEach((n, i) => {
    porArquivo.set(n.arquivo, i);
    const num = parseInt(n.numero, 10);
    if (!num) return;
    const k = `${n.tipo}|${num}|${n.ano}`;
    if (!porChave.has(k)) porChave.set(k, []);
    porChave.get(k).push(i);
  });
  for (const [k, arq] of Object.entries(CHAVES_EXTRA)) if (porArquivo.has(arq)) porChave.set(k, [porArquivo.get(arq)]);
  artigosDe = normas.map(() => new Map());
  trechos.forEach(([n, rot], i) => {
    const m = /^Art\. (\d+)/.exec(rot);   // so artigos do corpo da norma (nao os de anexos)
    if (!m) return;
    const mapa = artigosDe[n];
    if (!mapa.has(m[1])) mapa.set(m[1], []);
    if (mapa.get(m[1]).length < 2) mapa.get(m[1]).push(i);   // caput + 1 parte, no maximo
  });
}

function normaCitada(tipoTxt, numTxt, anoTxt, origem) {
  const t = dobrar(tipoTxt);
  for (const [rx, arq] of APELIDOS) if (rx.test(t)) return porArquivo.get(arq);
  if (/^(desta|deste)/.test(t)) return origem;
  if (!numTxt) return undefined;
  let ano = anoTxt ? parseInt(anoTxt, 10) : null;
  if (ano !== null && ano < 100) ano += ano < 50 ? 2000 : 1900;
  const cands = (porChave.get(`${grupoTipo(t.replace(/^d[ao]s?\s+/, ""))}|${parseInt(numTxt.replace(".", ""), 10)}|${ano}`) || [])
    .filter((i) => /conjunto/.test(t) === /conjunto/i.test(normas[i].arquivo));
  return cands.find((i) => normas[i].situacao !== "revogada") ?? cands[0];
}

const RX_CITACAO = new RegExp(
  "\\bart(?:igo)?s?\\.?\\s*(\\d{1,4})[º°o]?(?:-[A-Z])?((?:\\s*(?:,|e)\\s*(?:art\\.?\\s*)?\\d{1,4}[º°o]?)*)" +   // art. 3º, 4º e 5º
  // ate 60 caracteres ate o nome da norma, sem passar por outro "art." (senao "Art. 14 – Alterar o artigo 141 da..." pegaria o 14)
  "(?:(?!\\bart)[^.;\\n]){0,60}?\\b(" +
  "d[ao]s?\\s+regimento\\s+interno(?:\\s+d[ao]\\s+corregedoria)?|" +
  "(?:desta|deste)\\s+(?:resolu[çc][ãa]o|provimento|lei)|" +
  "d[ao]s?\\s+(?:resolu[çc][ãa]o|provimento(?:\\s+conjunto)?|lei\\s+complementar|lei))" +
  "(?:\\s+(?:tjpi|cgj|estadual|ordin[áa]ria))*\\s*(?:n[º°o.]*\\s*)?(\\d{1,2}\\.\\d{3}|\\d{1,4})?" +
  "(?:\\s*/\\s*(\\d{2,4})|,?\\s*de\\s+\\d{1,2}[º°o]?\\s+de\\s+[a-zç]+\\s+de\\s+(\\d{4}))?", "gi");

function citacoes(i) {
  const [origem, , , texto] = trechos[i], out = [];
  for (const m of texto.matchAll(RX_CITACAO)) {
    const n = normaCitada(m[3], m[4], m[5] || m[6], origem);
    if (n === undefined) continue;
    const arts = [m[1], ...(m[2].match(/\d{1,4}/g) || [])];
    for (const a of arts) for (const t of artigosDe[n].get(String(parseInt(a, 10))) || []) out.push(t);
  }
  return out;
}

function concluirCarga(semModelo) {
  const t0 = performance.now();
  montarBM25();
  montarRemissoes();
  console.log(`[busca] indice de palavras montado em ${Math.round(performance.now() - t0)} ms`);
  postMessage({ tipo: "pronto", normas: normas.length, trechos: trechos.length });
  if (!semModelo) carregarModelo();
}

async function buscar({ id, consulta, soVigentes, tipoNorma, maxPorNorma = 3, limite = 30 }) {
  const filtro = (i) => {
    const m = normas[trechos[i][0]];
    return (!soVigentes || (m.situacao !== "revogada" && !m.superada)) && (!tipoNorma || m.tipo === tipoNorma);
  };
  const listas = [topo(bm25(consulta), 100, filtro)], pesos = [1];
  let modo = "palavras";
  if (extrator) {
    const out = await extrator("query: " + consulta, { pooling: "mean", normalize: true });
    listas.push(topo(semantica(out.data), 100, filtro)); pesos.push(1);
    modo = "hibrida";
  }
  const ampliada = expandir(consulta);
  if (ampliada !== consulta) { listas.push(topo(bm25(ampliada), 100, filtro)); pesos.push(PESO_AMPLIADA); }
  const ordem = listas.length > 1 ? rrf(listas, pesos) : listas[0];
  const porNorma = new Map(), res = [];
  for (const i of ordem) {
    const n = trechos[i][0];
    if ((porNorma.get(n) || 0) >= maxPorNorma) continue;
    porNorma.set(n, (porNorma.get(n) || 0) + 1);
    const [, rotulo, estrutura, texto] = trechos[i];
    res.push({ idx: i, norma: normas[n], rotulo, estrutura, texto });
    if (res.length >= limite) break;
  }
  // artigos citados pelos primeiros resultados (a pagina escolhe quais entram no pedido a IA)
  const citados = {};
  for (const r of res.slice(0, 20)) {
    r.cita = [];
    for (const t of citacoes(r.idx)) {
      if (t === r.idx || r.cita.includes(t)) continue;
      r.cita.push(t);
      if (!citados[t]) {
        const [n, rotulo, , texto] = trechos[t];
        citados[t] = { norma: normas[n], rotulo, texto };
      }
    }
  }
  postMessage({ tipo: "resultado", id, modo, res, citados, termos: [...new Set(termos(consulta))] });
}

onmessage = (e) => {
  const m = e.data;
  if (m.tipo === "sinonimos") carregarSinonimos(m.grupos);
  else if (m.tipo === "parte") receberParte(m);
  else if (m.tipo === "fim") concluirCarga(m.semModelo);
  else if (m.tipo === "buscar") buscar(m).catch((e) => {
    console.error("[busca] falha na busca:", e);
    postMessage({ tipo: "resultado", id: m.id, modo: "erro", res: [], termos: [] });
  });
};
