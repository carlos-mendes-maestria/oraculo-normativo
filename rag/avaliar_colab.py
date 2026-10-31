"""Avaliacao temporaria no Colab: mede a recuperacao com reescrita e gera respostas de amostra, com tempos.
Roda com: exec(urllib.request.urlopen(URL).read()) numa celula, depois da etapa 2 do notebook. Usa `oraculo` ja carregado."""
import json, time, urllib.request

_u = "https://carlos-mendes-maestria.github.io/oraculo-normativo/rag/avaliacao.json?" + str(time.time())
_av = json.load(urllib.request.urlopen(_u))
_ac, _mrr, _t0 = {1: 0, 5: 0, 10: 0, 14: 0}, 0, time.time()
for _p, _esp in _av["recuperacao"]:
    _tema, _esc, _ = oraculo.recuperar(_p)
    _arq = [oraculo.normas[oraculo.trechos[i][0]]["arquivo"] for i in _esc]
    _pos = next((k for k, x in enumerate(_arq) if x in _esp), None)
    for _k in _ac:
        _ac[_k] += _pos is not None and _pos < _k
    _mrr += 1 / (_pos + 1) if _pos is not None else 0
_n = len(_av["recuperacao"])
print("RECUPERACAO", {k: round(100 * v / _n) for k, v in _ac.items()}, "MRR", round(_mrr / _n, 2), "s/pergunta", round((time.time() - _t0) / _n, 1), flush=True)
_tempos = []
for _i, _p in enumerate(_av["amostra"], 1):
    _t0 = time.time()
    _r = "".join(oraculo.responder(_p))
    _tempos.append(time.time() - _t0)
    print(f"\n<<<R{_i}>>> {_p}\n{_r}\n<<<FIM{_i}>>> {_tempos[-1]:.0f}s", flush=True)
print("TEMPO medio", round(sum(_tempos) / len(_tempos)), "min", round(min(_tempos)), "max", round(max(_tempos)), flush=True)
