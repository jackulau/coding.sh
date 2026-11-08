const config = require("./config");

function parseSmtpUrl(url) {
  const [hostPart, port] = url.split("://")[1].split(":");
  return { host: hostPart, port: Number(port || 587) };
}

let transport;
function createTransport() {
  if (!transport) {
    const { host, port } = parseSmtpUrl(config.smtpUrl);
    transport = { host, port, send: async (msg) => ({ id: Date.now(), to: msg.to }) };
  }
  return transport;
}

module.exports = { createTransport };
