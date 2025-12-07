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
      // 立即触发事件
      setImmediate(() => {
        eventBus.emit(msg.channel, JSON.parse(msg.payload));
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
