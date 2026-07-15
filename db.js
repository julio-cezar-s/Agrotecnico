/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  AgroTécnico — Camada de Banco de Dados                         ║
 * ║                                                                  ║
 * ║  MVP:       SQLite via better-sqlite3 (zero infraestrutura)     ║
 * ║  Produção:  Troque o driver abaixo por 'pg' (PostgreSQL)        ║
 * ║                                                                  ║
 * ║  INSTALAÇÃO MVP:                                                 ║
 * ║    npm install better-sqlite3                                    ║
 * ║                                                                  ║
 * ║  INSTALAÇÃO PRODUÇÃO:                                            ║
 * ║    npm install pg                                                ║
 * ║    # Definir DATABASE_URL no .env                               ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

'use strict';

const path = require('path');
const fs   = require('fs');

// ── Detecção automática de ambiente ──────────────────────────────
const USE_POSTGRES = !!process.env.DATABASE_URL;

// ══════════════════════════════════════════════════════════════════
// DRIVER SQLite (MVP)
// ══════════════════════════════════════════════════════════════════
function criarDriverSQLite() {
  const Database = require('better-sqlite3');
  const DB_FILE  = process.env.DB_FILE || path.join(__dirname, 'agrotecnico.db');
  const db       = new Database(DB_FILE);

  // Performance: WAL mode permite leituras concorrentes sem travar escritas
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Executa o schema na primeira vez
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
  db.exec(schema);

  console.log(`[db] SQLite iniciado: ${DB_FILE}`);

  return {
    /**
     * Executa uma query que retorna múltiplas linhas.
     * @param {string} sql
     * @param {any[]} params
     * @returns {any[]}
     */
    query(sql, params = []) {
      return db.prepare(sql).all(...params);
    },

    /**
     * Executa uma query que retorna uma linha.
     * @param {string} sql
     * @param {any[]} params
     * @returns {any|undefined}
     */
    queryOne(sql, params = []) {
      return db.prepare(sql).get(...params);
    },

    /**
     * Executa INSERT/UPDATE/DELETE.
     * @param {string} sql
     * @param {any[]} params
     * @returns {{ changes: number, lastInsertRowid: number }}
     */
    run(sql, params = []) {
      return db.prepare(sql).run(...params);
    },

    /**
     * Executa múltiplas operações em transação atômica.
     * @param {Function} fn - função que recebe o driver e executa queries
     */
    transaction(fn) {
      return db.transaction(fn)(this);
    },

    // Compatibilidade de sintaxe com PostgreSQL: ? → $1, $2...
    // SQLite usa ? nativamente — sem conversão necessária.
    placeholder: (n) => '?',

    close() { db.close(); },
  };
}

// ══════════════════════════════════════════════════════════════════
// DRIVER PostgreSQL (Produção)
// ══════════════════════════════════════════════════════════════════
function criarDriverPostgres() {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    max:             10,   // pool de conexões
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 2_000,
  });

  pool.on('error', (err) => {
    console.error('[db] PostgreSQL pool error:', err.message);
  });

  console.log('[db] PostgreSQL conectado via pool');

  return {
    async query(sql, params = []) {
      const res = await pool.query(sql, params);
      return res.rows;
    },

    async queryOne(sql, params = []) {
      const res = await pool.query(sql, params);
      return res.rows[0] || undefined;
    },

    async run(sql, params = []) {
      const res = await pool.query(sql, params);
      return { changes: res.rowCount, lastInsertRowid: res.rows[0]?.id };
    },

    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({
          query:    (sql, p) => client.query(sql, p).then(r => r.rows),
          queryOne: (sql, p) => client.query(sql, p).then(r => r.rows[0]),
          run:      (sql, p) => client.query(sql, p).then(r => ({ changes: r.rowCount })),
        });
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },

    // PostgreSQL usa $1, $2... em vez de ?
    placeholder: (n) => `$${n}`,

    async close() { await pool.end(); },
  };
}

// ══════════════════════════════════════════════════════════════════
// REPOSITÓRIOS — camada de acesso a dados
// Interface idêntica independente do banco
// ══════════════════════════════════════════════════════════════════

const db = USE_POSTGRES ? criarDriverPostgres() : criarDriverSQLite();

/**
 * Hash HMAC de valores sensíveis (IP, CPF) — irreversível, comparável.
 */
const crypto = require('crypto');
function hashSensivel(valor) {
  const secret = process.env.HASH_SECRET || 'agrotecnico-hash-secret-dev';
  return crypto.createHmac('sha256', secret).update(String(valor)).digest('hex');
}

/**
 * Converte um nome em slug ASCII minúsculo, hífens entre palavras.
 * "Beatriz Silva" → "beatriz-silva". Usado para gerar tecnicos.public_id.
 */
function slugNome(nome) {
  return (nome || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’‘ʼ`]/g, '-')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ── REPOSITÓRIO: Produtores ───────────────────────────────────────
const Produtores = {
  buscarPorIdent(ident) {
    return db.queryOne(
      'SELECT * FROM produtores WHERE identificador = ? AND ativo = 1',
      [ident.toLowerCase().trim()]
    );
  },

  criar({ nome, identificador, tipoIdent, senhaHash, aceitouNovidades }) {
    return db.run(
      `INSERT INTO produtores (nome, identificador, tipo_ident, senha_hash, aceita_novidades)
       VALUES (?, ?, ?, ?, ?)`,
      [nome, identificador.toLowerCase().trim(), tipoIdent, senhaHash, aceitouNovidades ? 1 : 0]
    );
  },

  contarFavoritos(produtorId) {
    const r = db.queryOne('SELECT COUNT(*) as n FROM produtor_favoritos WHERE produtor_id = ?', [produtorId]);
    return r?.n || 0;
  },

  toggleFavorito(produtorId, tecnicoId) {
    const existe = db.queryOne(
      'SELECT 1 FROM produtor_favoritos WHERE produtor_id = ? AND tecnico_id = ?',
      [produtorId, tecnicoId]
    );
    if (existe) {
      db.run('DELETE FROM produtor_favoritos WHERE produtor_id = ? AND tecnico_id = ?', [produtorId, tecnicoId]);
      return false;
    }
    db.run('INSERT INTO produtor_favoritos (produtor_id, tecnico_id) VALUES (?, ?)', [produtorId, tecnicoId]);
    return true;
  },
};

// ── REPOSITÓRIO: Técnicos ─────────────────────────────────────────
const Tecnicos = {
  listar({ uf, status = 'ativo', premium } = {}) {
    let sql    = 'SELECT * FROM tecnicos WHERE status = ? AND ativo = 1';
    const params = [status];
    if (uf)      { sql += ' AND uf = ?';      params.push(uf.toUpperCase()); }
    if (premium !== undefined) { sql += ' AND premium = ?'; params.push(premium ? 1 : 0); }
    sql += ' ORDER BY premium DESC, media_avaliacoes DESC';
    return db.query(sql, params);
  },

  buscarPorId(id) {
    return db.queryOne('SELECT * FROM tecnicos WHERE id = ?', [id]);
  },

  buscarPorPublicId(publicId) {
    return db.queryOne('SELECT * FROM tecnicos WHERE public_id = ?', [publicId]);
  },

  /**
   * Busca por e-mail OU whatsapp — usada no login do técnico, onde o
   * identificador pode ser digitado em qualquer um dos dois formatos.
   */
  buscarPorIdentificador(identificador) {
    const identLimpo = (identificador || '').trim().toLowerCase();
    const wppLimpo    = (identificador || '').replace(/\D/g, '');
    return db.queryOne(
      'SELECT * FROM tecnicos WHERE lower(email) = ? OR whatsapp = ?',
      [identLimpo, wppLimpo]
    );
  },

  /**
   * Gera um public_id único no formato tc-{slug-do-nome}[-N], consultando
   * o banco a cada tentativa — substitui o Set em memória usado no MVP
   * baseado em JSON, já que múltiplos processos podem escrever ao mesmo
   * tempo em produção.
   */
  gerarPublicIdUnico(nome) {
    const base = `tc-${slugNome(nome) || 'tecnico'}`;
    if (!db.queryOne('SELECT 1 FROM tecnicos WHERE public_id = ?', [base])) return base;
    let n = 2;
    let candidato = `${base}-${n}`;
    while (db.queryOne('SELECT 1 FROM tecnicos WHERE public_id = ?', [candidato])) {
      n++;
      candidato = `${base}-${n}`;
    }
    return candidato;
  },

  criar(dados) {
    const cpfHash      = hashSensivel(dados.cpf);
    const publicId     = this.gerarPublicIdUnico(dados.nome);
    const uploadToken  = crypto.randomUUID();
    const registroCompleto = `${dados.conselho}-${dados.ufConselho} ${dados.numConselho}`;

    const info = db.run(
      `INSERT INTO tecnicos
         (public_id, nome, whatsapp, email, cpf_hash, upload_token,
          cidade, uf, lat, lng, formacao,
          conselho, num_conselho, uf_conselho, registro_completo,
          bio, especialidades, servico, raio_km,
          status, ativo)
       VALUES (?,?,?,?,?,?, ?,?,?,?,?, ?,?,?,?, ?,?,?,?, 'pendente', 0)`,
      [
        publicId, dados.nome, dados.whatsapp, dados.email || null, cpfHash, uploadToken,
        dados.cidade, dados.uf, dados.lat || null, dados.lng || null, dados.formacao || null,
        dados.conselho, dados.numConselho, dados.ufConselho, registroCompleto,
        dados.bio || null, JSON.stringify(dados.especialidades || []), dados.servico || null,
        dados.raio || 100,
      ]
    );

    return { id: info.lastInsertRowid, publicId, uploadToken };
  },

  /**
   * Confirma que quem está enviando o documento comprobatório (ou
   * definindo a 1ª senha) é quem de fato criou o cadastro — mesma
   * prova de posse usada no server.js original.
   */
  verificarUploadToken(id, tokenRecebido) {
    const tec = db.queryOne('SELECT upload_token FROM tecnicos WHERE id = ?', [id]);
    return !!(tec && tec.upload_token && tec.upload_token === tokenRecebido);
  },

  salvarDocumento(id, { docPath, docOriginalName, docMime }) {
    return db.run(
      `UPDATE tecnicos SET doc_path = ?, doc_original_name = ?, doc_mime = ?,
       doc_enviado_em = datetime('now'), atualizado_em = datetime('now')
       WHERE id = ?`,
      [docPath, docOriginalName, docMime, id]
    );
  },

  listarPendentes() {
    return db.query("SELECT * FROM tecnicos WHERE status = 'pendente' ORDER BY criado_em DESC");
  },

  atualizarStatus(id, status, adminNome = 'sistema') {
    return db.run(
      `UPDATE tecnicos SET status = ?, ativo = ?, validado_em = datetime('now'), validado_por = ?,
       atualizado_em = datetime('now') WHERE id = ?`,
      [status, status === 'ativo' ? 1 : 0, adminNome, id]
    );
  },

  suspenderAutomaticamente(id) {
    return db.run(
      `UPDATE tecnicos SET status = 'suspenso', ativo = 0, suspensao_auto = 1,
       suspensao_data = datetime('now'), atualizado_em = datetime('now') WHERE id = ?`,
      [id]
    );
  },

  /**
   * Define a senha no primeiro acesso (prova de posse via upload_token).
   * Recusa se já existir senha — alterações posteriores exigem sessão
   * autenticada, não o upload_token do cadastro.
   */
  definirSenhaPrimeiroAcesso(id, senhaHash) {
    const tec = db.queryOne('SELECT senha_hash FROM tecnicos WHERE id = ?', [id]);
    if (!tec) return { ok: false, motivo: 'nao_encontrado' };
    if (tec.senha_hash) return { ok: false, motivo: 'ja_definida' };
    db.run('UPDATE tecnicos SET senha_hash = ? WHERE id = ?', [senhaHash, id]);
    return { ok: true };
  },

  ativarPremium(identificador, pagamentoId) {
    return db.run(
      `UPDATE tecnicos SET premium = 1, premium_desde = datetime('now'),
       premium_pagamento_id = ?, atualizado_em = datetime('now')
       WHERE whatsapp = ? OR email = ?`,
      [pagamentoId, identificador, identificador]
    );
  },

  /**
   * Ativa o Premium vinculando pelo tecnico_id (FK) em vez de casar por
   * e-mail/whatsapp — elimina a ambiguidade do método legado acima
   * (ex.: dois técnicos com o mesmo e-mail cadastrado por engano).
   * Preferir sempre este método quando o tecnicoId estiver disponível.
   */
  ativarPremiumPorId(tecnicoId, pagamentoId) {
    return db.run(
      `UPDATE tecnicos SET premium = 1, premium_desde = datetime('now'),
       premium_pagamento_id = ?, atualizado_em = datetime('now')
       WHERE id = ?`,
      [pagamentoId, tecnicoId]
    );
  },

  atualizarMediaAvaliacoes(tecnicoId) {
    const r = db.queryOne(
      'SELECT AVG(nota) as media, COUNT(*) as total FROM avaliacoes WHERE tecnico_id = ?',
      [tecnicoId]
    );
    db.run(
      'UPDATE tecnicos SET media_avaliacoes = ?, total_avaliacoes = ? WHERE id = ?',
      [r?.media || 0, r?.total || 0, tecnicoId]
    );
  },

  /**
   * Incrementa um contador de interação (visualização, clique em
   * WhatsApp/telefone/e-mail). Allow-list explícita de colunas — nunca
   * interpola o nome do parâmetro `campo` diretamente na query, para
   * não abrir brecha de SQL injection via nome de coluna arbitrário.
   */
  incrementarContador(id, campo) {
    const colunas = {
      visualizacoes:   'visualizacoes',
      cliquesWhatsapp: 'cliques_whatsapp',
      cliquesTelefone: 'cliques_telefone',
      cliquesEmail:    'cliques_email',
    };
    const coluna = colunas[campo];
    if (!coluna) throw new Error(`[Tecnicos.incrementarContador] campo inválido: ${campo}`);
    return db.run(`UPDATE tecnicos SET ${coluna} = ${coluna} + 1 WHERE id = ?`, [id]);
  },
  /**
   * Atualiza campos individuais do perfil — só grava o que foi passado,
   * preservando os demais (mesmo padrão "campos não enviados = mantidos"
   * das rotas PUT /tecnico/me/*).
   */
  atualizarPerfil(id, { bio, formacao, experiencia } = {}) {
    const campos = [];
    const valores = [];
    if (bio         !== undefined) { campos.push('bio = ?');         valores.push(bio); }
    if (formacao    !== undefined) { campos.push('formacao = ?');    valores.push(formacao); }
    if (experiencia !== undefined) { campos.push('experiencia = ?'); valores.push(experiencia); }
    if (!campos.length) return null;
    campos.push("atualizado_em = datetime('now')");
    valores.push(id);
    return db.run(`UPDATE tecnicos SET ${campos.join(', ')} WHERE id = ?`, valores);
  },

  atualizarEspecialidades(id, lista) {
    return db.run(
      `UPDATE tecnicos SET especialidades = ?, atualizado_em = datetime('now') WHERE id = ?`,
      [JSON.stringify(lista), id]
    );
  },

  atualizarServicos(id, lista) {
    return db.run(
      `UPDATE tecnicos SET servicos = ?, atualizado_em = datetime('now') WHERE id = ?`,
      [JSON.stringify(lista), id]
    );
  },

  atualizarContato(id, { whatsapp, email } = {}) {
    const campos = [];
    const valores = [];
    if (whatsapp !== undefined) { campos.push('whatsapp = ?'); valores.push(whatsapp); }
    if (email    !== undefined) { campos.push('email = ?');    valores.push(email); }
    if (!campos.length) return null;
    campos.push("atualizado_em = datetime('now')");
    valores.push(id);
    return db.run(`UPDATE tecnicos SET ${campos.join(', ')} WHERE id = ?`, valores);
  },
};
const TecnicoSessoes = {
  criar(tecnicoId, ip) {
    const token    = crypto.randomUUID();
    const ipHash   = hashSensivel(ip);
    const expiraEm = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(); // 8 horas
    db.run(
      'INSERT INTO tecnico_sessoes (token, tecnico_id, ip_hash, expira_em) VALUES (?,?,?,?)',
      [token, tecnicoId, ipHash, expiraEm]
    );
    return { token, expiraEm };
  },

  validar(token) {
    const r = db.queryOne(
      "SELECT tecnico_id, expira_em FROM tecnico_sessoes WHERE token = ? AND expira_em > datetime('now')",
      [token]
    );
    return r ? { tecnicoId: r.tecnico_id } : null;
  },

  revogar(token) {
    return db.run('DELETE FROM tecnico_sessoes WHERE token = ?', [token]);
  },

  revogarTodasDoTecnico(tecnicoId) {
    return db.run('DELETE FROM tecnico_sessoes WHERE tecnico_id = ?', [tecnicoId]);
  },
};

// ── REPOSITÓRIO: Pagamentos ───────────────────────────────────────
const Pagamentos = {
  /**
   * Cria o registro pendente no momento em que o Pix/cartão é gerado
   * junto ao Mercado Pago — antes de saber se será aprovado. Isso
   * substitui o comportamento antigo (premiums.json só ganhava uma
   * entrada DEPOIS da aprovação), permitindo status/histórico também
   * para pagamentos pendentes/rejeitados, e dá ao webhook uma linha
   * já existente para atualizar em vez de criar do zero.
   */
  criarPendente({ pagamentoIdMp, identificador, tecnicoId, plano, valor, metodo = 'pix' }) {
    return db.run(
      `INSERT OR IGNORE INTO pagamentos
         (pagamento_id_mp, identificador, tecnico_id, plano, valor, metodo, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      [pagamentoIdMp, identificador, tecnicoId || null, plano, valor, metodo]
    );
  },

  // Mantido para compatibilidade — equivalente a criarPendente, nome antigo.
  registrar({ pagamentoIdMp, identificador, plano, valor, metodo = 'pix' }) {
    return this.criarPendente({ pagamentoIdMp, identificador, plano, valor, metodo });
  },

  /**
   * Marca o pagamento como aprovado e gera (ou reaproveita) o
   * desbloqueio_token do técnico — o mesmo token deve se manter entre
   * renovações de assinatura, para que uma demanda já desbloqueada
   * anteriormente continue acessível sem exigir novo pagamento.
   *
   * @returns {{ desbloqueioToken: string }}
   */
  aprovar(pagamentoIdMp, { tecnicoId } = {}) {
    let desbloqueioToken = null;

    if (tecnicoId) {
      const anterior = db.queryOne(
        `SELECT desbloqueio_token FROM pagamentos
         WHERE tecnico_id = ? AND status = 'approved' AND desbloqueio_token IS NOT NULL
         ORDER BY aprovado_em DESC LIMIT 1`,
        [tecnicoId]
      );
      desbloqueioToken = anterior?.desbloqueio_token || crypto.randomUUID();
    } else {
      desbloqueioToken = crypto.randomUUID();
    }

    db.run(
      `UPDATE pagamentos SET status = 'approved', aprovado_em = datetime('now'),
       webhook_recebido_em = datetime('now'), idempotencia_ok = 1, desbloqueio_token = ?
       WHERE pagamento_id_mp = ?`,
      [desbloqueioToken, pagamentoIdMp]
    );

    return { desbloqueioToken };
  },

  jaAtivado(pagamentoIdMp) {
    const r = db.queryOne(
      'SELECT idempotencia_ok FROM pagamentos WHERE pagamento_id_mp = ?',
      [pagamentoIdMp]
    );
    return r?.idempotencia_ok === 1;
  },

  buscarPorIdent(identificador) {
    return db.queryOne(
      `SELECT * FROM pagamentos WHERE identificador = ? AND status = 'approved'
       ORDER BY aprovado_em DESC LIMIT 1`,
      [identificador]
    );
  },

  buscarPorMpId(pagamentoIdMp) {
    return db.queryOne('SELECT * FROM pagamentos WHERE pagamento_id_mp = ?', [pagamentoIdMp]);
  },

  /** Usado por GET /pagamentos/status/id/:paymentId — polling seguro por ID. */
  statusPorId(pagamentoIdMp) {
    return db.queryOne(
      'SELECT status, aprovado_em, desbloqueio_token, tecnico_id FROM pagamentos WHERE pagamento_id_mp = ?',
      [pagamentoIdMp]
    );
  },

  /** Usado por GET /pagamentos/status/:identificador — fallback legado. */
  statusPorIdentificador(identificador) {
    return db.queryOne(
      `SELECT status, aprovado_em FROM pagamentos
       WHERE identificador = ? AND status = 'approved'
       ORDER BY aprovado_em DESC LIMIT 1`,
      [identificador]
    );
  },

  /**
   * Token de posse do técnico Premium — usado em POST /demandas/:id/
   * desbloquear para provar que quem está pedindo o contato realmente
   * pagou (e não apenas descobriu o tecnicoId de outra pessoa).
   */
  desbloqueioTokenPorTecnico(tecnicoId) {
    const r = db.queryOne(
      `SELECT desbloqueio_token FROM pagamentos
       WHERE tecnico_id = ? AND status = 'approved' AND desbloqueio_token IS NOT NULL
       ORDER BY aprovado_em DESC LIMIT 1`,
      [tecnicoId]
    );
    return r?.desbloqueio_token || null;
  },

  /**
   * Contagem de pagamentos aprovados por mês (últimos `qtdMeses`) —
   * usado no gráfico de crescimento do painel admin. Retorna
   * [{ mes: 'YYYY-MM', total: N }, ...]; meses sem aprovação
   * simplesmente não aparecem na lista (o chamador preenche 0).
   */
  aprovadosPorMes(qtdMeses = 6) {
    return db.query(
      `SELECT strftime('%Y-%m', aprovado_em) as mes, COUNT(*) as total
       FROM pagamentos
       WHERE status = 'approved' AND aprovado_em >= datetime('now', ?)
       GROUP BY mes`,
      [`-${qtdMeses} months`]
    );
  },

  totalAprovados() {
    const r = db.queryOne("SELECT COUNT(*) as n FROM pagamentos WHERE status = 'approved'");
    return r?.n || 0;
  },
};

// ── REPOSITÓRIO: Avaliações ───────────────────────────────────────
const Avaliacoes = {
  listarPorTecnico(tecnicoId) {
    return db.query(
      'SELECT id, autor_nome, texto, nota, criado_em FROM avaliacoes WHERE tecnico_id = ? ORDER BY criado_em DESC',
      [tecnicoId]
    );
  },

  criar({ tecnicoId, autorNome, texto, nota, ip }) {
    const ipHash = hashSensivel(ip);
    return db.run(
      `INSERT INTO avaliacoes (tecnico_id, autor_nome, texto, nota, ip_hash)
       VALUES (?, ?, ?, ?, ?)`,
      [tecnicoId, autorNome, texto, nota, ipHash]
    );
  },

  jaAvaliouHoje(tecnicoId, ip) {
    const ipHash = hashSensivel(ip);
    const r = db.queryOne(
      `SELECT 1 FROM avaliacoes WHERE tecnico_id = ? AND ip_hash = ?
       AND date(criado_em) = date('now')`,
      [tecnicoId, ipHash]
    );
    return !!r;
  },
};

// ── REPOSITÓRIO: Denúncias ────────────────────────────────────────
const Denuncias = {
  listar() {
    return db.query('SELECT * FROM denuncias ORDER BY criado_em DESC');
  },

  criar({ tecnicoId, tecnicoNome, motivo, descricao, ip }) {
    const ipHash = hashSensivel(ip);
    return db.run(
      `INSERT INTO denuncias (tecnico_id, tecnico_nome, motivo, descricao, ip_hash)
       VALUES (?, ?, ?, ?, ?)`,
      [tecnicoId, tecnicoNome, motivo, descricao || null, ipHash]
    );
  },

  jaDenounciouHoje(tecnicoId, motivo, ip) {
    const ipHash = hashSensivel(ip);
    const r = db.queryOne(
      `SELECT 1 FROM denuncias WHERE tecnico_id = ? AND motivo = ? AND ip_hash = ?
       AND date(criado_em) = date('now')`,
      [tecnicoId, motivo, ipHash]
    );
    return !!r;
  },

  contarFalsosProfissionais(tecnicoId) {
    const r = db.queryOne(
      `SELECT COUNT(*) as n FROM denuncias
       WHERE tecnico_id = ? AND motivo = 'falso_profissional' AND status = 'pendente'`,
      [tecnicoId]
    );
    return r?.n || 0;
  },

  arquivar(id, resolucao, resolvidoPor = 'admin') {
    return db.run(
      `UPDATE denuncias SET status = 'arquivada', resolucao = ?,
       resolvido_em = datetime('now'), resolvido_por = ? WHERE id = ?`,
      [resolucao, resolvidoPor, id]
    );
  },
};

// ── REPOSITÓRIO: Demandas ─────────────────────────────────────────
const Demandas = {
  listarAtivas() {
    return db.query(
      `SELECT id, produtor_nome, cultura, descricao, cidade, uf, canal, status, criado_em
       FROM demandas WHERE status = 'ativa' AND expira_em > datetime('now')
       ORDER BY criado_em DESC`
      // contato_enc e contato_iv NUNCA retornados na listagem pública
    );
  },

  criar({ produtorNome, cultura, descricao, cidade, uf, canal, contatoEnc, contatoIv, optin, ip }) {
    const ipHash   = hashSensivel(ip);
    const expiraEm = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    return db.run(
      `INSERT INTO demandas
         (produtor_nome, cultura, descricao, cidade, uf, canal,
          contato_enc, contato_iv, optin_novidades, expira_em, ip_hash)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [produtorNome, cultura, descricao, cidade, uf, canal,
       contatoEnc, contatoIv, optin ? 1 : 0, expiraEm, ipHash]
    );
  },

  buscarContato(id) {
    // Retorna dados de contato criptografados — desencripta no backend
    return db.queryOne('SELECT contato_enc, contato_iv, canal FROM demandas WHERE id = ?', [id]);
  },

  registrarDesbloqueio(demandaId, tecnicoId, ip) {
    const ipHash = hashSensivel(ip);
    return db.run(
      'INSERT OR IGNORE INTO demanda_desbloqueios (demanda_id, tecnico_id, ip_hash) VALUES (?,?,?)',
      [demandaId, tecnicoId, ipHash]
    );
  },

  encerrar(id) {
    return db.run("UPDATE demandas SET status = 'encerrada' WHERE id = ?", [id]);
  },
};

// ── REPOSITÓRIO: Classificados ────────────────────────────────────
const Classificados = {
  listarAtivos() {
    return db.query(
      `SELECT id, empresa, titulo, descricao, wpp, icone, criado_em
       FROM classificados WHERE status = 'ativo' AND expira_em > datetime('now')
       ORDER BY pago DESC, criado_em DESC`
    );
  },

  contarPorIdent(identificador) {
    const r = db.queryOne(
      'SELECT COUNT(*) as n FROM classificados WHERE identificador = ?',
      [identificador]
    );
    return r?.n || 0;
  },

  criar({ identificador, empresa, titulo, descricao, wpp, icone, pago, pagamentoId }) {
    const expiraEm = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    return db.run(
      `INSERT INTO classificados
         (identificador, empresa, titulo, descricao, wpp, icone, pago, pagamento_id, expira_em)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [identificador, empresa, titulo, descricao, wpp, icone || '🏪', pago ? 1 : 0, pagamentoId || null, expiraEm]
    );
  },

  /**
   * Idempotência da confirmação de pagamento — se este pagamentoId já
   * publicou um anúncio antes, retorna o registro existente em vez de
   * duplicar. Substitui a checagem manual em classificados.json.
   */
  buscarPorPagamentoId(pagamentoId) {
    return db.queryOne('SELECT * FROM classificados WHERE pagamento_id = ?', [pagamentoId]);
  },
};

// ── REPOSITÓRIO: Configurações ────────────────────────────────────
const Configuracoes = {
  get(chave) {
    const r = db.queryOne('SELECT valor FROM configuracoes WHERE chave = ?', [chave]);
    return r?.valor;
  },

  set(chave, valor) {
    return db.run(
      `INSERT INTO configuracoes (chave, valor, atualizado_em)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, atualizado_em = excluded.atualizado_em`,
      [chave, String(valor)]
    );
  },

  precos() {
    return {
      premium:      parseFloat(this.get('preco_premium')      || '49.90'),
      classificado: parseFloat(this.get('preco_classificado') || '29.90'),
    };
  },

  /**
   * Substitui precosCfgSalvar() (arquivo precos.json) — grava os dois
   * preços na tabela `configuracoes`. Validação de faixa (R$1–999) fica
   * a cargo de quem chama (a rota), igual ao comportamento anterior.
   */
  definirPrecos(premium, classificado) {
    this.set('preco_premium', premium);
    this.set('preco_classificado', classificado);
    return this.precos();
  },
};

// ── REPOSITÓRIO: Avisos ───────────────────────────────────────────
const Avisos = {
  ativo() {
    return db.queryOne('SELECT texto FROM avisos WHERE ativo = 1 ORDER BY criado_em DESC LIMIT 1');
  },

  publicar(texto) {
    db.run('UPDATE avisos SET ativo = 0 WHERE ativo = 1'); // desativa o anterior
    return db.run('INSERT INTO avisos (texto) VALUES (?)', [texto]);
  },

  remover() {
    return db.run('UPDATE avisos SET ativo = 0 WHERE ativo = 1');
  },
};

// ── REPOSITÓRIO: Sessões Admin ────────────────────────────────────
const AdminSessoes = {
  criar(ip, ttlMs = 8 * 60 * 60 * 1000) {
    const token   = crypto.randomUUID();
    const ipHash  = hashSensivel(ip);
    const expiraEm = new Date(Date.now() + ttlMs).toISOString();
    db.run(
      'INSERT INTO admin_sessoes (token, ip_hash, expira_em) VALUES (?,?,?)',
      [token, ipHash, expiraEm]
    );
    return token;
  },

  validar(token) {
    const r = db.queryOne(
      "SELECT 1 FROM admin_sessoes WHERE token = ? AND expira_em > datetime('now')",
      [token]
    );
    return !!r;
  },

  revogar(token) {
    return db.run('DELETE FROM admin_sessoes WHERE token = ?', [token]);
  },
};

// ── REPOSITÓRIO: Pedidos de Técnico ──────────────────────────────
const PedidosTecnico = {
  criar({ nome, whatsapp, necessidade, cidade, especialidade }) {
    return db.run(
      `INSERT INTO pedidos_tecnico (nome, whatsapp, necessidade, cidade, especialidade)
       VALUES (?,?,?,?,?)`,
      [nome, whatsapp, necessidade, cidade || null, especialidade || null]
    );
  },
};

// ══════════════════════════════════════════════════════════════════
// EXPORTS
// ══════════════════════════════════════════════════════════════════
module.exports = {
  db,
  hashSensivel,
  Produtores,
  Tecnicos,
  TecnicoSessoes,
  Pagamentos,
  Avaliacoes,
  Denuncias,
  Demandas,
  Classificados,
  Configuracoes,
  Avisos,
  AdminSessoes,
  PedidosTecnico,
};
