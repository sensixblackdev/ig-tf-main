#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/ig-tf-main"
GH_TOKEN="${GH_TOKEN:-}"

if [ -n "$GH_TOKEN" ]; then
    REPO_URL="https://sensixblackdev:${GH_TOKEN}@github.com/sensixblackdev/ig-tf-main.git"
else
    REPO_URL="https://github.com/sensixblackdev/ig-tf-main.git"
fi

echo "=== [1/6] Sincronizando repositorio em $APP_DIR ==="
mkdir -p "$APP_DIR"
cd "$APP_DIR"

if [ ! -d ".git" ]; then
    git clone "$REPO_URL" .
else
    git remote set-url origin "$REPO_URL"
    git fetch origin main
    git reset --hard origin/main
fi

echo "=== [2/6] Instalando dependencias Node.js ==="
npm install --omit=dev

echo "=== [3/6] Configurando ambiente Python e Playwright ==="
if [ ! -d "venv" ]; then
    python3 -m venv venv
fi

./venv/bin/pip install --upgrade pip
./venv/bin/pip install -r requirements.txt
./venv/bin/playwright install-deps || true
./venv/bin/playwright install chromium

echo "=== [4/6] Configurando arquivos de persistencia ==="
[ -f dados.json ] || echo "[]" > dados.json
[ -f resultado.json ] || echo "[]" > resultado.json
chmod 666 dados.json resultado.json

echo "=== [5/6] Instalando e Reiniciando Servicos Systemd ==="
mkdir -p /etc/systemd/system
cp systemd/ig-web.service /etc/systemd/system/
cp systemd/ig-worker.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable ig-worker.service ig-web.service
systemctl restart ig-worker.service
systemctl restart ig-web.service

echo "=== [6/6] Verificando integridade local ==="
sleep 3
systemctl is-active --quiet ig-web.service && echo "ig-web: ATIVO" || (systemctl status ig-web.service --no-pager && exit 1)
systemctl is-active --quiet ig-worker.service && echo "ig-worker: ATIVO" || (systemctl status ig-worker.service --no-pager && exit 1)

echo "Aguardando warmup do worker Playwright..."
for i in {1..15}; do
    if curl -fsS http://127.0.0.1:3006/health > /dev/null 2>&1; then
        echo "ig-worker respondendo na porta 3006!"
        break
    fi
    sleep 1
done

curl -fsS http://127.0.0.1:5501/health || exit 1
echo ""
echo "=== Deploy IG TF finalizado com sucesso factual na VPS! ==="
