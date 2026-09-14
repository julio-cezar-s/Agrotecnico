/**
 * ══════════════════════════════════════════════════════════════════
 * NAVEGAÇÃO RÁPIDA — faixa "Mais no AgroTécnico" + botão do menu
 * ══════════════════════════════════════════════════════════════════
 * Arquivo independente: usa addEventListener direto (permitido pela
 * CSP — script-src 'self' só bloqueia handler inline tipo onclick="..."
 * no HTML, não código carregado via <script src>), sem precisar dos
 * arquivos que hoje cuidam da navegação por índice numérico
 * (data-csph-click) nem da função abrirLoginTecnico.
 *
 * A checagem de sessão (GET /api/v1/tecnico/me) é feita UMA VEZ só e
 * reaproveitada pelos dois botões que dependem dela:
 *
 *   1. #hub-btn-parceiros → abre #secao-parceiros (classe .ativa).
 *
 *   2. #hub-btn-tecnico (faixa "Mais no AgroTécnico") e
 *      #menu-btn-tecnico (aba do menu):
 *        logado     → abre #secao-tecnico (dashboard) e, no caso do
 *                     botão do menu, já leva direto pra aba "Perfil"
 *                     via tdAba('perfil') — função global já existente
 *                     no inline-12.js, que carrega antes deste arquivo.
 *        não logado → abre #modal-login-tecnico (classe .open), que já
 *                     tem o link "Cadastre-se grátis →" pra quem ainda
 *                     não tem conta.
 *
 *   Pra adicionar uma área nova no futuro: criar o botão dentro de
 *   #hub-nav-botoes com a classe .hub-nav-btn (ou o item de menu
 *   correspondente), e registrar o clique aqui embaixo, no mesmo
 *   padrão dos já existentes.
 * ══════════════════════════════════════════════════════════════════
 */
(function () {
  'use strict';

  const backendUrl = typeof BACKEND_URL !== 'undefined' ? BACKEND_URL : '';

  function abrirTela(id, classeAtiva) {
    const el = document.getElementById(id);
    if (el) el.classList.add(classeAtiva);
  }

  // ── Botão: Parceiros e Descontos ────────────────────────────────
  const btnParceiros = document.getElementById('hub-btn-parceiros');
  if (btnParceiros) {
    btnParceiros.addEventListener('click', () => abrirTela('secao-parceiros', 'ativa'));
  }

  // ── Checagem de sessão única, reaproveitada pelos dois botões ───
  async function verificarSessaoTecnico() {
    try {
      const r = await fetch(`${backendUrl}/api/v1/tecnico/me`, { credentials: 'include' });
      return r.ok; // 200 = sessão válida, 401 = não logado
    } catch (_) {
      return false; // rede falhou — trata como não logado, não trava os botões
    }
  }

  const sessaoPromise = verificarSessaoTecnico();

  // ── Botão da faixa: Meu Perfil / Já sou Técnico ─────────────────
  const btnHub = document.getElementById('hub-btn-tecnico');
  if (btnHub) {
    sessaoPromise.then(logado => {
      btnHub.textContent = logado ? '👤 Meu Perfil' : '🔑 Já sou Técnico';
      btnHub.dataset.logado = logado ? '1' : '0';
    });
    btnHub.addEventListener('click', () => {
      if (btnHub.dataset.logado === '1') {
        abrirTela('secao-tecnico', 'ativa');
      } else {
        abrirTela('modal-login-tecnico', 'open');
      }
    });
  }

  // ── Botão do menu: mesma lógica, mas leva direto pra aba Perfil ──
  const btnMenu = document.getElementById('menu-btn-tecnico');
  const tituloMenu = document.getElementById('menu-btn-tecnico-titulo');
  const subMenu = document.getElementById('menu-btn-tecnico-sub');
  if (btnMenu) {
    sessaoPromise.then(logado => {
      btnMenu.dataset.logado = logado ? '1' : '0';
      if (tituloMenu) tituloMenu.textContent = logado ? 'Meu Perfil' : 'Já sou técnico — Entrar';
      if (subMenu) subMenu.textContent = logado ? 'Ver e editar seus dados' : 'Painel do técnico cadastrado';
    });
    btnMenu.addEventListener('click', () => {
      if (btnMenu.dataset.logado === '1') {
        abrirTela('secao-tecnico', 'ativa');
        if (typeof tdAba === 'function') tdAba('perfil');
      } else {
        abrirTela('modal-login-tecnico', 'open');
      }
    });
  }
})();
