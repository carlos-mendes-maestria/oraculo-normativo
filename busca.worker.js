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
let sitTema = [];   // situacao de cada trecho de precedente, conforme o proprio tema
const MAX_POR_TRIBUNAL = 8;   // temas do STF e do STJ sao um documento por tribunal, com milhares de temas
const TIPOS_PRECEDENTE = new Set(["Sumulas", "Precedentes Qualificados", "Nota Técnica CIJEPI", "Guia NUGEP"]);

function dobrar(t) {
  return t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// Radical leve: "substituir", "substituto" e "substituicao" viram a mesma palavra na busca. Numeros e palavras curtas nao mudam.
function raiz(w) {
  if (w.length < 6 || !/^[a-z]+$/.test(w)) return w;
  if (w.endsWith("mente")) w = w.slice(0, -5);
  return w.slice(0, 7).replace(/[aeio]+$/, "") || w;
}

function termos(t) {
  const out = [];
  for (let w of dobrar(t).match(/[a-z0-9]+/g) || []) {
    if (w.length < 2 || STOP.has(w)) continue;
    if (w.length > 4 && w.endsWith("s")) w = w.slice(0, -1);   // plural simples
    out.push(raiz(w));
  }
  return out;
}

function docDe([n, rot, est, txt]) {
  return `${normas[n].b || normas[n].nome} ${rot === "Preâmbulo" ? normas[n].ementa : ""} ${rot} ${est} ${txt}`;
}

function montarBM25() {
  comp = new Float32Array(trechos.length);
  trechos.forEach((t, i) => {
    const c = new Map();
    for (const w of termos(docDe(t))) c.set(w, (c.get(w) || 0) + 1);
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
// A pergunta ampliada entra como uma 3a lista, so na busca por palavras (testar_busca.py, 28/10); peso 0,5 -> 1 em 06/11/2026 (OK do Carlos).
let sinonimos = [];
const PESO_AMPLIADA = 1;
const PESO_CONTEXTO = 2;     // busca da pergunta junto com o tema: costuma ser a lista mais precisa do conjunto

function escaparRx(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function carregarSinonimos(grupos) {
  sinonimos = grupos.map((g) => [new RegExp("\\b(?:" + g.se.map(escaparRx).join("|") + ")\\b"), g.acrescenta]);
}

function expandir(consulta) {
  const f = dobrar(consulta);
  const extra = sinonimos.filter(([rx]) => rx.test(f)).map(([, a]) => a);
  return extra.length ? consulta + " " + extra.join(" ") : consulta;
}

// Erro de digitacao: palavra fora do vocabulario, com 8 letras ou mais, troca pela mais frequente que difira em uma letra
// trocada ou duas invertidas. O fim da palavra fica de fora: "trabalhei" e conjugacao, nao erro, e nao vira "trabalhe".
const MIN_LETRAS_CORRECAO = 8, MIN_TRECHOS_CORRECAO = 3;

function umaEdicao(a, b) {
  if (a.length !== b.length || a === b) return false;
  let i = 0;
  while (a[i] === b[i]) i++;
  if (i >= a.length - 2) return false;
  return a.slice(i + 1) === b.slice(i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
}

function corrigir(consulta) {
  return consulta.replace(/\p{L}+/gu, (p) => {
    const palavra = dobrar(p), [t] = termos(palavra);
    if (!t || palavra.length < MIN_LETRAS_CORRECAO || inv.has(t) || !palavra.startsWith(t)) return p;
    let melhor = null, df = MIN_TRECHOS_CORRECAO * 2 - 1;   // cada trecho ocupa 2 posicoes da lista
    for (const [w, l] of inv) if (l.length > df && umaEdicao(t, w)) { melhor = w; df = l.length; }
    return melhor ? melhor + palavra.slice(t.length) : p;
  });
}

// Pertinencia para o prompt: a similaridade nao separa os trechos (estudo de 01/11), entao o criterio sao os termos.
// O trecho precisa ter o termo mais raro da consulta ou metade do peso dela; um sinonimo do dicionario tambem vale.
function avaliador(consulta, ampliada, fixos) {
  const ts = [...new Set(termos(consulta))].filter((w) => idf.has(w));
  const extras = termos(ampliada).filter((w) => !ts.includes(w));
  const total = ts.reduce((s, w) => s + idf.get(w), 0);
  const rara = ts.reduce((m, w) => (!m || idf.get(w) > idf.get(m) ? w : m), null);
  return (i) => {
    if (!rara || fixos.includes(i)) return true;
    const doc = new Set(termos(docDe(trechos[i])));
    return doc.has(rara) || extras.some((w) => doc.has(w)) ||
      ts.reduce((s, w) => s + (doc.has(w) ? idf.get(w) : 0), 0) >= total / 2;
  };
}

// Rebaixa no prompt, sem retirar: norma da pandemia quando a consulta nao fala nisso e tema do STF ou do STJ que so coincide
// em palavra, sem nenhum termo do dicionario, quando a pergunta foi traduzida para os termos das normas.
const RX_COVID = /covid|coronav|pandemia/;

function avaliadorFraco(consulta, ampliada) {
  const covidNaConsulta = RX_COVID.test(dobrar(consulta));
  const extras = termos(ampliada.slice(consulta.length));
  return (i) => {
    const doc = dobrar(docDe(trechos[i]));
    if (!covidNaConsulta && RX_COVID.test(doc)) return true;
    if (!trechos[i][4] || !extras.length) return false;
    const t = new Set(termos(doc));
    return !extras.some((w) => t.has(w));
  };
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

// Cada tema traz sua linha "Situação:"; temas longos viram "(parte N)" e a linha fica em uma so parte.
function montarSituacoes() {
  sitTema = new Array(trechos.length).fill("");
  let ini = 0;
  const fechar = (fim) => {
    if (normas[trechos[ini][0]].tipo !== "Precedentes Qualificados") return;
    let sit = "";
    for (let i = ini; i < fim && !sit; i++) {
      const m = /Situa[çc][ãa]o:[ \t]*([^\n]+)/.exec(trechos[i][3]);
      if (m && !/^(Processos|Descri)/.test(m[1])) sit = m[1].replace(/\s*\(Cont\.\)/, "").trim();
    }
    for (let i = ini; i < fim; i++) sitTema[i] = sit;
  };
  for (let i = 1; i <= trechos.length; i++) {
    if (i < trechos.length && trechos[i][0] === trechos[ini][0] && /\(parte \d+\)$/.test(trechos[i][1])) continue;
    fechar(i);
    ini = i;
  }
  trechos.forEach((t, i) => { if (t[4]) sitTema[i] = t[4].s; });   // STF e STJ: situacao vinda da fonte oficial
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
  montarSituacoes();
  montarRotulos();
  console.log(`[busca] indice de palavras montado em ${Math.round(performance.now() - t0)} ms`);
  postMessage({ tipo: "pronto", normas: normas.length, trechos: trechos.length });
  if (!semModelo) carregarModelo();
}

// "Tema 1376 STJ", "IAC 5": o tema pedido pelo numero vem primeiro, mesmo cancelado, para o usuario ver a situacao dele.
const RX_TEMA = /\b(tema|iac|sirdr|puil|relevancia)\s*(?:n[º°o.]*\s*)?(\d[\d.]*)(?:\s*(?:\/|d[oe])?\s*(stf|stj))?/gi;
let porRotulo = new Map();

function montarRotulos() {
  trechos.forEach((t, i) => { if (t[4]) porRotulo.set(dobrar(t[1]), i); });
}

function temasCitados(consulta) {
  const out = [];
  for (const [, sigla, num, trib] of dobrar(consulta).matchAll(RX_TEMA))
    for (const t of trib ? [trib] : ["stf", "stj"]) {
      const i = porRotulo.get(`${sigla} ${num.replace(/\./g, "")} ${t}`);
      if (i !== undefined) out.push(i);
    }
  return out;
}

async function buscar({ id, consulta: digitada, contexto, soVigentes, tipoNorma, maxPorNorma = 3, limite = 30 }) {
  const consulta = corrigir(digitada);
  const filtro = (i) => {
    const m = normas[trechos[i][0]];
    return (!soVigentes || (m.situacao !== "revogada" && !m.superada && !m.sem_efeito && !/^(cancelad|prejudicad)/i.test(sitTema[i]))) && (!tipoNorma || m.tipo === tipoNorma || (tipoNorma === "precedentes-sumulas" && TIPOS_PRECEDENTE.has(m.tipo)));
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
  // busca da pergunta: "quantos dias podem ser vendidos?" so faz sentido junto do tema "ferias"
  if (contexto) {
    listas.push(topo(bm25(`${corrigir(contexto)} ${ampliada}`), 100, filtro)); pesos.push(PESO_CONTEXTO);
    // so os termos das normas: a frase coloquial e o tema nao empurram o artigo certo para baixo
    const tecnicos = ampliada.slice(consulta.length);
    if (tecnicos) { listas.push(topo(bm25(tecnicos), 100, filtro)); pesos.push(PESO_CONTEXTO); }
  }
  const fixos = tipoNorma && !/recedentes/.test(tipoNorma) ? [] : temasCitados(consulta);
  const ordem = [...new Set([...fixos, ...(listas.length > 1 ? rrf(listas, pesos) : listas[0])])];
  const pertinente = avaliador(consulta, ampliada, fixos), fraco = avaliadorFraco(consulta, ampliada);
  const porNorma = new Map(), res = [];
  for (const i of ordem) {
    const n = trechos[i][0];
    const [, rotulo, estrutura, texto, tema] = trechos[i];
    if ((porNorma.get(n) || 0) >= (tema ? (tipoNorma ? limite : MAX_POR_TRIBUNAL) : maxPorNorma)) continue;
    porNorma.set(n, (porNorma.get(n) || 0) + 1);
    res.push({ idx: i, norma: normas[n], rotulo, estrutura, texto, situacaoTema: sitTema[i], linkTema: tema?.u, suspensao: tema?.n, estadoSuspensao: tema?.e, pertinente: pertinente(i), fraco: !fixos.includes(i) && fraco(i) });
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
  // trecho que termina num titulo ("Seção II – Da Substituição") ou cortado no meio: o seguinte da mesma norma vai junto
  for (const r of res.slice(0, 40)) {
    const s = seguinte(r.idx);
    if (s !== null) r.seguinte = { rotulo: trechos[s][1], texto: trechos[s][3] };
  }
  postMessage({ tipo: "resultado", id, modo, res, citados, tabela: tabelaRetribuicao(`${digitada} ${contexto || ""}`, filtro),
               termos: [...new Set(termos(consulta))], corrigida: consulta !== digitada ? consulta : "", equivalentes: ampliada.slice(consulta.length).trim() });
}

// ---------------------------------------------------------------- continuacao e tabela de retribuicao
const RX_TITULO = /^(t[íi]tulo|cap[íi]tulo|se[çc][ãa]o|subse[çc][ãa]o)\b/i;

function seguinte(i) {
  const [n, , , texto, tema] = trechos[i];
  if (tema || i + 1 >= trechos.length || trechos[i + 1][0] !== n) return null;
  const linhas = texto.trim().split("\n").map((l) => l.trim()).filter(Boolean);
  const ult = linhas[linhas.length - 1] || "", pen = linhas[linhas.length - 2] || "";
  const titulo = RX_TITULO.test(ult) || (RX_TITULO.test(pen) && ult.length < 90 && !/[.;:]$/.test(ult));
  const cortado = /\(parte \d+\)$/.test(trechos[i + 1][1]) && !/[.;:)”"]$/.test(ult);
  return titulo || cortado ? i + 1 : null;
}

// Pergunta sobre valor de cargo em comissao ou funcao de confianca: o valor esta no Quadro II do Anexo VII da LC 230/2017,
// por simbolo (CC/04, FC/02), e o simbolo de cada cargo nos quadros do Anexo VIII. Os dois trechos nunca saem juntos na busca.
const RX_VALOR = /\b(gratificac|remunerac|retribuic|valor|quanto (ganha|recebe|paga)|salario|vencimento|simbolo)/;
const RX_CARGO = /\b(diretor|secretari|assessor|assistente|gestor|gerente|oficial|coordenador|chefe|comissionad|cargo em comissao|funcao|cc|fc)\b/;
let quadroValores = null, quadroGeral = null, quadrosSimbolos = null;

function tabelaRetribuicao(texto, filtro) {
  const f = dobrar(texto);
  if (!RX_VALOR.test(f) || !RX_CARGO.test(f)) return null;
  const ano = (i) => parseInt(normas[trechos[i][0]].ano, 10) || 0;
  if (!quadroValores) {
    quadroValores = [], quadroGeral = [], quadrosSimbolos = [];
    trechos.forEach(([n, , , t], i) => {
      if (normas[n].situacao === "revogada") return;
      if (/Retribui[çc][ãa]o pelo exerc[íi]cio de cargo de dire[çc][ãa]o/i.test(t) && /CC\/01\s+[\d.]+,\d\d/.test(t)) quadroValores.push(i);
      else if (/Quadro Geral de cargos em comiss[ãa]o e fun[çc][õo]es de confian[çc]a/i.test(t)) quadroGeral.push(i);
      else if (/Cargo\/Fun[çc][ãa]o/i.test(t) && /\b(CC|FC)\/\d/.test(t)) quadrosSimbolos.push(i);
    });
    // a lei antes da resolucao que a republica; entre leis, a mais recente
    const lei = (i) => /complementar/i.test(normas[trechos[i][0]].tipo) ? 1 : 0;
    for (const q of [quadroValores, quadroGeral]) q.sort((a, b) => lei(b) - lei(a) || ano(b) - ano(a));
  }
  if (!quadroValores.length) return null;
  // simbolo do cargo: o Quadro I do Anexo VII (quadro geral, por simbolo) e o quadro da unidade mais parecido com a pergunta, sem as palavras de valor; entre os parecidos, o mais recente
  const s = bm25(f.replace(/\b(qual|o|a|valor|da|do|de|gratificacao|remuneracao|retribuicao|quanto|ganha|recebe|um|uma|salario)\b/g, " "));
  const cands = quadrosSimbolos.filter((i) => s[i] > 0 && filtro(i)).sort((a, b) => s[b] - s[a]).slice(0, 6);
  const corte = cands.length ? s[cands[0]] * 0.7 : 0;
  const simbolos = [], vistas = new Set();
  for (const i of cands.filter((i) => s[i] >= corte).sort((a, b) => ano(b) - ano(a))) {
    if (vistas.has(trechos[i][0])) continue;
    vistas.add(trechos[i][0]); simbolos.push(i);
    if (simbolos.length >= 2) break;
  }
  const item = (i) => ({ idx: i, norma: normas[trechos[i][0]], rotulo: trechos[i][1], texto: trechos[i][3] });
  return { valores: item(quadroValores[0]), simbolos: [...quadroGeral.slice(0, 1), ...simbolos].map(item) };
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
