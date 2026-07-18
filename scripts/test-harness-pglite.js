'use strict';
/**
 * Arnês de teste — NÃO faz parte da aplicação, existe só para validar
 * db.js contra um Postgres de verdade (PGlite, via WASM) sem precisar
 * de rede ou de uma instância Postgres real disponível.
 *
 * Funciona substituindo o que `require('pg')` devolve por uma classe
 * Pool falsa que por baixo dos panos fala com o PGlite — o código de
 * db.js roda 100% inalterado, sem saber que não é um Postgres de rede.
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

module.exports = require('../db.js');
