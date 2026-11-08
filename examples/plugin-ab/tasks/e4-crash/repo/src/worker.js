const { sendReceipt } = require("./jobs/receipt");

const handlers = { send_receipt: sendReceipt };

async function runJob(job) {
  const h = handlers[job.type];
  return h(job);
}

module.exports = { runJob };
