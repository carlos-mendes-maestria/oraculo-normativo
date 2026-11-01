"""Motor de RAG do Oraculo normativo do TJPI, usado pelo notebook do Colab e pelo aplicativo local.

Etapas de cada resposta: (1) o LLM reescreve a pergunta em buscas mais gerais; (2) busca hibrida no banco vetorial
ChromaDB (BGE-M3) e por palavras (BM25); (3) um reclassificador escolhe os melhores trechos; (4) acrescenta os artigos
citados e o mapa de quem altera ou revoga quem; (5) o LLM responde, separando o que vem das normas do que nao vem.

A base vem do site publicado e so e baixada de novo quando muda. Requer um Ollama rodando em http://127.0.0.1:11434.
"""
import hashlib, io, json, math, os, re, time, unicodedata, urllib.request
from collections import Counter, defaultdict
import numpy as np

SITE = os.environ.get("ORACULO_SITE", "https://carlos-mendes-maestria.github.io/oraculo-normativo/")
OLLAMA = "http://127.0.0.1:11434"
MODELO_VETOR = "bge-m3"
REPO_RERANK = "onnx-community/bge-reranker-v2-m3-ONNX"
N_CANDIDATOS = 50        # entram no reclassificador
N_TRECHOS = 14           # vao ao LLM
POR_NORMA = 3
POR_TRIBUNAL = 6         # temas do STF e do STJ: um documento por tribunal, com milhares de temas
POR_TRIBUNAL_COMUM = 2   # pergunta que nao fala em precedentes: os temas nao tomam o lugar das normas
MAX_CITADOS = 6
CTX = 16384

STOP = set("a o as os e de do da dos das em no na nos nas um uma uns umas por para pelo pela pelos pelas com sem "
           "que se ao aos ou ser como qual quais quem onde quando pode tem ter ha mais seu sua seus suas este esta "
           "isso isto esse essa me eu".split())


def dobrar(t):
    return "".join(c for c in unicodedata.normalize("NFD", t.lower()) if unicodedata.category(c) != "Mn")


def termos(t):
    out = []
    for w in re.findall(r"[a-z0-9]+", dobrar(t)):
        if len(w) < 2 or w in STOP:
            continue
        out.append(w[:-1] if len(w) > 4 and w.endswith("s") else w)
    return out


def rrf(listas, pesos, k=60):
    s = defaultdict(float)
    for l, p in zip(listas, pesos):
        for pos, i in enumerate(l):
            s[i] += p / (k + pos + 1)
    return sorted(s, key=lambda i: -s[i])


def chamar_ollama(rota, corpo, stream=False):
    req = urllib.request.Request(OLLAMA + rota, json.dumps(corpo).encode(), {"Content-Type": "application/json"})
    r = urllib.request.urlopen(req, timeout=1800)
    return r if stream else json.load(r)


class Reclassificador:
    """bge-reranker-v2-m3 em ONNX. Na GPU usa o modelo fp16; sem GPU, o int8 (menor e mais rapido em CPU)."""

    def __init__(self):
        import onnxruntime as ort
        from huggingface_hub import hf_hub_download
        from tokenizers import Tokenizer
        gpu = "CUDAExecutionProvider" in ort.get_available_providers()
        arq = "onnx/model_fp16.onnx" if gpu else "onnx/model_int8.onnx"
        self.tok = Tokenizer.from_file(hf_hub_download(REPO_RERANK, "tokenizer.json"))
        self.tok.enable_truncation(512)
        self.tok.enable_padding(pad_id=1, pad_token="<pad>")
        prov = ["CUDAExecutionProvider", "CPUExecutionProvider"] if gpu else ["CPUExecutionProvider"]
        self.sessao = ort.InferenceSession(hf_hub_download(REPO_RERANK, arq), providers=prov)
        self.entradas = {e.name for e in self.sessao.get_inputs()}
        self.lote = 16 if gpu else 4

    def notas(self, pergunta, textos):
        saida = []
        for k in range(0, len(textos), self.lote):
            enc = self.tok.encode_batch([(pergunta, t) for t in textos[k:k + self.lote]])
            feed = {"input_ids": np.array([e.ids for e in enc], dtype=np.int64),
                    "attention_mask": np.array([e.attention_mask for e in enc], dtype=np.int64)}
            if "token_type_ids" in self.entradas:
                feed["token_type_ids"] = np.zeros_like(feed["input_ids"])
            saida += self.sessao.run(None, feed)[0].reshape(-1).tolist()
        return saida


class Oraculo:
    def __init__(self, pasta, modelo="gemma4:12b", reescrever=True, reclassificar=True, avisar=print):
        self.pasta, self.modelo, self.reescrever, self.avisar = pasta, modelo, reescrever, avisar
        os.makedirs(pasta, exist_ok=True)
        self._carregar_base()
        self._montar_bm25()
        self._montar_remissoes()
        self._montar_banco()
        self.rerank = None
        if reclassificar:
            avisar("Carregando o reclassificador…")
            self.rerank = Reclassificador()

    # ------------------------------------------------------------ base
    def _baixar(self, nome):
        destino = os.path.join(self.pasta, nome.replace("/", "_"))
        if os.path.isdir(SITE):   # testes: le a pasta site/ local, antes de publicar
            return open(os.path.join(SITE, nome), "rb").read()
        if not os.path.exists(destino):
            with urllib.request.urlopen(SITE + nome, timeout=300) as r:
                dados = r.read()
            with open(destino + ".tmp", "wb") as f:
                f.write(dados)
            os.replace(destino + ".tmp", destino)
        return open(destino, "rb").read()

    def _carregar_base(self):
        self.avisar("Conferindo a base de normas…")
        if os.path.isdir(SITE):
            info = json.load(open(os.path.join(SITE, "dados", "indice_info.json"), encoding="utf-8"))
        else:
            with urllib.request.urlopen(SITE + f"dados/indice_info.json?{time.time()}", timeout=60) as r:
                info = json.load(r)
        marca = os.path.join(self.pasta, "versao.txt")
        self.mudou = not os.path.exists(marca) or open(marca).read() != info["versao"]
        if self.mudou:   # base nova: descarta os dados antigos (os arquivos vet_* nunca mudam e ficam)
            for n in os.listdir(self.pasta):
                if n.startswith("dados_") or n == "rag_indice.json":
                    os.remove(os.path.join(self.pasta, n))
        self.normas = json.loads(self._baixar("dados/normas.json"))
        self.grupos = json.loads(self._baixar("dados/sinonimos.json"))["grupos"]
        self.mapa = json.loads(self._baixar("dados/mapa_normas.json"))
        self.trechos = []
        for p in range(len(info["partes"])):
            self.trechos += json.loads(self._baixar(f"dados/trechos_{p}.json"))
        self.versao, self.marca = info["versao"], marca
        self.sinonimos = [(re.compile(r"\b(?:" + "|".join(re.escape(s) for s in g["se"]) + r")\b"), g["acrescenta"])
                          for g in self.grupos]

    def _texto_rag(self, t):
        return " | ".join(p for p in (self.normas[t[0]]["nome"], t[1], t[2], t[3]) if p)

    def _tema(self, i):
        """Tema do STF ou do STJ: {"s": situacao, "u": link}. Normas e demais trechos nao tem."""
        t = self.trechos[i]
        return t[4] if len(t) > 4 else None

    def _fora_de_vigor(self, i):
        tema = self._tema(i)
        return bool(tema and re.match(r"cancelad|prejudicad", tema["s"], re.I))

    def _valido(self, i, so_vigentes):
        n = self.normas[self.trechos[i][0]]
        return not so_vigentes or (n["situacao"] != "revogada" and not n.get("superada") and not self._fora_de_vigor(i))

    # ------------------------------------------------------------ palavras
    def _montar_bm25(self):
        self.inv, self.comp = defaultdict(list), np.zeros(len(self.trechos), dtype=np.float32)
        for i, (n, rot, est, txt, *_) in enumerate(self.trechos):
            d = f"{self.normas[n]['nome']} {self.normas[n]['ementa'] if rot == 'Preâmbulo' else ''} {rot} {est} {txt}"
            c = Counter(termos(d))
            self.comp[i] = sum(c.values())
            for w, k in c.items():
                self.inv[w].append((i, k))
        self.media = float(self.comp.mean())
        N = len(self.trechos)
        self.idf = {w: math.log(1 + (N - len(p) + 0.5) / (len(p) + 0.5)) for w, p in self.inv.items()}

    def _bm25(self, consulta, k1=1.2, b=0.75):
        s = np.zeros(len(self.trechos), dtype=np.float32)
        for w in set(termos(consulta)):
            for i, n in self.inv.get(w, []):
                s[i] += self.idf[w] * n * (k1 + 1) / (n + k1 * (1 - b + b * self.comp[i] / self.media))
        return s

    def _expandir(self, consulta):
        f = dobrar(consulta)
        extra = [a for rx, a in self.sinonimos if rx.search(f)]
        return consulta + " " + " ".join(extra) if extra else consulta

    # ------------------------------------------------------------ banco vetorial
    def _montar_banco(self):
        import chromadb
        cliente = chromadb.PersistentClient(path=os.path.join(self.pasta, "banco"))
        col = cliente.get_or_create_collection("normas", metadata={"hnsw:space": "cosine"})
        if self.mudou or col.count() == 0:
            self.avisar("Montando o banco vetorial (só quando a base muda)…")
            cliente.delete_collection("normas")
            col = cliente.create_collection("normas", metadata={"hnsw:space": "cosine"})
            vetores = {}
            manifesto = json.loads(self._baixar("rag/indice.json"))
            for a in manifesto["arquivos"]:
                z = np.load(io.BytesIO(self._baixar("rag/" + a)))
                for h, v in zip(z["h"], z["v"]):
                    vetores[bytes(h).ljust(20, b"\0").hex()] = v   # o numpy corta zeros no fim do hash
            ids, vs, metas = [], [], []
            for i, t in enumerate(self.trechos):
                v = vetores.get(hashlib.sha1(self._texto_rag(t).encode("utf-8")).hexdigest())
                if v is None:
                    continue
                n = self.normas[t[0]]
                ids.append(str(i)); vs.append(v.astype(np.float32).tolist())
                metas.append({"tipo": n["tipo"], "ano": str(n["ano"]), "situacao": "revogada" if self._fora_de_vigor(i) else n["situacao"],
                              "superada": bool(n.get("superada"))})
            for k in range(0, len(ids), 4000):
                col.add(ids=ids[k:k + 4000], embeddings=vs[k:k + 4000], metadatas=metas[k:k + 4000])
            open(self.marca, "w").write(self.versao)
        self.colecao = col

    def _vetor(self, textos):
        return chamar_ollama("/api/embed", {"model": MODELO_VETOR, "input": textos, "truncate": True})["embeddings"]

    def _densa(self, consultas, so_vigentes):
        filtro = {"$and": [{"situacao": {"$ne": "revogada"}}, {"superada": False}]} if so_vigentes else None
        r = self.colecao.query(query_embeddings=self._vetor(consultas), n_results=60, where=filtro, include=[])
        return [[int(i) for i in lista] for lista in r["ids"]]

    # ------------------------------------------------------------ remissoes
    def _montar_remissoes(self):
        self.por_arquivo = {n["arquivo"]: i for i, n in enumerate(self.normas)}
        self.por_chave = defaultdict(list)
        for i, n in enumerate(self.normas):
            if str(n["numero"]).isdigit():
                self.por_chave[(n["tipo"], int(n["numero"]), str(n["ano"]))].append(i)
        if "Resolucao_02_1987" in self.por_arquivo:
            self.por_chave[("Resolucoes", 2, "1987")] = [self.por_arquivo["Resolucao_02_1987"]]
        self.artigos = defaultdict(lambda: defaultdict(list))
        for i, (n, rot, *_) in enumerate(self.trechos):
            m = re.match(r"Art\. (\d+)", rot)
            if m and len(self.artigos[n][m.group(1)]) < 2:
                self.artigos[n][m.group(1)].append(i)

    RX = re.compile(
        r"\bart(?:igo)?s?\.?\s*(\d{1,4})[º°o]?(?:-[A-Z])?((?:\s*(?:,|e)\s*(?:art\.?\s*)?\d{1,4}[º°o]?)*)"
        r"(?:(?!\bart)[^.;\n]){0,60}?\b("
        r"d[ao]s?\s+regimento\s+interno(?:\s+d[ao]\s+corregedoria)?|"
        r"(?:desta|deste)\s+(?:resolu[çc][ãa]o|provimento|lei)|"
        r"d[ao]s?\s+(?:resolu[çc][ãa]o|provimento(?:\s+conjunto)?|lei\s+complementar|lei))"
        r"(?:\s+(?:tjpi|cgj|estadual|ordin[áa]ria))*\s*(?:n[º°o.]*\s*)?(\d{1,2}\.\d{3}|\d{1,4})?"
        r"(?:\s*/\s*(\d{2,4})|,?\s*de\s+\d{1,2}[º°o]?\s+de\s+[a-zç]+\s+de\s+(\d{4}))?", re.I)

    def _norma_citada(self, tipo, num, ano, origem):
        t = dobrar(tipo)
        if "regimento interno" in t:
            return self.por_arquivo.get("Provimento_21_2014" if "corregedoria" in t else "Resolucao_02_1987")
        if t.startswith(("desta", "deste")):
            return origem
        if not num:
            return None
        a = int(ano) if ano else None
        if a is not None and a < 100:
            a += 2000 if a < 50 else 1900
        t2 = re.sub(r"^d[ao]s?\s+", "", t)
        g = ("Resolucoes" if t2.startswith("resolu") else "Provimentos" if t2.startswith("provimento")
             else "Leis Complementares" if "complementar" in t2 else "Leis Ordinarias")
        c = [i for i in self.por_chave.get((g, int(num.replace(".", "")), str(a)), [])
             if ("conjunto" in t) == ("conjunto" in self.normas[i]["arquivo"].lower())]
        v = [i for i in c if self.normas[i]["situacao"] != "revogada"]
        return (v or c or [None])[0]

    def _citados(self, escolhidos):
        out = []
        for i in escolhidos:
            origem, _, _, texto = self.trechos[i][:4]
            for m in self.RX.finditer(texto):
                n = self._norma_citada(m.group(3), m.group(4), m.group(5) or m.group(6), origem)
                if n is None or self.normas[n]["situacao"] == "revogada" or self.normas[n].get("superada"):
                    continue   # artigo de norma sem efeito so ocuparia espaco e confundiria a IA
                for a in [m.group(1)] + re.findall(r"\d{1,4}", m.group(2) or ""):
                    for t in self.artigos[n].get(str(int(a)), []):
                        if t not in escolhidos and t not in out:
                            out.append(t)
        return out[:MAX_CITADOS]

    def _nome(self, arquivo):
        i = self.por_arquivo.get(arquivo)
        return self.normas[i]["nome"] if i is not None else arquivo.replace("_", " ")

    def cabecalho(self, i):
        n, rot = self.normas[self.trechos[i][0]], self.trechos[i][1]
        tema = self._tema(i)
        if tema:   # vale a situacao do proprio tema, nao a do documento que reune os temas do tribunal
            sit = tema["s"].upper() if self._fora_de_vigor(i) else tema["s"]
            return f"{n['nome']} – {rot} (situação do tema: {sit}; fonte: {n['fonte']}, coletado em {n['coletado']}; link oficial: {tema['u']})"
        sit = "REVOGADA" if n["situacao"] == "revogada" else "SEM EFEITO, alterou norma revogada" if n.get("superada") else "vigente"
        por = f" pela {n['revogada_por']}" if n.get("revogada_por") else ""
        data = f", {n['data']}" if n.get("data") else ""
        rel = self.mapa.get(n["arquivo"], {})
        alt = [self._nome(a) for a in rel.get("alterada_por", [])][-4:]
        nota = f"; alterada por: {', '.join(alt)}" if alt else ""
        return f"{n['nome']} – {rot} ({sit}{por}{data}{nota})"

    # ------------------------------------------------------------ recuperacao
    def _variacoes(self, pergunta):
        prompt = ("Você ajuda a buscar normas internas do Poder Judiciário do Piauí. Reescreva a pergunta abaixo em 3 buscas "
                  "curtas e mais gerais, trocando cargos específicos pela categoria (ex.: analista judicial → servidor público "
                  "efetivo; juiz → magistrado) e usando os termos técnicos das normas. Responda só com JSON, no formato "
                  '{"tema": "assunto em poucas palavras", "buscas": ["...", "...", "..."]}.\n\nPergunta: ' + pergunta)
        r = chamar_ollama("/api/chat", {"model": self.modelo, "stream": False, "think": False, "format": "json",
                                        "messages": [{"role": "user", "content": prompt}],
                                        "options": {"temperature": 0, "num_predict": 200, "num_ctx": 2048}})
        try:
            d = json.loads(r["message"]["content"])
            return str(d.get("tema") or ""), [str(b) for b in d.get("buscas", [])][:3]
        except (ValueError, AttributeError):
            return "", []

    RX_TEMA = re.compile(r"\b(tema|iac|sirdr|puil|relevancia)\s*(?:n[º°o.]*\s*)?(\d[\d.]*)(?:\s*(?:/|d[oe])?\s*(stf|stj))?", re.I)

    def _temas_citados(self, pergunta):
        """"Tema 1376 STJ": o tema pedido pelo numero entra sempre, mesmo cancelado, para a IA informar a situacao."""
        rotulos = {dobrar(t[1]): i for i, t in enumerate(self.trechos) if len(t) > 4}
        out = []
        for sigla, num, trib in self.RX_TEMA.findall(dobrar(pergunta)):
            for t in [trib] if trib else ["stf", "stj"]:
                i = rotulos.get(f"{sigla} {num.replace('.', '')} {t}")
                if i is not None:
                    out.append(i)
        return out

    def recuperar(self, pergunta, so_vigentes=True):
        """Devolve (tema, trechos escolhidos, artigos citados)."""
        tema, buscas = self._variacoes(pergunta) if self.reescrever else ("", [])
        topo = lambda s: [int(i) for i in np.argsort(-s)[:400] if s[i] > 0 and self._valido(int(i), so_vigentes)][:100]
        densas = self._densa([pergunta] + buscas, so_vigentes)
        listas = [topo(self._bm25(pergunta)), densas[0]]
        pesos = [1, 1]
        amp = self._expandir(pergunta)
        if amp != pergunta:
            listas.append(topo(self._bm25(amp))); pesos.append(0.5)
        for b, d in zip(buscas, densas[1:]):
            listas += [topo(self._bm25(b)), d]; pesos += [0.5, 0.5]
        fundidos = rrf(listas, pesos)[:N_CANDIDATOS]
        if self.rerank:
            notas = self.rerank.notas(pergunta, [self._texto_rag(self.trechos[i]) for i in fundidos])
            fundidos = [i for _, i in sorted(zip(notas, fundidos), key=lambda x: -x[0])]
        cont, escolhidos = Counter(), []
        fixos = self._temas_citados(pergunta)
        limite_tema = POR_TRIBUNAL if self._quer_precedentes(pergunta) else POR_TRIBUNAL_COMUM
        for i in fixos + [i for i in fundidos if i not in fixos]:
            n = self.trechos[i][0]
            if cont[n] < (limite_tema if self._tema(i) else POR_NORMA):
                cont[n] += 1
                escolhidos.append(i)
                if len(escolhidos) >= N_TRECHOS:
                    break
        return tema or pergunta, escolhidos, self._citados(escolhidos)

    # ------------------------------------------------------------ resposta
    def montar_mensagens(self, pergunta, tema, escolhidos, citados, historico=()):
        ident = f"Tema: {tema} | Pergunta: {pergunta}"
        trechos = "\n\n".join(f"[{k + 1}] {self.cabecalho(i)}\n{self.trechos[i][3]}" for k, i in enumerate(escolhidos))
        cit = "\n\n".join(f"[C{k + 1}] {self.cabecalho(i)}\n{self.trechos[i][3]}" for k, i in enumerate(citados))
        regras = ("Você é um assistente que tira dúvidas sobre as normas internas do Poder Judiciário do Estado do Piauí. "
                  "Responda em português, em linguagem clara, para um servidor sem formação jurídica.\n"
                  "Regras: use SOMENTE os trechos fornecidos e cite a norma e o artigo de cada informação, no formato "
                  "(Resolução nº X/AAAA, art. Y). Regras gerais dos servidores ou dos magistrados valem para todos os cargos da "
                  "categoria. Quando duas normas tratarem do mesmo ponto, vale a mais recente; nunca use trecho marcado como "
                  "REVOGADA ou SEM EFEITO como regra atual; se o citar, diga que não vale mais. Se a norma estiver indicada como "
                  "alterada, procure a redação da norma que a alterou. Nos precedentes, vale a situação do próprio tema: tema "
                  "CANCELADO ou PREJUDICADO não é regra atual, e tema afetado, em julgamento ou sem tese ainda não tem tese definitiva.")
        if self._quer_precedentes(pergunta):
            return self._mensagens(regras, self._pedido_precedentes(pergunta, tema, trechos, cit), historico)
        pedido = ("Organize a resposta com os títulos abaixo. Copie só o título, nunca o texto entre colchetes, que é instrução para você.\n\n"
                  f'Logo abaixo do título de CADA parte, escreva: "{ident}".\n\n'
                  "PARTE 1 – VISÃO GERAL DO TEMA\n[Explicação minuciosa do que as normas dispõem sobre o tema: quais tratam dele, "
                  "para quem se aplicam, regras, requisitos, prazos, procedimentos e exceções. Não resuma.]\n\n"
                  "PARTE 2 – RESPOSTA À PERGUNTA\n[Responda de forma completa e direta. Se os trechos não bastarem, diga o que ficou sem resposta.]\n\n"
                  '⚠️ ATENÇÃO – INFORMAÇÃO FORA DAS NORMAS DO ACERVO (CONFERIR)\n[Use este título somente se a Parte 2 não responder por completo: '
                  "traga seu conhecimento geral, a fonte provável e o aviso de que isso precisa ser conferido no texto oficial. "
                  "Se a Parte 2 bastar, encerre nela, sem este título e sem comentar sobre ele.]\n\n"
                  f"PERGUNTA: {pergunta}\n\nTRECHOS:\n{trechos}" + (f"\n\nTRECHOS CITADOS PELOS ACIMA:\n{cit}" if cit else ""))
        return self._mensagens(regras, pedido, historico)

    def _mensagens(self, regras, pedido, historico):
        msgs = [{"role": "system", "content": regras}]
        for p, r in list(historico)[-3:]:   # conversa anterior, sem os trechos, para entender perguntas de continuacao
            msgs += [{"role": "user", "content": p}, {"role": "assistant", "content": r[:1500]}]
        return msgs + [{"role": "user", "content": pedido}]

    RX_PRECEDENTE = re.compile(r"\b(precedentes?|temas?\s+\d|repetitivos?|repercuss[ãa]o geral|s[úu]mulas?|irdr|iac|tese firmada|stf|stj)\b", re.I)

    def _quer_precedentes(self, pergunta):
        """So a pergunta decide: pelos trechos, uma duvida comum sobre ferias viraria fichas de temas de outras carreiras."""
        return bool(self.RX_PRECEDENTE.search(pergunta))

    def _pedido_precedentes(self, pergunta, tema, trechos, cit):
        """Mesmas fichas do botao "Copiar prompt de precedentes" do site."""
        return ("Responda com base nos trechos abaixo. Copie só os títulos, nunca o texto entre colchetes, que é instrução para você.\n\n"
                f"Tema: {tema} | Pergunta: {pergunta}\n\n"
                "Identifique quais trechos tratam de fato da pergunta e ignore os demais. Para CADA precedente ou súmula pertinente, "
                "apresente esta ficha, na ordem STF, STJ, TJPI:\n"
                "Tribunal: [TJPI, STJ ou STF]\n"
                "Identificação: [espécie, número do tema ou da súmula, processo paradigma, órgão julgador e data, se constarem]\n"
                "Questão jurídica: [a controvérsia, em uma ou duas frases]\n"
                "Tese firmada: [transcrição LITERAL, entre aspas, sem paráfrase; se não houver, diga que não há tese]\n"
                "Situação: [a situação do próprio tema, conforme o cabeçalho do trecho]\n"
                "Alcance e efeitos: [a quem se aplica e caráter vinculante, apenas se constar do trecho]\n"
                "Dispositivos legais relacionados: [os citados no trecho]\n"
                "Fonte: [referência [n] e link oficial]\n\n"
                "Depois das fichas, escreva \"Aplicação à pergunta\": explique em linguagem clara como a tese responde à pergunta. "
                "Se nenhum trecho for pertinente, diga isso. Não invente número, data, tese ou órgão julgador. "
                "Encerre com: \"O texto oficial do precedente, disponível no link indicado, prevalece sobre este resumo.\"\n\n"
                f"PERGUNTA: {pergunta}\n\nTRECHOS:\n{trechos}" + (f"\n\nTRECHOS CITADOS PELOS ACIMA:\n{cit}" if cit else ""))

    def pergunta_completa(self, pergunta, historico):
        """'E para magistrados?' vira uma pergunta completa, usando a conversa anterior."""
        if not historico:
            return pergunta
        ctx = "\n".join(f"Usuário: {p}" for p, _ in list(historico)[-3:])
        prompt = ("Reescreva a última pergunta para que fique completa e compreensível sozinha, usando a conversa. "
                  f"Responda só com a pergunta.\n\n{ctx}\nÚltima pergunta: {pergunta}")
        r = chamar_ollama("/api/chat", {"model": self.modelo, "stream": False, "think": False,
                                        "messages": [{"role": "user", "content": prompt}],
                                        "options": {"temperature": 0, "num_predict": 80, "num_ctx": 2048}})
        return r["message"]["content"].strip() or pergunta

    def responder(self, pergunta, historico=(), so_vigentes=True):
        """Gera pedacos da resposta; ao fim, devolve a lista de normas consultadas em self.fontes."""
        completa = self.pergunta_completa(pergunta, historico)
        tema, esc, cit = self.recuperar(completa, so_vigentes)
        self.fontes = [(self.cabecalho(i), (self._tema(i) or {}).get("u") or self.normas[self.trechos[i][0]]["url"]) for i in esc + cit]
        r = chamar_ollama("/api/chat", {"model": self.modelo, "stream": True, "think": False,
                                        "messages": self.montar_mensagens(completa, tema, esc, cit, historico),
                                        "options": {"num_ctx": CTX, "num_predict": 3000, "temperature": 0.2}}, stream=True)
        for linha in r:
            pedaco = json.loads(linha).get("message", {}).get("content", "")
            if pedaco:
                yield pedaco
