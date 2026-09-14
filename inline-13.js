/**
 * ══════════════════════════════════════════════════════════════════
 * MEUS ANÚNCIOS — edição de classificados publicados
 * ══════════════════════════════════════════════════════════════════
 * Arquivo independente, propositalmente. Não depende de nenhum outro
 * inline-*.js nem dos handlers de CSP existentes — usa addEventListener
 * direto (permitido pela CSP atual, que só bloqueia HANDLERS INLINE no
 * HTML tipo onclick="...", não código carregado via <script src>).
 *
 * Como funciona sem precisar mexer no formulário de publicar anúncio
 * (que vive num arquivo hoje indisponível):
 *   1. Intercepta window.fetch — sem alterar nenhum outro arquivo,
 *      observa toda resposta de /classificados/publicar e
 *      /classificados/confirmar/*, e quando vem um editToken de
 *      verdade, guarda no localStorage deste navegador.
 *   2. Mostra um botão flutuante "Meus Anúncios" só quando existe
 *      pelo menos 1 anúncio salvo.
 *   3. Ao abrir, busca os dados atuais de cada anúncio (GET
 *      /classificados/:id) e permite editar e salvar (PUT).
 * ══════════════════════════════════════════════════════════════════
 */
(function () {
  'use strict';

  const CHAVE_STORAGE = 'agro_meus_anuncios';
  const backendUrl = typeof BACKEND_URL !== 'undefined' ? BACKEND_URL : '';

  // ── Persistência local ────────────────────────────────────────────
  function lerAnunciosSalvos() {
    try {
      const bruto = localStorage.getItem(CHAVE_STORAGE);
      const lista = bruto ? JSON.parse(bruto) : [];
      return Array.isArray(lista) ? lista : [];
    } catch (_) {
      return [];
    }
  }

  function salvarAnuncio(id, editToken) {
    const lista = lerAnunciosSalvos().filter(a => a.id !== id);
    lista.push({ id, editToken, salvoEm: Date.now() });
    try { localStorage.setItem(CHAVE_STORAGE, JSON.stringify(lista)); } catch (_) {}
    atualizarVisibilidadeBotao();
  }

  function removerAnuncioSalvo(id) {
    const lista = lerAnunciosSalvos().filter(a => a.id !== id);
    try { localStorage.setItem(CHAVE_STORAGE, JSON.stringify(lista)); } catch (_) {}
    atualizarVisibilidadeBotao();
  }

  // ── Interceptação do fetch — captura o editToken sem tocar em mais nada ──
  const fetchOriginal = window.fetch;
  window.fetch = async function (...args) {
    const resposta = await fetchOriginal.apply(this, args);

    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
      const ehPublicacaoDeClassificado =
        url.includes('/api/v1/classificados/publicar') ||
        url.includes('/api/v1/classificados/confirmar/');

      if (ehPublicacaoDeClassificado && resposta.ok) {
        resposta
          .clone()
          .json()
          .then(dados => {
            if (dados && dados.id && dados.editToken) {
              salvarAnuncio(dados.id, dados.editToken);
            }
          })
          .catch(() => {});
      }
    } catch (_) {
      // Nunca deixa a interceptação quebrar a chamada original
    }

    return resposta;
  };

  // ── Botão flutuante ──────────────────────────────────────────────
  function criarBotaoFlutuante() {
    const btn = document.createElement('button');
    btn.id = 'meus-anuncios-btn';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Meus anúncios publicados');
    btn.textContent = '📋 Meus Anúncios';
    btn.style.cssText = `
      position: fixed; bottom: 20px; right: 20px; z-index: 9998;
      background: #2f6e3b; color: #fff; border: none; border-radius: 999px;
      padding: 12px 20px; font-family: system-ui, sans-serif; font-size: 14px;
      font-weight: 700; box-shadow: 0 4px 16px rgba(0,0,0,.25); cursor: pointer;
      display: none;
    `;
    btn.addEventListener('click', abrirPainel);
    document.body.appendChild(btn);
    return btn;
  }

  function atualizarVisibilidadeBotao() {
    const btn = document.getElementById('meus-anuncios-btn') || criarBotaoFlutuante();
    const qtd = lerAnunciosSalvos().length;
    btn.style.display = qtd > 0 ? 'block' : 'none';
    btn.textContent = qtd > 0 ? `📋 Meus Anúncios (${qtd})` : '📋 Meus Anúncios';
  }

  // ── Painel — lista, edita, salva ─────────────────────────────────
  function criarOverlay() {
    const overlay = document.createElement('div');
    overlay.id = 'meus-anuncios-overlay';
    overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 9999; background: rgba(0,0,0,.55);
      display: flex; align-items: center; justify-content: center; padding: 16px;
      font-family: system-ui, sans-serif;
    `;
    overlay.addEventListener('click', e => { if (e.target === overlay) fecharPainel(); });

    const caixa = document.createElement('div');
    caixa.style.cssText = `
      background: #fff; border-radius: 12px; padding: 20px; max-width: 480px;
      width: 100%; max-height: 80vh; overflow-y: auto;
    `;
    caixa.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <h2 style="margin:0;font-size:18px;color:#1a2e1e">Meus Anúncios</h2>
        <button id="meus-anuncios-fechar" aria-label="Fechar" style="background:none;border:none;font-size:22px;cursor:pointer;color:#666">×</button>
      </div>
      <div id="meus-anuncios-lista">Carregando…</div>
    `;
    overlay.appendChild(caixa);
    document.body.appendChild(overlay);
    document.getElementById('meus-anuncios-fechar').addEventListener('click', fecharPainel);
    return overlay;
  }

  function fecharPainel() {
    const overlay = document.getElementById('meus-anuncios-overlay');
    if (overlay) overlay.remove();
  }

  function escaparHtml(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  async function abrirPainel() {
    const overlay = document.getElementById('meus-anuncios-overlay') || criarOverlay();
    const listaEl = document.getElementById('meus-anuncios-lista');
    const salvos = lerAnunciosSalvos();

    if (salvos.length === 0) {
      listaEl.innerHTML = '<p style="color:#666">Nenhum anúncio salvo neste navegador.</p>';
      return;
    }

    listaEl.innerHTML = 'Carregando…';
    const cartoes = await Promise.all(salvos.map(async (salvo) => {
      try {
        const r = await fetch(`${backendUrl}/api/v1/classificados/${salvo.id}`);
        if (!r.ok) {
          removerAnuncioSalvo(salvo.id); // anúncio expirado/removido — limpa do storage
          return '';
        }
        const dados = await r.json();
        return montarCartaoEdicao(salvo.id, salvo.editToken, dados);
      } catch (_) {
        return '';
      }
    }));

    const html = cartoes.filter(Boolean).join('');
    listaEl.innerHTML = html || '<p style="color:#666">Nenhum anúncio ativo encontrado.</p>';

    salvos.forEach(salvo => {
      const form = document.getElementById(`ma-form-${salvo.id}`);
      if (form) form.addEventListener('submit', e => salvarEdicao(e, salvo.id, salvo.editToken));
    });
  }

  function montarCartaoEdicao(id, editToken, dados) {
    return `
      <form id="ma-form-${id}" style="border:1px solid #ddd;border-radius:8px;padding:14px;margin-bottom:12px">
        <label style="display:block;font-size:12px;color:#555;margin-bottom:4px">Empresa</label>
        <input name="empresa" value="${escaparHtml(dados.empresa)}" maxlength="60" required
          style="width:100%;padding:8px;border:1px solid #ccc;border-radius:6px;margin-bottom:8px;box-sizing:border-box">

        <label style="display:block;font-size:12px;color:#555;margin-bottom:4px">Título</label>
        <input name="titulo" value="${escaparHtml(dados.titulo)}" maxlength="80" required
          style="width:100%;padding:8px;border:1px solid #ccc;border-radius:6px;margin-bottom:8px;box-sizing:border-box">

        <label style="display:block;font-size:12px;color:#555;margin-bottom:4px">Descrição</label>
        <textarea name="desc" maxlength="200" rows="3" required
          style="width:100%;padding:8px;border:1px solid #ccc;border-radius:6px;margin-bottom:8px;box-sizing:border-box">${escaparHtml(dados.descricao)}</textarea>

        <label style="display:block;font-size:12px;color:#555;margin-bottom:4px">WhatsApp</label>
        <input name="wpp" value="${escaparHtml(dados.wpp)}" maxlength="11"
          style="width:100%;padding:8px;border:1px solid #ccc;border-radius:6px;margin-bottom:10px;box-sizing:border-box">

        <div id="ma-msg-${id}" style="font-size:13px;margin-bottom:8px"></div>
        <button type="submit" style="background:#2f6e3b;color:#fff;border:none;border-radius:6px;padding:10px 16px;font-weight:700;cursor:pointer;width:100%">
          Salvar alterações
        </button>
      </form>
    `;
  }

  async function salvarEdicao(evento, id, editToken) {
    evento.preventDefault();
    const form = evento.target;
    const msgEl = document.getElementById(`ma-msg-${id}`);
    const dadosForm = new FormData(form);

    msgEl.textContent = 'Salvando…';
    msgEl.style.color = '#555';

    try {
      const r = await fetch(`${backendUrl}/api/v1/classificados/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          editToken,
          empresa: dadosForm.get('empresa'),
          titulo: dadosForm.get('titulo'),
          desc: dadosForm.get('desc'),
          wpp: dadosForm.get('wpp'),
        }),
      });
      const corpo = await r.json();

      if (r.ok) {
        msgEl.textContent = '✅ Salvo com sucesso!';
        msgEl.style.color = '#2f6e3b';
      } else if (r.status === 403) {
        msgEl.textContent = '❌ Não foi possível confirmar que este anúncio é seu.';
        msgEl.style.color = '#b23b3b';
      } else {
        msgEl.textContent = `❌ ${corpo.erro || 'Erro ao salvar.'}`;
        msgEl.style.color = '#b23b3b';
      }
    } catch (_) {
      msgEl.textContent = '❌ Erro de conexão. Tente novamente.';
      msgEl.style.color = '#b23b3b';
    }
  }

  // ── Inicialização ────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', atualizarVisibilidadeBotao);
  } else {
    atualizarVisibilidadeBotao();
  }
})();
