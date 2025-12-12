const EventEmitter = require("events");
const sharedPg = require("@shared/clients/pg");
const ALL_CHANNELS = require("../constants/pgNotifyChannels");

let listenClient = null;
let isListening = false;
const eventBus = new EventEmitter();

async function start() {
  if (isListening) return;

  try {
    listenClient = await sharedPg.connect();

    // 批量监听所有配置的频道
    const listenPromises = Object.values(ALL_CHANNELS).map((channel) =>
      listenClient.query(`LISTEN ${channel}`),
    );
    await Promise.all(listenPromises);

    listenClient.on("notification", (msg) => {
      setImmediate(() => {
        try {
          let payload;
          // 尝试解析为JSON，失败就当作纯文本
          try {
            payload = JSON.parse(msg.payload);
          } catch {
            payload = msg.payload; // 保持纯文本
          }
          eventBus.emit(msg.channel, payload);
        } catch (error) {
          logger.error(`处理通知失败`, {
            channel: msg.channel,
            payload: msg.payload,
            error,
          });
        }
      });
    });

    isListening = true;
  } catch (err) {
    logger.error("❌ Failed to start pg_notify listener:", {
      error: err.message,
      stack: err.stack,
    });
    throw err;
  }
}

module.exports = {
  start,
  stop: async () => {
    if (listenClient) {
      listenClient.release();
      listenClient = null;
    }
    isListening = false;
  },
  eventBus, // 直接导出 eventBus
  isActive: () => isListening,
};
