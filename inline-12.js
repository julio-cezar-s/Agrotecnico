
// ══════════════════════════════════════════════════════════════
// ÁREA DO TÉCNICO — login persistente + dashboard completo
// ─────────────────────────────────────────────────────────────
// Sessão real via cookie HttpOnly (agro_tec_sess), mesma arquitetura
// já usada para produtor e admin. Nenhum dado de perfil é fonte de
// verdade no localStorage — tudo é buscado do backend a cada abertura
// do painel; agro_tec_local (inline-09.js) continua existindo só como
// cache leve para o fluxo de pagamento Premium, e é realimentado aqui
// com dados reais sempre que o dashboard carrega ou o login acontece.
// ══════════════════════════════════════════════════════════════

/** Cache em memória dos dados do técnico logado (fonte: GET /me). */
let TD_SESSAO = null;
/** Guarda quais abas já buscaram dados, para não refazer fetch ao trocar de aba repetidamente. */
const TD_ABAS_CARREGADAS = new Set();

function _tdBackendUrl() {
  return typeof BACKEND_URL !== 'undefined' ? BACKEND_URL : '';
}

async function _tdFetch(path, opts = {}) {
  const r = await fetch(`${_tdBackendUrl()}${path}`, { credentials: 'include', ...opts });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.erro || `Falha em ${path}`);
  return data;
}

/** Verifica se há sessão de técnico válida, sem carregar o perfil inteiro. */
async function tdVerificarSessao() {
  try {
    const d = await _tdFetch('/api/v1/tecnico/verificar');
    return !!d.logado;
  } catch { return false; }
}

// ── MODAL DE LOGIN ───────────────────────────────────────────

let _tdScrollY = 0;
let _tdFocusOrigin = null;

/**
 * Ponto de entrada do menu "Já sou técnico — Entrar". Se já existe
 * sessão válida (cookie ainda não expirou), pula direto para o
 * dashboard — é o que dá o caráter de "login permanente" pedido.
 */
async function abrirLoginTecnico() {
  if (typeof closeMenu === 'function') closeMenu(); // fecha o drawer, se aberto
  const jaLogado = await tdVerificarSessao();
  if (jaLogado) { await tdAbrirDashboard(); return; }

  _tdScrollY     = window.scrollY;
  _tdFocusOrigin = document.activeElement;
  document.getElementById('modal-login-tecnico').classList.add('open');
  document.body.style.overflow = 'hidden';
  document.getElementById('td-login-err-geral').textContent = '';
  requestAnimationFrame(() => document.getElementById('td-login-ident').focus());
}

function fecharLoginTecnico() {
  document.getElementById('modal-login-tecnico').classList.remove('open');
  document.body.style.overflow = '';
  if (_tdFocusOrigin) { _tdFocusOrigin.focus({ preventScroll: true }); _tdFocusOrigin = null; }
}

function hdlTdLoginOverlay(e) {
  if (e.target === document.getElementById('modal-login-tecnico')) fecharLoginTecnico();
}

/** Fecha o login e abre o cadastro (mesmo fluxo multi-etapas já existente). */
function tdIrParaCadastro() {
  fecharLoginTecnico();
  if (typeof openModal === 'function') openModal();
}

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (document.getElementById('modal-login-tecnico')?.classList.contains('open')) fecharLoginTecnico();
});

async function tdEntrar() {
  const ident    = document.getElementById('td-login-ident').value.trim();
  const senha    = document.getElementById('td-login-senha').value;
  const lembrar  = document.getElementById('td-login-lembrar').checked;
  let ok = true;

  document.getElementById('td-login-ident').classList.toggle('err', !ident);
  document.getElementById('td-login-err-ident').classList.toggle('show', !ident);
  if (!ident) ok = false;

  document.getElementById('td-login-senha').classList.toggle('err', !senha);
  document.getElementById('td-login-err-senha').classList.toggle('show', !senha);
  if (!senha) ok = false;
  if (!ok) return;

  const errGeral = document.getElementById('td-login-err-geral');
  errGeral.textContent = '';
  const btn = document.getElementById('td-btn-login');
  btn.disabled = true; btn.textContent = 'Entrando…';

  try {
    await _tdFetch('/api/v1/tecnico/login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ identificador: ident, senha, lembrarMe: lembrar }),
    });
  } catch (err) {
    errGeral.textContent = err.message || 'Identificador ou senha incorretos.';
    btn.disabled = false; btn.textContent = 'Entrar';
    return;
  }

  btn.disabled = false; btn.textContent = 'Entrar';
  document.getElementById('td-login-senha').value = '';
  fecharLoginTecnico();
  await tdAbrirDashboard();
}

async function tdSair() {
  try { await _tdFetch('/api/v1/tecnico/logout', { method: 'POST' }); } catch (_) {}
  TD_SESSAO = null;
  TD_ABAS_CARREGADAS.clear();
  document.getElementById('secao-tecnico').classList.remove('ativa');
  document.body.style.overflow = '';
}

// ── ABERTURA DO DASHBOARD ─────────────────────────────────────

async function tdAbrirDashboard() {
  document.getElementById('secao-tecnico').classList.add('ativa');
  document.body.style.overflow = 'hidden';
  window.scrollTo({ top: 0, behavior: 'instant' });

  try {
    TD_SESSAO = await _tdFetch('/api/v1/tecnico/me');
  } catch (err) {
    console.error('[tecnico] Falha ao carregar sessão:', err?.message);
    alert('Não foi possível carregar seus dados. Faça login novamente.');
    document.getElementById('secao-tecnico').classList.remove('ativa');
    document.body.style.overflow = '';
    return;
  }

  // Realimenta a sessão local usada pelo fluxo de pagamento Premium
  // (inline-09.js) e pelo mural/documentos (inline-10.js) com dados
  // reais e atualizados — mantém esses dois arquivos funcionando sem
  // precisar reescrevê-los, e sem que o localStorage vire fonte de
  // verdade (é sempre sobrescrito a partir do backend aqui).
  if (typeof tecSalvarSessaoLocal === 'function') {
    tecSalvarSessaoLocal({
      tecnicoId:     TD_SESSAO.id,
      publicId:      TD_SESSAO.publicId,
      nome:          TD_SESSAO.nome,
      identificador: TD_SESSAO.email || TD_SESSAO.whatsapp,
      cidade:        TD_SESSAO.cidade,
      uf:            TD_SESSAO.uf,
      conselho:      TD_SESSAO.conselho,
      numConselho:   TD_SESSAO.numConselho,
      ufConselho:    TD_SESSAO.ufConselho,
      registro:      TD_SESSAO.registroCompleto,
      premium:       TD_SESSAO.premium,
    });
  }

  tdRenderizarCabecalho();
  TD_ABAS_CARREGADAS.clear();
  TD_ABAS_CARREGADAS.add('visao');
  tdRenderizarVisaoGeral();

  // Garante que a aba visível seja sempre "Visão Geral" ao reabrir
  document.querySelectorAll('.td-tab').forEach((t,i) => t.classList.toggle('ativa', i===0));
  document.querySelectorAll('.td-painel').forEach((p) => p.classList.toggle('ativo', p.id === 'td-painel-visao'));
}

function tdRenderizarCabecalho() {
  const av = document.getElementById('td-avatar-img');
  av.innerHTML = TD_SESSAO.fotoUrl
    ? `<img src="${_x(TD_SESSAO.fotoUrl)}" alt="Foto de perfil" style="width:100%;height:100%;border-radius:50%;object-fit:cover">`
    : '👨‍🌾';

  document.getElementById('td-header-nome').textContent = TD_SESSAO.nome;
  document.getElementById('td-header-sub').textContent  = `${TD_SESSAO.cidade || ''} — ${TD_SESSAO.uf || ''}`;

  const badges = document.getElementById('td-header-badges');
  const badgeValidacao = TD_SESSAO.statusValidacao === 'ativo'
    ? '<span class="tc-verificado">✓ Verificado</span>'
    : TD_SESSAO.statusValidacao === 'suspenso'
      ? '<span class="tc-pendente" style="background:#ffebee;border-color:#ffcdd2;color:#c62828">⛔ Suspenso</span>'
      : '<span class="tc-pendente">⏳ Em análise</span>';
  const badgePremium = TD_SESSAO.premium
    ? '<span class="mural-prem-badge">⭐ Premium</span>' : '';
  badges.innerHTML = badgeValidacao + badgePremium;
}

// ── NAVEGAÇÃO ENTRE ABAS ──────────────────────────────────────

function tdAba(nome) {
  document.querySelectorAll('.td-tab').forEach(t =>
    t.classList.toggle('ativa', t.getAttribute('data-csph-a0') === nome));
  document.querySelectorAll('.td-painel').forEach(p =>
    p.classList.toggle('ativo', p.id === `td-painel-${nome}`));

  if (TD_ABAS_CARREGADAS.has(nome)) return;
  TD_ABAS_CARREGADAS.add(nome);

  const carregadores = {
    perfil:        tdRenderizarPerfil,
    documentos:    tdRenderizarDocumentos,
    seguranca:     tdRenderizarSeguranca,
    premium:       tdRenderizarPremium,
    estatisticas:  tdRenderizarEstatisticas,
    config:        tdRenderizarConfig,
  };
  carregadores[nome]?.();
}

function _tdMsg(id, texto, ok) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = texto;
  el.className = 'td-msg ' + (ok ? 'ok' : 'err');
}

// ── VISÃO GERAL ────────────────────────────────────────────────

function tdRenderizarVisaoGeral() {
  document.getElementById('td-vg-vis').textContent       = TD_SESSAO.visualizacoes || 0;
  document.getElementById('td-vg-contatos').textContent  = (TD_SESSAO.cliquesWhatsapp || 0) + (TD_SESSAO.cliquesTelefone || 0);
  document.getElementById('td-vg-favoritos').textContent = TD_SESSAO.totalFavoritos || 0;
  document.getElementById('td-vg-avaliacoes').textContent= TD_SESSAO.totalAvaliacoes || 0;

  document.getElementById('td-vg-plano').textContent = TD_SESSAO.premium ? '⭐ Premium' : 'Gratuito';
  document.getElementById('td-vg-validacao').textContent = {
    ativo: '✓ Verificado', pendente: '⏳ Em análise', suspenso: '⛔ Suspenso', recusado: '✕ Recusado',
  }[TD_SESSAO.statusValidacao] || TD_SESSAO.statusValidacao;
  document.getElementById('td-vg-desde').textContent = TD_SESSAO.cadastradoEm
    ? new Date(TD_SESSAO.cadastradoEm).toLocaleDateString('pt-BR') : '—';
  document.getElementById('td-vg-ultimo-acesso').textContent = TD_SESSAO.ultimoAcesso
    ? new Date(TD_SESSAO.ultimoAcesso).toLocaleString('pt-BR') : 'Este é seu primeiro acesso registrado';
}

// ── PERFIL ───────────────────────────────────────────────────

function tdRenderizarPerfil() {
  const d = TD_SESSAO;
  document.getElementById('td-p-nome').value       = d.nome || '';
  document.getElementById('td-p-formacao').value   = d.formacao || '';
  document.getElementById('td-p-whatsapp').value   = d.whatsapp ? aplicarMascaraTel(d.whatsapp) : '';
  document.getElementById('td-p-telefone').value   = d.telefone ? aplicarMascaraTel(d.telefone) : '';
  document.getElementById('td-p-cidade').value     = d.cidade || '';
  document.getElementById('td-p-uf').value         = d.uf || '';
  document.getElementById('td-p-endereco').value   = d.endereco || '';
  document.getElementById('td-p-cep').value        = d.cep || '';
  document.getElementById('td-p-raio').value       = d.raio || 100;
  document.getElementById('td-p-experiencia').value= d.experiencia || '';
  document.getElementById('td-p-bio').value        = d.bio || '';
  document.getElementById('td-p-instagram').value  = d.redesSociais?.instagram || '';
  document.getElementById('td-p-facebook').value   = d.redesSociais?.facebook  || '';
  document.getElementById('td-p-linkedin').value   = d.redesSociais?.linkedin  || '';
  document.getElementById('td-p-site').value       = d.sitePessoal || '';

  (d.especialidades || []).forEach(esp => {
    const chk = document.getElementById(`td-sp-${esp}`);
    if (chk) chk.checked = true;
  });
}

async function tdSalvarPerfil() {
  const payload = {
    nome:        document.getElementById('td-p-nome').value.trim(),
    formacao:    document.getElementById('td-p-formacao').value.trim(),
    cidade:      document.getElementById('td-p-cidade').value.trim(),
    uf:          document.getElementById('td-p-uf').value.trim().toUpperCase(),
    endereco:    document.getElementById('td-p-endereco').value.trim(),
    cep:         document.getElementById('td-p-cep').value.trim(),
    raio:        parseInt(document.getElementById('td-p-raio').value) || 100,
    experiencia: document.getElementById('td-p-experiencia').value.trim(),
    bio:         document.getElementById('td-p-bio').value.trim(),
  };

  try {
    await _tdFetch('/api/v1/tecnico/me/perfil', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    // Contato (whatsapp/telefone) vive em rota própria
    await _tdFetch('/api/v1/tecnico/me/contato', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        whatsapp: document.getElementById('td-p-whatsapp').value.replace(/\D/g,''),
        telefone: document.getElementById('td-p-telefone').value.replace(/\D/g,'') || undefined,
      }),
    });
    Object.assign(TD_SESSAO, payload);
    tdRenderizarCabecalho();
    _tdMsg('td-p-msg', '✓ Perfil salvo com sucesso.', true);
  } catch (err) {
    _tdMsg('td-p-msg', err.message || 'Erro ao salvar perfil.', false);
  }
}

async function tdSalvarEspecialidades() {
  const especialidades = [...document.querySelectorAll('#td-p-especialidades input:checked')].map(i => i.value);
  try {
    await _tdFetch('/api/v1/tecnico/me/especialidades', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ especialidades }),
    });
    _tdMsg('td-esp-msg', '✓ Especialidades atualizadas.', true);
  } catch (err) {
    _tdMsg('td-esp-msg', err.message || 'Erro ao salvar.', false);
  }
}

async function tdSalvarRedes() {
  const payload = {
    instagram:   document.getElementById('td-p-instagram').value.trim(),
    facebook:    document.getElementById('td-p-facebook').value.trim(),
    linkedin:    document.getElementById('td-p-linkedin').value.trim(),
    sitePessoal: document.getElementById('td-p-site').value.trim(),
  };
  try {
    await _tdFetch('/api/v1/tecnico/me/perfil', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    _tdMsg('td-redes-msg', '✓ Redes sociais atualizadas.', true);
  } catch (err) {
    _tdMsg('td-redes-msg', err.message || 'Erro ao salvar.', false);
  }
}

function tdAbrirSeletorFoto() {
  document.getElementById('td-input-foto').click();
}

async function tdEnviarFoto(inputEl) {
  const arquivo = inputEl?.files?.[0] || document.getElementById('td-input-foto').files?.[0];
  if (!arquivo) return;

  const fd = new FormData();
  fd.append('foto', arquivo);

  try {
    const data = await _tdFetch('/api/v1/tecnico/me/foto', { method: 'POST', body: fd });
    TD_SESSAO.fotoUrl = data.fotoUrl;
    tdRenderizarCabecalho();
  } catch (err) {
    alert(err.message || 'Não foi possível enviar a foto.');
  }
}

// ── DOCUMENTOS ───────────────────────────────────────────────

function tdRenderizarDocumentos() {
  const badge = document.getElementById('td-doc-status-badge');
  const labelMap = {
    ativo:    ['ativo', '✓ Verificado'],
    pendente: ['pendente', '⏳ Em análise'],
    suspenso: ['suspenso', '⛔ Suspenso'],
    recusado: ['recusado', '✕ Recusado'],
  };
  const [cls, texto] = labelMap[TD_SESSAO.statusValidacao] || ['pendente', TD_SESSAO.statusValidacao];
  badge.className = 'td-doc-status ' + cls;
  badge.textContent = texto;

  document.getElementById('td-doc-nome-atual').textContent = TD_SESSAO.docOriginalName
    ? `Documento atual: ${TD_SESSAO.docOriginalName}${TD_SESSAO.docEnviadoEm ? ' — enviado em ' + new Date(TD_SESSAO.docEnviadoEm).toLocaleDateString('pt-BR') : ''}`
    : 'Nenhum documento enviado ainda.';
}

async function tdEnviarDocumento() {
  const input = document.getElementById('td-doc-input');
  const arquivo = input.files?.[0];
  if (!arquivo) { _tdMsg('td-doc-msg', 'Selecione um arquivo antes de enviar.', false); return; }

  const fd = new FormData();
  fd.append('documento', arquivo);

  try {
    await _tdFetch('/api/v1/tecnico/me/documento', { method: 'POST', body: fd });
    TD_SESSAO.statusValidacao = 'pendente';
    TD_SESSAO.docOriginalName = arquivo.name;
    TD_SESSAO.docEnviadoEm    = new Date().toISOString();
    tdRenderizarDocumentos();
    tdRenderizarCabecalho();
    input.value = '';
    _tdMsg('td-doc-msg', '✓ Documento enviado. Sua validação será reanalisada.', true);
  } catch (err) {
    _tdMsg('td-doc-msg', err.message || 'Erro ao enviar documento.', false);
  }
}

// ── SEGURANÇA ────────────────────────────────────────────────

async function tdRenderizarSeguranca() {
  try {
    const { sessoes } = await _tdFetch('/api/v1/tecnico/me/sessoes');
    document.getElementById('td-sec-sessoes-lista').innerHTML = sessoes.length === 0
      ? '<p style="font-family:var(--sans);font-size:13px;color:var(--mu)">Nenhuma sessão ativa encontrada.</p>'
      : sessoes.map(s => `
        <div class="td-sessao-item">
          <div>
            <span class="td-sessao-info">Sessão ${_x(s.id)}${s.atual ? '<span class="td-sessao-atual">Esta sessão</span>' : ''}</span>
            <p class="td-sessao-meta">Criada em ${new Date(s.criadoEm).toLocaleString('pt-BR')} · expira em ${new Date(s.expiraEm).toLocaleDateString('pt-BR')}</p>
          </div>
          ${!s.atual ? `<button class="adm-btn ban" data-csph-dyn-click="tdEncerrarSessao" data-csph-a0="${_x(s.token||'')}">Encerrar</button>` : ''}
        </div>`).join('');
  } catch (err) {
    document.getElementById('td-sec-sessoes-lista').innerHTML = '<p style="color:var(--rd);font-size:13px">Não foi possível carregar as sessões.</p>';
  }

  try {
    const { eventos } = await _tdFetch('/api/v1/tecnico/me/historico-login');
    document.getElementById('td-sec-historico-lista').innerHTML = eventos.length === 0
      ? '<p style="font-family:var(--sans);font-size:13px;color:var(--mu)">Nenhum evento registrado ainda.</p>'
      : eventos.map(e => `
        <div class="td-hist-item">
          <span>${e.sucesso ? '✓ Login bem-sucedido' : '✕ Tentativa incorreta'}</span>
          <span>${new Date(e.data).toLocaleString('pt-BR')}</span>
        </div>`).join('');
  } catch (err) {
    document.getElementById('td-sec-historico-lista').innerHTML = '<p style="color:var(--rd);font-size:13px">Não foi possível carregar o histórico.</p>';
  }
}

async function tdAlterarSenha() {
  const atual = document.getElementById('td-sec-senha-atual').value;
  const nova  = document.getElementById('td-sec-senha-nova').value;
  if (!atual || nova.length < 8) {
    _tdMsg('td-sec-senha-msg', 'Preencha a senha atual e uma nova senha com pelo menos 8 caracteres.', false);
    return;
  }
  try {
    await _tdFetch('/api/v1/tecnico/me/senha', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ senhaAtual: atual, novaSenha: nova }),
    });
    document.getElementById('td-sec-senha-atual').value = '';
    document.getElementById('td-sec-senha-nova').value  = '';
    _tdMsg('td-sec-senha-msg', '✓ Senha alterada. Suas outras sessões foram encerradas.', true);
    TD_ABAS_CARREGADAS.delete('seguranca');
    tdRenderizarSeguranca();
  } catch (err) {
    _tdMsg('td-sec-senha-msg', err.message || 'Erro ao alterar senha.', false);
  }
}

async function tdAlterarEmail() {
  const novoEmail = document.getElementById('td-sec-email-novo').value.trim();
  const senha     = document.getElementById('td-sec-email-senha').value;
  if (!novoEmail || !senha) {
    _tdMsg('td-sec-email-msg', 'Preencha o novo e-mail e sua senha atual.', false);
    return;
  }
  try {
    const data = await _tdFetch('/api/v1/tecnico/me/email', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ novoEmail, senha }),
    });
    TD_SESSAO.email = data.email;
    document.getElementById('td-sec-email-novo').value = '';
    document.getElementById('td-sec-email-senha').value = '';
    _tdMsg('td-sec-email-msg', '✓ E-mail atualizado com sucesso.', true);
  } catch (err) {
    _tdMsg('td-sec-email-msg', err.message || 'Erro ao alterar e-mail.', false);
  }
}

async function tdEncerrarSessao(token) {
  try {
    await _tdFetch(`/api/v1/tecnico/me/sessoes/${encodeURIComponent(token)}`, { method: 'DELETE' });
    TD_ABAS_CARREGADAS.delete('seguranca');
    tdRenderizarSeguranca();
  } catch (err) {
    alert(err.message || 'Não foi possível encerrar a sessão.');
  }
}

async function tdEncerrarTodasSessoes() {
  try {
    await _tdFetch('/api/v1/tecnico/me/sessoes/encerrar-todas', { method: 'POST' });
    TD_ABAS_CARREGADAS.delete('seguranca');
    tdRenderizarSeguranca();
  } catch (err) {
    alert(err.message || 'Não foi possível encerrar as sessões.');
  }
}

// ── PREMIUM ──────────────────────────────────────────────────

function tdRenderizarPremium() {
  const box    = document.getElementById('td-prem-box');
  const status = document.getElementById('td-prem-status');
  const venc   = document.getElementById('td-prem-venc');

  const expiraEm = TD_SESSAO.premiumExpiraEm ? new Date(TD_SESSAO.premiumExpiraEm) : null;
  const diasRestantes = expiraEm ? Math.ceil((expiraEm.getTime() - Date.now()) / (1000 * 60 * 60 * 24)) : null;

  if (TD_SESSAO.premium) {
    box.className = 'td-premium-box ativo';
    status.textContent = '⭐ Você é Premium';
    if (expiraEm) {
      const dataFmt = expiraEm.toLocaleDateString('pt-BR');
      venc.textContent = diasRestantes <= 5
        ? `⚠️ Renova em ${diasRestantes} dia${diasRestantes === 1 ? '' : 's'} (${dataFmt}) — renove pra não perder o destaque`
        : `Válido até ${dataFmt} · renovação manual via Pix, sem cobrança automática`;
    } else {
      venc.textContent = 'Assinatura ativa';
    }
    document.getElementById('td-prem-btn-renovar').textContent = '⭐ Renovar assinatura';
  } else {
    box.className = 'td-premium-box inativo';
    if (expiraEm) {
      // Já foi Premium, mas venceu — diferente de nunca ter assinado
      status.textContent = 'Seu Premium venceu';
      venc.textContent = `Válido até ${expiraEm.toLocaleDateString('pt-BR')}. Renove pra voltar a aparecer no topo das buscas.`;
    } else {
      status.textContent = 'Você está no plano Gratuito';
      venc.textContent = 'Ative o Premium para aparecer no topo das buscas.';
    }
    document.getElementById('td-prem-btn-renovar').textContent = expiraEm ? '⭐ Renovar Premium' : '⭐ Ativar Premium';
  }

  _tdFetch('/api/v1/tecnico/me/pagamentos').then(({ pagamentos }) => {
    const cont = document.getElementById('td-prem-pagamentos');
    cont.innerHTML = pagamentos.length === 0
      ? '<p style="font-family:var(--sans);font-size:13px;color:var(--mu)">Nenhum pagamento registrado ainda.</p>'
      : pagamentos.map(p => `
        <div class="td-pag-item">
          <span>${p.plano === 'premium_mensal' ? 'Premium mensal' : 'Classificado'} · ${p.metodo.toUpperCase()}</span>
          <span>R$ ${Number(p.valor).toFixed(2).replace('.',',')} · ${{approved:'✓ Aprovado',pending:'⏳ Pendente',rejected:'✕ Rejeitado',in_process:'⏳ Em análise'}[p.status] || p.status}</span>
        </div>`).join('');
  }).catch(() => {
    document.getElementById('td-prem-pagamentos').innerHTML = '<p style="color:var(--rd);font-size:13px">Não foi possível carregar o histórico.</p>';
  });
}

/** Abre o modal de upgrade Premium já existente (inline-09.js). */
function tdAbrirPremium() {
  if (typeof abrirModalPremium === 'function') abrirModalPremium();
}

// ── ESTATÍSTICAS ─────────────────────────────────────────────

async function tdRenderizarEstatisticas() {
  let dados;
  try {
    dados = await _tdFetch('/api/v1/tecnico/estatisticas');
  } catch (err) {
    document.getElementById('td-painel-estatisticas').innerHTML = '<p style="color:var(--rd);font-size:13px">Não foi possível carregar as estatísticas.</p>';
    return;
  }

  document.getElementById('td-est-vis').textContent   = dados.visualizacoes || 0;
  document.getElementById('td-est-wpp').textContent   = dados.cliquesWhatsapp || 0;
  document.getElementById('td-est-tel').textContent   = dados.cliquesTelefone || 0;
  document.getElementById('td-est-busca').textContent = dados.impressoesBusca || 0;

  const evo = dados.evolucaoMensal || [];
  const maxVal = Math.max(...evo.map(m => m.visualizacoes), 1);
  const cont = document.getElementById('td-evo-barras');
  cont.innerHTML = evo.map((m, i) => `
    <div class="td-evo-col">
      <div class="td-evo-barra" id="td-evo-bar-${i}" style="height:0"></div>
      <span class="td-evo-mes">${_x(m.mes)}</span>
    </div>`).join('');

  requestAnimationFrame(() => requestAnimationFrame(() => {
    evo.forEach((m, i) => {
      const el = document.getElementById(`td-evo-bar-${i}`);
      if (el) el.style.height = `${Math.round((m.visualizacoes / maxVal) * 80)}px`;
    });
  }));
}

// ── CONFIGURAÇÕES ────────────────────────────────────────────

function tdRenderizarConfig() {
  document.getElementById('td-cfg-visivel').checked  = TD_SESSAO.configuracoes?.visivel !== false;
  document.getElementById('td-cfg-email').checked    = TD_SESSAO.configuracoes?.notifEmail !== false;
  document.getElementById('td-cfg-whatsapp').checked = TD_SESSAO.configuracoes?.notifWhatsapp !== false;
}

async function tdSalvarConfig() {
  const payload = {
    visivel:       document.getElementById('td-cfg-visivel').checked,
    notifEmail:    document.getElementById('td-cfg-email').checked,
    notifWhatsapp: document.getElementById('td-cfg-whatsapp').checked,
  };
  try {
    await _tdFetch('/api/v1/tecnico/me/configuracoes', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    TD_SESSAO.configuracoes = payload;
    _tdMsg('td-cfg-msg', '✓ Configurações salvas.', true);
  } catch (err) {
    _tdMsg('td-cfg-msg', err.message || 'Erro ao salvar configurações.', false);
  }
}

async function tdExcluirConta() {
  const senha = document.getElementById('td-del-senha').value;
  if (!senha) { _tdMsg('td-del-msg', 'Confirme sua senha para excluir a conta.', false); return; }

  if (!confirm('Tem certeza? Seu perfil sairá do ar imediatamente e esta ação não pode ser desfeita por aqui.')) return;

  try {
    await _tdFetch('/api/v1/tecnico/me/excluir', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ senha }),
    });
    try { localStorage.removeItem('agro_tec_local'); } catch (_) {}
    alert('Sua conta foi excluída. Sentiremos sua falta!');
    document.getElementById('secao-tecnico').classList.remove('ativa');
    document.body.style.overflow = '';
    TD_SESSAO = null;
  } catch (err) {
    _tdMsg('td-del-msg', err.message || 'Não foi possível excluir a conta.', false);
  }
}
