// Versao visivel do site: rodape, "Sobre" e campo Versao do formulario "Nao achei".
// Cada publicacao incrementa o ultimo numero (0.9.1, 0.9.2...) e registra no Diario o que mudou; a 1.0 sai do beta.
const VERSAO_SITE = "Versão beta 0.9.19 (14/11/2026)";
let textoVersao = VERSAO_SITE;

fetch("dados/indice_info.json?" + Date.now()).then((r) => r.json()).then((info) => {
  const [a, m, d] = (info.gerado_em || "").slice(0, 10).split("-");
  if (d) textoVersao = `${VERSAO_SITE} · base de normas atualizada em ${d}/${m}/${a}`;
}).catch(() => {}).finally(() => {
  document.querySelectorAll("[data-versao]").forEach((el) => { el.textContent = textoVersao; });
});
