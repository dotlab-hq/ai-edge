/**
 * Singleton MongoDB connection manager.
 * Lazily connects on first use and caches the client + database.
 */
import { MongoClient, type Db, type MongoClientOptions } from 'mongodb';
import type { StorageConfig } from './types';

let client: MongoClient | null = null;
let db: Db | null = null;

const DEFAULT_DB_NAME = 'ai_edge_skills';
const CONNECT_OPTIONS: MongoClientOptions = {
  maxPoolSize: 10,
  minPoolSize: 2,
  serverSelectionTimeoutMS: 5000,
  connectTimeoutMS: 5000,
};

export async function getMongoDb( mongoUri?: string ): Promise<Db> {
  if ( db ) return db;

  const uri = mongoUri ?? process.env.MONGO_URI;
  if ( !uri ) {
    throw new Error(
      'MongoDB URI not configured. Set storage.mongo_uri in config or MONGO_URI env var.'
    );
  }

  client = new MongoClient( uri, CONNECT_OPTIONS );
  await client.connect();

  // Extract database name from URI or use default
  const url = new URL( uri );
  const dbName = url.pathname.replace( /^\//, '' ) || DEFAULT_DB_NAME;
  db = client.db( dbName );

  console.info( `[mongo] connected uri=${uri.replace( /\/\/[^:]+:[^@]+@/, '//***:***@' )} db=${dbName}` );
  return db;
}

export async function closeMongo(): Promise<void> {
  if ( client ) {
    await client.close();
    client = null;
    db = null;
  }
}
