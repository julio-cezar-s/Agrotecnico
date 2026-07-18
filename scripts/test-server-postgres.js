'use strict';
/**
 * Entry point SÓ DE TESTE — sobe o server.js real, mas com o driver
 * 'pg' substituído por PGlite (Postgres real via WASM). Usado para
 * validar o servidor HTTP inteiro contra Postgres sem precisar de
 * rede ou de uma instância Postgres externa disponível.
 */
const Module = require('module');
const { PGlite } = require('@electric-sql/pglite');

const pglite = new PGlite();

class FakePool {
  constructor(_config) { this.pg = pglite; }
  async query(sql, params) {
    const res = await this.pg.query(sql, params);
    return { rows: res.rows, rowCount: res.affectedRows ?? res.rows.length };
  }
  async connect() {
    const pg = this.pg;
    return {
      query: async (sql, params) => {
        const res = await pg.query(sql, params);
        return { rows: res.rows, rowCount: res.affectedRows ?? res.rows.length };
      },
      release: () => {},
    };
  }
  on(_event, _cb) {}
  async end() {}
}

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'pg') return { Pool: FakePool };
  return originalLoad.apply(this, arguments);
};

process.env.DATABASE_URL = 'postgresql://fake:fake@localhost:5432/fake';
process.env.DB_SSL = 'false';

require('../server.js');
