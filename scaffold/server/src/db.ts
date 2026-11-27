import { MongoClient, type Db } from 'mongodb';
import { config } from './config.js';

let client: MongoClient | undefined;

// Connects on first use. Call from anywhere: const db = await getDb();
export async function getDb(): Promise<Db> {
  if (!client) {
    client = new MongoClient(config.mongoUrl, {
      serverSelectionTimeoutMS: 5_000,
      connectTimeoutMS: 5_000,
    });
    await client.connect();
  }
  return client.db();
}

export async function closeDb(): Promise<void> {
  if (client) {
    await client.close();
    client = undefined;
  }
}
