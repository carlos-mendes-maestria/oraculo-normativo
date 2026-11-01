// Interface do Oraculo: conversa com o worker de busca e monta os cartoes e o pedido para a IA.

const $ = (id) => document.getElementById(id);
const worker = new Worker("busca.worker.js", { type: "module" });
const NA_TELA = 10;          // cartoes mostrados (ate 3 por norma)
const TRECHOS_NA_IA = 14;    // consulta geral: mais trechos, para a explicacao minuciosa (ate 2 por norma)
const POR_NORMA_NA_IA = 2;
let ultimo = null, contador = 0, baseOk = false, modeloOk = false, modeloMsg = "";

function dobrar(t) { return t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""); }

function escapar(t) {
  return t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// destaca palavras do texto cujo radical simples bate com um termo da busca
function destacar(texto, termos) {
  const alvo = new Set(termos);
  return escapar(texto).replace(/[\p{L}\p{N}]+/gu, (w) => {
    let f = dobrar(w);
    if (f.length > 4 && f.endsWith("s")) f = f.slice(0, -1);
    return alvo.has(f) ? `<mark>${w}</mark>` : w;
  });
}

function situacao(n) { return n.cancelada ? "cancelada" : n.situacao === "revogada" ? "revogada" : "vigente"; }

// selo do cartao: nos precedentes vale a situacao do tema, nao a do arquivo do NUGEP que reune centenas de temas
function seloDe(r) {
  const sit = situacao(r.norma);
  if (r.norma.tipo !== "Precedentes Qualificados") return { texto: sit, classe: sit === "vigente" ? "vigente" : "revogada" };
  const t = r.situacaoTema;
  if (!t) return { texto: "situação: ver o texto", classe: "tema" };
  if (/^cancelad/i.test(t)) return { texto: t, classe: "revogada tema" };
  return { texto: t, classe: /afetad|sobrest|julgamento|pendente|preliminar|revis/i.test(t) ? "tema" : "vigente tema" };
}

// painel de carregamento: barra + giro + "aguarde"; some quando a busca inteligente fica pronta
function painel(titulo, pct, dica) {
  if (titulo === null) { $("carga").hidden = true; return; }
  $("carga").hidden = false;
  $("carga-titulo").textContent = titulo;
  $("carga-pct").textContent = pct == null ? "" : `${pct}%`;
  $("carga-barra").style.width = `${pct || 0}%`;
  if (dica) $("carga-dica").textContent = dica;
}

// "motor": o tipo de busca em uso, ao lado dos filtros; "estado": so avisos sobre a ultima busca
function atualizarEstado(aviso) {
  if (baseOk) $("motor").textContent = modeloOk ? "Busca inteligente ativa" : (modeloMsg || "Busca por palavras");
  $("estado").textContent = aviso || "";
}

// Fluxo guiado: tudo deriva do que foi adicionado e do que esta escrito nos campos agora.
// Editar o tema ou a pergunta depois de adicionar bloqueia os botoes ate adicionar de novo,
// para o prompt nunca sair com conteudo diferente do que esta na tela.
let temaAdd = null, perguntaAdd = null, consultaGeral = false;

function atualizarFluxo() {
  const temaOk = !!temaAdd && dobrar($("q").value.trim()) === dobrar(temaAdd);
  const escrita = $("pergunta").value.trim();
  const perguntaOk = temaOk && (consultaGeral ? !escrita : !!perguntaAdd && dobrar(escrita) === dobrar(perguntaAdd));
  const achou = !!(ultimo && ultimo.res.length);
  const pronto = perguntaOk && achou;
  const marcar = (id, estado) => {
    const c = $(id).classList;
    c.toggle("ativa", estado === "ativa"); c.toggle("feita", estado === "feita"); c.toggle("bloqueada", estado === "bloqueada");
  };
  marcar("etapa1", temaOk ? "feita" : "ativa");
  marcar("etapa2", !temaOk ? "bloqueada" : perguntaOk ? "feita" : "ativa");
  marcar("ia", pronto ? "ativa" : "bloqueada");
  $("pergunta").disabled = !temaOk;
  $("ir-p").disabled = !temaOk;
  $("ir-geral").disabled = !temaOk;
  ["ia-chatgpt", "ia-gemini", "ia-copiar", "ia-precedentes"].forEach((id) => { $(id).disabled = !pronto; });
  $("ia-precedentes").hidden = !(pronto && ultimo.res.slice(0, NA_TELA).some(ehPrecedente));
  $("passo2").hidden = !pronto;
  $("resultados").hidden = !pronto;
  $("exemplos").hidden = !!temaAdd;
  if (!pronto) { $("ia-aviso").hidden = true; $("ia-texto").hidden = true; }
  $("ia-resumo").innerHTML = pronto
    ? `Tudo pronto. Tema: <strong>“${escapar(temaAdd)}”</strong>. ` +
      (consultaGeral ? "<strong>Consulta geral</strong>, sem pergunta específica." : `Pergunta: <strong>“${escapar(perguntaAdd)}”</strong>.`)
    : !temaOk ? "Os botões serão liberados depois do tema e da pergunta ou consulta geral."
    : "Falta adicionar a pergunta ou escolher a consulta geral para liberar os botões.";
}

function adicionarTema(t) {
  if (!t) { $("q").focus(); return; }
  if (!temaAdd || dobrar(t) !== dobrar(temaAdd)) {   // tema novo, pergunta nova
    perguntaAdd = null; consultaGeral = false; $("pergunta").value = "";
  }
  temaAdd = t;
  buscar(t);
  atualizarFluxo();
  if (!perguntaAdd && !consultaGeral) $("pergunta").focus();
}

function adicionarPergunta() {
  const p = $("pergunta").value.trim();
  if (!p) { $("pergunta").focus(); return; }
  perguntaAdd = p; consultaGeral = false;
  atualizarFluxo();
  $("ia").scrollIntoView({ block: "nearest" });
}

function fazerConsultaGeral() {
  perguntaAdd = null; consultaGeral = true; $("pergunta").value = "";
  atualizarFluxo();
  $("ia").scrollIntoView({ block: "nearest" });
}

function cartao(r, termos) {
  const li = document.createElement("li");
  const n = r.norma, selo = seloDe(r);
  li.className = `res ${/revogada/.test(selo.classe) ? "revogada" : ""}`;
  li.innerHTML = `
    <div class="res-cab">
      <span class="res-norma">${escapar(n.nome)}</span>
      <span class="res-rotulo">${escapar(r.rotulo)}</span>
      <span class="selo ${selo.classe}">${escapar(selo.texto)}</span>
    </div>
    ${n.revogada_por ? `<p class="res-meta">Revogada pela ${escapar(n.revogada_por)}</p>` : ""}
    ${n.superada ? `<p class="res-meta">Sem efeito atual: esta norma apenas alterou uma norma já revogada.</p>` : ""}
    ${n.ementa ? `<p class="res-meta">${escapar(n.ementa.slice(0, 200))}${n.ementa.length > 200 ? "…" : ""}</p>` : ""}
    ${r.estrutura ? `<p class="res-meta">${escapar(r.estrutura)}</p>` : ""}
    <div class="res-texto recolhido">${destacar(r.texto, termos)}</div>
    <div class="res-pe">
      <button type="button" class="link ver-mais">Ver trecho inteiro</button>
      ${n.url ? `<a href="${escapar(n.url)}" target="_blank" rel="noopener">Texto oficial</a>` : ""}
    </div>`;
  const corpo = li.querySelector(".res-texto"), bt = li.querySelector(".ver-mais");
  bt.onclick = () => {
    const rec = corpo.classList.toggle("recolhido");
    bt.textContent = rec ? "Ver trecho inteiro" : "Recolher";
  };
  requestAnimationFrame(() => { if (corpo.scrollHeight <= corpo.clientHeight + 4) { corpo.classList.remove("recolhido"); bt.hidden = true; } });
  return li;
}

function escolherParaIA(res, limite, excluir = new Set()) {
  const cont = new Map(), out = [];
  for (const r of res) {
    const k = r.norma.arquivo;
    if (excluir.has(r.idx) || (cont.get(k) || 0) >= POR_NORMA_NA_IA) continue;
    cont.set(k, (cont.get(k) || 0) + 1);
    out.push(r);
    if (out.length >= limite) break;
  }
  return out;
}

const MAX_CITADOS_NA_IA = 8;
const TRECHOS_ASSUNTO_COM_PERGUNTA = 8;   // com pergunta: 8 do assunto + ate 8 da pergunta
const TRECHOS_PERGUNTA = 8;

function cabecalho(n, rotulo, sitTema) {
  const sit = sitTema || (n.superada ? "sem efeito, alterou norma revogada" : situacao(n));
  return `${n.nome} – ${rotulo} (${sit}${n.revogada_por ? " pela " + n.revogada_por : ""}${n.data ? ", " + n.data : ""})`;
}

// assunto: a busca mostrada na tela; pergunta: busca paralela (nao exibida) so para subsidiar o pedido
function montarPedido(assunto, resAssunto, pergunta, resPergunta, citados) {
  const temPergunta = pergunta && resPergunta;
  const blocoA = escolherParaIA(resAssunto, temPergunta ? TRECHOS_ASSUNTO_COM_PERGUNTA : TRECHOS_NA_IA);
  const blocoB = temPergunta ? escolherParaIA(resPergunta, TRECHOS_PERGUNTA, new Set(blocoA.map((r) => r.idx))) : [];
  const todos = [...blocoA, ...blocoB];
  const texto = (lista, ini) => lista.map((r, i) => `[${ini + i + 1}] ${cabecalho(r.norma, r.rotulo, r.situacaoTema)}\n${r.texto}`).join("\n\n");
  // artigos de outras normas citados nos trechos escolhidos ("art. 81 do Regimento Interno")
  const ordemCit = new Map(), enviados = new Set(todos.map((r) => r.idx));
  todos.forEach((r, i) => (r.cita || []).forEach((t) => {
    if (enviados.has(t) || !citados[t]) return;   // o artigo citado ja esta entre os trechos
    if (!ordemCit.has(t)) ordemCit.set(t, []);
    ordemCit.get(t).push(i + 1);
  }));
  const blocosCit = [...ordemCit.entries()].slice(0, MAX_CITADOS_NA_IA).map(([t, de], j) =>
    `[C${j + 1}] ${cabecalho(citados[t].norma, citados[t].rotulo)} – citado em [${de.join("], [")}]\n${citados[t].texto}`);
  const identificacao = pergunta ? `Tema: ${assunto} | Pergunta: ${pergunta}` : `Tema: ${assunto} | Consulta geral, sem pergunta específica`;
  const regras = [
    "- Use SOMENTE os trechos abaixo e cite a norma e o artigo de cada informação, no formato (Resolução nº X/AAAA, art. Y).",
    "- Regras gerais dos servidores ou dos magistrados (ex.: Estatuto dos Servidores, Constituição Estadual) se aplicam a todos os cargos da categoria, mesmo que o trecho não cite o cargo perguntado.",
    "- Se houver norma revogada ou redações diferentes do mesmo artigo, use a vigente e a mais recente e mencione a diferença.",
  ];
  const parteFora = pergunta ? "PARTE 3 – SOMENTE se a Parte 2 não responder por completo:"
                             : "PARTE 2 – SOMENTE se algum aspecto importante do tema não estiver coberto pelos trechos:";
  return [
    "Você é um assistente que tira dúvidas sobre as normas internas do Poder Judiciário do Estado do Piauí.",
    "Responda em português, em linguagem clara, para um servidor sem formação jurídica, nesta ordem.",
    `Logo abaixo do título de CADA parte da resposta, escreva a linha de identificação: "${identificacao}".`,
    "",
    `PARTE 1 – VISÃO GERAL DO TEMA "${assunto}" (com base nas normas do acervo)`,
    `- Faça uma explicação minuciosa do que as normas abaixo dispõem sobre o tema: quais normas tratam dele, para quem se aplicam, as regras, requisitos, prazos, procedimentos, exceções e como as normas se relacionam entre si.`,
    ...regras,
    "- Não resuma: desenvolva cada ponto relevante encontrado nos trechos.",
    "",
    ...(pergunta ? [
      `PARTE 2 – RESPOSTA À PERGUNTA "${pergunta}" (com base nas normas do acervo)`,
      "- Responda à pergunta de forma completa e direta.",
      ...regras,
      "- Se os trechos não bastarem, diga claramente o que ficou sem resposta.",
      "",
    ] : []),
    parteFora,
    "- Abra uma seção separada com o título exato: \"⚠️ ATENÇÃO – INFORMAÇÃO FORA DAS NORMAS DO ACERVO (CONFERIR)\".",
    "- Nela, complemente com seu conhecimento geral (ex.: Constituição Federal, leis federais), indicando a fonte provável de cada informação.",
    "- Termine a seção avisando que esse conteúdo não veio das normas consultadas e precisa ser conferido no texto oficial antes de ser usado.",
    "- Nunca misture esse conteúdo nas partes anteriores. Se elas já bastarem, não escreva esta seção.",
    "",
    `TEMA PESQUISADO: ${assunto}`,
    pergunta ? `PERGUNTA DO USUÁRIO: ${pergunta}` : "PERGUNTA DO USUÁRIO: nenhuma (consulta geral sobre o tema)",
    "",
    "TRECHOS SOBRE O TEMA:",
    texto(blocoA, 0),
    "",
    ...(blocoB.length ? ["TRECHOS ENCONTRADOS PARA A PERGUNTA:", texto(blocoB, blocoA.length), ""] : []),
    ...(blocosCit.length ? [
      "TRECHOS CITADOS (artigos de normas mencionados nos trechos acima; use-os para completar a resposta quando o trecho remeter a eles):",
      blocosCit.join("\n\n"),
      "",
    ] : []),
    "Lembrete: o texto oficial publicado prevalece.",
  ].join("\n");
}

// Prompt de precedentes: so aparece quando ha sumula ou precedente qualificado entre os trechos da tela.
const TIPOS_PRECEDENTE = new Set(["Sumulas", "Precedentes Qualificados"]);
const PRECEDENTES_NA_IA = 14;   // trechos no prompt, primeiro as sumulas e os precedentes

function ehPrecedente(r) { return TIPOS_PRECEDENTE.has(r.norma.tipo); }

function situacaoPrecedente(r) {
  const n = r.norma;
  if (n.tipo === "Precedentes Qualificados") return r.situacaoTema || "não informada no trecho";
  return n.superada ? "sem efeito, alterou norma revogada" : situacao(n) + (n.revogada_por ? " pela " + n.revogada_por : "");
}

function identificarPrecedente(r) {
  const n = r.norma;
  if (n.tipo === "Sumulas") return `Súmula do TJPI nº ${n.numero}/${n.ano}`;
  if (n.tipo === "Precedentes Qualificados") return `${r.rotulo} (${n.nome})`;
  return `${n.nome} – ${r.rotulo}`;
}

function montarPedidoPrecedentes(assunto, resAssunto, pergunta, resPergunta) {
  // trechos da pergunta primeiro; a mesma sumula pode estar duas vezes no portal, por isso o filtro pelo texto
  const vistos = new Set(), unicos = [...(resPergunta || []), ...resAssunto].filter((r) => {
    if (vistos.has(r.idx) || vistos.has(r.texto)) return false;
    vistos.add(r.idx); vistos.add(r.texto);
    return true;
  });
  const lista = [...unicos.filter(ehPrecedente), ...unicos.filter((r) => !ehPrecedente(r))].slice(0, PRECEDENTES_NA_IA);
  const trechos = lista.map((r, i) =>
    `[${i + 1}] ${identificarPrecedente(r)} | Situação: ${situacaoPrecedente(r)} | Link oficial: ${r.norma.url || "não informado"}\n${r.texto}`).join("\n\n");
  return [
    "Você é um assistente jurídico especializado em precedentes qualificados (TJPI, STJ e STF), consultados a partir da base normativa do Tribunal de Justiça do Estado do Piauí (TJPI).",
    `TEMA: ${assunto}`,
    `PERGUNTA: ${pergunta || "consulta geral sobre o tema"}`,
    "Abaixo estão trechos de súmulas e de informações sobre precedentes qualificados do TJPI, do STJ e do STF (e, se houver, de outras normas internas) constantes da base do TJPI, localizados por busca semântica no Oráculo Normativo. Responda EXCLUSIVAMENTE com base nesses trechos.",
    "TRECHOS ENCONTRADOS:",
    trechos,
    "INSTRUÇÕES:",
    "1. Identifique quais trechos tratam de fato da pergunta. Ignore os que não tratam e diga quais foram ignorados.",
    "2. Para CADA precedente ou súmula pertinente, apresente a ficha abaixo, nesta ordem e com estes títulos:",
    " - Tribunal: TJPI, STJ ou STF.",
    " - Identificação: espécie (por exemplo, súmula, súmula vinculante, tema de repercussão geral, tema de recurso repetitivo, IRDR, IAC ou outra indicada no trecho), número do tema ou da súmula, processo paradigma, órgão julgador e data, se constarem.",
    " - Questão jurídica: a controvérsia resolvida, em uma ou duas frases.",
    " - Tese firmada: transcrição LITERAL, entre aspas, sem paráfrase.",
    " - Situação: vigente, revisada, superada, cancelada ou pendente de julgamento (com ou sem suspensão de processos), conforme o trecho. Se o trecho não informar, escreva \"não informada no trecho; conferir no texto oficial\".",
    " - Alcance e efeitos: a quem e a quais processos se aplica e o caráter vinculante, apenas se constar do trecho.",
    " - Dispositivos legais relacionados: os citados no trecho.",
    " - Fonte: referência [n] e link oficial.",
    "3. Se houver precedentes de mais de um tribunal, apresente as fichas na ordem STF, STJ, TJPI.",
    "4. Depois das fichas, escreva \"Aplicação à pergunta\": explique em linguagem clara como a(s) tese(s) responde(m) à pergunta e aponte elementos que poderiam afastar a aplicação (distinção), se o próprio trecho os indicar.",
    "5. Se nenhum trecho contiver precedente ou súmula pertinente, diga isso claramente. Não invente número, data, tese ou órgão julgador.",
    "6. Se julgar útil trazer informação que não está nos trechos (por exemplo, precedentes ou julgados que não aparecem nos trechos), faça isso SOMENTE em seção separada, intitulada \"Informações complementares (fora da base do TJPI)\", com a advertência: \"Estas informações não constam dos trechos fornecidos e devem ser conferidas em fonte oficial.\"",
    "7. Encerre com: \"O texto oficial do precedente, disponível no link indicado, prevalece sobre este resumo.\"",
  ].join("\n");
}

// busca da pergunta: mesma busca do worker, mas o resultado nao vai para a tela
let idOculto = 1e6;
const pendentes = new Map();
function buscarOculto(consulta) {
  return new Promise((ok) => {
    const id = ++idOculto;
    pendentes.set(id, ok);
    worker.postMessage({ tipo: "buscar", id, consulta, soVigentes: $("vigentes").checked, tipoNorma: $("tipo").value });
  });
}

async function copiar(texto) {
  try { await navigator.clipboard.writeText(texto); return true; }
  catch {
    const ta = document.createElement("textarea");
    ta.value = texto; document.body.appendChild(ta); ta.select();
    const ok = document.execCommand("copy"); ta.remove(); return ok;
  }
}

async function perguntarIA(destino, precedentes = false) {
  if (!ultimo) return;
  // a busca da pergunta leva menos de 1 s: a copia e a nova aba ainda contam como acao do clique
  // (abrir a aba antes tiraria o foco da pagina e o navegador recusaria a copia)
  const pergunta = perguntaAdd;
  let resP = null, citados = { ...(ultimo.citados || {}) };
  if (pergunta && dobrar(pergunta) !== dobrar(ultimo.consulta)) {
    const m = await buscarOculto(pergunta);
    resP = m.res;
    Object.assign(citados, m.citados);
  }
  const pedido = precedentes ? montarPedidoPrecedentes(ultimo.consulta, ultimo.res, pergunta, resP)
                             : montarPedido(ultimo.consulta, ultimo.res, pergunta, resP, citados);
  const ok = await copiar(pedido);
  const msg = ok ? (destino ? "✓ Prompt copiado. Na aba que abriu, cole na conversa (Ctrl+V, ou toque longo › Colar) e envie."
                            : `✓ Prompt${precedentes ? " de precedentes" : ""} copiado. Cole no assistente de IA que preferir e envie.`)
                 : "O navegador não deixou copiar sozinho. O prompt está na caixa abaixo, já selecionado: copie (Ctrl+C, ou toque longo › Copiar) e cole na IA.";
  $("ia-aviso").textContent = msg;
  $("ia-aviso").hidden = false;
  const caixa = $("ia-texto");
  caixa.hidden = ok;
  if (!ok) { caixa.value = pedido; caixa.focus(); caixa.select(); }
  if (destino) window.open(destino, "_blank", "noopener");
}

worker.onerror = (e) => {
  console.error("[busca] erro no worker:", e.message || e);
  $("estado").textContent = "Erro ao carregar a busca. Recarregue a página.";
};

worker.onmessage = (e) => {
  const m = e.data;
  if (m.tipo === "pronto") {
    baseOk = true;
    $("q").disabled = false; $("ir").disabled = false; $("q").focus();
    if (semModelo) painel(null);
    else painel("Aguarde: preparando a busca inteligente…", 0,
                "Só na primeira visita (cerca de 120 MB). Enquanto isso, a busca por palavras já funciona; os resultados se atualizam sozinhos ao terminar.");
    document.querySelectorAll("#exemplos button").forEach((b) => { b.disabled = false; });
    atualizarEstado();
  } else if (m.tipo === "modelo") {
    if (m.estado === "baixando") painel("Aguarde: preparando a busca inteligente…", m.pct);
    else if (m.estado === "pronto") { modeloOk = true; modeloMsg = ""; painel(null); }
    else { modeloMsg = "Busca inteligente indisponível neste aparelho; seguimos por palavras."; painel(null); }
    if (m.estado !== "baixando") atualizarEstado();
    if (m.estado === "pronto" && ultimo) buscar(ultimo.consulta);   // refaz a ultima busca com o modelo
  } else if (m.tipo === "resultado" && pendentes.has(m.id)) {
    pendentes.get(m.id)(m);
    pendentes.delete(m.id);
  } else if (m.tipo === "resultado" && m.id === contador) {
    const lista = $("resultados");
    lista.innerHTML = "";
    ultimo.res = m.res;
    ultimo.citados = m.citados;
    m.res.slice(0, NA_TELA).forEach((r) => lista.appendChild(cartao(r, m.termos)));
    $("contagem").textContent = m.res.length ? `${Math.min(m.res.length, NA_TELA)} mais relevantes` : "";
    atualizarEstado(m.res.length ? "" : "Nada encontrado para este tema. Tente outras palavras ou desmarque “Só normas vigentes”.");
    atualizarFluxo();
  }
};

function buscar(consulta) {
  if (!consulta) return;
  contador++;
  ultimo = { consulta, res: [] };   // sem resultados ate a resposta chegar: botoes nao usam a busca anterior
  worker.postMessage({ tipo: "buscar", id: contador, consulta, soVigentes: $("vigentes").checked, tipoNorma: $("tipo").value });
}

$("form").onsubmit = (e) => { e.preventDefault(); adicionarTema($("q").value.trim()); };
$("form-p").onsubmit = (e) => { e.preventDefault(); adicionarPergunta(); };
$("ir-geral").onclick = fazerConsultaGeral;
$("q").oninput = atualizarFluxo;
$("pergunta").oninput = atualizarFluxo;
$("pergunta").onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); adicionarPergunta(); } };
$("vigentes").onchange = $("tipo").onchange = () => { if (temaAdd) buscar(temaAdd); atualizarFluxo(); };
$("ia-chatgpt").onclick = () => perguntarIA("https://chatgpt.com/");
$("ia-gemini").onclick = () => perguntarIA("https://gemini.google.com/app");
$("ia-copiar").onclick = () => perguntarIA(null);
$("ia-precedentes").onclick = () => perguntarIA(null, true);
document.querySelectorAll("#exemplos button").forEach((b) => {
  b.onclick = () => { $("q").value = b.textContent; adicionarTema(b.textContent); };
});

// Download da base: partes pequenas, uma por vez, com tempo limite e nova tentativa,
// para que uma queda no 4G so obrigue a repetir a parte que caiu.
async function baixar(url, tentativas = 4) {
  for (let k = 1; ; k++) {
    const ctl = new AbortController();
    const relogio = setTimeout(() => ctl.abort(), 45000);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      return await r.arrayBuffer();
    } catch (e) {
      if (k >= tentativas) throw e;
      await new Promise((ok) => setTimeout(ok, 1500 * k));
    } finally {
      clearTimeout(relogio);
    }
  }
}

async function carregarBase(semModelo) {
  try {
    const info = JSON.parse(new TextDecoder().decode(await baixar("dados/indice_info.json?" + Date.now())));
    const v = "?v=" + info.versao;   // muda a cada nova base, para o cache do navegador nao servir a antiga
    try {   // sem o dicionario a busca funciona igual, so sem as equivalencias
      const sin = JSON.parse(new TextDecoder().decode(await baixar("dados/sinonimos.json?" + Date.now(), 2)));
      worker.postMessage({ tipo: "sinonimos", grupos: sin.grupos });
    } catch (e) { console.warn("[busca] sem dicionario de equivalencias", e); }
    const normasBuf = await baixar("dados/normas.json" + v);
    worker.postMessage({ tipo: "parte", normasBuf, total: info.trechos }, [normasBuf]);
    let feitos = 0;
    for (let p = 0; p < info.partes.length; p++) {
      const trechosBuf = await baixar(`dados/trechos_${p}.json${v}`);
      const vetoresBuf = await baixar(`dados/vetores_${p}.i8${v}`);
      worker.postMessage({ tipo: "parte", trechosBuf, vetoresBuf, n: info.partes[p] }, [trechosBuf, vetoresBuf]);
      feitos += info.partes[p];
      painel("Aguarde: carregando a base de normas…", Math.round(100 * feitos / info.trechos));
    }
    painel("Aguarde: montando o índice de busca…", 100);
    worker.postMessage({ tipo: "fim", semModelo });
  } catch (e) {
    console.error("[busca]", e);
    painel(null);
    $("estado").textContent = "Não foi possível baixar a base de normas. Verifique a conexão e recarregue a página.";
  }
}

const semModelo = new URLSearchParams(location.search).has("leve") ||
  (navigator.connection && (navigator.connection.saveData || /2g/.test(navigator.connection.effectiveType || "")));
if (semModelo) modeloMsg = "Modo leve: só busca por palavras.";
carregarBase(semModelo);
