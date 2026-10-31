"""Oraculo no computador do usuario: abre a pagina de conversa em http://127.0.0.1:7860.

Instala o que falta, baixa as IAs pelo Ollama e os dados do site. Depois da primeira vez, funciona sem internet,
exceto a conferencia de atualizacao da base. Uso:  py oraculo_local.py [--modelo gemma4:12b] [--leve]
--leve dispensa a reescrita da pergunta e o reclassificador, para responder mais rapido em computador sem GPU.
"""
import argparse, os, subprocess, sys

PASTA = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, PASTA)
DADOS = os.path.join(os.path.expanduser("~"), "OraculoTJPI")
PACOTES = ["numpy", "chromadb", "gradio", "onnxruntime", "tokenizers", "huggingface_hub"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--modelo", default="gemma4:12b")
    ap.add_argument("--leve", action="store_true")
    a = ap.parse_args()
    try:
        import chromadb, gradio, onnxruntime, tokenizers  # noqa: F401
    except ImportError:
        print("Instalando bibliotecas (só na primeira vez)…")
        subprocess.run([sys.executable, "-m", "pip", "install", "--user", "-q"] + PACOTES, check=True)
    print("Conferindo as IAs (na primeira vez baixa cerca de 9 GB)…")
    for m in ("bge-m3", a.modelo):
        subprocess.run(["ollama", "pull", m], check=True)
    import interface, oraculo_rag
    oraculo = oraculo_rag.Oraculo(DADOS, modelo=a.modelo, reescrever=not a.leve, reclassificar=not a.leve)
    aviso = ("Em computador sem placa de vídeo dedicada, cada resposta leva cerca de 15 minutos com o modelo padrão, "
             "ou 6 minutos com o modelo gemma4:e4b. A demora vem dos limites do equipamento, não é um erro.")
    interface.criar(oraculo, aviso).launch(inbrowser=True, server_name="127.0.0.1", server_port=7860)


if __name__ == "__main__":
    main()
