
// ══════════════════════════════════════════════════════════════
// PAINEL ADMIN — autenticação via backend (cookie HttpOnly)
// Nenhuma credencial armazenada no frontend.
// O cookie agro_admin_sess é HttpOnly — inacessível ao JavaScript.
//
// INTEGRAÇÃO COM BACKEND (auditoria 20/07/2026, Achado #1):
// Antes, as tabelas deste painel liam de TECNICOS_DEMO e de dois Sets
// no localStorage (ADM_BAN_KEY/ADM_PREM_KEY) — cada admin via um
// estado diferente, e nenhuma ação sobrevivia à troca de navegador.
// A tabela de denúncias, em particular, chamava denLer()/denSalvar(),
// duas funções que nunca chegaram a existir em nenhum arquivo deste
// projeto — ou seja, o painel quebrava com ReferenceError toda vez
// que era aberto. Agora as três tabelas (técnicos, produtores,
// denúncias) e o gráfico de crescimento vêm de rotas reais
// (GET /api/v1/admin/tecnicos, /produtores, /denuncias e
// GET /api/admin/crescimento) e as ações (validar, suspender, dar
// Premium) escrevem direto no banco.
// ══════════════════════════════════════════════════════════════

/** Cache em memória da última leitura — evita 3 fetches a cada re-render. */
let ADM_CACHE = { tecnicos: [], produtores: [], denuncias: [] };

function _admBackendUrl() {
  return typeof BACKEND_URL !== 'undefined' ? BACKEND_URL : '';
}

async function _admFetchJSON(path, opts = {}) {
  const r = await fetch(`${_admBackendUrl()}${path}`, { credentials: 'include', ...opts });
  if (!r.ok) throw new Error(`Falha em ${path} (HTTP ${r.status})`);
  return r.json();
}

// ── ACESSO ───────────────────────────────────────────────────

/** Verifica sessão admin consultando o backend (cookie HttpOnly). */
async function admLogado() {
  try {
    const r = await fetch(`${_admBackendUrl()}/api/admin/verificar`, { credentials: 'include' });
    const d = await r.json().catch(() => ({}));
    return d.logado === true;
  } catch { return false; }
}

/** Abre o painel admin — chamada após login bem-sucedido. */
function admAbrir() {
  fecharModalProdutor();
  document.getElementById('secao-admin').classList.add('ativa');
  document.body.style.overflow = 'hidden';
  admRenderizar();
  admCarregarPrecos();
  if (typeof avisoInit === 'function') avisoInit();
}

/** Fecha o painel admin — invalida sessão no backend. */
async function admSair() {
  try {
    await fetch(`${_admBackendUrl()}/api/admin/logout`, {
      method: 'POST', credentials: 'include'
    });
  } catch { /* ok mesmo offline */ }
  document.getElementById('secao-admin').classList.remove('ativa');
  document.body.style.overflow = '';
  window.scrollTo({ top: 0, behavior: 'instant' });
}

// ── RENDERIZAÇÃO DA TABELA ────────────────────────────────────

const _ADM_LINKS_CONSELHO = {
  CREA: 'https://www.confea.org.br/profissional/consulta-de-registro',
  CRMV: 'https://www.cfmv.gov.br/consulta-medico-veterinario/',
  CFTA: 'https://www.cfta.org.br/consulta',
};

/**
 * Busca os dados reais (técnicos, produtores, denúncias) no backend e
 * redesenha as três tabelas + métricas + gráficos do painel.
 */
async function admRenderizar() {
  let tecnicos = [], produtores = [], denuncias = [];
  try {
    [tecnicos, produtores, denuncias] = await Promise.all([
      _admFetchJSON('/api/v1/admin/tecnicos').then(d => d.tecnicos || []),
      _admFetchJSON('/api/v1/admin/produtores').then(d => d.produtores || []),
      _admFetchJSON('/api/v1/admin/denuncias').then(d => d.denuncias || []),
    ]);
  } catch (err) {
    console.error('[admin] Erro ao carregar dados:', err?.message);
  }
  ADM_CACHE = { tecnicos, produtores, denuncias };

  // ── MÉTRICAS
  document.getElementById('adm-tot-produtores').textContent = produtores.length;
  document.getElementById('adm-tot-tecnicos').textContent   = tecnicos.length;
  document.getElementById('adm-tot-premium').textContent    = tecnicos.filter(t => t.premium).length;

  admRenderizarGraficos();

  // ── TABELA DE TÉCNICOS
  const tbodyTec = document.getElementById('adm-tbody-tec');
  if (tecnicos.length === 0) {
    tbodyTec.innerHTML = `<tr><td colspan="6" style="text-align:center;color:rgba(255,255,255,.25);padding:24px">Nenhum técnico cadastrado ainda.</td></tr>`;
  } else {
    tbodyTec.innerHTML = tecnicos.map(t => {
      const suspenso = t.status === 'suspenso';
      const validado = t.status === 'ativo';
      const cons     = t.conselho && t.numConselho ? `${t.conselho}-${t.ufConselho||t.uf} ${t.numConselho}` : '—';
      const linkConselho = t.conselho && _ADM_LINKS_CONSELHO[t.conselho]
        ? `<a href="${_ADM_LINKS_CONSELHO[t.conselho]}" target="_blank" rel="noopener"
             style="color:#6fcf97;font-size:10px;display:block;margin-top:3px">
             🔗 Consultar ${t.conselho}</a>` : '';
      return `<tr id="adm-row-${t.id}">
        <td style="font-weight:600;color:var(--w)">${_x(t.nome)}</td>
        <td style="color:rgba(255,255,255,.5)">${_x(t.cidade)} — ${_x(t.uf)}</td>
        <td style="color:rgba(255,255,255,.7);font-size:12px">${_x(cons)}${linkConselho}</td>
        <td><span class="adm-badge ${validado?'ativo':(suspenso?'suspenso':'pendente')}">${validado?'✓ Verificado':(suspenso?'⛔ Suspenso':'⏳ Pendente')}</span></td>
        <td>${t.premium
          ? `<span class="adm-badge premium">⭐ Premium</span>${t.premiumExpiraEm ? `<br><span style="font-size:10px;color:rgba(255,255,255,.4)">até ${new Date(t.premiumExpiraEm).toLocaleDateString('pt-BR')}</span>` : ''}`
          : `<span class="adm-badge" style="color:rgba(255,255,255,.3)">Gratuito</span>${t.premiumExpiraEm ? `<br><span style="font-size:10px;color:rgba(255,255,255,.3)">venceu ${new Date(t.premiumExpiraEm).toLocaleDateString('pt-BR')}</span>` : ''}`
        }</td>
        <td><div class="adm-acoes">
          ${!validado?`<button class="adm-btn ativar"  data-csph-dyn-click="admValidarConselho" data-csph-a0="${t.id}">✓ Validar</button>`:''}
          <button class="adm-btn ${suspenso?'ativar':'ban'}"
             data-csph-dyn-click="admToggleBanTecnico" data-csph-a0="${t.id}" data-csph-a1="${suspenso}">
            ${suspenso?'✓ Ativar':'⛔ Suspender'}
          </button>
          <button class="adm-btn ${t.premium?'unprem':'prem'}"
             data-csph-dyn-click="admTogglePrem" data-csph-a0="${t.id}" data-csph-a1="${t.premium}">
            ${t.premium?'↓ Remover Premium':'⭐ Dar Premium'}
          </button>
        </div></td>
      </tr>`;
    }).join('');
  }

  // ── TABELA DE PRODUTORES
  const tbodyProd = document.getElementById('adm-tbody-prod');
  if (produtores.length === 0) {
    tbodyProd.innerHTML = `<tr><td colspan="6" style="text-align:center;color:rgba(255,255,255,.25);padding:24px">Nenhum produtor registrado ainda.</td></tr>`;
  } else {
    tbodyProd.innerHTML = produtores.map(p => {
      const suspenso  = !p.ativo;
      const identExib = p.identificador || '—';
      const tipoIcon  = p.tipoIdent === 'tel' ? '📱 ' : '✉️ ';
      const novidadesCell = p.aceitouNovidades
        ? `<span class="adm-badge ativo" title="Aceita receber e-mails">✉ Sim</span>`
        : `<span style="color:rgba(255,255,255,.2);font-size:12px">—</span>`;
      return `<tr>
        <td style="font-weight:600;color:var(--w)">${_x(p.nome)}</td>
        <td style="color:rgba(255,255,255,.5)">${tipoIcon}${_x(identExib)}</td>
        <td style="color:#6fcf97">${p.totalFavoritos} técnico${p.totalFavoritos!==1?'s':''}</td>
        <td>${novidadesCell}</td>
        <td><span class="adm-badge ${suspenso?'suspenso':'ativo'}">${suspenso?'⛔ Suspenso':'✓ Ativo'}</span></td>
        <td><div class="adm-acoes">
          <button class="adm-btn ${suspenso?'ativar':'ban'}"
             data-csph-dyn-click="admToggleBanProdutor" data-csph-a0="${p.id}" data-csph-a1="${suspenso}">
            ${suspenso?'✓ Ativar':'⛔ Suspender'}
          </button>
        </div></td>
      </tr>`;
    }).join('');
  }

  // ── TABELA DE DENÚNCIAS
  const tbodyDen = document.getElementById('adm-tbody-den');
  if (!tbodyDen) return;

  if (denuncias.length === 0) {
    tbodyDen.innerHTML = `<tr><td colspan="6" style="text-align:center;color:rgba(255,255,255,.25);padding:20px">Nenhuma denúncia registrada ainda.</td></tr>`;
    return;
  }

  const contagemPorTec = {};
  denuncias.forEach(d => {
    if (d.status === 'arquivada') return;
    contagemPorTec[d.tecnicoId] = (contagemPorTec[d.tecnicoId] || 0) + 1;
  });

  const motivoLabels = {
    falso_profissional:      '⚠ Falso Profissional',
    dados_falsos:            'Dados falsos',
    profissional_inadequado: 'Profissional inadequado',
    numero_incorreto:        'Telefone incorreto',
    golpe_fraude:            'Golpe / Fraude',
    conteudo_ofensivo:       'Conteúdo ofensivo',
    outro:                   'Outro motivo',
  };

  const tecnicosPorId = Object.fromEntries(tecnicos.map(t => [t.id, t]));

  tbodyDen.innerHTML = denuncias.map(d => {
    const data = new Date(d.criadoEm).toLocaleDateString('pt-BR',
      { day:'2-digit', month:'2-digit', year:'2-digit', hour:'2-digit', minute:'2-digit' });
    const isSuspenso = tecnicosPorId[d.tecnicoId]?.status === 'suspenso';
    const isCritico  = d.motivo === 'falso_profissional';
    const qtdDens    = contagemPorTec[d.tecnicoId] || 1;
    const motivoLabel= motivoLabels[d.motivo] || d.motivo;
    const alertaAuto = qtdDens >= 3 ? `<span class="den-alerta-badge">🔴 AUTO-SUSPENSO</span>` : '';

    return `<tr class="${isCritico && d.status === 'pendente' ? 'den-row-critica' : ''}">
      <td style="font-weight:600;color:var(--w)">
        ${_x(d.tecnicoNome || d.tecnicoId)}
        ${alertaAuto}
        <span class="den-count-badge ${qtdDens >= 3 ? '' : 'warn'}" title="${qtdDens} denúncia(s) pendentes">${qtdDens}</span>
      </td>
      <td>
        <span class="adm-badge ${isCritico ? 'critico' : 'suspenso'}" style="${isCritico ? '' : 'background:rgba(235,87,87,.12)'}">
          ${motivoLabel}
        </span>
      </td>
      <td style="color:rgba(255,255,255,.45);max-width:160px;word-break:break-word">
        ${d.descricao ? _x(d.descricao) : '<em style="opacity:.4">sem descrição</em>'}
      </td>
      <td style="color:rgba(255,255,255,.35);white-space:nowrap;font-size:11px">${data}</td>
      <td><span class="adm-badge ${d.status === 'pendente' ? (isCritico ? 'critico' : 'suspenso') : 'ativo'}">
        ${d.status === 'pendente' ? (isCritico ? '🔴 Alerta' : '⏳ Pendente') : '✓ Resolvida'}
      </span></td>
      <td><div class="adm-acoes">
        ${d.status === 'pendente' ? `
        <button class="adm-btn arquivar" data-csph-dyn-click="denIgnorar" data-csph-a0="${d.id}"
          title="Ignorar esta denúncia — mantém o técnico ativo">🙈 Ignorar</button>` : ''}
        <button class="adm-btn ${isSuspenso ? 'ativar' : 'ban'}"
           data-csph-dyn-click="denSuspenderTecnico" data-csph-a0="${d.tecnicoId}" data-csph-a1="${d.id}"
          title="${isSuspenso ? 'Reativar técnico' : 'Suspender técnico imediatamente'}">
          ${isSuspenso ? '✓ Reativar' : '⛔ Suspender'}
        </button>
      </div></td>
    </tr>`;
  }).join('');
}

// ── AÇÕES ─────────────────────────────────────────────────────

/** IGNORAR DENÚNCIA — arquiva sem tomar ação no técnico. */
async function denIgnorar(denId) {
  try {
    await fetch(`${_admBackendUrl()}/api/v1/denuncias/${denId}/ignorar`, {
      method: 'POST', credentials: 'include',
    });
  } catch (err) { console.error('[denIgnorar] Erro:', err?.message); }
  admRenderizar();
}

/** SUSPENDER/REATIVAR TÉCNICO via denúncia — arquiva a denúncia que motivou. */
async function denSuspenderTecnico(tecnicoId, denId) {
  const tec = ADM_CACHE.tecnicos.find(t => Number(t.id) === Number(tecnicoId));
  const jaSuspenso = tec?.status === 'suspenso';

  try {
    await fetch(`${_admBackendUrl()}/api/v1/denuncias/${denId}/${jaSuspenso ? 'reativar' : 'suspender'}`, {
      method:  'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ tecnicoId }),
    });
  } catch (err) { console.error('[denSuspenderTecnico] Erro:', err?.message); }

  // Remove o card público imediatamente se foi suspenso agora
  if (!jaSuspenso) {
    const card = document.querySelector(`.tc-card[data-id="${tecnicoId}"]`);
    if (card) card.remove();
  }
  admRenderizar();
}

/** Valida o conselho de classe — muda status do técnico para 'ativo'. */
async function admValidarConselho(tecId) {
  try {
    await fetch(`${_admBackendUrl()}/api/v1/admin/tecnicos/${tecId}/validar`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) { console.error('[admValidarConselho] Erro:', err?.message); }
  admRenderizar();
}

/** Suspende ou reativa um técnico. */
async function admToggleBanTecnico(id, estaSuspensoAtualmente) {
  const jaSuspenso = estaSuspensoAtualmente === 'true' || estaSuspensoAtualmente === true;
  const novoStatus = jaSuspenso ? 'ativo' : 'suspenso';
  try {
    await fetch(`${_admBackendUrl()}/api/v1/admin/tecnicos/${id}/status`, {
      method:  'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ status: novoStatus }),
    });
  } catch (err) { console.error('[admToggleBanTecnico] Erro:', err?.message); }

  const card = document.querySelector(`.tc-card[data-id="${id}"]`);
  if (card) card.style.display = novoStatus === 'suspenso' ? 'none' : '';

  admRenderizar();
}

/** Suspende ou reativa um produtor. */
async function admToggleBanProdutor(id, estaSuspensoAtualmente) {
  const jaSuspenso = estaSuspensoAtualmente === 'true' || estaSuspensoAtualmente === true;
  try {
    await fetch(`${_admBackendUrl()}/api/v1/admin/produtores/${id}/status`, {
      method:  'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ ativo: jaSuspenso }), // reativar → ativo:true
    });
  } catch (err) { console.error('[admToggleBanProdutor] Erro:', err?.message); }
  admRenderizar();
}

/** Concede ou revoga Premium manualmente (sem pagamento). */
async function admTogglePrem(id, jaPremium) {
  const novoValor = !(jaPremium === 'true' || jaPremium === true);
  try {
    await fetch(`${_admBackendUrl()}/api/v1/admin/tecnicos/${id}/premium`, {
      method:  'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ premium: novoValor }),
    });
  } catch (err) { console.error('[admTogglePrem] Erro:', err?.message); }

  const card = document.querySelector(`.tc-card[data-id="${id}"]`);
  if (card) card.classList.toggle('tec-premium', novoValor);

  admRenderizar();
}

// ── GRÁFICOS ─────────────────────────────────────────────────

/**
 * Renderiza os dois gráficos no painel admin, a partir de dados reais
 * de GET /api/admin/crescimento (contagem de técnicos por mês no
 * banco) — antes usava CRESCIMENTO_DEMO, uma série inventada com só
 * o último ponto real.
 */
async function admRenderizarGraficos() {
  const container = document.getElementById('adm-gf-barras');
  if (!container) return;

  let meses = [], totais = [], premiumsPorMes = [];
  try {
    const d = await _admFetchJSON('/api/admin/crescimento');
    meses  = d.meses  || [];
    totais = d.totais || [];
    premiumsPorMes = d.premiums || [];
  } catch (err) {
    console.error('[admin/crescimento] Erro:', err?.message);
  }

  const maxVal  = Math.max(...totais, 1);
  const isAtual = (i) => i === totais.length - 1;

  container.innerHTML = meses.map((mes, i) => `
    <div class="adm-gf-col">
      <span class="adm-gf-val">${totais[i] || 0}</span>
      <div class="adm-gf-barra${isAtual(i) ? ' destaque' : ''}"
        id="adm-bar-${i}" role="img" aria-label="${mes}: ${totais[i]||0} técnicos cadastrados"
        style="height:0"></div>
      <span class="adm-gf-mes">${mes}</span>
    </div>
  `).join('');

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      totais.forEach((v, i) => {
        const el = document.getElementById(`adm-bar-${i}`);
        if (el) el.style.height = `${Math.round((v / maxVal) * 100)}px`;
      });
    });
  });

  // ── GRÁFICO 2: distribuição produtores / técnicos / premium ──
  const nProdutores = ADM_CACHE.produtores.length;
  const nPremium    = ADM_CACHE.tecnicos.filter(t => t.premium).length;
  const nTecComum   = ADM_CACHE.tecnicos.length - nPremium;

  const total   = nProdutores + nTecComum + nPremium || 1;
  const pctProd = (nProdutores / total * 100).toFixed(1);
  const pctTec  = (nTecComum   / total * 100).toFixed(1);
  const pctPrem = (nPremium    / total * 100).toFixed(1);

  ['adm-segm-prod','adm-segm-tec','adm-segm-prem'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.width = '0%';
  });

  const labelsEl = document.getElementById('adm-gf-segm-labels');
  if (labelsEl) {
    labelsEl.innerHTML = [
      ['prod', `Produtores: ${nProdutores} (${pctProd}%)`],
      ['tec',  `Técnicos: ${nTecComum} (${pctTec}%)`],
      ['prem', `Premium: ${nPremium} (${pctPrem}%)`],
    ].map(([cls, txt]) => `<span class="adm-gf-segm-label ${cls}">${txt}</span>`).join('');
  }

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const segProd = document.getElementById('adm-segm-prod');
      const segTec  = document.getElementById('adm-segm-tec');
      const segPrem = document.getElementById('adm-segm-prem');
      if (segProd) segProd.style.width = pctProd + '%';
      if (segTec)  segTec.style.width  = pctTec  + '%';
      if (segPrem) segPrem.style.width  = pctPrem + '%';
    });
  });
}

// ── INTERCEPTAÇÃO DO LOGIN ADMIN ──────────────────────────────
// Verifica se as credenciais correspondem ao admin via backend.
// Nenhuma senha ou hash de admin é armazenado no frontend.

const _prodEntrarOriginal = prodEntrar;
prodEntrar = async function() {
  const ident = document.getElementById('prod-email-login').value.trim();
  const senha = document.getElementById('prod-senha-login').value;
  const errGeral = document.getElementById('prod-err-login-geral');

  // Tenta login admin via backend (não compara credenciais localmente)
  if (ident && senha) {
    try {
      const r = await fetch(`${_admBackendUrl()}/api/admin/login`, {
        method:      'POST',
        credentials: 'include',           // envia/recebe cookie HttpOnly
        headers:     { 'Content-Type': 'application/json' },
        body:        JSON.stringify({ email: ident, senha }),
      });
      if (r.ok) {
        document.getElementById('prod-email-login').value = '';
        document.getElementById('prod-senha-login').value = '';
        errGeral.classList.remove('show');
        admAbrir();
        return;
      }
      // 401 = credenciais erradas — pode ser produtor normal, continua
    } catch { /* backend offline — continua fluxo do produtor */ }
  }

  // Fluxo normal do produtor (a checagem de conta suspensa já acontece
  // no backend, via Produtores.buscarPorIdent filtrando ativo=1)
  _prodEntrarOriginal();
};

// Restaura estado do admin ao recarregar a página (valida via backend)
(async () => { if (await admLogado()) admAbrir(); })();

// ══════════════════════════════════════════════════════════════
// AVISO GLOBAL — disparado pelo admin, exibido para todos
// Chave localStorage : 'agro_aviso'       (texto do aviso)
// Chave sessionStorage: 'agro_aviso_fechado' (fechado pelo usuário)
// ══════════════════════════════════════════════════════════════

const AVISO_KEY        = 'agro_aviso';
const AVISO_FECHADO_KEY= 'agro_aviso_fechado';

/**
 * Exibe ou oculta a barra de aviso global.
 * Se texto for vazio → oculta. Caso contrário → exibe com animação.
 */
function _avisoExibir(texto) {
  const barra   = document.getElementById('aviso-global');
  const textoEl = document.getElementById('aviso-global-texto');
  if (!barra || !textoEl) return;

  if (texto && !sessionStorage.getItem(AVISO_FECHADO_KEY)) {
    textoEl.textContent = texto;
    barra.classList.add('visivel');
    document.body.classList.add('tem-aviso');
  } else {
    barra.classList.remove('visivel');
    document.body.classList.remove('tem-aviso');
  }

  // Sincroniza painel admin
  const statusEl = document.getElementById('adm-aviso-status');
  if (statusEl) {
    statusEl.textContent = texto
      ? `✓ Aviso ativo: "${texto.slice(0, 60)}${texto.length > 60 ? '…' : ''}"`
      : 'Nenhum aviso publicado no momento.';
    const inputEl = document.getElementById('adm-aviso-input');
    if (inputEl && !inputEl.value) inputEl.placeholder =
      texto || 'Digite o texto do aviso que aparecerá no topo do site…';
  }
}

/**
 * avisoInit — carrega aviso do backend (com fallback para localStorage).
 * Rota backend: GET /api/v1/aviso → { texto: "..." }
 */
async function avisoInit() {
  // Tenta buscar do backend (aviso centralizado para todos os usuários)
  try {
    const r = await fetch(`${_admBackendUrl()}/api/v1/aviso`, { cache: 'no-store' })
      .catch(() => null);
    if (r && r.ok) {
      const data = await r.json().catch(() => ({}));
      const textoServidor = data.texto || '';
      // Sincroniza localStorage com o que vem do servidor
      if (textoServidor) {
        localStorage.setItem(AVISO_KEY, textoServidor);
      } else {
        localStorage.removeItem(AVISO_KEY);
      }
      _avisoExibir(textoServidor);
      return;
    }
  } catch (_) {}

  // Fallback: usa localStorage (admin local ou última versão cacheada)
  _avisoExibir(localStorage.getItem(AVISO_KEY) || '');
}

/**
 * Publica aviso via admin: salva no backend + localStorage + exibe.
 */
async function avisoPublicar() {
  const input  = document.getElementById('adm-aviso-input');
  const texto  = input.value.trim();
  const status = document.getElementById('adm-aviso-status');

  if (!texto) {
    status.textContent = '⚠ Digite o texto antes de publicar.';
    input.focus();
    return;
  }

  // Persiste no backend em background
  fetch(`${_admBackendUrl()}/api/v1/aviso`, {
    method:  'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texto }),
  }).catch(() => {});

  localStorage.setItem(AVISO_KEY, texto);
  sessionStorage.removeItem(AVISO_FECHADO_KEY);
  input.value = '';
  _avisoExibir(texto);
  status.textContent = '✓ Aviso publicado!';
}

/**
 * Remove aviso do backend + localStorage + oculta barra.
 */
function avisoRemover() {
  fetch(`${_admBackendUrl()}/api/v1/aviso`, {
    method:  'DELETE',
    credentials: 'include',
  }).catch(() => {});

  localStorage.removeItem(AVISO_KEY);
  sessionStorage.removeItem(AVISO_FECHADO_KEY);
  _avisoExibir('');
  const status = document.getElementById('adm-aviso-status');
  if (status) status.textContent = 'Aviso removido.';
}

/**
 * Fecha a barra apenas nesta sessão do usuário.
 */
function avisoFechar() {
  sessionStorage.setItem(AVISO_FECHADO_KEY, '1');
  document.getElementById('aviso-global').classList.remove('visivel');
  document.body.classList.remove('tem-aviso');
}

// Roda na inicialização da página
avisoInit();
