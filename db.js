/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  AgroTécnico — Camada de Banco de Dados                         ║
 * ║                                                                  ║
 * ║  MVP:       SQLite via better-sqlite3 (zero infraestrutura)     ║
 * ║  Produção:  PostgreSQL via 'pg' — ativado com DATABASE_URL      ║
 * ║                                                                  ║
 * ║  INSTALAÇÃO MVP:                                                 ║
 * ║    npm install better-sqlite3                                    ║
 * ║                                                                  ║
 * ║  INSTALAÇÃO PRODUÇÃO:                                            ║
 * ║    npm install pg                                                ║
 * ║    # Definir DATABASE_URL no .env                               ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * ── POR QUE TODO REPOSITÓRIO AQUI É async/await ─────────────────────
 * O driver SQLite (better-sqlite3) é SÍNCRONO — query/queryOne/run
 * retornam o valor direto, na hora. O driver Postgres (pg) é
 * ASSÍNCRONO — os mesmos métodos retornam Promises, porque falam com
 * um banco pela rede. `await` funciona corretamente nos dois casos
 * (await em um valor não-Promise apenas resolve na hora), então TODO
 * método de repositório aqui usa async/await, mesmo os que rodam
 * contra SQLite — é o único jeito de ter uma interface realmente
 * idêntica entre os dois bancos, sem armadilha de Promise não
 * aguardada (bug real encontrado e corrigido nesta revisão: métodos
 * sem await retornavam a própria Promise em vez do dado, fazendo
 * checagens como `if (!tecnico)` nunca disparar 404 contra Postgres).
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

    // ── Helpers de dialeto SQL — SQLite ──────────────────────────
    // Repositórios chamam essas funções em vez de escrever
    // `datetime('now')` direto no texto da query, para que o mesmo
    // código de repositório funcione sem alteração nos dois bancos.
    agora:        () => "datetime('now')",
    condicaoHoje: (coluna) => `date(${coluna}) = date('now')`,

    close() { db.close(); },
  };
}

// ══════════════════════════════════════════════════════════════════
// DRIVER PostgreSQL (Produção)
// ══════════════════════════════════════════════════════════════════

/**
 * Traduz placeholders `?` (sintaxe SQLite) para `$1, $2, ...`
 * (sintaxe Postgres/pg), na ordem em que aparecem. Todo repositório
 * escreve as queries com `?` — essa tradução acontece uma vez, aqui,
 * em vez de reescrever ~70 strings SQL manualmente.
 */
function traduzirPlaceholders(sql) {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

/**
 * Executa schema-postgres.sql statement por statement (não confia no
 * protocolo simples do 'pg' aceitar múltiplos comandos em uma única
 * chamada — testado e confirmado que o divisor manual é mais seguro
 * e dá erros mais claros, apontando exatamente qual statement falhou).
 */
async function executarSchemaPostgres(pool) {
  const schemaPath = path.join(__dirname, 'schema-postgres.sql');
  const schemaSql  = fs.readFileSync(schemaPath, 'utf-8');

  // Remove comentários de linha antes de dividir por ';', para um ';'
  // dentro de um comentário não cortar um statement no lugar errado.
  const semComentarios = schemaSql
    .split('\n')
    .map(linha => {
      const idx = linha.indexOf('--');
      return idx === -1 ? linha : linha.slice(0, idx);
    })
    .join('\n');

  const statements = semComentarios
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  for (const stmt of statements) {
    await pool.query(stmt);
  }
}

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

  // Promise de "schema pronto" — toda chamada real de query/queryOne/run
  // espera essa promise antes de executar, garantindo que as tabelas já
  // existem mesmo que a primeira requisição chegue antes do schema
  // terminar de rodar. Módulo carrega de forma síncrona (CommonJS não
  // tem top-level await), então essa é a forma correta de sequenciar
  // um passo assíncrono obrigatório antes do primeiro uso real.
  const schemaPronto = executarSchemaPostgres(pool)
    .then(() => console.log('[db] Schema PostgreSQL (schema-postgres.sql) executado com sucesso.'))
    .catch(err => {
      console.error('[db] ERRO FATAL ao executar schema-postgres.sql:', err.message);
      throw err;
    });

  console.log('[db] PostgreSQL conectado via pool — aguardando schema...');

  return {
    async query(sql, params = []) {
      await schemaPronto;
      const res = await pool.query(traduzirPlaceholders(sql), params);
      return res.rows;
    },

    async queryOne(sql, params = []) {
      await schemaPronto;
      const res = await pool.query(traduzirPlaceholders(sql), params);
      return res.rows[0] || undefined;
    },

    async run(sql, params = []) {
      await schemaPronto;
      const res = await pool.query(traduzirPlaceholders(sql), params);
      // rows[0]?.id só existe se a query tiver RETURNING id — presente
      // em todo INSERT cujo id gerado é usado depois pelo chamador.
      return { changes: res.rowCount, lastInsertRowid: res.rows[0]?.id };
    },

    async transaction(fn) {
      await schemaPronto;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({
          query:    async (sql, p) => (await client.query(traduzirPlaceholders(sql), p)).rows,
          queryOne: async (sql, p) => (await client.query(traduzirPlaceholders(sql), p)).rows[0],
          run:      async (sql, p) => {
            const r = await client.query(traduzirPlaceholders(sql), p);
            return { changes: r.rowCount, lastInsertRowid: r.rows[0]?.id };
          },
          agora:        () => 'NOW()',
          condicaoHoje: (coluna) => `${coluna}::date = CURRENT_DATE`,
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

    // ── Helpers de dialeto SQL — Postgres ────────────────────────
    agora:        () => 'NOW()',
    condicaoHoje: (coluna) => `${coluna}::date = CURRENT_DATE`,

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
  async buscarPorIdent(ident) {
    return db.queryOne(
      'SELECT * FROM produtores WHERE identificador = ? AND ativo = 1',
      [ident.toLowerCase().trim()]
    );
  },

  async criar({ nome, identificador, tipoIdent, senhaHash, aceitouNovidades }) {
    return db.run(
      `INSERT INTO produtores (nome, identificador, tipo_ident, senha_hash, aceita_novidades)
       VALUES (?, ?, ?, ?, ?) RETURNING id`,
      [nome, identificador.toLowerCase().trim(), tipoIdent, senhaHash, aceitouNovidades ? 1 : 0]
    );
  },

  async contarFavoritos(produtorId) {
    const r = await db.queryOne('SELECT COUNT(*) as n FROM produtor_favoritos WHERE produtor_id = ?', [produtorId]);
    return Number(r?.n || 0);
  },

  async toggleFavorito(produtorId, tecnicoId) {
    const existe = await db.queryOne(
      'SELECT 1 FROM produtor_favoritos WHERE produtor_id = ? AND tecnico_id = ?',
      [produtorId, tecnicoId]
    );
    if (existe) {
      await db.run('DELETE FROM produtor_favoritos WHERE produtor_id = ? AND tecnico_id = ?', [produtorId, tecnicoId]);
      return false;
    }
    await db.run('INSERT INTO produtor_favoritos (produtor_id, tecnico_id) VALUES (?, ?)', [produtorId, tecnicoId]);
    return true;
  },
};

// ── REPOSITÓRIO: Técnicos ─────────────────────────────────────────
const Tecnicos = {
  async listar({ uf, status = 'ativo', premium } = {}) {
    let sql    = 'SELECT * FROM tecnicos WHERE status = ? AND ativo = 1';
    const params = [status];
    if (uf)      { sql += ' AND uf = ?';      params.push(uf.toUpperCase()); }
    if (premium !== undefined) { sql += ' AND premium = ?'; params.push(premium ? 1 : 0); }
    sql += ' ORDER BY premium DESC, media_avaliacoes DESC';
    return db.query(sql, params);
  },

  async buscarPorId(id) {
    return db.queryOne('SELECT * FROM tecnicos WHERE id = ?', [id]);
  },

  async buscarPorPublicId(publicId) {
    return db.queryOne('SELECT * FROM tecnicos WHERE public_id = ?', [publicId]);
  },

  /**
   * Busca por e-mail OU whatsapp — usada no login do técnico, onde o
   * identificador pode ser digitado em qualquer um dos dois formatos.
   */
  async buscarPorIdentificador(identificador) {
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
  async gerarPublicIdUnico(nome) {
    const base = `tc-${slugNome(nome) || 'tecnico'}`;
    if (!(await db.queryOne('SELECT 1 FROM tecnicos WHERE public_id = ?', [base]))) return base;
    let n = 2;
    let candidato = `${base}-${n}`;
    while (await db.queryOne('SELECT 1 FROM tecnicos WHERE public_id = ?', [candidato])) {
      n++;
      candidato = `${base}-${n}`;
    }
    return candidato;
  },

  async criar(dados) {
    const cpfHash      = hashSensivel(dados.cpf);
    const publicId     = await this.gerarPublicIdUnico(dados.nome);
    const uploadToken  = crypto.randomUUID();
    const registroCompleto = `${dados.conselho}-${dados.ufConselho} ${dados.numConselho}`;

    const info = await db.run(
      `INSERT INTO tecnicos
         (public_id, nome, whatsapp, email, cpf_hash, upload_token,
          cidade, uf, lat, lng, formacao,
          conselho, num_conselho, uf_conselho, registro_completo,
          bio, especialidades, servico, raio_km,
          status, ativo)
       VALUES (?,?,?,?,?,?, ?,?,?,?,?, ?,?,?,?, ?,?,?,?, 'pendente', 0)
       RETURNING id`,
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
  async verificarUploadToken(id, tokenRecebido) {
    const tec = await db.queryOne('SELECT upload_token FROM tecnicos WHERE id = ?', [id]);
    return !!(tec && tec.upload_token && tec.upload_token === tokenRecebido);
  },

  async salvarDocumento(id, { docPath, docOriginalName, docMime }) {
    return db.run(
      `UPDATE tecnicos SET doc_path = ?, doc_original_name = ?, doc_mime = ?,
       doc_enviado_em = ${db.agora()}, atualizado_em = ${db.agora()}
       WHERE id = ?`,
      [docPath, docOriginalName, docMime, id]
    );
  },

  async listarPendentes() {
    return db.query("SELECT * FROM tecnicos WHERE status = 'pendente' ORDER BY criado_em DESC");
  },

  async atualizarStatus(id, status, adminNome = 'sistema') {
    return db.run(
      `UPDATE tecnicos SET status = ?, ativo = ?, validado_em = ${db.agora()}, validado_por = ?,
       atualizado_em = ${db.agora()} WHERE id = ?`,
      [status, status === 'ativo' ? 1 : 0, adminNome, id]
    );
  },

  async suspenderAutomaticamente(id) {
    return db.run(
      `UPDATE tecnicos SET status = 'suspenso', ativo = 0, suspensao_auto = 1,
       suspensao_data = ${db.agora()}, atualizado_em = ${db.agora()} WHERE id = ?`,
      [id]
    );
  },

  /**
   * Define a senha no primeiro acesso (prova de posse via upload_token).
   * Recusa se já existir senha — alterações posteriores exigem sessão
   * autenticada, não o upload_token do cadastro.
   */
  async definirSenhaPrimeiroAcesso(id, senhaHash) {
    const tec = await db.queryOne('SELECT senha_hash FROM tecnicos WHERE id = ?', [id]);
    if (!tec) return { ok: false, motivo: 'nao_encontrado' };
    if (tec.senha_hash) return { ok: false, motivo: 'ja_definida' };
    await db.run('UPDATE tecnicos SET senha_hash = ? WHERE id = ?', [senhaHash, id]);
    return { ok: true };
  },

  async ativarPremium(identificador, pagamentoId) {
    return db.run(
      `UPDATE tecnicos SET premium = 1, premium_desde = ${db.agora()},
       premium_pagamento_id = ?, atualizado_em = ${db.agora()}
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
  async ativarPremiumPorId(tecnicoId, pagamentoId) {
    return db.run(
      `UPDATE tecnicos SET premium = 1, premium_desde = ${db.agora()},
       premium_pagamento_id = ?, atualizado_em = ${db.agora()}
       WHERE id = ?`,
      [pagamentoId, tecnicoId]
    );
  },

  async atualizarMediaAvaliacoes(tecnicoId) {
    const r = await db.queryOne(
      'SELECT AVG(nota) as media, COUNT(*) as total FROM avaliacoes WHERE tecnico_id = ?',
      [tecnicoId]
    );
    await db.run(
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
  async incrementarContador(id, campo) {
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
  async atualizarPerfil(id, { bio, formacao, experiencia } = {}) {
    const campos = [];
    const valores = [];
    if (bio         !== undefined) { campos.push('bio = ?');         valores.push(bio); }
    if (formacao    !== undefined) { campos.push('formacao = ?');    valores.push(formacao); }
    if (experiencia !== undefined) { campos.push('experiencia = ?'); valores.push(experiencia); }
    if (!campos.length) return null;
    campos.push(`atualizado_em = ${db.agora()}`);
    valores.push(id);
    return db.run(`UPDATE tecnicos SET ${campos.join(', ')} WHERE id = ?`, valores);
  },

  async atualizarEspecialidades(id, lista) {
    return db.run(
      `UPDATE tecnicos SET especialidades = ?, atualizado_em = ${db.agora()} WHERE id = ?`,
      [JSON.stringify(lista), id]
    );
  },

  async atualizarServicos(id, lista) {
    return db.run(
      `UPDATE tecnicos SET servicos = ?, atualizado_em = ${db.agora()} WHERE id = ?`,
      [JSON.stringify(lista), id]
    );
  },

  async atualizarContato(id, { whatsapp, email } = {}) {
    const campos = [];
    const valores = [];
    if (whatsapp !== undefined) { campos.push('whatsapp = ?'); valores.push(whatsapp); }
    if (email    !== undefined) { campos.push('email = ?');    valores.push(email); }
    if (!campos.length) return null;
    campos.push(`atualizado_em = ${db.agora()}`);
    valores.push(id);
    return db.run(`UPDATE tecnicos SET ${campos.join(', ')} WHERE id = ?`, valores);
  },
};

// ── REPOSITÓRIO: Sessões de Técnico ───────────────────────────────
const TecnicoSessoes = {
  async criar(tecnicoId, ip) {
    const token    = crypto.randomUUID();
    const ipHash   = hashSensivel(ip);
    const expiraEm = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(); // 8 horas
    await db.run(
      'INSERT INTO tecnico_sessoes (token, tecnico_id, ip_hash, expira_em) VALUES (?,?,?,?)',
      [token, tecnicoId, ipHash, expiraEm]
    );
    return { token, expiraEm };
  },

  async validar(token) {
    const r = await db.queryOne(
      `SELECT tecnico_id, expira_em FROM tecnico_sessoes WHERE token = ? AND expira_em > ${db.agora()}`,
      [token]
    );
    return r ? { tecnicoId: r.tecnico_id } : null;
  },

  async revogar(token) {
    return db.run('DELETE FROM tecnico_sessoes WHERE token = ?', [token]);
  },

  async revogarTodasDoTecnico(tecnicoId) {
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
   *
   * INSERT OR IGNORE é sintaxe SQLite — o equivalente Postgres é
   * ON CONFLICT (...) DO NOTHING, com o alvo do conflito explícito
   * (a coluna UNIQUE pagamento_id_mp). Os dois caminhos convivem aqui
   * porque a sintaxe difere estruturalmente, não é só um placeholder.
   */
  async criarPendente({ pagamentoIdMp, identificador, tecnicoId, plano, valor, metodo = 'pix' }) {
    const sql = USE_POSTGRES
      ? `INSERT INTO pagamentos
           (pagamento_id_mp, identificador, tecnico_id, plano, valor, metodo, status)
         VALUES (?, ?, ?, ?, ?, ?, 'pending')
         ON CONFLICT (pagamento_id_mp) DO NOTHING`
      : `INSERT OR IGNORE INTO pagamentos
           (pagamento_id_mp, identificador, tecnico_id, plano, valor, metodo, status)
         VALUES (?, ?, ?, ?, ?, ?, 'pending')`;
    return db.run(sql, [pagamentoIdMp, identificador, tecnicoId || null, plano, valor, metodo]);
  },

  // Mantido para compatibilidade — equivalente a criarPendente, nome antigo.
  async registrar({ pagamentoIdMp, identificador, plano, valor, metodo = 'pix' }) {
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
  async aprovar(pagamentoIdMp, { tecnicoId } = {}) {
    let desbloqueioToken = null;

    if (tecnicoId) {
      const anterior = await db.queryOne(
        `SELECT desbloqueio_token FROM pagamentos
         WHERE tecnico_id = ? AND status = 'approved' AND desbloqueio_token IS NOT NULL
         ORDER BY aprovado_em DESC LIMIT 1`,
        [tecnicoId]
      );
      desbloqueioToken = anterior?.desbloqueio_token || crypto.randomUUID();
    } else {
      desbloqueioToken = crypto.randomUUID();
    }

    await db.run(
      `UPDATE pagamentos SET status = 'approved', aprovado_em = ${db.agora()},
       webhook_recebido_em = ${db.agora()}, idempotencia_ok = 1, desbloqueio_token = ?
       WHERE pagamento_id_mp = ?`,
      [desbloqueioToken, pagamentoIdMp]
    );

    return { desbloqueioToken };
  },

  async jaAtivado(pagamentoIdMp) {
    const r = await db.queryOne(
      'SELECT idempotencia_ok FROM pagamentos WHERE pagamento_id_mp = ?',
      [pagamentoIdMp]
    );
    // Postgres devolve boolean nativo (true/false); SQLite devolve 0/1.
    return r?.idempotencia_ok === 1 || r?.idempotencia_ok === true;
  },

  async buscarPorIdent(identificador) {
    return db.queryOne(
      `SELECT * FROM pagamentos WHERE identificador = ? AND status = 'approved'
       ORDER BY aprovado_em DESC LIMIT 1`,
      [identificador]
    );
  },

  async buscarPorMpId(pagamentoIdMp) {
    return db.queryOne('SELECT * FROM pagamentos WHERE pagamento_id_mp = ?', [pagamentoIdMp]);
  },

  /** Usado por GET /pagamentos/status/id/:paymentId — polling seguro por ID. */
  async statusPorId(pagamentoIdMp) {
    return db.queryOne(
      'SELECT status, aprovado_em, desbloqueio_token, tecnico_id FROM pagamentos WHERE pagamento_id_mp = ?',
      [pagamentoIdMp]
    );
  },

  /** Usado por GET /pagamentos/status/:identificador — fallback legado. */
  async statusPorIdentificador(identificador) {
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
  async desbloqueioTokenPorTecnico(tecnicoId) {
    const r = await db.queryOne(
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
   *
   * strftime()/datetime('now','-N months') são funções SQLite — o
   * equivalente Postgres é to_char()/NOW() - INTERVAL, com sintaxe
   * estruturalmente diferente o bastante para não caber num helper
   * genérico só de substituição de texto.
   */
  async aprovadosPorMes(qtdMeses = 6) {
    if (USE_POSTGRES) {
      return db.query(
        `SELECT to_char(aprovado_em, 'YYYY-MM') as mes, COUNT(*) as total
         FROM pagamentos
         WHERE status = 'approved' AND aprovado_em >= NOW() - (? || ' months')::interval
         GROUP BY mes`,
        [String(qtdMeses)]
      );
    }
    return db.query(
      `SELECT strftime('%Y-%m', aprovado_em) as mes, COUNT(*) as total
       FROM pagamentos
       WHERE status = 'approved' AND aprovado_em >= datetime('now', ?)
       GROUP BY mes`,
      [`-${qtdMeses} months`]
    );
  },

  async totalAprovados() {
    const r = await db.queryOne("SELECT COUNT(*) as n FROM pagamentos WHERE status = 'approved'");
    return Number(r?.n || 0);
  },
};

// ── REPOSITÓRIO: Avaliações ───────────────────────────────────────
const Avaliacoes = {
  async listarPorTecnico(tecnicoId) {
    return db.query(
      'SELECT id, autor_nome, texto, nota, criado_em FROM avaliacoes WHERE tecnico_id = ? ORDER BY criado_em DESC',
      [tecnicoId]
    );
  },

  async criar({ tecnicoId, autorNome, texto, nota, ip }) {
    const ipHash = hashSensivel(ip);
    return db.run(
      `INSERT INTO avaliacoes (tecnico_id, autor_nome, texto, nota, ip_hash)
       VALUES (?, ?, ?, ?, ?) RETURNING id`,
      [tecnicoId, autorNome, texto, nota, ipHash]
    );
  },

  async jaAvaliouHoje(tecnicoId, ip) {
    const ipHash = hashSensivel(ip);
    const r = await db.queryOne(
      `SELECT 1 FROM avaliacoes WHERE tecnico_id = ? AND ip_hash = ?
       AND ${db.condicaoHoje('criado_em')}`,
      [tecnicoId, ipHash]
    );
    return !!r;
  },
};

// ── REPOSITÓRIO: Denúncias ────────────────────────────────────────
const Denuncias = {
  async listar() {
    return db.query('SELECT * FROM denuncias ORDER BY criado_em DESC');
  },

  async criar({ tecnicoId, tecnicoNome, motivo, descricao, ip }) {
    const ipHash = hashSensivel(ip);
    return db.run(
      `INSERT INTO denuncias (tecnico_id, tecnico_nome, motivo, descricao, ip_hash)
       VALUES (?, ?, ?, ?, ?) RETURNING id`,
      [tecnicoId, tecnicoNome, motivo, descricao || null, ipHash]
    );
  },

  async jaDenounciouHoje(tecnicoId, motivo, ip) {
    const ipHash = hashSensivel(ip);
    const r = await db.queryOne(
      `SELECT 1 FROM denuncias WHERE tecnico_id = ? AND motivo = ? AND ip_hash = ?
       AND ${db.condicaoHoje('criado_em')}`,
      [tecnicoId, motivo, ipHash]
    );
    return !!r;
  },

  async contarFalsosProfissionais(tecnicoId) {
    const r = await db.queryOne(
      `SELECT COUNT(*) as n FROM denuncias
       WHERE tecnico_id = ? AND motivo = 'falso_profissional' AND status = 'pendente'`,
      [tecnicoId]
    );
    return Number(r?.n || 0);
  },

  async arquivar(id, resolucao, resolvidoPor = 'admin') {
    return db.run(
      `UPDATE denuncias SET status = 'arquivada', resolucao = ?,
       resolvido_em = ${db.agora()}, resolvido_por = ? WHERE id = ?`,
      [resolucao, resolvidoPor, id]
    );
  },
};

// ── REPOSITÓRIO: Demandas ─────────────────────────────────────────
const Demandas = {
  async listarAtivas() {
    return db.query(
      `SELECT id, produtor_nome, cultura, descricao, cidade, uf, canal, status, criado_em
       FROM demandas WHERE status = 'ativa' AND expira_em > ${db.agora()}
       ORDER BY criado_em DESC`
      // contato_enc e contato_iv NUNCA retornados na listagem pública
    );
  },

  async criar({ produtorNome, cultura, descricao, cidade, uf, canal, contatoEnc, contatoIv, optin, ip }) {
    const ipHash   = hashSensivel(ip);
    const expiraEm = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    return db.run(
      `INSERT INTO demandas
         (produtor_nome, cultura, descricao, cidade, uf, canal,
          contato_enc, contato_iv, optin_novidades, expira_em, ip_hash)
       VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
      [produtorNome, cultura, descricao, cidade, uf, canal,
       contatoEnc, contatoIv, optin ? 1 : 0, expiraEm, ipHash]
    );
  },

  async buscarContato(id) {
    // Retorna dados de contato criptografados — desencripta no backend
    return db.queryOne('SELECT contato_enc, contato_iv, canal FROM demandas WHERE id = ?', [id]);
  },

  /**
   * INSERT OR IGNORE é sintaxe SQLite — equivalente Postgres é
   * ON CONFLICT (...) DO NOTHING, alvo do conflito = UNIQUE(demanda_id, tecnico_id).
   */
  async registrarDesbloqueio(demandaId, tecnicoId, ip) {
    const ipHash = hashSensivel(ip);
    const sql = USE_POSTGRES
      ? `INSERT INTO demanda_desbloqueios (demanda_id, tecnico_id, ip_hash) VALUES (?,?,?)
         ON CONFLICT (demanda_id, tecnico_id) DO NOTHING`
      : `INSERT OR IGNORE INTO demanda_desbloqueios (demanda_id, tecnico_id, ip_hash) VALUES (?,?,?)`;
    return db.run(sql, [demandaId, tecnicoId, ipHash]);
  },

  async encerrar(id) {
    return db.run("UPDATE demandas SET status = 'encerrada' WHERE id = ?", [id]);
  },
};

// ── REPOSITÓRIO: Classificados ────────────────────────────────────
const Classificados = {
  async listarAtivos() {
    return db.query(
      `SELECT id, empresa, titulo, descricao, wpp, icone, criado_em
       FROM classificados WHERE status = 'ativo' AND expira_em > ${db.agora()}
       ORDER BY pago DESC, criado_em DESC`
    );
  },

  async contarPorIdent(identificador) {
    const r = await db.queryOne(
      'SELECT COUNT(*) as n FROM classificados WHERE identificador = ?',
      [identificador]
    );
    return Number(r?.n || 0);
  },

  async criar({ identificador, empresa, titulo, descricao, wpp, icone, pago, pagamentoId }) {
    const expiraEm = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    return db.run(
      `INSERT INTO classificados
         (identificador, empresa, titulo, descricao, wpp, icone, pago, pagamento_id, expira_em)
       VALUES (?,?,?,?,?,?,?,?,?) RETURNING id`,
      [identificador, empresa, titulo, descricao, wpp, icone || '🏪', pago ? 1 : 0, pagamentoId || null, expiraEm]
    );
  },

  /**
   * Idempotência da confirmação de pagamento — se este pagamentoId já
   * publicou um anúncio antes, retorna o registro existente em vez de
   * duplicar.
   */
  async buscarPorPagamentoId(pagamentoId) {
    return db.queryOne('SELECT * FROM classificados WHERE pagamento_id = ?', [pagamentoId]);
  },
};

// ── REPOSITÓRIO: Configurações ────────────────────────────────────
const Configuracoes = {
  async get(chave) {
    const r = await db.queryOne('SELECT valor FROM configuracoes WHERE chave = ?', [chave]);
    return r?.valor;
  },

  async set(chave, valor) {
    return db.run(
      `INSERT INTO configuracoes (chave, valor, atualizado_em)
       VALUES (?, ?, ${db.agora()})
       ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, atualizado_em = excluded.atualizado_em`,
      [chave, String(valor)]
    );
  },

  async precos() {
    const premiumRaw      = await this.get('preco_premium');
    const classificadoRaw = await this.get('preco_classificado');
    return {
      premium:      parseFloat(premiumRaw      || '49.90'),
      classificado: parseFloat(classificadoRaw || '29.90'),
    };
  },

  /**
   * Substitui precosCfgSalvar() (arquivo precos.json) — grava os dois
   * preços na tabela `configuracoes`. Validação de faixa (R$1–999) fica
   * a cargo de quem chama (a rota), igual ao comportamento anterior.
   */
  async definirPrecos(premium, classificado) {
    await this.set('preco_premium', premium);
    await this.set('preco_classificado', classificado);
    return this.precos();
  },
};

// ── REPOSITÓRIO: Avisos ───────────────────────────────────────────
const Avisos = {
  async ativo() {
    return db.queryOne('SELECT texto FROM avisos WHERE ativo = 1 ORDER BY criado_em DESC LIMIT 1');
  },

  async publicar(texto) {
    await db.run('UPDATE avisos SET ativo = 0 WHERE ativo = 1'); // desativa o anterior
    return db.run('INSERT INTO avisos (texto) VALUES (?) RETURNING id', [texto]);
  },

  async remover() {
    return db.run('UPDATE avisos SET ativo = 0 WHERE ativo = 1');
  },
};

// ── REPOSITÓRIO: Sessões Admin ────────────────────────────────────
const AdminSessoes = {
  async criar(ip, ttlMs = 8 * 60 * 60 * 1000) {
    const token   = crypto.randomUUID();
    const ipHash  = hashSensivel(ip);
    const expiraEm = new Date(Date.now() + ttlMs).toISOString();
    await db.run(
      'INSERT INTO admin_sessoes (token, ip_hash, expira_em) VALUES (?,?,?)',
      [token, ipHash, expiraEm]
    );
    return token;
  },

  async validar(token) {
    const r = await db.queryOne(
      `SELECT 1 FROM admin_sessoes WHERE token = ? AND expira_em > ${db.agora()}`,
      [token]
    );
    return !!r;
  },

  async revogar(token) {
    return db.run('DELETE FROM admin_sessoes WHERE token = ?', [token]);
  },
};

// ── REPOSITÓRIO: Pedidos de Técnico ──────────────────────────────
const PedidosTecnico = {
  async criar({ nome, whatsapp, necessidade, cidade, especialidade }) {
    return db.run(
      `INSERT INTO pedidos_tecnico (nome, whatsapp, necessidade, cidade, especialidade)
       VALUES (?,?,?,?,?) RETURNING id`,
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
  USE_POSTGRES,
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
