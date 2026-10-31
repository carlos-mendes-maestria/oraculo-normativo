"""Pagina de conversa do Oraculo (Gradio), igual no Google Colab e no computador do usuario."""
import gradio as gr

AVISO = ("**Iniciativa independente, sem vínculo oficial com o Tribunal.** A IA pode errar: confira os artigos citados, "
         "pois o texto oficial prevalece. Não digite dados de processos ou de pessoas.")


def criar(oraculo, aviso_tempo=""):
    def enviar(pergunta, conversa, historico, so_vigentes):
        pergunta = (pergunta or "").strip()
        if not pergunta:
            yield "", conversa, historico, gr.update()
            return
        conversa = conversa + [{"role": "user", "content": pergunta}, {"role": "assistant", "content": "⏳ Procurando nas normas…"}]
        yield "", conversa, historico, ""
        resposta = ""
        try:
            for pedaco in oraculo.responder(pergunta, historico, so_vigentes):
                resposta += pedaco
                conversa[-1]["content"] = resposta
                yield "", conversa, historico, gr.update()
        except Exception as e:
            conversa[-1]["content"] = f"Não foi possível responder agora ({e}). Tente de novo."
            yield "", conversa, historico, gr.update()
            return
        fontes = "\n".join(f"- [{c}]({u})" if u else f"- {c}" for c, u in oraculo.fontes)
        yield "", conversa, historico + [(pergunta, resposta)], fontes

    with gr.Blocks(title="Oráculo normativo do TJPI") as pagina:
        gr.Markdown("# Oráculo normativo do TJPI\nFaça sua pergunta sobre as normas internas do Judiciário do Piauí. "
                    "Você pode continuar a conversa com perguntas de acompanhamento.")
        if aviso_tempo:
            gr.Markdown(f"⏱️ {aviso_tempo}")
        conversa = gr.Chatbot(height=460, label="Conversa", show_label=False)
        historico = gr.State([])
        with gr.Row():
            campo = gr.Textbox(placeholder="Ex.: com quantos dias de antecedência preciso pedir a folga do plantão?",
                               show_label=False, scale=5, lines=2)
            botao = gr.Button("Perguntar", variant="primary", scale=1)
        so_vigentes = gr.Checkbox(value=True, label="Só normas vigentes")
        limpar = gr.Button("Começar nova conversa")
        with gr.Accordion("Normas consultadas na última resposta", open=False):
            fontes = gr.Markdown()
        gr.Markdown(AVISO)
        entradas, saidas = [campo, conversa, historico, so_vigentes], [campo, conversa, historico, fontes]
        botao.click(enviar, entradas, saidas)
        campo.submit(enviar, entradas, saidas)
        limpar.click(lambda: ([], [], ""), None, [conversa, historico, fontes])
    return pagina
