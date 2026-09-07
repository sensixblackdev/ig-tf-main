const http = require('http');
const fs = require('fs');
const path = require('path');

const port = 5501;
const publicDir = path.join(__dirname, 'public');
const codigoDir = path.join(__dirname, 'codigo');
const dataFile = path.join(__dirname, 'dados.json');
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function saveLogin(request, response) {
  let body = '';
  request.on('data', (chunk) => {
    body += chunk;
    if (body.length > 10_000) request.destroy();
  });

  request.on('end', () => {
    try {
      const login = JSON.parse(body);
      if (!login.username || !login.password) {
        sendJson(response, 400, { error: 'Preencha usuário e senha.' });
        return;
      }

      let savedLogins = [];
      if (fs.existsSync(dataFile) && fs.readFileSync(dataFile, 'utf8').trim()) {
        savedLogins = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      }
      if (!Array.isArray(savedLogins)) savedLogins = [];

      savedLogins.push({
        username: String(login.username),
        password: String(login.password),
        createdAt: new Date().toISOString(),
      });
      fs.writeFileSync(dataFile, `${JSON.stringify(savedLogins, null, 2)}\n`, 'utf8');
      sendJson(response, 201, { saved: true });
    } catch {
      sendJson(response, 400, { error: 'Não foi possível salvar os dados.' });
    }
  });
}

function serveFile(request, response) {
  const requestedPath = decodeURIComponent(new URL(request.url, `http://${request.headers.host}`).pathname);
  const isCodigoRoute = requestedPath === '/codigo' || requestedPath.startsWith('/codigo/');
  const isPublicAlias = requestedPath === '/public' || requestedPath.startsWith('/public/');
  const rootDir = isCodigoRoute ? codigoDir : publicDir;
  const routePath = isCodigoRoute
    ? requestedPath.replace(/^\/codigo\/?/, '')
    : isPublicAlias
      ? requestedPath.replace(/^\/public\/?/, '')
      : requestedPath.replace(/^\/+/, '');
  const relativePath = routePath || 'index.html';
  const filePath = path.resolve(rootDir, relativePath);

  if (!filePath.startsWith(`${rootDir}${path.sep}`)) {
    response.writeHead(403);
    response.end('Acesso negado');
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(error.code === 'ENOENT' ? 404 : 500);
      response.end('Arquivo não encontrado');
      return;
    }
    response.writeHead(200, { 'Content-Type': mimeTypes[path.extname(filePath)] || 'application/octet-stream' });
    response.end(content);
  });
}

http.createServer((request, response) => {
  if (request.method === 'POST' && request.url === '/api/login') {
    saveLogin(request, response);
    return;
  }
  if (request.method === 'GET') {
    serveFile(request, response);
    return;
  }
  response.writeHead(405);
  response.end('Método não permitido');
}).listen(port, () => {
  console.log(`Servidor iniciado em http://localhost:${port}`);
});
