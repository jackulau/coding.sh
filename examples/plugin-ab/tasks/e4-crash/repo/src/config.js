module.exports = {
  queueUrl: process.env.QUEUE_URL,
  smtpUrl: process.env.SMTP_URL,
  logLevel: process.env.LOG_LEVEL || "info",
  concurrency: Number(process.env.WORKER_CONCURRENCY || 4),
};
