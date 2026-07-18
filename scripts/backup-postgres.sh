#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════╗
# ║  AgroTécnico — Backup do Postgres (produção)                     ║
# ║                                                                    ║
# ║  Só relevante quando DATABASE_URL estiver configurada.            ║
# ║                                                                    ║
# ║  ⚠️  IMPORTANTE: a maioria dos provedores gerenciados (Neon,      ║
# ║  Supabase, Railway) já faz backup automático diário nativamente — ║
# ║  confira no painel deles ANTES de montar esta rotina própria.     ║
# ║  Este script é um complemento/fallback, não substitui o backup    ║
# ║  do provedor (ex.: para guardar uma cópia fora da infraestrutura  ║
# ║  deles, ou se o plano gratuito não incluir backup automático).    ║
# ╚══════════════════════════════════════════════════════════════════╝
#
# REQUISITO: cliente `pg_dump` instalado no servidor que roda o script
#   sudo apt install postgresql-client
#
# AGENDAMENTO (crontab -e), backup diário às 3h:
#   0 3 * * * DATABASE_URL="..." /caminho/scripts/backup-postgres.sh >> /caminho/logs/backup.log 2>&1
#
# Por segurança, NÃO deixe a DATABASE_URL fixa dentro deste script —
# passe via variável de ambiente na hora de rodar (ou leia do .env).

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-backups}"
RETENCAO_DIAS="${RETENCAO_DIAS:-14}"
TIMESTAMP=$(date +%Y%m%d-%H%M%S-%N)

if [ -z "${DATABASE_URL:-}" ]; then
  echo "❌ DATABASE_URL não definida. Exporte-a antes de rodar, ou carregue do .env:"
  echo '   export $(grep -v "^#" .env | grep DATABASE_URL | xargs) && ./scripts/backup-postgres.sh'
  exit 1
fi

if ! command -v pg_dump &> /dev/null; then
  echo "❌ pg_dump não encontrado. Instale com: sudo apt install postgresql-client"
  exit 1
fi

mkdir -p "$BACKUP_DIR"

DESTINO="$BACKUP_DIR/agrotecnico-pg-${TIMESTAMP}.sql"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Iniciando pg_dump..."
# --no-owner/--no-privileges: torna o dump restaurável em qualquer
# banco novo sem precisar recriar os mesmos usuários/permissões do
# servidor de origem — mais portável para restaurar em outro provedor
# se um dia for necessário migrar.
pg_dump "$DATABASE_URL" --no-owner --no-privileges --format=plain > "$DESTINO"
gzip -f "$DESTINO"

TAMANHO=$(du -h "${DESTINO}.gz" | cut -f1)
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Backup salvo em ${DESTINO}.gz (${TAMANHO})"

# Remove backups mais antigos que RETENCAO_DIAS
REMOVIDOS=$(find "$BACKUP_DIR" -name "agrotecnico-pg-*.sql.gz" -mtime "+${RETENCAO_DIAS}" -print -delete | wc -l)
if [ "$REMOVIDOS" -gt 0 ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ${REMOVIDOS} backup(s) com mais de ${RETENCAO_DIAS} dias removido(s)."
fi

TOTAL=$(find "$BACKUP_DIR" -name "agrotecnico-pg-*.sql.gz" | wc -l)
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Total de backups mantidos: ${TOTAL}"

echo ""
echo "Para restaurar: gunzip -c ${DESTINO}.gz | psql \$DATABASE_URL"
