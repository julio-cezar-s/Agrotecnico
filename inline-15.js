/**
 * ══════════════════════════════════════════════════════════════════
 * DESTAQUE DE CONSELHO VERIFICADO
 * ══════════════════════════════════════════════════════════════════
 * Arquivo independente — mesmo espírito do inline-13.js/inline-14.js.
 * Não modifica o arquivo que renderiza os cards de técnico na
 * listagem (#lista-tecnicos); em vez disso:
 *
 *   1. Intercepta window.fetch pra capturar, de qualquer resposta de
 *      /api/v1/tecnicos, o mapa { publicId → verificadoPorConselho }.
 *   2. Observa #lista-tecnicos com MutationObserver — toda vez que a
 *      listagem é (re)renderizada, aplica o destaque nos cards cujo
 *      data-id bate com um técnico verificado.
 *
 * Pressupõe que cada card renderizado tem data-id="{publicId}" no
 * elemento .tc-card — é o padrão já usado no projeto (visto nos cards
 * de exemplo removidos anteriormente). Se a renderização real usar
 * outro atributo, este arquivo precisa ser ajustado nesse ponto.
 * ══════════════════════════════════════════════════════════════════
 */
(function () {
  'use strict';

  let mapaVerificados = {}; // publicId -> true/false

  function extrairMapa(dados) {
    const lista = Array.isArray(dados) ? dados : (dados?.tecnicos || []);
    lista.forEach(t => {
      if (t && t.publicId) mapaVerificados[t.publicId] = !!t.verificadoPorConselho;
    });
  }

  // ── Interceptação do fetch — só leitura, nunca altera a resposta ──
  const fetchOriginal = window.fetch;
  window.fetch = async function (...args) {
    const resposta = await fetchOriginal.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
      if (url.includes('/api/v1/tecnicos') && !url.includes('/api/v1/tecnicos/')) {
        resposta.clone().json().then(extrairMapa).catch(() => {});
      }
    } catch (_) {}
    return resposta;
  };

  // ── Aplica o destaque nos cards já presentes no DOM ─────────────
  function aplicarDestaques() {
    const cards = document.querySelectorAll('#lista-tecnicos .tc-card[data-id]');
    cards.forEach(card => {
      const publicId = card.getAttribute('data-id');
      const verificado = mapaVerificados[publicId];

      card.classList.toggle('verificado-conselho', !!verificado);

      const jaTemBadge = card.querySelector('.badge-conselho');
      if (verificado && !jaTemBadge) {
        const badge = document.createElement('span');
        badge.className = 'badge-conselho';
        badge.textContent = '✅ Registro profissional verificado';
        card.insertBefore(badge, card.firstChild);
      } else if (!verificado && jaTemBadge) {
        jaTemBadge.remove();
      }
    });
  }

  // ── Observa a listagem — reaplica sempre que ela for repintada ──
  function iniciarObservador() {
    const container = document.getElementById('lista-tecnicos');
    if (!container) return;

    const observador = new MutationObserver(() => aplicarDestaques());
    observador.observe(container, { childList: true, subtree: false });
    aplicarDestaques(); // caso já tenha algo renderizado antes deste script carregar
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciarObservador);
  } else {
    iniciarObservador();
  }
})();
