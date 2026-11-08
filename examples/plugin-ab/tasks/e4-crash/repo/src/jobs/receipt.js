const { createTransport } = require("../mailer");

async function sendReceipt(job) {
  const t = createTransport();
  return t.send({ to: job.email, subject: "Your receipt" });
}

module.exports = { sendReceipt };
