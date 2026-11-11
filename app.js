// Interface do Oraculo: conversa com o worker de busca e monta os cartoes e o pedido para a IA.

const $ = (id) => document.getElementById(id);
const VERSAO = "5671481fbce2";   // preenchida por publicar_site.ps1 na copia publicada; vazia no teste local
const worker = new Worker("busca.worker.js" + (VERSAO ? `?v=${VERSAO}` : ""), { type: "module" });

// Depois de uma publicacao, quem esta com a pagina antiga no cache recarrega uma vez, na versao nova.
function conferirVersao(atual = VERSAO) {
  if (!atual) return;
  fetch("versao.json?" + Date.now()).then((r) => r.json()).then(({ v }) => {
    const url = new URL(location.href);
    if (v === atual || url.searchParams.get("v") === v) return;
    url.searchParams.set("v", v);
    location.replace(url);
  }).catch(() => {});
}
conferirVersao();
const NA_TELA = 10;          // cartoes mostrados (ate 3 por norma)
const TRECHOS_NA_IA = 14;    // consulta geral: mais trechos, para a explicacao minuciosa (ate 2 por norma)
const POR_NORMA_NA_IA = 2;
const POR_TRIBUNAL_NA_IA = 4;   // temas do STF e do STJ: um documento por tribunal
const TOTAL_DA_BUSCA = 100;     // trechos pedidos ao worker: o "Estender busca" percorre todos eles
const TRECHOS_POR_LOTE = 14;    // "Estender busca": trechos ainda nao enviados em cada novo prompt
let envio = null;               // ultimo prompt copiado: { precedentes, lote, enviados (Set de idx) }
let ultimoTermos = [];
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
    if (f.length >= 6 && /^[a-z]+$/.test(f)) f = (f.endsWith("mente") ? f.slice(0, -5) : f).slice(0, 7).replace(/[aeio]+$/, "") || f;   // raiz, como no worker
    return alvo.has(f) ? `<mark>${w}</mark>` : w;
  });
}

function situacao(n) { return n.cancelada ? "cancelada" : n.situacao === "revogada" ? "revogada" : (n.superada || n.sem_efeito) ? "sem efeito" : "vigente"; }

// selo do cartao: nos precedentes vale a situacao do tema, nao a do arquivo do NUGEP que reune centenas de temas
function seloDe(r) {
  const sit = situacao(r.norma);
  if (r.norma.tipo !== "Precedentes Qualificados") return { texto: sit, classe: sit === "vigente" ? "vigente" : "revogada" };
  const t = r.situacaoTema;
  if (!t) return { texto: "situação: ver o texto", classe: "tema" };
  if (/^(cancelad|prejudicad)/i.test(t)) return { texto: t, classe: "revogada tema" };
  const semDefinicao = /afetad|sobrest|em julgamento|pendente|preliminar|relev|admitid|sem processo|suspens|finalizada|vinculada|repercuss[ãa]o geral publicado/i;
  return { texto: t, classe: semDefinicao.test(t) ? "tema" : "vigente tema" };
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
  const tema = $("q").value.trim();
  const temaOk = !!temaAdd && dobrar(tema) === dobrar(temaAdd);
  const escrita = $("pergunta").value.trim();
  const perguntaOk = temaOk && (consultaGeral ? !escrita : !!perguntaAdd && dobrar(escrita) === dobrar(perguntaAdd));
  const achou = !!(ultimo && ultimo.res.length);
  // depois da primeira busca os botoes ficam liberados: ao clicar, o prompt sai do que esta escrito agora (sincronizarCampos)
  const mudou = !!temaAdd && !perguntaOk && !!tema && (!!escrita || consultaGeral || !!perguntaAdd);
  const pronto = (perguntaOk || mudou) && achou;
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
  ["ia-chatgpt", "ia-gemini", "ia-copiar", "ia-precedentes", "estender"].forEach((id) => { $(id).disabled = !pronto; });
  $("ia-precedentes").hidden = !(pronto && ultimo.res.slice(0, NA_TELA).some(ehPrecedente));
  $("estender").hidden = !(pronto && envio);
  $("passo2").hidden = !pronto;
  $("resultados").hidden = !pronto;
  $("falha-area").hidden = !pronto || !FORMULARIO.url;
  $("exemplos").hidden = !!temaAdd;
  if (!pronto) { $("ia-aviso").hidden = true; $("ia-texto").hidden = true; }
  $("ia-resumo").innerHTML = pronto && mudou
    ? "Os campos mudaram: ao clicar em um botão, a busca é refeita com o que está escrito agora."
    : pronto
    ? `Tudo pronto. Tema: <strong>“${escapar(temaAdd)}”</strong>. ` +
      (consultaGeral ? "<strong>Consulta geral</strong>, sem pergunta específica." : `Pergunta: <strong>“${escapar(perguntaAdd)}”</strong>.`)
    : !temaOk ? "Os botões serão liberados depois do tema e da pergunta ou consulta geral."
    : "Falta adicionar a pergunta ou escolher a consulta geral para liberar os botões.";
}

// estatistica de uso: so o nome do evento, nunca o texto da busca; bloqueador de anuncios nao quebra nada
function contarEvento(nome) {
  if (window.goatcounter && window.goatcounter.count) window.goatcounter.count({ path: nome, title: nome, event: true });
}

function adicionarTema(t) {
  if (!t) { $("q").focus(); return; }
  contarEvento($("tipo").value === "precedentes-sumulas" ? "busca-somente-precedentes" : "busca-normas");
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

function fonteTema(n) { return `${n.fonte}, coletado em ${n.coletado}`; }

// tema com suspensao vigente: aviso destacado; acordao publicado ou suspensao encerrada: so uma linha discreta
function avisoSuspensao(r) {
  if (r.estadoSuspensao === "vigente")
    return `<p class="aviso-suspensao"><strong>${/^Há suspensão nacional/.test(r.suspensao) ? "Há suspensão nacional" : "Há determinação de suspensão"}</strong>${escapar(r.suspensao.replace(/^Há [^.]*\./, ""))}</p>`;
  if (r.estadoSuspensao === "conferir" || r.estadoSuspensao === "encerrada")
    return `<p class="res-meta">Suspensão nacional: ${escapar(r.suspensao)}</p>`;
  return "";
}

function cartao(r, termos) {
  const li = document.createElement("li");
  li.dataset.idx = r.idx;
  const n = r.norma, selo = seloDe(r);
  li.className = `res ${/revogada/.test(selo.classe) ? "revogada" : ""}`;
  li.innerHTML = `
    <div class="res-cab">
      <span class="res-norma">${escapar(n.nome)}</span>
      <span class="res-rotulo">${escapar(r.rotulo)}</span>
      <span class="selo ${selo.classe}">${escapar(selo.texto)}</span>
    </div>
    ${avisoSuspensao(r)}
    ${n.revogada_por ? `<p class="res-meta">Revogada pela ${escapar(n.revogada_por)}</p>` : ""}
    ${n.superada ? `<p class="res-meta">Sem efeito atual: esta norma apenas alterou uma norma já revogada.</p>` : ""}
    ${n.ementa ? `<p class="res-meta">${escapar(n.ementa.slice(0, 200))}${n.ementa.length > 200 ? "…" : ""}</p>` : ""}
    ${r.linkTema ? `<p class="res-meta">Fonte: ${escapar(fonteTema(n))}</p>` : ""}
    ${r.estrutura ? `<p class="res-meta">${escapar(r.estrutura)}</p>` : ""}
    <div class="res-texto recolhido">${destacar(r.texto, termos)}</div>
    <div class="res-pe">
      <button type="button" class="link ver-mais">Ver trecho inteiro</button>
      ${r.linkTema || n.url ? `<a href="${escapar(r.linkTema || n.url)}" target="_blank" rel="noopener">Texto oficial</a>` : ""}
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
    if (excluir.has(r.idx) || (cont.get(k) || 0) >= (r.linkTema ? POR_TRIBUNAL_NA_IA : POR_NORMA_NA_IA)) continue;
    cont.set(k, (cont.get(k) || 0) + 1);
    out.push(r);
    if (out.length >= limite) break;
  }
  return out;
}

const MAX_CITADOS_NA_IA = 8;
// sem trecho sobre um ponto nao se pode concluir que a norma nao trata dele: a busca so traz parte do acervo
const REGRA_AUSENCIA = "Se os trechos não tratarem de algum ponto, escreva \"os trechos encontrados não tratam disso\" e recomende nova busca ou consulta ao texto oficial. Nunca afirme que a norma não prevê, não autoriza ou proíbe algo com base na ausência de trechos.";
// linha final da resposta da IA: identifica a origem da consulta
const LINHA_ORIGEM = "Consulta elaborada a partir de prompt gerado pelo Oráculo Normativo TJPI (https://carlos-mendes-maestria.github.io/oraculo-normativo/). O texto oficial das normas e dos precedentes prevalece.";
const REGRA_ORIGEM = `Termine a resposta, depois de todas as partes, com esta linha, copiada sem alterações: "${LINHA_ORIGEM}"`;
let equivalentes = "";   // termos das normas para a linguagem da pergunta (dicionario de equivalencias)
const TRECHOS_ASSUNTO_COM_PERGUNTA = 7;   // com pergunta: 7 do assunto + ate 7 da pergunta
const TRECHOS_PERGUNTA = 7;
// pergunta concreta (valor, prazo, quantos dias): a resposta costuma estar num artigo so, entao a pergunta leva mais vagas
const RX_CONCRETA = /\b(valor|valores|quanto|quanta|quantos|quantas|prazo|percentual|idade|horas?|n[úu]mero|dias)\b/i;
const TRECHOS_ASSUNTO_CONCRETA = 4, TRECHOS_PERGUNTA_CONCRETA = 10;
const MAX_CONTINUACOES = 4;   // trechos seguintes anexados (terminam em titulo ou cortados); nao contam no limite de 14
// Vizinhanca (autoteste de 07/11/2026): norma curta (ate 15 trechos) com 2+ trechos no prompt leva os artigos seguintes
// no lugar dos ultimos trechos de outras normas; o total continua 14.
const MAX_VIZINHOS_NA_IA = 3, MAX_NORMAS_VIZINHANCA = 2, MAX_VIZINHOS_POR_NORMA = 2;
// O Gemini corta mensagens perto de 32.700 caracteres (P10 do autoteste de 07/11/2026): acima do limite, os trechos
// mais longos (anexos, quadros) sao encurtados e, se ainda faltar espaco, os trechos citados saem.
const MAX_CARACTERES_PROMPT = 30000;
const CORTES_TRECHO = [Infinity, 4000, 3000, 2000, 1500, 1000];

function aplicarVizinhanca(blocoA, blocoB) {
  const todos = [...blocoA, ...blocoB];
  const noPedido = new Set(todos.map((r) => r.idx));
  const novos = (k) => todos.filter((x) => x.norma.arquivo === k).sort((a, b) => a.idx - b.idx)
    .flatMap((r) => (r.vizinhos || []).map((v) => ({ ...v, norma: r.norma })));
  // candidatas: normas curtas que ja tem 2+ trechos no prompt (uma norma com 1 trecho so pode ser ruido da busca:
  // no teste, completar o Prov. Conj. 92/2023 tirou do prompt o Prov. 161/2024, que respondia a pergunta)
  const cont = new Map();
  todos.forEach((r) => cont.set(r.norma.arquivo, (cont.get(r.norma.arquivo) || 0) + 1));
  // entre elas, a mais recente primeiro (o prompt manda usar a vigente e a mais recente): no reajuste de 2026, a Lei 8.938/2026
  // vem antes da Res. 520/2026, que so aprovou o projeto, e da Res. 95/2018, projeto do reajuste de 2018
  const dataDe = new Map(todos.map((r) => [r.norma.arquivo, (r.norma.data || "").split("/").reverse().join("")]));
  const candidatas = [...cont].filter(([, c]) => c >= 2).map(([k]) => k)
    .sort((a, b) => dataDe.get(b).localeCompare(dataDe.get(a)));
  const dominantes = [], extras = [];
  for (const k of candidatas) {
    if (dominantes.includes(k) || dominantes.length >= MAX_NORMAS_VIZINHANCA || extras.length >= MAX_VIZINHOS_NA_IA) continue;
    let deste = 0;
    for (const v of novos(k)) {
      if (deste >= MAX_VIZINHOS_POR_NORMA || extras.length >= MAX_VIZINHOS_NA_IA || noPedido.has(v.idx)) continue;
      noPedido.add(v.idx); deste++;
      extras.push({ idx: v.idx, norma: v.norma, rotulo: v.rotulo, texto: v.texto, vizinho: true });
    }
    if (deste) dominantes.push(k);   // norma sem artigo novo a acrescentar nao ocupa a vaga de dominante
  }
  if (!extras.length) return;
  // sai o fim da lista (primeiro do bloco da pergunta), nunca trecho de norma dominante nem o 1º de cada bloco
  let n = extras.length;
  for (const bloco of [blocoB, blocoA])
    for (let i = bloco.length - 1; i >= 1 && n > 0; i--)
      if (!dominantes.includes(bloco[i].norma.arquivo)) { bloco.splice(i, 1); n--; }
  extras.splice(extras.length - n, n);   // sem espaco para trocar: os vizinhos que sobraram ficam de fora
  (blocoB.length ? blocoB : blocoA).push(...extras);
}

function cabecalho(n, rotulo, sitTema) {
  const sit = sitTema || (n.superada ? "sem efeito, alterou norma revogada" : n.sem_efeito ? "sem efeito: " + n.sem_efeito : situacao(n));
  return `${n.nome} – ${rotulo} (${sit}${n.revogada_por ? " pela " + n.revogada_por : ""}${n.data ? ", " + n.data : ""})`;
}

// assunto: a busca mostrada na tela; pergunta: busca paralela (nao exibida) so para subsidiar o pedido
// lote: { numero, excluir, primeiro } nos prompts do "Estender busca"; devolve { texto, usados }
function avisoContinuacao(lote) {
  return [
    `CONTINUAÇÃO – LOTE ${lote.numero} DE TRECHOS DA MESMA BUSCA. Os trechos abaixo não foram enviados antes e continuam a numeração a partir de [${lote.primeiro}].`,
    "São menos semelhantes à pergunta que os dos lotes anteriores: confira a pertinência de cada um, ignore os que não tratam do assunto e diga quais foram ignorados.",
    "Não refaça o que já foi respondido: traga apenas o que estes trechos acrescentam ou alteram.",
    "",
  ];
}

const NORMA_PEDIDA_NA_IA = 30;   // trechos da norma pedida pelo numero (o limite de caracteres encurta os longos)
function montarPedido(assunto, resAssunto, pergunta, resPergunta, citados, lote, tabela, pedida) {
  const temPergunta = pergunta && resPergunta;
  const concreta = temPergunta && RX_CONCRETA.test(pergunta);
  const excluir = lote ? lote.excluir : new Set();
  const inicio = lote ? lote.primeiro - 1 : 0;
  // consulta geral sobre uma norma citada pelo numero: o prompt leva os trechos dela, na ordem dos artigos
  // (caso real do "Não achei" de 10/11/2026; a Res. 571/2026 ia com 3 trechos e 7 de outras normas)
  const geralDaNorma = !temPergunta && !lote && pedida && pedida.length;
  const blocoA = geralDaNorma ? pedida.slice(0, NORMA_PEDIDA_NA_IA).sort((a, b) => a.idx - b.idx)
                : lote ? escolherParaIA(resAssunto, temPergunta ? TRECHOS_POR_LOTE / 2 : TRECHOS_POR_LOTE, excluir)
                      : escolherParaIA(resAssunto, !temPergunta ? TRECHOS_NA_IA : concreta ? TRECHOS_ASSUNTO_CONCRETA : TRECHOS_ASSUNTO_COM_PERGUNTA);
  const blocoB = temPergunta ? escolherParaIA(resPergunta, lote ? TRECHOS_POR_LOTE - blocoA.length : concreta ? TRECHOS_PERGUNTA_CONCRETA : TRECHOS_PERGUNTA,
                                              new Set([...excluir, ...blocoA.map((r) => r.idx)])) : [];
  if (!lote) aplicarVizinhanca(blocoA, blocoB);
  const todos = [...blocoA, ...blocoB];
  if (!todos.length) return { texto: "", usados: [] };
  const fonte = (r) => r.linkTema ? `Fonte: ${fonteTema(r.norma)}. Link oficial: ${r.linkTema}\nSuspensão nacional: ${r.suspensao}\n` : "";
  const noPedido = new Set(todos.map((r) => r.idx));
  let continuacoes = 0, corte = Infinity;
  const encurtar = (t) => t.length <= corte ? t
    : t.slice(0, corte).replace(/\s+\S*$/, "") + " […] (trecho encurtado para caber no limite do prompt; a íntegra está no texto oficial da norma)";
  const continuacao = (r) => {
    if (!r.seguinte || continuacoes >= MAX_CONTINUACOES || noPedido.has(r.idx + 1)) return "";
    continuacoes++;
    return `\n(continuação: trecho seguinte da mesma norma, ${r.seguinte.rotulo})\n${encurtar(r.seguinte.texto)}`;
  };
  const vizinho = (r) => r.vizinho ? " – artigo seguinte da mesma norma" : "";
  const texto = (lista, ini) => lista.map((r, i) => `[${ini + i + 1}] ${cabecalho(r.norma, r.rotulo, r.situacaoTema)}${vizinho(r)}\n${fonte(r)}${encurtar(r.texto)}${continuacao(r)}`).join("\n\n");
  const blocoTabela = tabela && !lote ? [
    "TABELA DE RETRIBUIÇÃO DOS CARGOS EM COMISSÃO E FUNÇÕES DE CONFIANÇA (anexada porque a pergunta trata do valor de cargo ou função):",
    "Primeiro localize o símbolo do cargo ou da função (CC/0x ou FC/0x) nos quadros de cargos; depois, o valor desse símbolo no Quadro II do Anexo VII da LC nº 230/2017.",
    `Atenção: os valores abaixo são os da redação dada pela ${tabela.valores.norma.nome}${tabela.valores.norma.arquivo === "Lei_Complementar_284_2023" ? " (atualizados até maio de 2023)" : ""} e podem ter tido reajuste posterior. Diga isso na resposta e recomende conferir a tabela vigente no Portal da Transparência do TJPI.`,
    `[T1] ${cabecalho(tabela.valores.norma, tabela.valores.rotulo)}\n${tabela.valores.texto}`,
    ...tabela.simbolos.map((r, j) => `[T${j + 2}] ${cabecalho(r.norma, r.rotulo)} – quadro de cargos e símbolos\n${r.texto}`),
    "",
  ] : [];
  // artigos de outras normas citados nos trechos escolhidos ("art. 81 do Regimento Interno")
  const ordemCit = new Map(), enviados = new Set(todos.map((r) => r.idx));
  todos.forEach((r, i) => (r.cita || []).forEach((t) => {
    if (enviados.has(t) || !citados[t]) return;   // o artigo citado ja esta entre os trechos
    if (!ordemCit.has(t)) ordemCit.set(t, []);
    ordemCit.get(t).push(i + 1);
  }));
  const montarCitados = (max) => [...ordemCit.entries()].slice(0, max).map(([t, de], j) =>
    `[C${j + 1}] ${cabecalho(citados[t].norma, citados[t].rotulo)} – citado em [${de.join("], [")}]\n${encurtar(citados[t].texto)}`);
  const identificacao = pergunta ? `Tema: ${assunto} | Pergunta: ${pergunta}` : `Tema: ${assunto} | Consulta geral, sem pergunta específica`;
  const regras = [
    "- Use SOMENTE os trechos abaixo e cite a norma e o artigo de cada informação, com o nome exato da norma como aparece no trecho, no formato (Resolução nº X/AAAA, art. Y) ou (Nota Técnica CIJEPI nº X/AAAA, trecho Y).",
    "- Regras gerais dos servidores ou dos magistrados (ex.: Estatuto dos Servidores, Constituição Estadual) se aplicam a todos os cargos da categoria, mesmo que o trecho não cite o cargo perguntado.",
    "- Se houver norma revogada ou redações diferentes do mesmo artigo, use a vigente e a mais recente e mencione a diferença.",
    `- ${REGRA_AUSENCIA}`,
  ];
  const parteFora = pergunta ? "PARTE 3 – SOMENTE se a Parte 2 não responder por completo:"
                             : "PARTE 2 – SOMENTE se algum aspecto importante do tema não estiver coberto pelos trechos:";
  const gerar = (maxCit) => {
  continuacoes = 0;
  const blocosCit = montarCitados(maxCit);
  return [
    ...(lote ? avisoContinuacao(lote) : []),
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
      "- Responda à pergunta de forma completa e direta. Antes de concluir, leia todos os trechos, começando pelos \"TRECHOS ENCONTRADOS PARA A PERGUNTA\".",
      ...(equivalentes ? [`- A pergunta pode usar linguagem do dia a dia. Nas normas, o assunto pode aparecer com estes termos: ${equivalentes}.`] : []),
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
    `${pergunta ? "PARTE 4" : "PARTE 3"} – NOVA BUSCA SUGERIDA (somente se as partes anteriores não responderam por completo).`,
    "- O Oráculo encontra trechos por semelhança de sentido e de palavras, usando os termos das normas. Funciona melhor com termos técnicos usados nas normas (ex.: teletrabalho em vez de home office, retribuição em vez de gratificação), com tema curto (2 a 4 palavras) e pergunta objetiva.",
    "- Use os trechos recebidos como pista: aproveite os termos que as normas usam e as normas ou anexos que elas citam ou alteram, e indique, quando houver, qual norma citada nos trechos parece conter a resposta.",
    "- Se algum trecho terminar cortado ou terminar num título (Seção, Subseção, Capítulo) que anuncia o assunto da pergunta, avise que a continuação não foi enviada e sugira busca com as palavras desse título e o número da norma.",
    "- Sugira até 3 novas tentativas no formato Tema: ... | Pergunta: ..., com uma linha explicando por que cada uma pode encontrar a norma. Não invente número de norma ou artigo.",
    "",
    `ENCERRAMENTO – ${REGRA_ORIGEM}`,
    "",
    `TEMA PESQUISADO: ${assunto}`,
    pergunta ? `PERGUNTA DO USUÁRIO: ${pergunta}` : "PERGUNTA DO USUÁRIO: nenhuma (consulta geral sobre o tema)",
    "",
    "TRECHOS SOBRE O TEMA:",
    texto(blocoA, inicio),
    "",
    ...(blocoB.length ? ["TRECHOS ENCONTRADOS PARA A PERGUNTA:", texto(blocoB, inicio + blocoA.length), ""] : []),
    ...blocoTabela,
    ...(blocosCit.length ? [
      "TRECHOS CITADOS (artigos de normas mencionados nos trechos acima; use-os para completar a resposta quando o trecho remeter a eles):",
      blocosCit.join("\n\n"),
      "",
    ] : []),
    "Lembrete: o texto oficial publicado prevalece.",
  ].join("\n");
  };
  let texto_ = "";
  for (const c of CORTES_TRECHO) {
    corte = c;
    texto_ = gerar(MAX_CITADOS_NA_IA);
    if (texto_.length <= MAX_CARACTERES_PROMPT) break;
  }
  for (let m = MAX_CITADOS_NA_IA - 1; texto_.length > MAX_CARACTERES_PROMPT && m >= 0; m--) texto_ = gerar(m);
  return { texto: texto_, usados: todos };
}

// Prompt de precedentes: so aparece quando ha sumula ou precedente qualificado entre os trechos da tela.
const TIPOS_PRECEDENTE = new Set(["Sumulas", "Precedentes Qualificados", "Nota Técnica CIJEPI", "Guia NUGEP"]);
const PRECEDENTES_NA_IA = 14;   // trechos no prompt, primeiro as sumulas e os precedentes
const MIN_PERTINENTES = 3;
const TRECHOS_POR_NOTA = 2;
const VAGAS_SUMULA = 2;      // sumulas pertinentes abrem o prompt, antes dos temas e das notas

function ehPrecedente(r) { return TIPOS_PRECEDENTE.has(r.norma.tipo); }

function situacaoPrecedente(r) {
  const n = r.norma;
  if (n.tipo === "Precedentes Qualificados") return r.situacaoTema || "não informada no trecho";
  return n.superada ? "sem efeito, alterou norma revogada" : n.sem_efeito ? "sem efeito: " + n.sem_efeito : situacao(n) + (n.revogada_por ? " pela " + n.revogada_por : "");
}

function identificarPrecedente(r) {
  const n = r.norma;
  if (n.tipo === "Sumulas") return `Súmula do TJPI nº ${n.numero}/${n.ano}`;
  if (n.tipo === "Precedentes Qualificados") return `${r.rotulo} (${n.nome})`;
  return `${n.nome} – ${r.rotulo}`;
}

// tira do prompt o claramente sem relacao com a consulta; se sobrar muito pouco, nao corta nada
function pertinentes(res) {
  const ok = res.filter((r) => r.pertinente !== false);
  return ok.length >= MIN_PERTINENTES ? ok : res;
}

function rebaixar(res) { return [...res.filter((r) => !r.fraco), ...res.filter((r) => r.fraco)]; }

function intercalar(a, b) {
  const out = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) { if (i < a.length) out.push(a[i]); if (i < b.length) out.push(b[i]); }
  return out;
}

function montarPedidoPrecedentes(assunto, resAssunto, pergunta, resPergunta, lote) {
  // pergunta e tema dividem as vagas; a mesma sumula pode estar duas vezes no portal, por isso o filtro pelo texto
  const vistos = new Set(), unicos = intercalar(resPergunta || [], resAssunto).filter((r) => {
    if (vistos.has(r.idx) || vistos.has(r.texto) || (lote && lote.excluir.has(r.idx))) return false;
    vistos.add(r.idx); vistos.add(r.texto);
    return true;
  });
  const porNota = new Map();   // uma nota longa nao toma as vagas das outras; o restante fica para o "Estender busca"
  const sumulas = unicos.filter((r) => r.norma.tipo === "Sumulas").slice(0, VAGAS_SUMULA);
  const resto = unicos.filter((r) => !sumulas.includes(r));
  const lista = [...sumulas, ...resto.filter(ehPrecedente), ...resto.filter((r) => !ehPrecedente(r))].filter((r) => {
    if (r.norma.tipo !== "Nota Técnica CIJEPI") return true;
    porNota.set(r.norma.arquivo, (porNota.get(r.norma.arquivo) || 0) + 1);
    return porNota.get(r.norma.arquivo) <= TRECHOS_POR_NOTA;
  }).slice(0, PRECEDENTES_NA_IA);
  if (!lista.length) return { texto: "", usados: [] };
  const inicio = lote ? lote.primeiro - 1 : 0;
  const trechos = lista.map((r, i) =>
    `[${inicio + i + 1}] ${identificarPrecedente(r)} | Situação: ${situacaoPrecedente(r)}${r.linkTema ? ` | Suspensão nacional: ${r.suspensao} | Fonte: ${fonteTema(r.norma)}` : ""} | Link oficial: ${r.linkTema || r.norma.url || "não informado"}\n${r.texto}`).join("\n\n");
  const texto = [
    ...(lote ? avisoContinuacao(lote) : []),
    "Você é um assistente jurídico especializado em precedentes qualificados (TJPI, STJ e STF), consultados a partir da base do Oráculo Normativo: documentos do Tribunal de Justiça do Estado do Piauí (TJPI) e, para o STF e o STJ, as fontes oficiais desses tribunais.",
    `TEMA: ${assunto}`,
    `PERGUNTA: ${pergunta || "consulta geral sobre o tema"}`,
    "Abaixo estão trechos de súmulas e de informações sobre precedentes qualificados do TJPI, do STJ e do STF (e, se houver, de outras normas internas), localizados por busca semântica no Oráculo Normativo. Responda EXCLUSIVAMENTE com base nesses trechos.",
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
    " - Suspensão nacional: copie o dado \"Suspensão nacional\" do trecho, com o alcance e a fonte. Nunca deduza que não há suspensão se o trecho não disser isso.",
    " - Alcance e efeitos: a quem e a quais processos se aplica e o caráter vinculante, apenas se constar do trecho.",
    " - Dispositivos legais relacionados: os citados no trecho.",
    " - Fonte: referência [n] e link oficial.",
    "   Notas Técnicas do CIJEPI e guias do NUGEP são orientações do TJPI, não precedentes: não use a ficha para elas. Informe o que orientam, com número, ano, referência [n] e link.",
    "3. Se houver precedentes de mais de um tribunal, apresente as fichas na ordem STF, STJ, TJPI.",
    "4. Depois das fichas, escreva \"Aplicação à pergunta\": explique em linguagem clara como a(s) tese(s) responde(m) à pergunta e aponte elementos que poderiam afastar a aplicação (distinção), se o próprio trecho os indicar.",
    `5. Se nenhum trecho contiver precedente ou súmula pertinente, diga isso claramente. Não invente número, data, tese ou órgão julgador. ${REGRA_AUSENCIA}`,
    "6. Se julgar útil trazer informação que não está nos trechos (por exemplo, precedentes ou julgados que não aparecem nos trechos), faça isso SOMENTE em seção separada, intitulada \"Informações complementares (fora da base do Oráculo)\", com a advertência: \"Estas informações não constam dos trechos fornecidos e devem ser conferidas em fonte oficial.\"",
    "7. NOVA BUSCA SUGERIDA (somente se os trechos não responderam por completo): o Oráculo encontra trechos por semelhança de sentido e de palavras e funciona melhor com os termos técnicos usados nos precedentes (ex.: o instituto jurídico, \"recurso repetitivo\", \"repercussão geral\", o número do tema), com tema curto (2 a 4 palavras) e pergunta objetiva. Use os trechos como pista (termos, temas e dispositivos legais citados) e sugira até 3 novas tentativas no formato Tema: ... | Pergunta: ..., com uma linha explicando por que cada uma pode encontrar o precedente. Não invente número de tema, súmula ou processo.",
    "8. Encerre com: \"O texto oficial do precedente, disponível no link indicado, prevalece sobre este resumo.\"",
    `9. ${REGRA_ORIGEM}`,
  ].join("\n");
  return { texto, usados: lista };
}

// busca da pergunta: mesma busca do worker, mas o resultado nao vai para a tela
let idOculto = 1e6;
const pendentes = new Map();
function buscarOculto(consulta, contexto) {
  return new Promise((ok) => {
    const id = ++idOculto;
    pendentes.set(id, ok);
    worker.postMessage({ tipo: "buscar", id, consulta, contexto, soVigentes: $("vigentes").checked, tipoNorma: $("tipo").value, limite: TOTAL_DA_BUSCA });
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

let fimDaBusca = null;   // resolvida quando chega o resultado da busca da tela

// O prompt sempre sai do que esta escrito nos campos agora, mesmo sem clicar em "Adicionar" de novo.
async function sincronizarCampos() {
  const tema = $("q").value.trim(), pergunta = $("pergunta").value.trim();
  if (tema && dobrar(tema) !== dobrar(temaAdd || "")) {
    temaAdd = tema;
    await new Promise((ok) => { fimDaBusca = ok; buscar(tema); });
  }
  if (dobrar(pergunta) !== dobrar(perguntaAdd || "")) {
    perguntaAdd = pergunta || null; consultaGeral = !pergunta; envio = null;
  }
  atualizarFluxo();
}

async function perguntarIA(destino, precedentes = false, estender = false) {
  await sincronizarCampos();
  if (!ultimo) return;
  if (!ultimo.res.length) {
    $("ia-aviso").textContent = "Nada encontrado para este tema. Tente outras palavras.";
    $("ia-aviso").hidden = false;
    return;
  }
  estender = estender && !!envio;
  // a busca da pergunta leva menos de 1 s: a copia e a nova aba ainda contam como acao do clique
  // (abrir a aba antes tiraria o foco da pagina e o navegador recusaria a copia)
  const pergunta = perguntaAdd;
  let resP = null, citados = { ...(ultimo.citados || {}) }, tabela = ultimo.tabela;
  equivalentes = "";
  if (pergunta && dobrar(pergunta) !== dobrar(ultimo.consulta)) {
    const m = await buscarOculto(pergunta, ultimo.consulta);
    resP = m.res;
    equivalentes = m.equivalentes;
    tabela = m.tabela || tabela;
    Object.assign(citados, m.citados);
  }
  const lote = estender ? { numero: envio.lote + 1, excluir: envio.enviados, primeiro: envio.enviados.size + 1 } : null;
  const enxuto = precedentes || $("tipo").value === "precedentes-sumulas";
  const resA = rebaixar(enxuto ? pertinentes(ultimo.res) : ultimo.res);
  resP = resP && rebaixar(enxuto ? pertinentes(resP) : resP);
  const { texto: pedido, usados } = precedentes ? montarPedidoPrecedentes(ultimo.consulta, resA, pergunta, resP, lote)
                                                : montarPedido(ultimo.consulta, resA, pergunta, resP, citados, lote, tabela, ultimo.pedida);
  if (!usados.length) {
    $("ia-aviso").textContent = "Não há mais trechos nesta busca: todos os encontrados já foram enviados.";
    $("ia-aviso").hidden = false;
    $("estender").disabled = true;
    return;
  }
  envio = { precedentes, lote: lote ? lote.numero : 1, enviados: new Set([...(lote ? lote.excluir : []), ...usados.map((r) => r.idx)]) };
  if (lote) mostrarLote(usados);
  atualizarFluxo();
  const ok = await copiar(pedido);
  const msg = ok ? estender ? `✓ Lote ${envio.lote} copiado, com ${usados.length} trechos novos, listados no fim dos resultados. Atenção: eles são menos semelhantes à pergunta; confira a pertinência. Cada prompt leva até 14 trechos porque, com mais texto, as IAs tendem a perder precisão e as versões gratuitas podem recusar mensagens longas. Cole na mesma conversa ou em outra.` : (destino ? "✓ Prompt copiado. Na aba que abriu, cole na conversa (Ctrl+V, ou toque longo › Colar) e envie."
                            : `✓ Prompt${precedentes ? " de precedentes" : ""} copiado. Cole no assistente de IA que preferir e envie.`)
                 : "O navegador não deixou copiar sozinho. O prompt está na caixa abaixo, já selecionado: copie (Ctrl+C, ou toque longo › Copiar) e cole na IA.";
  $("ia-aviso").textContent = msg;
  $("ia-aviso").hidden = false;
  const caixa = $("ia-texto");
  caixa.hidden = ok;
  if (!ok) { caixa.value = pedido; caixa.focus(); caixa.select(); }
  if (destino) window.open(destino, "_blank", "noopener");
}

// trechos do lote estendido que ainda nao estavam na tela
function mostrarLote(usados) {
  const lista = $("resultados"), noCartao = new Set([...lista.children].map((li) => li.dataset.idx));
  usados.filter((r) => !noCartao.has(String(r.idx))).forEach((r) => lista.appendChild(cartao(r, ultimoTermos)));
  $("contagem").textContent = `${lista.children.length} trechos`;
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
    ultimo.pedida = m.pedida || [];
    ultimo.tabela = m.tabela;
    ultimoTermos = m.termos;
    m.res.slice(0, NA_TELA).forEach((r) => lista.appendChild(cartao(r, m.termos)));
    $("contagem").textContent = m.res.length ? `${Math.min(m.res.length, NA_TELA)} mais relevantes` : "";
    if (fimDaBusca) { fimDaBusca(); fimDaBusca = null; }
    atualizarEstado(m.res.length ? (m.corrigida ? `Busca feita por: “${m.corrigida}”.` : "") : "Nada encontrado para este tema. Tente outras palavras ou desmarque “Só normas vigentes”.");
    atualizarFluxo();
  }
};

function buscar(consulta) {
  if (!consulta) return;
  contador++;
  ultimo = { consulta, res: [] };   // sem resultados ate a resposta chegar: botoes nao usam a busca anterior
  envio = null;
  worker.postMessage({ tipo: "buscar", id: contador, consulta, soVigentes: $("vigentes").checked, tipoNorma: $("tipo").value, limite: TOTAL_DA_BUSCA });
}

$("form").onsubmit = (e) => { e.preventDefault(); adicionarTema($("q").value.trim()); };
$("form-p").onsubmit = (e) => { e.preventDefault(); adicionarPergunta(); };
$("ir-geral").onclick = fazerConsultaGeral;
$("q").oninput = atualizarFluxo;
$("pergunta").oninput = atualizarFluxo;
$("pergunta").onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); adicionarPergunta(); } };
function filtroMudou() {
  $("so-precedentes").setAttribute("aria-pressed", String($("tipo").value === "precedentes-sumulas"));
  if (temaAdd) buscar(temaAdd);
  atualizarFluxo();
}
$("vigentes").onchange = $("tipo").onchange = filtroMudou;
$("so-precedentes").onclick = () => {   // liga e desliga: um novo clique volta a todos os tipos
  $("tipo").value = $("tipo").value === "precedentes-sumulas" ? "" : "precedentes-sumulas";
  filtroMudou();
};
$("ia-chatgpt").onclick = () => { contarEvento("abrir-chatgpt"); perguntarIA("https://chatgpt.com/"); };
$("ia-gemini").onclick = () => { contarEvento("abrir-gemini"); perguntarIA("https://gemini.google.com/app"); };
$("ia-copiar").onclick = () => { contarEvento("copiar-prompt"); perguntarIA(null); };
$("ia-precedentes").onclick = () => { contarEvento("copiar-prompt-precedentes"); perguntarIA(null, true); };
$("estender").onclick = () => perguntarIA(null, !!envio && envio.precedentes, true);
document.querySelectorAll("#exemplos button").forEach((b) => {
  b.onclick = () => { $("q").value = b.textContent; adicionarTema(b.textContent); };
});

// "Nao achei o que procurava": so envia com autorizacao, para um Google Forms. O botao fica oculto enquanto FORMULARIO.url estiver vazio.
const FORMULARIO = { url: "https://docs.google.com/forms/d/e/1FAIpQLScmWbI0UclJ7fsQ0ObCJFdgFpzwMo1vpnnWc7OEVMEltM5iVw/formResponse",
  tema: "entry.999084937", pergunta: "entry.2146385897", comentario: "entry.1119120063", versao: "entry.554524928", trechos: "entry.74192523", resposta: "entry.806851156" };   // formResponse e os entry.NNN

function semDadosPessoais(t) {
  return t.replace(/\b\d{7}-?\d{2}\.?\d{4}\.?\d\.?\d{2}\.?\d{4}\b/g, "[removido]")   // processo CNJ
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, "[removido]")                     // CPF
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[removido]")                             // e-mail
    .replace(/(?:\(?\b\d{2}\)?[\s-]?)?\b9?\d{4}[\s-]?\d{4}\b/g, "[removido]");      // telefone
}

function enviarFalha() {
  const f = FORMULARIO, corpo = new URLSearchParams();
  corpo.set(f.tema, semDadosPessoais(temaAdd || ""));
  corpo.set(f.pergunta, semDadosPessoais(perguntaAdd || "(consulta geral)"));
  corpo.set(f.comentario, semDadosPessoais($("falha-comentario").value.trim()));
  if (f.resposta) corpo.set(f.resposta, semDadosPessoais($("falha-resposta").value.trim().slice(0, 8000)));
  corpo.set(f.versao, `${typeof textoVersao === "string" ? textoVersao : "Versão beta"} [${VERSAO || "local"}]`);
  corpo.set(f.trechos, ((ultimo && ultimo.res) || []).slice(0, NA_TELA).map((r) => `${r.norma.nome} – ${r.rotulo}`).join("; ").slice(0, 500));
  // Sem cookies: com a conta Google logada no navegador o envio podia nao chegar; keepalive conclui mesmo se a aba fechar.
  // Se o navegador bloquear (extensao, rede), devolve o link do formulario ja preenchido para enviar manualmente.
  return fetch(f.url, { method: "POST", mode: "no-cors", credentials: "omit", keepalive: corpo.toString().length < 60000, body: corpo })
    .then(() => null, () => {
      corpo.delete(f.resposta);
      return f.url.replace("formResponse", "viewform") + "?usp=pp_url&" + corpo.toString().slice(0, 6000);
    });
}

$("falha").onclick = () => { contarEvento("nao-achei"); $("falha-comentario").value = ""; $("falha-resposta").value = ""; $("falha-dialogo").showModal(); };
$("falha-nao").onclick = () => $("falha-dialogo").close();
$("falha-enviar").onclick = async () => {
  $("falha-enviar").disabled = true;
  $("estado").textContent = "Enviando a consulta...";
  const link = await enviarFalha();
  $("falha-enviar").disabled = false;
  $("falha-dialogo").close();
  if (!link) { $("estado").textContent = "Consulta enviada. Obrigado."; return; }
  $("estado").innerHTML = "O navegador bloqueou o envio automático. " +
    `<a href="${escapar(link)}" target="_blank" rel="noopener">Abra o formulário já preenchido</a> e clique em Enviar.`;
};

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
