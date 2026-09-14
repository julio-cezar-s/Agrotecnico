
// ══════════════════════════════════════════════════════════════
// MODAL UPGRADE PREMIUM — Fluxo seguro com polling por paymentId
//
// ARQUITETURA DE SEGURANÇA (recomendação da IA do MP):
//   1. upgGerarPix()  → POST /criar-pix — recebe pagamento_id do backend
//   2. Frontend NUNCA ativa Premium por conta própria
//   3. iniciarPollingPagamento(paymentId) → GET /status/id/:paymentId
//      a cada 3 segundos (30 min de TTL = 600 tentativas máx.)
//   4. Quando backend confirmar aprovado:true → upgAtivarPremium()
//
// POLLING POR paymentId (não por identificador):
//   Mais seguro — o backend confere o paymentId real dentro do
//   premiums.json que só é populado após o webhook com 4 travas.
// ══════════════════════════════════════════════════════════════

// BUG CRÍTICO CORRIGIDO (integração 20/07/2026): este valor estava
// hardcoded como 'http://localhost:3000'. Como o server.js serve tanto
// o HTML quanto a API a partir da MESMA origem (ver app.get('/', ...)
// em server.js), qualquer fetch usando esse valor tentava, a partir do
// navegador do usuário em produção, acessar 'localhost:3000' — ou
// seja, o próprio computador do usuário, não o servidor. Isso quebrava
// silenciosamente todo o fluxo de pagamento (Pix e cartão) assim que
// publicado fora do ambiente de desenvolvimento local. String vazia =
// caminho relativo = mesma origem que serviu a página, em qualquer
// ambiente (local, Render, etc.).
const BACKEND_URL   = '';
let UPG_PIX_VALOR = 29.90; // carregado dinamicamente do servidor

/**
 * Lê a sessão local do técnico neste navegador — criada logo após o
 * cadastro (ver finalizarComStatus em inline-03.js). Não é um login
 * persistente entre aparelhos (a interface ainda não tem uma tela de
 * "técnico, faça login" dedicada): é o suficiente para o próprio
 * técnico ativar Premium, publicar demandas do mural e emitir
 * documentos logo após se cadastrar neste mesmo navegador — sem
 * recorrer a um id inventado ('tec-demo') nem à sessão do produtor.
 */
function tecLerSessaoLocal() {
  try { return JSON.parse(localStorage.getItem('agro_tec_local') || 'null'); }
  catch { return null; }
}
function tecSalvarSessaoLocal(dados) {
  try { localStorage.setItem('agro_tec_local', JSON.stringify(dados)); } catch (_) {}
}

/** Carrega o preço do backend e atualiza o modal e as parcelas */
async function carregarPrecoPremium() {
  try {
    const backendUrl = typeof BACKEND_URL !== 'undefined' ? BACKEND_URL : '';
    const r = await fetch(`${backendUrl}/api/v1/preco-premium`, { cache: 'no-store' })
      .catch(() => null);
    if (r && r.ok) {
      const data = await r.json().catch(() => ({}));
      if (data.valor && !isNaN(data.valor)) {
        UPG_PIX_VALOR = parseFloat(data.valor);
        _aplicarPrecoNaTela(UPG_PIX_VALOR);
      }
    }
  } catch (_) {}
}

function _aplicarPrecoNaTela(valor) {
  const fmt = valor.toLocaleString('pt-BR', { minimumFractionDigits: 2 });
  // Atualiza o preço exibido no modal
  const exib = document.getElementById('upg-preco-exib');
  if (exib) exib.textContent = `R$ ${fmt}`;
  // Atualiza as parcelas do cartão
  const sel = document.getElementById('card-parcelas');
  if (sel) {
    const parcs = [1,2,3,4,5];
    sel.innerHTML = parcs.map(n => {
      const v = (valor / n).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
      return `<option value="${n}">${n}× de R$ ${v} (sem juros)</option>`;
    }).join('');
  }
  // Atualiza o campo no admin se estiver aberto
  const inp = document.getElementById('adm-preco-input');
  if (inp && !inp.value) inp.value = valor.toFixed(2);
}

/** Admin: carrega preços do backend e preenche os inputs */
async function admCarregarPrecos() {
  const backendUrl = typeof BACKEND_URL !== 'undefined' ? BACKEND_URL : '';
  try {
    const r = await fetch(`${backendUrl}/api/v1/config/precos`, { cache: 'no-store' })
      .catch(() => null);
    if (r && r.ok) {
      const data = await r.json().catch(() => ({}));
      const inpP = document.getElementById('adm-preco-premium');
      const inpC = document.getElementById('adm-preco-classificado');
      if (inpP && data.premium)     inpP.value = parseFloat(data.premium).toFixed(2);
      if (inpC && data.classificado) inpC.value = parseFloat(data.classificado).toFixed(2);
    }
  } catch (_) {}
}

/** Admin: salva ambos os preços no backend */
async function admSalvarPrecos() {
  const inpP   = document.getElementById('adm-preco-premium');
  const inpC   = document.getElementById('adm-preco-classificado');
  const status = document.getElementById('adm-preco-status');
  const btn    = document.getElementById('adm-preco-btn');

  const premium     = parseFloat(inpP?.value);
  const classificado = parseFloat(inpC?.value);

  if (!premium || premium < 1 || premium > 999) {
    status.textContent = '⚠ Valor Premium inválido (R$ 1,00 a R$ 999,00).';
    inpP?.focus();
    return;
  }
  if (!classificado || classificado < 1 || classificado > 999) {
    status.textContent = '⚠ Valor de Parceiro inválido (R$ 1,00 a R$ 999,00).';
    inpC?.focus();
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = '⏳ Salvando…'; }

  const backendUrl = typeof BACKEND_URL !== 'undefined' ? BACKEND_URL : '';
  try {
    const r = await fetch(`${backendUrl}/api/v1/config/precos`, {
      method:      'POST',
      credentials: 'include',
      headers:     { 'Content-Type': 'application/json' },
      body:        JSON.stringify({ premium, classificado }),
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok) {
      // Aplica o preço premium também na tela de upgrade
      UPG_PIX_VALOR = premium;
      _aplicarPrecoNaTela(premium);
      status.textContent = `✓ Preços salvos — Premium: R$ ${premium.toFixed(2).replace('.',',')} | Parceiro: R$ ${classificado.toFixed(2).replace('.',',')}`;
    } else {
      status.textContent = '❌ ' + (data.erro || 'Erro ao salvar.');
    }
  } catch (_) {
    // Fallback offline
    UPG_PIX_VALOR = premium;
    _aplicarPrecoNaTela(premium);
    status.textContent = '⚠ Offline — preços aplicados localmente.';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '💾 Salvar Configurações de Preço'; }
  }
}

// Carrega o preço ao abrir a página
carregarPrecoPremium();

let _upgScrollY       = 0;
let _upgFocusOrigin   = null;
let _upgPollingTimer  = null;  // ID do setInterval do polling por paymentId
let _upgPaymentId     = null;  // ID do pagamento retornado pelo backend
let _upgIdentPagador  = '';    // identificador do técnico (fallback para polling antigo)

/** Payload PIX simulado — usado apenas em modo offline/dev sem backend */
function upgGerarPayloadPix() {
  return '00020126580014BR.GOV.BCB.PIX0136contato@agrotecnico.com.br5204000053039865802BR5925AgroTecnico Plataforma Di6009SAO PAULO62070503***6304ABCD';
}

function abrirModalPremium() {
  _upgScrollY    = window.scrollY;
  _upgFocusOrigin = document.activeElement;

  // Reset do estado do modal
  document.getElementById('upg-pix-box').classList.remove('visivel');
  const btnGerar = document.getElementById('upg-btn-gerar');
  btnGerar.disabled    = false;
  btnGerar.textContent = '🔑 Gerar Pix de Assinatura';
  const btnCopiar = document.getElementById('upg-btn-copiar');
  btnCopiar.classList.remove('copiado');
  btnCopiar.textContent = '📋 Copiar código Pix';

  // Remove área de status de polling se existir de sessão anterior
  const statusAnt = document.getElementById('upg-polling-status');
  if (statusAnt) statusAnt.remove();

  // Reset cartão
  ['card-numero','card-nome','card-validade','card-cvv'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.value = ''; el.classList.remove('err'); }
  });
  ['card-err-numero','card-err-nome','card-err-validade','card-err-cvv'].forEach(id => {
    document.getElementById(id)?.classList.remove('show');
  });
  const cardParcelas = document.getElementById('card-parcelas');
  if (cardParcelas) cardParcelas.value = '1';
  const btnCard = document.getElementById('upg-btn-pagar-card');
  if (btnCard) { btnCard.disabled = false; btnCard.textContent = '💳 Pagar com Cartão'; }

  // Volta sempre para aba Pix ao abrir
  upgTrocarAba('pix');

  upgPararPolling();

  // Atualiza o preço ao abrir o modal
  carregarPrecoPremium();

  const modal = document.getElementById('modal-premium-tecnico');
  modal.classList.add('open');
  modal.scrollTop = 0;
  document.body.style.overflow = 'hidden';
  requestAnimationFrame(() => btnGerar.focus());
}

function fecharModalPremium() {
  upgPararPolling();
  document.getElementById('modal-premium-tecnico').classList.remove('open');
  document.body.style.overflow = '';
  window.scrollTo({ top: _upgScrollY, behavior: 'instant' });
  if (_upgFocusOrigin) {
    requestAnimationFrame(() => {
      _upgFocusOrigin.focus({ preventScroll: true });
      _upgFocusOrigin = null;
    });
  }
}

function hdlUpgOverlay(e) {
  if (e.target === document.getElementById('modal-premium-tecnico')) fecharModalPremium();
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.getElementById('modal-premium-tecnico').classList.contains('open'))
    fecharModalPremium();
});

// ── GERAÇÃO DO PIX ────────────────────────────────────────────

/**
 * Gera o QR Code Pix via backend.
 * Recebe o pagamento_id do backend e dispara o polling seguro por ID.
 * Se o backend estiver offline, usa payload simulado (modo dev).
 */
function upgGerarPix() {
  const btn = document.getElementById('upg-btn-gerar');
  btn.disabled    = true;
  btn.textContent = '⏳ Gerando…';

  // Coleta identificador do técnico logado (sessão local do próprio
  // técnico — nunca a sessão do produtor, que é uma pessoa diferente)
  const dadosTec    = tecLerSessaoLocal();
  _upgIdentPagador  = dadosTec ? (dadosTec.identificador || '') : '';
  _upgPaymentId     = null; // limpa paymentId de sessão anterior

  if (!dadosTec?.tecnicoId) {
    btn.disabled    = false;
    btn.textContent = '🔑 Gerar Pix de Assinatura';
    alert('Não encontramos seu cadastro de técnico neste navegador. Cadastre-se primeiro para ativar o Premium.');
    return;
  }

  const payload = JSON.stringify({
    nome:          dadosTec?.nome || 'Técnico AgroTécnico',
    identificador: _upgIdentPagador,
    tecnicoId:     dadosTec.tecnicoId,
    // Valor não enviado pelo cliente — o backend lê o preço configurado no banco
    descricao:     'AgroTécnico Premium — Destaque mensal',
  });

  fetch(`${BACKEND_URL}/api/v1/pagamentos/criar-pix`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    payload,
  })
    .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(data => {
      // Armazena o paymentId real para o polling seguro
      _upgPaymentId = data.pagamento_id || null;
      upgExibirPix(data.qr_code || upgGerarPayloadPix());

      if (_upgPaymentId) {
        // Polling primário: por paymentId (seguro — confirma o webhook)
        iniciarPollingPagamento(_upgPaymentId);
      } else if (_upgIdentPagador) {
        // Fallback: por identificador (compatibilidade com rota antiga)
        upgIniciarPollingLegado(_upgIdentPagador);
      }
    })
    .catch(() => {
      // Backend offline — modo dev: payload simulado sem polling real
      console.warn('[upg] Backend offline — exibindo Pix simulado (sem polling ativo)');
      upgExibirPix(upgGerarPayloadPix());
      upgMostrarStatusPolling('🔌 Modo offline — aguardando conexão com o servidor…', false);
    });
}

function upgExibirPix(pixPayload) {
  document.getElementById('upg-pix-codigo').textContent = pixPayload;
  document.getElementById('upg-pix-box').classList.add('visivel');
  document.getElementById('upg-btn-gerar').textContent = '✓ Pix gerado!';
  requestAnimationFrame(() =>
    document.getElementById('upg-pix-box').scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  );
}

// ── POLLING POR PAYMENT ID ────────────────────────────────────

/**
 * iniciarPollingPagamento(paymentId)
 *
 * Consulta GET /api/v1/pagamentos/status/id/:paymentId a cada 3 segundos.
 * Essa rota só retorna aprovado:true DEPOIS que o webhook com as 4 travas
 * gravou o registro no premiums.json — garantia de pagamento real.
 *
 * TTL máximo: 30 minutos (600 × 3s) — igual ao TTL do QR Code.
 * Ao receber aprovado:true → clearInterval + upgAtivarPremium().
 */
function iniciarPollingPagamento(paymentId) {
  upgPararPolling();

  const INTERVALO_MS  = 3000;   // 3 segundos (recomendação da IA do MP)
  const MAX_TENTATIVAS = 600;   // 600 × 3s = 30 minutos
  let tentativas = 0;

  upgMostrarStatusPolling('🔄 Aguardando confirmação do pagamento…', false);
  console.log(`[polling] Iniciado — paymentId: ${paymentId} | intervalo: ${INTERVALO_MS}ms | TTL: ${MAX_TENTATIVAS * INTERVALO_MS / 60000}min`);

  _upgPollingTimer = setInterval(async () => {
    tentativas++;

    // Encerra polling ao atingir o TTL do QR Code
    if (tentativas > MAX_TENTATIVAS) {
      upgPararPolling();
      upgMostrarStatusPolling('⏱ QR Code expirado. Feche e gere um novo.', false);
      console.log('[polling] TTL atingido — polling encerrado');
      return;
    }

    try {
      const r = await fetch(
        `${BACKEND_URL}/api/v1/pagamentos/status/id/${encodeURIComponent(paymentId)}`
      ).catch(() => null);

      if (!r || !r.ok) return; // falha de rede — tenta novamente no próximo ciclo

      const data = await r.json().catch(() => ({}));

      console.log(`[polling] tentativa ${tentativas} — paymentId: ${paymentId} | aprovado: ${data.aprovado}`);

      if (data.aprovado === true || data.premium === true) {
        upgPararPolling();
        upgAtivarPremium(data.desbloqueioToken || null);
      }

    } catch (_) { /* ignora erros de rede — ciclo seguinte tenta novamente */ }

  }, INTERVALO_MS);
}

/**
 * upgIniciarPollingLegado(identificador)
 * Fallback para a rota antiga por identificador.
 * Mantido para compatibilidade — usar iniciarPollingPagamento quando possível.
 */
function upgIniciarPollingLegado(identificador) {
  upgPararPolling();
  let tentativas = 0;
  const MAX = 600; // 30 min × 3s

  upgMostrarStatusPolling('🔄 Verificando pagamento…', false);

  _upgPollingTimer = setInterval(async () => {
    tentativas++;
    if (tentativas > MAX) { upgPararPolling(); return; }

    try {
      const r = await fetch(
        `${BACKEND_URL}/api/v1/pagamentos/status/${encodeURIComponent(identificador)}`
      ).catch(() => null);
      if (!r || !r.ok) return;
      const data = await r.json().catch(() => ({}));
      if (data.premium === true) {
        upgPararPolling();
        upgAtivarPremium();
      }
    } catch (_) {}
  }, 3000);
}

function upgPararPolling() {
  if (_upgPollingTimer) {
    clearInterval(_upgPollingTimer);
    _upgPollingTimer = null;
    console.log('[polling] Encerrado');
  }
}

/**
 * Exibe/atualiza a área de status do polling dentro do modal.
 * Cria o elemento se não existir, evita poluir o DOM com duplicatas.
 */
function upgMostrarStatusPolling(mensagem, sucesso = false) {
  let el = document.getElementById('upg-polling-status');
  if (!el) {
    el = document.createElement('p');
    el.id = 'upg-polling-status';
    el.style.cssText = [
      'font-family:var(--sans)', 'font-size:13px', 'text-align:center',
      'margin-top:12px', 'line-height:1.5', 'min-height:20px',
      'transition:color .2s',
    ].join(';');
    // Insere após o bloco do código PIX
    const pixBox = document.getElementById('upg-pix-box');
    if (pixBox) pixBox.insertAdjacentElement('afterend', el);
  }
  el.textContent = mensagem;
  el.style.color = sucesso ? '#2e7d32' : 'var(--mu)';
}

// ── ATIVAÇÃO DO PREMIUM ───────────────────────────────────────

/**
 * upgAtivarPremium()
 *
 * Chamada pelo polling SOMENTE após confirmação do backend.
 * O backend só confirma depois que o webhook com as 4 travas processou.
 * Portanto esta função nunca é chamada por ação direta do usuário.
 *
 * Ações:
 *   1. Marca Premium no localStorage do técnico logado
 *   2. Aplica visual Premium no card correspondente
 *   3. Fecha o modal
 *   4. Exibe toast com "Parabéns! Seu plano Premium está ativo."
 */
function upgAtivarPremium(desbloqueioToken) {
  console.log('[upg] ✅ Premium confirmado pelo backend — ativando visual');

  // O backend já marcou tecnicos.premium=1 no banco assim que o
  // pagamento foi aprovado (registrarPremiumMVP, em server.js) — o
  // que falta aqui é só refletir isso na sessão local deste navegador
  // e, se o card deste técnico estiver visível na página, aplicar o
  // estilo Premium nele sem precisar recarregar.
  const dados = tecLerSessaoLocal();
  if (dados) {
    dados.premium = true;
    // desbloqueioToken é a prova de posse exigida por POST /api/v1/
    // demandas/:id/desbloquear (mural de demandas) — sem guardá-lo
    // aqui, o técnico nunca conseguiria desbloquear contato nenhum
    // mesmo já sendo Premium de verdade no banco.
    if (desbloqueioToken) dados.desbloqueioToken = desbloqueioToken;
    tecSalvarSessaoLocal(dados);

    const card = document.querySelector(`.tc-card[data-id="${dados.tecnicoId}"]`);
    if (card) card.classList.add('tec-premium');

    const tecCache = (typeof TECNICOS_DEMO !== 'undefined') &&
      TECNICOS_DEMO.find(t => Number(t.id) === Number(dados.tecnicoId));
    if (tecCache) tecCache.premium = true;
  }

  // Fecha o modal
  fecharModalPremium();

  // Toast de confirmação — mensagem exata solicitada
  const toast = document.createElement('div');
  toast.setAttribute('role', 'alert');
  toast.setAttribute('aria-live', 'assertive');
  toast.style.cssText = [
    'position:fixed', 'bottom:100px', 'left:50%', 'transform:translateX(-50%)',
    'z-index:9999', 'background:#1c4a2e', 'color:#fff',
    'font-family:var(--sans)', 'font-size:15px', 'font-weight:700',
    'padding:16px 28px', 'border-radius:14px', 'text-align:center',
    'box-shadow:0 8px 28px rgba(14,30,18,.4)',
    'max-width:90vw', 'line-height:1.4',
    'animation:fadeUp .25s ease both',
  ].join(';');
  toast.innerHTML = '⭐ Parabéns! Seu plano Premium está ativo.';
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.transition = 'opacity .3s ease';
    toast.style.opacity    = '0';
    setTimeout(() => toast.remove(), 350);
  }, 5000);
}

// ── COPIAR PIX ────────────────────────────────────────────────

/**
 * Copia o código PIX para a área de transferência.
 * Usa navigator.clipboard (moderno) com fallback execCommand.
 */
function upgCopiarPix() {
  const codigo = document.getElementById('upg-pix-codigo').textContent.trim();
  const btn    = document.getElementById('upg-btn-copiar');

  const sucesso = () => {
    btn.classList.add('copiado');
    btn.textContent = '✓ Código copiado!';
    setTimeout(() => {
      btn.classList.remove('copiado');
      btn.textContent = '📋 Copiar código Pix';
    }, 3000);
  };

  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(codigo).then(sucesso).catch(() => upgCopiarFallback(codigo, sucesso));
  } else {
    upgCopiarFallback(codigo, sucesso);
  }
}

function upgCopiarFallback(texto, cb) {
  const el = document.createElement('textarea');
  el.value = texto;
  el.style.cssText = 'position:fixed;top:-9999px;opacity:0';
  document.body.appendChild(el);
  el.select();
  try { document.execCommand('copy'); cb(); } catch (_) {}
  document.body.removeChild(el);
}
