/**
 * realtime-listener.js
 *
 * Supabase Realtime -> Redis mapping module
 *
 * ENV:
 *  REALTIME_URL       ws://localhost:4000/socket
 *  REALTIME_KEY       supabase_dummy_key
 *  REDIS_URL          redis://localhost:6379
 *  PG_DSN (optional)  postgres://user:pass@host/db  // only for optional prewarm
 */

const { RealtimeClient } = require('@supabase/realtime-js');
const redis = require('../clients/redis');

const REALTIME_URL = process.env.REALTIME_URL;

if (!REALTIME_URL) {
  throw new Error('REALTIME_URL must be set');
}

// optional postgres client for prewarm (not required for normal operation)
// const pg = PG_DSN ? new PgClient({ connectionString: PG_DSN }) : null;

const realtime = new RealtimeClient(REALTIME_URL, { params: { apikey: 'tacnad-3xyfzy-Jevxow' }})

const KEYS = {
  VK_CONFIG: (vk) => `vk_config:${vk}`,
  NODE_VK_SET: (nodeId) => `node_vk_mapping:${nodeId}`,
  VK_NODE: (vk) => `vk_node:${vk}`
};

// helper: normalize payload new/old shapes
function payloadRecord(payload) {
  return (payload && (payload.new || payload.record || payload.payload || payload.data)) || null;
}

// Redis helpers
async function addVkToNode(nodeId, vk) {
  if (!nodeId || !vk) return;
  await redis.sadd(KEYS.NODE_VK_SET(nodeId), vk);
  await redis.set(KEYS.VK_NODE(vk), nodeId);
}

async function removeVkFromNode(nodeId, vk) {
  if (!nodeId || !vk) return;
  await redis.srem(KEYS.NODE_VK_SET(nodeId), vk);
  const cur = await redis.get(KEYS.VK_NODE(vk));
  if (cur === nodeId) {
    await redis.del(KEYS.VK_NODE(vk));
  }
}

async function getVksByNode(nodeId) {
  return await redis.smembers(KEYS.NODE_VK_SET(nodeId)); // returns [] if none
}

// clear vk config cache
async function invalidateVkConfig(vk) {
  if (!vk) return;
  await redis.del(KEYS.VK_CONFIG(vk));
}

// optional: prewarm mapping for a node by querying PG (only if PG_DSN provided)
async function prewarmNodeMapping(nodeId) {
  if (!pg) return [];
  const res = await pg.query('SELECT virtual_key FROM data.virtual_key WHERE primary_config_node_id = $1', [nodeId]);
  const vks = res.rows.map(r => r.virtual_key);
  if (vks.length) {
    // store as set
    const key = KEYS.NODE_VK_SET(nodeId);
    const pipeline = redis.pipeline();
    pipeline.del(key);
    for (const vk of vks) pipeline.sadd(key, vk);
    await pipeline.exec();
    for (const vk of vks) await redis.set(KEYS.VK_NODE(vk), nodeId);
  }
  return vks;
}

// handle virtual_key table changes
async function handleVirtualKeyChange(payload) {
  const recNew = payload.new || payload.record || null;
  const recOld = payload.old || null;
  // virtual_key identifier (string)
  const vkNew = recNew?.virtual_key;
  const vkOld = recOld?.virtual_key;
  // node ids (uuid text)
  const newNode = recNew?.primary_config_node_id ?? null;
  const oldNode = recOld?.primary_config_node_id ?? null;

  // If virtual_key identity changed (rare), ensure removal of old key mapping
  if (vkOld && vkOld !== vkNew) {
    await invalidateVkConfig(vkOld);
    if (oldNode) await removeVkFromNode(oldNode, vkOld);
  }

  // If node mapping changed
  if (oldNode && newNode && oldNode !== newNode) {
    // moved
    if (vkNew) {
      await removeVkFromNode(oldNode, vkNew);
      await addVkToNode(newNode, vkNew);
      await invalidateVkConfig(vkNew);
    }
  } else if (!oldNode && newNode) {
    // new insertion -> add
    if (vkNew) {
      await addVkToNode(newNode, vkNew);
      await invalidateVkConfig(vkNew);
    }
  } else if (oldNode && !newNode) {
    // removed node association
    if (vkNew || vkOld) {
      await removeVkFromNode(oldNode, vkNew || vkOld);
      await invalidateVkConfig(vkNew || vkOld);
    }
  } else {
    // node didn't change (maybe config_data changed) -> invalidate vk config
    if (vkNew) await invalidateVkConfig(vkNew);
  }
}

// handle config_nodes changes: clear all vk configs for that node (no PG)
async function handleNodeChange(payload) {
  const rec = payload.new || payload.record || payload.old;
  const nodeId = rec?.id;
  if (!nodeId) return;

  // get vks list from redis (zero PG)
  let vks = await getVksByNode(nodeId);
  if (!vks || vks.length === 0) {
    // optional prewarm if PG configured
    if (pg) {
      vks = await prewarmNodeMapping(nodeId);
    } else {
      // nothing to do: mapping empty and no PG available
      return;
    }
  }

  // delete vk caches
  const pipeline = redis.pipeline();
  for (const vk of vks) pipeline.del(KEYS.VK_CONFIG(vk));
  await pipeline.exec();
}

// initialize and subscribe
async function start() {
  if (pg) await pg.connect();

  realtime.connect();

  // subscribe virtual_key table
  const vkChannel = realtime.channel('realtime:data:virtual_key');
  vkChannel.on('postgres_changes', async (payload) => {
    try {
      await handleVirtualKeyChange(payload);
    } catch (err) {
      console.error('handleVirtualKeyChange error', err);
    }
  });
  await vkChannel.subscribe();

  // subscribe config_nodes table
  const nodeChannel = realtime.channel('realtime:data:config_nodes');
  nodeChannel.on('postgres_changes', async (payload) => {
    try {
      await handleNodeChange(payload);
    } catch (err) {
      console.error('handleNodeChange error', err);
    }
  });
  await nodeChannel.subscribe();

  console.log('Realtime listener started: subscribed to virtual_key and config_nodes');
}

// graceful shutdown
async function stop() {
  try {
    await realtime.disconnect();
    await redis.quit();
    if (pg) await pg.end();
  } catch (e) {
    /* ignore */
  }
}

start().catch(err => {
  console.error('Failed to start realtime listener', err);
  process.exit(1);
});

// export helpers if consumed elsewhere
module.exports = {
  start, stop, handleVirtualKeyChange, handleNodeChange, addVkToNode, removeVkFromNode
};
