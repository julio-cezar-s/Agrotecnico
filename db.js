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
// MIGRAÇÃO — colunas novas da Área do Técnico
// ─────────────────────────────────────────────────────────────────
// CREATE TABLE IF NOT EXISTS (em schema.sql/schema-postgres.sql) só
// cria a tabela do zero — não adiciona colunas a uma tabela `tecnicos`
// que já existia de um deploy anterior. Estas listas rodam depois do
// schema principal, uma vez no boot, e são seguras de reexecutar.
// ══════════════════════════════════════════════════════════════════
const MIGRACOES_COLUNAS_TECNICOS_SQLITE = [
  `ALTER TABLE tecnicos ADD COLUMN foto_path TEXT`,
  `ALTER TABLE tecnicos ADD COLUMN telefone TEXT`,
  `ALTER TABLE tecnicos ADD COLUMN endereco TEXT`,
  `ALTER TABLE tecnicos ADD COLUMN cep TEXT`,
  `ALTER TABLE tecnicos ADD COLUMN instagram TEXT`,
  `ALTER TABLE tecnicos ADD COLUMN facebook TEXT`,
  `ALTER TABLE tecnicos ADD COLUMN linkedin TEXT`,
  `ALTER TABLE tecnicos ADD COLUMN site_pessoal TEXT`,
  `ALTER TABLE tecnicos ADD COLUMN visivel INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE tecnicos ADD COLUMN notif_email INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE tecnicos ADD COLUMN notif_whatsapp INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE tecnicos ADD COLUMN excluido INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE tecnicos ADD COLUMN excluido_em TEXT`,
  `ALTER TABLE tecnicos ADD COLUMN impressoes_busca INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE tecnicos ADD COLUMN ultimo_acesso TEXT`,
  `ALTER TABLE tecnicos ADD COLUMN premium_expira_em TEXT`,
];

const MIGRACOES_COLUNAS_CLASSIFICADOS_SQLITE = [
  `ALTER TABLE classificados ADD COLUMN edit_token TEXT`,
];

const MIGRACOES_COLUNAS_TECNICOS_POSTGRES = [
  `ALTER TABLE tecnicos ADD COLUMN IF NOT EXISTS foto_path TEXT`,
  `ALTER TABLE tecnicos ADD COLUMN IF NOT EXISTS telefone TEXT`,
  `ALTER TABLE tecnicos ADD COLUMN IF NOT EXISTS endereco TEXT`,
  `ALTER TABLE tecnicos ADD COLUMN IF NOT EXISTS cep TEXT`,
  `ALTER TABLE tecnicos ADD COLUMN IF NOT EXISTS instagram TEXT`,
  `ALTER TABLE tecnicos ADD COLUMN IF NOT EXISTS facebook TEXT`,
  `ALTER TABLE tecnicos ADD COLUMN IF NOT EXISTS linkedin TEXT`,
  `ALTER TABLE tecnicos ADD COLUMN IF NOT EXISTS site_pessoal TEXT`,
  `ALTER TABLE tecnicos ADD COLUMN IF NOT EXISTS visivel INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE tecnicos ADD COLUMN IF NOT EXISTS notif_email INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE tecnicos ADD COLUMN IF NOT EXISTS notif_whatsapp INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE tecnicos ADD COLUMN IF NOT EXISTS excluido INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE tecnicos ADD COLUMN IF NOT EXISTS excluido_em TIMESTAMPTZ`,
  `ALTER TABLE tecnicos ADD COLUMN IF NOT EXISTS impressoes_busca INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE tecnicos ADD COLUMN IF NOT EXISTS ultimo_acesso TIMESTAMPTZ`,
  `ALTER TABLE tecnicos ADD COLUMN IF NOT EXISTS premium_expira_em TIMESTAMPTZ`,
];

const MIGRACOES_COLUNAS_CLASSIFICADOS_POSTGRES = [
  `ALTER TABLE classificados ADD COLUMN IF NOT EXISTS edit_token TEXT`,
];

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

  // ── Migração idempotente de colunas novas ──────────────────────
  // CREATE TABLE IF NOT EXISTS (acima) não adiciona colunas a uma
  // tabela `tecnicos` que já existia de um deploy anterior a este —
  // sem isso, todo banco já em produção quebraria com "no such
  // column" assim que qualquer rota da Área do Técnico rodasse.
  // SQLite não suporta "ADD COLUMN IF NOT EXISTS": tenta e ignora o
  // erro de "duplicate column name" quando a coluna já existe.
  for (const alter of MIGRACOES_COLUNAS_TECNICOS_SQLITE) {
    try { db.exec(alter); } catch (err) {
      if (!/duplicate column name/i.test(err.message)) throw err;
    }
  }
  for (const alter of MIGRACOES_COLUNAS_CLASSIFICADOS_SQLITE) {
    try { db.exec(alter); } catch (err) {
      if (!/duplicate column name/i.test(err.message)) throw err;
    }
  }

  // ── Migração de dados de compatibilidade retroativa ─────────────
  // Sem isso, qualquer técnico que já tinha premium=1 gravado ANTES
  // desta feature de expiração existir (ex.: concedido manualmente
  // pelo admin num deploy anterior) perderia o Premium silenciosamente
  // assim que este deploy subisse — a coluna nova nasce NULL, e
  // premiumEfetivo() exige premium_expira_em preenchido. Dá 30 dias de
  // transição em vez de cortar na hora. Roda sempre no boot, mas é
  // segura de reexecutar: depois da primeira vez, não sobra nenhuma
  // linha com premium=1 e premium_expira_em NULL pra este UPDATE afetar.
  db.exec(`UPDATE tecnicos SET premium_expira_em = datetime('now', '+30 days')
           WHERE premium = 1 AND premium_expira_em IS NULL`);

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

  // Migração idempotente de colunas novas — necessária para bancos
  // que já existiam de um deploy anterior a este. IF NOT EXISTS torna
  // cada ALTER seguro de reexecutar em todo boot.
  for (const alter of MIGRACOES_COLUNAS_TECNICOS_POSTGRES) {
    await pool.query(alter);
  }
  for (const alter of MIGRACOES_COLUNAS_CLASSIFICADOS_POSTGRES) {
    await pool.query(alter);
  }

  // Migração de dados de compatibilidade retroativa — mesmo raciocínio
  // do driver SQLite acima: dá 30 dias de transição a quem já era
  // Premium antes desta coluna existir, em vez de cortar o acesso na
  // hora do deploy. Segura de reexecutar todo boot (idempotente na
  // prática: some a condição que o WHERE procura depois da 1ª vez).
  await pool.query(`UPDATE tecnicos SET premium_expira_em = NOW() + INTERVAL '30 days'
                     WHERE premium = 1 AND premium_expira_em IS NULL`);
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

  async buscarPorId(id) {
    return db.queryOne('SELECT * FROM produtores WHERE id = ?', [id]);
  },

  /**
   * Lista todos os produtores com a contagem de favoritos de cada um —
   * usada pelo painel admin (tabela "Produtores Registrados"), que antes
   * só conseguia enxergar o único produtor logado no navegador atual
   * (localStorage), nunca a base real de produtores cadastrados.
   */
  async listarComFavoritos() {
    return db.query(
      `SELECT p.*, COUNT(f.id) as total_favoritos
       FROM produtores p
       LEFT JOIN produtor_favoritos f ON f.produtor_id = p.id
       GROUP BY p.id
       ORDER BY p.criado_em DESC`
    );
  },

  /** Suspende ou reativa uma conta de produtor — ação do admin. */
  async atualizarStatus(id, ativoBool) {
    return db.run(
      `UPDATE produtores SET ativo = ?, atualizado_em = ${db.agora()} WHERE id = ?`,
      [ativoBool ? 1 : 0, id]
    );
  },

  async criar({ nome, identificador, tipoIdent, senhaHash, aceitouNovidades }) {
    return db.run(
      `INSERT INTO produtores (nome, identificador, tipo_ident, senha_hash, aceita_novidades)
       VALUES (?, ?, ?, ?, ?) RETURNING id`,
      [nome, identificador.toLowerCase().trim(), tipoIdent, senhaHash, aceitouNovidades ? 1 : 0]
    );
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
    // excluido/visivel: contas com soft-delete (Área do Técnico → excluir
    // conta) ou com a exibição pública desativada (Configurações →
    // "ativar/desativar exibição pública") nunca aparecem na busca,
    // mesmo que o cadastro em si continue existindo no banco.
    let sql    = `SELECT * FROM tecnicos
                  WHERE status = ? AND ativo = 1
                    AND (excluido IS NULL OR excluido = 0)
                    AND (visivel IS NULL OR visivel = 1)`;
    const params = [status];
    if (uf)      { sql += ' AND uf = ?';      params.push(uf.toUpperCase()); }
    if (premium !== undefined) { sql += ' AND premium = ?'; params.push(premium ? 1 : 0); }
    sql += ` ORDER BY (CASE WHEN premium = 1 AND premium_expira_em > ${db.agora()} THEN 1 ELSE 0 END) DESC, media_avaliacoes DESC`;
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
    const registroCompleto = dados.conselho ? `${dados.conselho}-${dados.ufConselho} ${dados.numConselho}` : null;

    let info;
    try {
      info = await db.run(
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
    } catch (err) {
      // Violação de idx_tecnicos_email_unico ou idx_tecnicos_cpf_hash_unico
      // — já existe um técnico com esse e-mail ou CPF. Sinaliza pro
      // chamador tratar como cadastro duplicado, não como erro genérico.
      const msg = String(err?.message || '');
      if (err?.code === '23505' || /unique|UNIQUE constraint/i.test(msg)) {
        const duplicado = new Error('TECNICO_JA_CADASTRADO');
        duplicado.cadastroDuplicado = true;
        duplicado.campo = /email/i.test(msg) ? 'email' : 'cpf';
        throw duplicado;
      }
      throw err;
    }

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

  /**
   * Lista TODOS os técnicos, qualquer status (ativo/pendente/suspenso/
   * recusado) — usada exclusivamente pelo painel admin. Diferente de
   * listar(), que por padrão só retorna status='ativo' para a busca
   * pública. Sem este método o admin não tinha como enxergar a base
   * real de técnicos (usava dados de demonstração no frontend).
   */
  async listarTodosAdmin() {
    return db.query('SELECT * FROM tecnicos ORDER BY criado_em DESC');
  },

  /**
   * Contagem de técnicos cadastrados por mês (últimos qtdMeses) — usada
   * no gráfico de crescimento do painel admin. Espelha
   * Pagamentos.aprovadosPorMes(), mesma lógica de dialeto SQLite/Postgres.
   */
  async contarPorMes(qtdMeses = 6) {
    if (USE_POSTGRES) {
      return db.query(
        `SELECT to_char(criado_em, 'YYYY-MM') as mes, COUNT(*) as total
         FROM tecnicos
         WHERE criado_em >= NOW() - (? || ' months')::interval
         GROUP BY mes`,
        [String(qtdMeses)]
      );
    }
    return db.query(
      `SELECT strftime('%Y-%m', criado_em) as mes, COUNT(*) as total
       FROM tecnicos
       WHERE criado_em >= datetime('now', ?)
       GROUP BY mes`,
      [`-${qtdMeses} months`]
    );
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
    const DURACAO_MS = 30 * 24 * 60 * 60 * 1000;
    const atual = await db.queryOne(
      'SELECT premium_expira_em FROM tecnicos WHERE whatsapp = ? OR email = ?',
      [identificador, identificador]
    );
    const expiraAtual = atual?.premium_expira_em ? new Date(atual.premium_expira_em).getTime() : 0;
    const novaExpiracao = new Date(Math.max(Date.now(), expiraAtual) + DURACAO_MS).toISOString();

    return db.run(
      `UPDATE tecnicos SET premium = 1, premium_desde = ${db.agora()},
       premium_expira_em = ?, premium_pagamento_id = ?, atualizado_em = ${db.agora()}
       WHERE whatsapp = ? OR email = ?`,
      [novaExpiracao, pagamentoId, identificador, identificador]
    );
  },

  /**
   * Ativa o Premium vinculando pelo tecnico_id (FK) em vez de casar por
   * e-mail/whatsapp — elimina a ambiguidade do método legado acima
   * (ex.: dois técnicos com o mesmo e-mail cadastrado por engano).
   * Preferir sempre este método quando o tecnicoId estiver disponível.
   */
  async ativarPremiumPorId(tecnicoId, pagamentoId) {
    const DURACAO_MS = 30 * 24 * 60 * 60 * 1000;
    const atual = await db.queryOne('SELECT premium_expira_em FROM tecnicos WHERE id = ?', [tecnicoId]);
    const expiraAtual = atual?.premium_expira_em ? new Date(atual.premium_expira_em).getTime() : 0;
    const base = Math.max(Date.now(), expiraAtual); // renovar antes de vencer estende a partir do vencimento atual, não desperdiça dias já pagos
    const novaExpiracao = new Date(base + DURACAO_MS).toISOString();

    return db.run(
      `UPDATE tecnicos SET premium = 1, premium_desde = ${db.agora()},
       premium_expira_em = ?, premium_pagamento_id = ?, atualizado_em = ${db.agora()}
       WHERE id = ?`,
      [novaExpiracao, pagamentoId, tecnicoId]
    );
  },

  /**
   * Concede ou revoga Premium manualmente (ação do admin, sem pagamento
   * associado) — usada pelo botão "Dar/Remover Premium" do painel admin.
   * Diferente de ativarPremiumPorId(), não grava premium_pagamento_id.
   */
  async definirPremium(tecnicoId, premiumBool) {
    if (premiumBool) {
      const novaExpiracao = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      return db.run(
        `UPDATE tecnicos SET premium = 1, premium_desde = ${db.agora()}, premium_expira_em = ?, atualizado_em = ${db.agora()} WHERE id = ?`,
        [novaExpiracao, tecnicoId]
      );
    }
    return db.run(
      `UPDATE tecnicos SET premium = 0, premium_expira_em = NULL, atualizado_em = ${db.agora()} WHERE id = ?`,
      [tecnicoId]
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
    const resultado = await db.run(`UPDATE tecnicos SET ${coluna} = ${coluna} + 1 WHERE id = ?`, [id]);

    // Espelha em tecnico_metricas_diarias (com dimensão de tempo) para
    // permitir "evolução mensal" real no dashboard — cliquesEmail não
    // tem coluna diária equivalente (métrica secundária, sem gráfico).
    const camposDiarios = {
      visualizacoes:   'visualizacoes',
      cliquesWhatsapp: 'cliques_whatsapp',
      cliquesTelefone: 'cliques_telefone',
    };
    if (camposDiarios[campo]) await TecnicoMetricas.incrementar(id, camposDiarios[campo]);

    return resultado;
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

  async atualizarContato(id, { whatsapp, email, telefone } = {}) {
    const campos = [];
    const valores = [];
    if (whatsapp !== undefined) { campos.push('whatsapp = ?'); valores.push(whatsapp); }
    if (email    !== undefined) { campos.push('email = ?');    valores.push(email); }
    if (telefone !== undefined) { campos.push('telefone = ?'); valores.push(telefone); }
    if (!campos.length) return null;
    campos.push(`atualizado_em = ${db.agora()}`);
    valores.push(id);
    return db.run(`UPDATE tecnicos SET ${campos.join(', ')} WHERE id = ?`, valores);
  },

  /**
   * Atualiza os campos estendidos de perfil da Área do Técnico (nome,
   * localização, endereço, raio, formação, experiência, bio, redes
   * sociais e site). Só grava os campos efetivamente enviados —
   * mesmo padrão "campos não enviados = mantidos" já usado em
   * atualizarContato().
   */
  async atualizarPerfilEstendido(id, campos_ = {}) {
    const mapa = {
      nome: 'nome', cidade: 'cidade', uf: 'uf', endereco: 'endereco', cep: 'cep',
      raio: 'raio_km', formacao: 'formacao', experiencia: 'experiencia', bio: 'bio',
      instagram: 'instagram', facebook: 'facebook', linkedin: 'linkedin',
      sitePessoal: 'site_pessoal',
    };
    const sets = [];
    const valores = [];
    for (const [chave, coluna] of Object.entries(mapa)) {
      if (campos_[chave] !== undefined) { sets.push(`${coluna} = ?`); valores.push(campos_[chave]); }
    }
    if (!sets.length) return null;
    sets.push(`atualizado_em = ${db.agora()}`);
    valores.push(id);
    return db.run(`UPDATE tecnicos SET ${sets.join(', ')} WHERE id = ?`, valores);
  },

  async atualizarFoto(id, fotoPath) {
    return db.run(
      `UPDATE tecnicos SET foto_path = ?, atualizado_em = ${db.agora()} WHERE id = ?`,
      [fotoPath, id]
    );
  },

  /**
   * Troca de senha autenticada (técnico já logado, confirmando a senha
   * atual na rota) — diferente de definirSenhaPrimeiroAcesso(), que só
   * vale uma vez e via uploadToken, sem sessão.
   */
  async atualizarSenha(id, senhaHash) {
    return db.run(
      `UPDATE tecnicos SET senha_hash = ?, atualizado_em = ${db.agora()} WHERE id = ?`,
      [senhaHash, id]
    );
  },

  async atualizarConfiguracoes(id, { visivel, notifEmail, notifWhatsapp } = {}) {
    const campos = [];
    const valores = [];
    if (visivel        !== undefined) { campos.push('visivel = ?');        valores.push(visivel ? 1 : 0); }
    if (notifEmail     !== undefined) { campos.push('notif_email = ?');    valores.push(notifEmail ? 1 : 0); }
    if (notifWhatsapp  !== undefined) { campos.push('notif_whatsapp = ?'); valores.push(notifWhatsapp ? 1 : 0); }
    if (!campos.length) return null;
    campos.push(`atualizado_em = ${db.agora()}`);
    valores.push(id);
    return db.run(`UPDATE tecnicos SET ${campos.join(', ')} WHERE id = ?`, valores);
  },

  /**
   * Soft-delete — remove o perfil do ar imediatamente (excluido=1 já
   * é filtrado em listar()/buscarPorPublicId ativo), mas preserva a
   * linha no banco. Mesma política já descrita na Política de
   * Privacidade do site ("soft-delete imediato + exclusão definitiva
   * em 30 dias"); a exclusão definitiva depende de um job periódico
   * fora do escopo desta rota (ver observação na entrega).
   */
  async marcarExcluido(id) {
    await TecnicoSessoes.revogarTodasDoTecnico(id);
    return db.run(
      `UPDATE tecnicos SET excluido = 1, excluido_em = ${db.agora()}, ativo = 0,
       atualizado_em = ${db.agora()} WHERE id = ?`,
      [id]
    );
  },

  async atualizarUltimoAcesso(id) {
    return db.run(`UPDATE tecnicos SET ultimo_acesso = ${db.agora()} WHERE id = ?`, [id]);
  },

  /**
   * Incrementa impressoes_busca para cada técnico retornado em uma
   * busca pública — usado para a métrica "quantidade de buscas em que
   * apareceu" no dashboard. Recebe uma lista de ids e incrementa todos
   * em uma única query (evita N updates por busca).
   */
  async incrementarImpressoesBusca(ids) {
    if (!ids || !ids.length) return;
    const placeholders = ids.map(() => '?').join(',');
    await db.run(
      `UPDATE tecnicos SET impressoes_busca = impressoes_busca + 1 WHERE id IN (${placeholders})`,
      ids
    );
    await TecnicoMetricas.incrementarLote(ids, 'impressoes_busca');
  },

  /** Quantos produtores favoritaram este técnico. */
  async contarFavoritadoPor(tecnicoId) {
    const r = await db.queryOne(
      'SELECT COUNT(*) as n FROM produtor_favoritos WHERE tecnico_id = ?',
      [tecnicoId]
    );
    return Number(r?.n || 0);
  },
};

// ── REPOSITÓRIO: Sessões de Técnico ───────────────────────────────
const TecnicoSessoes = {
  async criar(tecnicoId, ip, ttlMs = 8 * 60 * 60 * 1000) {
    const token    = crypto.randomUUID();
    const ipHash   = hashSensivel(ip);
    const expiraEm = new Date(Date.now() + ttlMs).toISOString();
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

  /**
   * Lista as sessões ativas de um técnico — usada na aba Segurança
   * ("encerrar sessões abertas"). Nunca retorna o token em texto puro
   * para o frontend; a rota expõe só um id derivado e metadados.
   */
  async listarPorTecnico(tecnicoId) {
    return db.query(
      `SELECT token, ip_hash, criado_em, expira_em FROM tecnico_sessoes
       WHERE tecnico_id = ? AND expira_em > ${db.agora()}
       ORDER BY criado_em DESC`,
      [tecnicoId]
    );
  },

  /** Revoga uma sessão específica, só se pertencer ao técnico informado. */
  async revogarSeDoTecnico(token, tecnicoId) {
    return db.run(
      'DELETE FROM tecnico_sessoes WHERE token = ? AND tecnico_id = ?',
      [token, tecnicoId]
    );
  },

  /** Revoga todas as sessões do técnico, exceto a informada (a atual). */
  async revogarTodasExceto(tecnicoId, tokenAtual) {
    return db.run(
      'DELETE FROM tecnico_sessoes WHERE tecnico_id = ? AND token != ?',
      [tecnicoId, tokenAtual]
    );
  },
};

// ── REPOSITÓRIO: Histórico de Login do Técnico ────────────────────
const TecnicoLoginHistorico = {
  async registrar(tecnicoId, ip, sucesso = true) {
    const ipHash = hashSensivel(ip || '');
    return db.run(
      'INSERT INTO tecnico_login_historico (tecnico_id, ip_hash, sucesso) VALUES (?,?,?)',
      [tecnicoId, ipHash, sucesso ? 1 : 0]
    );
  },

  async listarRecentes(tecnicoId, limite = 10) {
    return db.query(
      `SELECT ip_hash, sucesso, criado_em FROM tecnico_login_historico
       WHERE tecnico_id = ? ORDER BY criado_em DESC LIMIT ?`,
      [tecnicoId, limite]
    );
  },
};

// ── REPOSITÓRIO: Métricas Diárias do Técnico ──────────────────────
// Permite "evolução mensal" real (com dimensão de tempo) em vez de só
// contadores cumulativos — as colunas visualizacoes/cliques_* em
// `tecnicos` continuam existindo e sendo incrementadas em paralelo,
// para não quebrar nada que já lia esses totais.
const TecnicoMetricas = {
  /** Incrementa uma métrica do dia de hoje para um único técnico (upsert). */
  async incrementar(tecnicoId, campo) {
    const colunas = ['visualizacoes', 'cliques_whatsapp', 'cliques_telefone', 'impressoes_busca'];
    if (!colunas.includes(campo)) throw new Error(`[TecnicoMetricas.incrementar] campo inválido: ${campo}`);
    const hoje = new Date().toISOString().slice(0, 10);

    const sql = USE_POSTGRES
      ? `INSERT INTO tecnico_metricas_diarias (tecnico_id, data, ${campo})
         VALUES (?, ?, 1)
         ON CONFLICT (tecnico_id, data) DO UPDATE SET ${campo} = tecnico_metricas_diarias.${campo} + 1`
      : `INSERT INTO tecnico_metricas_diarias (tecnico_id, data, ${campo})
         VALUES (?, ?, 1)
         ON CONFLICT (tecnico_id, data) DO UPDATE SET ${campo} = ${campo} + 1`;
    return db.run(sql, [tecnicoId, hoje]);
  },

  /** Mesma coisa, mas para vários técnicos de uma vez (ex: impressões de busca). */
  async incrementarLote(ids, campo) {
    for (const id of ids) {
      await this.incrementar(id, campo);
    }
  },

  /**
   * Evolução mensal — soma cada métrica agrupada por mês, últimos
   * qtdMeses meses. Retorna um array por mês já com os 4 campos
   * zerados quando não há registro, pronto para o gráfico do frontend.
   */
  async evolucaoMensal(tecnicoId, qtdMeses = 6) {
    const linhas = USE_POSTGRES
      ? await db.query(
          `SELECT to_char(data, 'YYYY-MM') as mes,
                  SUM(visualizacoes) as visualizacoes,
                  SUM(cliques_whatsapp) as cliques_whatsapp,
                  SUM(cliques_telefone) as cliques_telefone,
                  SUM(impressoes_busca) as impressoes_busca
           FROM tecnico_metricas_diarias
           WHERE tecnico_id = ? AND data >= (NOW() - (? || ' months')::interval)::date
           GROUP BY mes`,
          [tecnicoId, String(qtdMeses)]
        )
      : await db.query(
          `SELECT strftime('%Y-%m', data) as mes,
                  SUM(visualizacoes) as visualizacoes,
                  SUM(cliques_whatsapp) as cliques_whatsapp,
                  SUM(cliques_telefone) as cliques_telefone,
                  SUM(impressoes_busca) as impressoes_busca
           FROM tecnico_metricas_diarias
           WHERE tecnico_id = ? AND data >= date('now', ?)
           GROUP BY mes`,
          [tecnicoId, `-${qtdMeses} months`]
        );

    const mapa = Object.fromEntries(linhas.map(l => [l.mes, l]));
    const agora = new Date();
    const resultado = [];
    for (let i = qtdMeses - 1; i >= 0; i--) {
      const d      = new Date(agora.getFullYear(), agora.getMonth() - i, 1);
      const mesISO = d.toISOString().slice(0, 7);
      const l      = mapa[mesISO];
      resultado.push({
        mes:             d.toLocaleDateString('pt-BR', { month: 'short' }),
        visualizacoes:   Number(l?.visualizacoes || 0),
        cliquesWhatsapp: Number(l?.cliques_whatsapp || 0),
        cliquesTelefone: Number(l?.cliques_telefone || 0),
        impressoesBusca: Number(l?.impressoes_busca || 0),
      });
    }
    return resultado;
  },
};

// ── REPOSITÓRIO: Sessões de Produtor ──────────────────────────────
// Espelha TecnicoSessoes — cookie HttpOnly agro_prod_sess. Substitui a
// sessão "apenas localStorage" (PROD_KEY no frontend) por autenticação
// real de servidor, a mesma lacuna que já havia sido fechada para
// técnicos mas nunca para produtores.
const ProdutorSessoes = {
  async criar(produtorId, ip) {
    const token    = crypto.randomUUID();
    const ipHash   = hashSensivel(ip);
    const expiraEm = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(); // 8 horas
    await db.run(
      'INSERT INTO produtor_sessoes (token, produtor_id, ip_hash, expira_em) VALUES (?,?,?,?)',
      [token, produtorId, ipHash, expiraEm]
    );
    return { token, expiraEm };
  },

  async validar(token) {
    const r = await db.queryOne(
      `SELECT produtor_id, expira_em FROM produtor_sessoes WHERE token = ? AND expira_em > ${db.agora()}`,
      [token]
    );
    return r ? { produtorId: r.produtor_id } : null;
  },

  async revogar(token) {
    return db.run('DELETE FROM produtor_sessoes WHERE token = ?', [token]);
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

  /**
   * Histórico de pagamentos de um técnico — usado na aba Premium do
   * dashboard ("histórico de pagamentos"). Não expõe nenhum dado do
   * Mercado Pago além do necessário para exibir a linha do tempo.
   */
  async listarPorTecnico(tecnicoId) {
    return db.query(
      `SELECT plano, valor, metodo, status, criado_em, aprovado_em
       FROM pagamentos WHERE tecnico_id = ? ORDER BY criado_em DESC`,
      [tecnicoId]
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
    const editToken = crypto.randomUUID();
    try {
      const info = await db.run(
        `INSERT INTO classificados
           (identificador, empresa, titulo, descricao, wpp, icone, pago, pagamento_id, expira_em, edit_token)
         VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id`,
        [identificador, empresa, titulo, descricao, wpp, icone || '🏪', pago ? 1 : 0, pagamentoId || null, expiraEm, editToken]
      );
      return { ...info, editToken };
    } catch (err) {
      // Violação do índice único parcial (idx_classificados_gratis_unico) —
      // perdeu a corrida pelo classificado grátis contra uma requisição
      // simultânea. Não é um erro de banco genérico, é uma resposta de
      // negócio válida: sinaliza pro chamador tratar como "grátis já usado".
      const msg = String(err?.message || '');
      if (err?.code === '23505' || /unique|UNIQUE constraint/i.test(msg)) {
        const jaExiste = new Error('CLASSIFICADO_GRATIS_JA_USADO');
        jaExiste.corridaPerdida = true;
        throw jaExiste;
      }
      throw err;
    }
  },

  async buscarPorId(id) {
    return db.queryOne('SELECT * FROM classificados WHERE id = ?', [id]);
  },

  /**
   * Atualiza um anúncio, mas só se o edit_token bater — sem exigir
   * login, exatamente o mesmo padrão de "prova de posse" já usado no
   * upload_token do cadastro de técnico. A checagem do token acontece
   * na própria cláusula WHERE, atomicamente: token errado = 0 linhas
   * afetadas, sem precisar de um SELECT separado antes.
   */
  async atualizar(id, editToken, { empresa, titulo, descricao, wpp, icone } = {}) {
    const campos = [];
    const valores = [];
    if (empresa   !== undefined) { campos.push('empresa = ?');   valores.push(empresa); }
    if (titulo    !== undefined) { campos.push('titulo = ?');    valores.push(titulo); }
    if (descricao !== undefined) { campos.push('descricao = ?'); valores.push(descricao); }
    if (wpp       !== undefined) { campos.push('wpp = ?');       valores.push(wpp); }
    if (icone     !== undefined) { campos.push('icone = ?');     valores.push(icone); }
    if (!campos.length) return { ok: false, motivo: 'nada_para_atualizar' };

    valores.push(id, editToken);
    const info = await db.run(
      `UPDATE classificados SET ${campos.join(', ')} WHERE id = ? AND edit_token = ?`,
      valores
    );
    const linhasAfetadas = info?.changes ?? info?.rowCount ?? 0;
    return linhasAfetadas > 0 ? { ok: true } : { ok: false, motivo: 'token_invalido_ou_nao_encontrado' };
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

  async listar() {
    return db.query('SELECT * FROM pedidos_tecnico ORDER BY criado_em DESC');
  },

  async contarTotal() {
    const r = await db.queryOne('SELECT COUNT(*) as n FROM pedidos_tecnico');
    return Number(r?.n || 0);
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
  TecnicoLoginHistorico,
  TecnicoMetricas,
  ProdutorSessoes,
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
