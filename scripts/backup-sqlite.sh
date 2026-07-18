#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════╗
# ║  AgroTécnico — Backup do SQLite (MVP)                            ║
# ║                                                                    ║
# ║  Só relevante enquanto DATABASE_URL estiver vazia (SQLite ativo). ║
# ║  Se migrar para Postgres, use backup-postgres.sh no lugar deste.  ║
# ╚══════════════════════════════════════════════════════════════════╝
#
# O QUE FAZ:
#   1. Força um checkpoint do WAL — garante que tudo que está nos
#      arquivos -wal/-shm seja gravado no arquivo .db principal antes
#      de copiar (copiar só o .db sem isso pode perder transações
#      recentes que ainda estão só no WAL).
#   2. Copia o .db para uma pasta de backups com timestamp no nome.
#   3. Apaga backups com mais de RETENCAO_DIAS dias.
#
# AGENDAMENTO (crontab -e), backup diário às 3h da manhã:
#   0 3 * * * /caminho/completo/para/scripts/backup-sqlite.sh >> /caminho/completo/para/logs/backup.log 2>&1

set -euo pipefail

DB_FILE="${DB_FILE:-agrotecnico.db}"
BACKUP_DIR="${BACKUP_DIR:-backups}"
RETENCAO_DIAS="${RETENCAO_DIAS:-14}"
# Inclui nanossegundos — evita colisão de nome se o script rodar mais
# de uma vez dentro do mesmo segundo (ex.: execução manual logo após
# o cron, ou dois deploys em sequência rápida).
TIMESTAMP=$(date +%Y%m%d-%H%M%S-%N)

if [ ! -f "$DB_FILE" ]; then
  echo "❌ $DB_FILE não encontrado. Rode este script no diretório do projeto (ou defina DB_FILE)."
  exit 1
fi

mkdir -p "$BACKUP_DIR"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Forçando checkpoint do WAL..."
# Usa better-sqlite3 (já é dependência do projeto) em vez do CLI sqlite3,
# que pode não estar instalado no servidor — um binário externo a menos
# para se preocupar em manter presente.
node -e "
const Database = require('better-sqlite3');
const db = new Database('$DB_FILE');
db.pragma('wal_checkpoint(TRUNCATE)');
db.close();
"

DESTINO="$BACKUP_DIR/agrotecnico-${TIMESTAMP}.db"
cp "$DB_FILE" "$DESTINO"
gzip -f "$DESTINO"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Backup salvo em ${DESTINO}.gz"

# Remove backups mais antigos que RETENCAO_DIAS
REMOVIDOS=$(find "$BACKUP_DIR" -name "agrotecnico-*.db.gz" -mtime "+${RETENCAO_DIAS}" -print -delete | wc -l)
if [ "$REMOVIDOS" -gt 0 ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ${REMOVIDOS} backup(s) com mais de ${RETENCAO_DIAS} dias removido(s)."
fi

TOTAL=$(find "$BACKUP_DIR" -name "agrotecnico-*.db.gz" | wc -l)
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Total de backups mantidos: ${TOTAL}"
