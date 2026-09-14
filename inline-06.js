
// ══════════════════════════════════════════════════════════════
// MÓDULO PRODUTOR — Sessão real de servidor (cookie HttpOnly)
// ─────────────────────────────────────────────────────────────
// Antes (auditoria 20/07/2026, Achado #1): cadastro e login gravavam
// só em localStorage — nenhum dado sobrevivia à troca de aparelho ou
// navegador, e o admin nunca via a base real de produtores. Agora usa
// POST /api/v1/produtor/cadastrar, /login, /logout, GET /verificar e
// /me — a mesma arquitetura de sessão já usada para técnico e admin.
// ══════════════════════════════════════════════════════════════

/** Cache em memória da sessão do produtor logado — null se deslogado. */
let PROD_SESSAO = null;

function _prodBackendUrl() {
  return typeof BACKEND_URL !== 'undefined' ? BACKEND_URL : '';
}

/**
 * Consulta o backend para saber se há sessão de produtor válida
 * (cookie HttpOnly, não legível via JS) e, se houver, carrega os
 * dados completos (nome, ident, favoritos). Atualiza PROD_SESSAO.
 */
async function prodCarregarSessao() {
  try {
    const r = await fetch(`${_prodBackendUrl()}/api/v1/produtor/me`, { credentials: 'include' });
    if (!r.ok) { PROD_SESSAO = null; return null; }
    PROD_SESSAO = await r.json();
    return PROD_SESSAO;
  } catch {
    PROD_SESSAO = null;
    return null;
  }
}

// ── MODAL ─────────────────────────────────────────────────────

let _prodScrollY = 0;
let _prodFocusOrigin = null;

async function abrirModalProdutor() {
  _prodScrollY       = window.scrollY;
  _prodFocusOrigin   = document.activeElement;
  const modal        = document.getElementById('modal-login-produtor');
  modal.classList.add('open');
  document.body.style.overflow = 'hidden';
  await prodRenderizarEstado();
  requestAnimationFrame(() => {
    const primeiro = modal.querySelector('input:not([type=hidden]), button.prod-sair');
    if (primeiro) primeiro.focus();
  });
}

function fecharModalProdutor() {
  document.getElementById('modal-login-produtor').classList.remove('open');
  document.body.style.overflow = '';
  window.scrollTo({ top: _prodScrollY, behavior: 'instant' });
  if (_prodFocusOrigin) {
    requestAnimationFrame(() => { _prodFocusOrigin.focus({ preventScroll: true }); _prodFocusOrigin = null; });
  }
}

// Fecha ao clicar no backdrop
function hdlProdOverlay(e) {
  if (e.target === document.getElementById('modal-login-produtor')) fecharModalProdutor();
}

// ESC fecha
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.getElementById('modal-login-produtor').classList.contains('open'))
    fecharModalProdutor();
});

// ── ABAS ──────────────────────────────────────────────────────

function prodAba(qual) {
  ['login','cadastro'].forEach(id => {
    document.getElementById(`prod-painel-${id}`).classList.toggle('ativo', id === qual);
    const tab = document.getElementById(`tab-${id}`);
    tab.classList.toggle('ativa', id === qual);
    tab.setAttribute('aria-selected', id === qual);
  });
  document.querySelectorAll('.prod-err.show').forEach(e => e.classList.remove('show'));
  document.querySelectorAll('.prod-input.err').forEach(e => e.classList.remove('err'));
}

// ── RENDERIZAÇÃO DE ESTADO ────────────────────────────────────

async function prodRenderizarEstado() {
  const dados     = await prodCarregarSessao();
  const btn       = document.getElementById('nav-prod-btn');
  const deslogado = document.getElementById('prod-painel-deslogado');
  const conta     = document.getElementById('prod-painel-conta');

  if (dados) {
    // Nav — estado logado
    btn.innerHTML = `
      <span class="nav-prod-avatar">${_x(dados.nome.charAt(0).toUpperCase())}</span>
      <span class="nav-prod-nome">${_x(dados.nome.split(' ')[0])}</span>`;
    btn.classList.add('logado');
    btn.setAttribute('aria-label', `Olá, ${dados.nome} — abrir área do produtor`);

    // Modal — painel da conta
    deslogado.style.display = 'none';
    conta.style.display     = 'block';
    document.getElementById('prod-av-inicial').textContent   = dados.nome.charAt(0).toUpperCase();
    document.getElementById('prod-nome-exibido').textContent  = `Olá, ${dados.nome}!`;
    document.getElementById('prod-email-exibido').textContent = dados.ident || '—';
    const n = (dados.favoritos || []).length;
    document.getElementById('prod-fav-count').textContent     = n === 1 ? '1 técnico' : `${n} técnicos`;

    // Sincroniza corações dos cards com favoritos salvos
    prodSincronizarFavs(dados.favoritos || []);

  } else {
    // Nav — estado deslogado
    btn.innerHTML = '<span>👤</span><span>Entrar</span>';
    btn.classList.remove('logado');
    btn.setAttribute('aria-label', 'Área do Produtor — entrar ou criar conta');

    // Modal — painéis de login/cadastro
    deslogado.style.display = 'block';
    conta.style.display     = 'none';
    prodAba('login'); // sempre abre na aba login

    // Garante que nenhum coração fique marcado se a sessão expirou
    prodSincronizarFavs([]);
  }
}

// ── UTILITÁRIO: validação e máscara do campo identificador ───

/**
 * Detecta se o valor é telefone ou e-mail.
 * Regra infalível: qualquer string com '@' é e-mail.
 * Sem '@', trata como telefone — nenhum número de telefone contém '@'.
 * Retorna 'tel' | 'email' | '' (vazio).
 */
function prodTipoIdent(v) {
  if (!v) return '';
  return v.includes('@') ? 'email' : 'tel';
}

/**
 * Formata dígitos puros no padrão BR: (XX) XXXXX-XXXX.
 * Extrai só dígitos antes de formatar — aceita qualquer entrada suja.
 */
function aplicarMascaraTel(v) {
  let d = String(v).replace(/\D/g, "");
  if (d.length > 11) d = d.slice(0, 11);
  if (d.length === 0) return "";
  if (d.length === 1) return "(" + d;
  if (d.length === 2) return "(" + d;
  if (d.length <= 6)  return "(" + d.slice(0,2) + ") " + d.slice(2);
  if (d.length <= 10) return "(" + d.slice(0,2) + ") " + d.slice(2,6) + "-" + d.slice(6);
  return "(" + d.slice(0,2) + ") " + d.slice(2,7) + "-" + d.slice(7);
}

/**
 * Valida o identificador: e-mail válido OU telefone com 10–11 dígitos.
 */
function prodValidarIdent(v) {
  if (!v) return false;
  if (prodTipoIdent(v) === 'tel') {
    const digitos = v.replace(/\D/g, '');
    return digitos.length >= 10 && digitos.length <= 11;
  }
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

/**
 * Listener de máscara inteligente — letra vs. número.
 */
function prodMascaraListener(e) {
  const inp     = e.target;
  const raw     = inp.value;
  const digitos = raw.replace(/\D/g, '');

  if (raw.includes('@') || digitos.length === 0) return;

  inp.removeAttribute('maxlength');

  const antesLen  = raw.length;
  const posCursor = inp.selectionStart ?? antesLen;
  const mascarado = aplicarMascaraTel(digitos);

  inp.value = mascarado;
  inp.setAttribute('maxlength', digitos.length > 0 ? '15' : '100');

  const novoCursor = Math.max(0, posCursor + (mascarado.length - antesLen));
  try { inp.setSelectionRange(novoCursor, novoCursor); } catch (_) {}
}

['prod-email-login', 'prod-email-cad'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('input', prodMascaraListener);
});

// ── LOGIN ─────────────────────────────────────────────────────

async function prodEntrar() {
  const ident = document.getElementById('prod-email-login').value.trim();
  const senha = document.getElementById('prod-senha-login').value;
  let ok = true;

  const identValido = prodValidarIdent(ident);
  document.getElementById('prod-email-login').classList.toggle('err', !identValido);
  document.getElementById('prod-err-email-login').classList.toggle('show', !identValido);
  if (!identValido) ok = false;

  document.getElementById('prod-senha-login').classList.toggle('err', !senha);
  document.getElementById('prod-err-senha-login').classList.toggle('show', !senha);
  if (!senha) ok = false;

  if (!ok) return;

  const errGeral = document.getElementById('prod-err-login-geral');
  errGeral.classList.remove('show');

  const btn = document.getElementById('btn-prod-entrar');
  const textoOriginal = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Entrando…';

  try {
    const r = await fetch(`${_prodBackendUrl()}/api/v1/produtor/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ identificador: ident, senha }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      errGeral.textContent = data?.erro || 'Identificador ou senha incorretos.';
      errGeral.classList.add('show');
      return;
    }
  } catch (err) {
    errGeral.textContent = 'Não foi possível conectar ao servidor. Tente novamente.';
    errGeral.classList.add('show');
    return;
  } finally {
    btn.disabled = false;
    btn.textContent = textoOriginal;
  }

  document.getElementById('prod-email-login').value = '';
  document.getElementById('prod-senha-login').value = '';
  await prodRenderizarEstado();
}

// ── CADASTRO ──────────────────────────────────────────────────

async function prodCadastrar() {
  const nome    = document.getElementById('prod-nome-cad').value.trim();
  const ident   = document.getElementById('prod-email-cad').value.trim();
  const senha   = document.getElementById('prod-senha-cad').value;
  const aceitouNovidades = document.getElementById('prod-optin-novidades').checked;
  let ok = true;

  [
    ['prod-nome-cad',  'prod-err-nome-cad',  nome.length > 1],
    ['prod-email-cad', 'prod-err-email-cad', prodValidarIdent(ident)],
    ['prod-senha-cad', 'prod-err-senha-cad', senha.length >= 6],
  ].forEach(([inpId, errId, valido]) => {
    document.getElementById(inpId).classList.toggle('err', !valido);
    document.getElementById(errId).classList.toggle('show', !valido);
    if (!valido) ok = false;
  });

  if (!ok) return;

  const btn = document.getElementById('btn-prod-cadastrar');
  const textoOriginal = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Criando conta…';

  try {
    const r = await fetch(`${_prodBackendUrl()}/api/v1/produtor/cadastrar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ nome, identificador: ident, senha, aceitaNovidades: aceitouNovidades }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      // Erro mais comum: conta já existe com este identificador
      document.getElementById('prod-email-cad').classList.add('err');
      document.getElementById('prod-err-email-cad').textContent = data?.erro || 'Não foi possível criar a conta.';
      document.getElementById('prod-err-email-cad').classList.add('show');
      return;
    }
  } catch (err) {
    alert('Não foi possível conectar ao servidor. Tente novamente.');
    return;
  } finally {
    btn.disabled = false;
    btn.textContent = textoOriginal;
  }

  ['prod-nome-cad','prod-email-cad','prod-senha-cad'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('prod-optin-novidades').checked = false;

  // Sessão já foi criada pelo backend (cookie) — só re-renderiza.
  await prodRenderizarEstado();
}

// ── LOGOUT ────────────────────────────────────────────────────

async function prodSair() {
  try {
    await fetch(`${_prodBackendUrl()}/api/v1/produtor/logout`, {
      method: 'POST',
      credentials: 'include',
    });
  } catch (_) { /* mesmo se falhar, limpamos o estado local abaixo */ }

  PROD_SESSAO = null;
  document.querySelectorAll('.btn-fav.favoritado').forEach(b => {
    b.classList.remove('favoritado');
    b.textContent = '♡';
    b.setAttribute('aria-pressed','false');
  });
  await prodRenderizarEstado();
}

// ── FAVORITOS ─────────────────────────────────────────────────

/**
 * Alterna o favorito de um técnico via backend (POST /api/v1/produtor/
 * favoritos/:tecnicoId — requer sessão). Se não houver sessão válida,
 * abre o modal de login em vez de tentar favoritar.
 * @param {string|number} tecId - id numérico real do técnico
 * @param {HTMLElement}    btn   - botão .btn-fav clicado
 */
async function toggleFav(tecId, btn) {
  if (!PROD_SESSAO) {
    // Confere no servidor antes de assumir deslogado — a sessão pode
    // ter sido criada em outra aba desde a última verificação local.
    await prodCarregarSessao();
    if (!PROD_SESSAO) {
      abrirModalProdutor();
      return;
    }
  }

  const idNum = Number(tecId);
  let resultado;
  try {
    const r = await fetch(`${_prodBackendUrl()}/api/v1/produtor/favoritos/${idNum}`, {
      method: 'POST',
      credentials: 'include',
    });
    if (r.status === 401) {
      PROD_SESSAO = null;
      abrirModalProdutor();
      return;
    }
    resultado = await r.json();
    if (!r.ok) throw new Error(resultado?.erro || 'Falha ao favoritar.');
  } catch (err) {
    console.error('[favoritos] Erro:', err?.message);
    return;
  }

  const favoritado = !!resultado.favoritado;
  btn.classList.toggle('favoritado', favoritado);
  btn.textContent = favoritado ? '♥' : '♡';
  btn.setAttribute('aria-pressed', String(favoritado));
  const labelAtual = btn.getAttribute('aria-label') || '';
  btn.setAttribute('aria-label', favoritado
    ? labelAtual.replace('Favoritar','Desfavoritar')
    : labelAtual.replace('Desfavoritar','Favoritar'));

  // Mantém o cache local em sincronia para o contador do painel da conta
  if (PROD_SESSAO) {
    const favs = new Set((PROD_SESSAO.favoritos || []).map(Number));
    if (favoritado) favs.add(idNum); else favs.delete(idNum);
    PROD_SESSAO.favoritos = [...favs];
    const contador = document.getElementById('prod-fav-count');
    if (contador) {
      const n = PROD_SESSAO.favoritos.length;
      contador.textContent = n === 1 ? '1 técnico' : `${n} técnicos`;
    }
  }
}

/**
 * Sincroniza os ícones de coração com o array de favoritos salvo.
 * `favs` pode conter ids numéricos (backend) — normaliza para Number
 * antes de comparar com o data-id (string) de cada card.
 */
function prodSincronizarFavs(favs) {
  const favsNum = (favs || []).map(Number);
  document.querySelectorAll('.btn-fav').forEach(btn => {
    const card  = btn.closest('[data-id]');
    if (!card) return;
    const tecId = Number(card.dataset.id);
    const fav   = favsNum.includes(tecId);
    btn.classList.toggle('favoritado', fav);
    btn.textContent = fav ? '♥' : '♡';
    btn.setAttribute('aria-pressed', fav ? 'true' : 'false');
  });
}

/**
 * Wrapper chamado por inline-02.js sempre que novos cards são
 * renderizados dinamicamente (busca/carga inicial), para que os
 * corações apareçam corretos mesmo sem o modal do produtor ter sido
 * aberto ainda nesta visita.
 */
function prodSincronizarFavoritosDOM() {
  if (PROD_SESSAO) prodSincronizarFavs(PROD_SESSAO.favoritos || []);
}

// ── INICIALIZAÇÃO ─────────────────────────────────────────────
// Roda ao carregar a página — restaura estado de sessão na nav
(async function prodInit() {
  await prodRenderizarEstado();
})();
