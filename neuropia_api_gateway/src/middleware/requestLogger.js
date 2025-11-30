// neuropia_api_gateway/src/middleware/requestLogger.js
function generateRequestId() {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function getBearerToken(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;

  const parts = authHeader.split(' ');
  if (parts.length === 2 && parts[0] === 'Bearer') {
    return parts[1];
  }
  return null;
}

function maskToken(token) {
  if (!token || token.length <= 8) return token;
  const first = token.slice(0, 4);
  const last = token.slice(-4);
  return `${first}…${last}`;
}

function RequestLogger(req, res, next) {
  const startTime = Date.now();
  const requestId = generateRequestId();
  const bearerToken = getBearerToken(req);

  req.requestId = requestId;

  console.log(`➡️  [${requestId}] ${req.method} ${req.url}`, {
    vk: maskToken(bearerToken),
    ip: req.ip,
  });

  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const logFn = res.statusCode >= 400 ? console.warn : console.log;
    logFn(`${res.statusCode >= 400 ? '⚠️' : '✅'} [${requestId}] ${req.method} ${req.url} - ${res.statusCode} (${duration}ms)`);
  });

  next();
}

module.exports = RequestLogger;
