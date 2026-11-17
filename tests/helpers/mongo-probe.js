'use strict';

const { MongoClient } = require('mongodb');

/** Mongo 连接试探：可达返回 client；不可达关连接、onFail(e) 写原因并返回 null（federation / real-backends e2e 共用） */
async function probeMongo(uri, onFail) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 });
  try {
    await client.connect();
    await client.db().command({ ping: 1 });
  } catch (e) {
    await client.close().catch(() => {});
    onFail(e);
    return null;
  }
  return client;
}

module.exports = { probeMongo };
