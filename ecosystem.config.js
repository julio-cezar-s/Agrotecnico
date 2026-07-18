/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  AgroTécnico — Configuração do PM2                               ║
 * ║                                                                    ║
 * ║  PM2 mantém o server.js rodando como processo persistente:       ║
 * ║  reinicia sozinho se cair, sobrevive a reboot do servidor (com    ║
 * ║  pm2 startup) e centraliza os logs.                               ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * INSTALAÇÃO (uma vez, no servidor):
 *   npm install -g pm2
 *
 * USO:
 *   pm2 start ecosystem.config.js --env production
 *   pm2 logs agrotecnico              # acompanhar logs em tempo real
 *   pm2 status                        # ver se está rodando
 *   pm2 restart agrotecnico           # reiniciar após deploy de código novo
 *   pm2 save && pm2 startup           # sobreviver a reboot do servidor
 */

module.exports = {
  apps: [
    {
      name:        'agrotecnico',
      script:      './server.js',
      cwd:         __dirname,

      // Processo único — o server.js usa SQLite (better-sqlite3) por
      // padrão, que não suporta múltiplos processos escrevendo ao
      // mesmo tempo no mesmo arquivo. Só aumente 'instances' se
      // DATABASE_URL estiver configurada (Postgres suporta concorrência).
      instances:   1,
      exec_mode:   'fork',

      // Reinício automático em caso de crash, com limite para não
      // entrar em loop de restart se o processo estiver quebrado de
      // verdade (ex.: erro de configuração que impede o boot).
      autorestart: true,
      max_restarts: 10,
      min_uptime:  '30s',
      restart_delay: 3000,

      // Reinicia se o processo passar de 500MB — rede de segurança
      // contra memory leak, não deveria disparar em uso normal.
      max_memory_restart: '500M',

      // Logs — caminhos explícitos para facilitar rotação/monitoramento
      error_file:  './logs/error.log',
      out_file:    './logs/output.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs:  true,

      env_production: {
        NODE_ENV: 'production',
      },
    },
  ],
};
