// migrate.js — One-time migration from local JSON files to MongoDB Atlas
// Run this ONCE from your local machine (or Fly.io shell) before switching to Render
// Usage: MONGODB_URI="your-connection-string" node migrate.js

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('❌ Missing MONGODB_URI — set it in your .env or as an environment variable');
  process.exit(1);
}

// Where your JSON files live — adjust DATA_DIR if needed
const DATA_DIR = process.env.DATA_DIR || '.';
function dataPath(f) { return path.join(DATA_DIR, f); }

// Map of: filename → MongoDB collection name
const FILES_TO_MIGRATE = [
  { file: 'camera-config.json',       collection: 'camera_config' },
  { file: 'speed-match-config.json',  collection: 'speed_match_config' },
  { file: 'channel-index-config.json',collection: 'channel_index_config' },
  { file: 'descriptions.json',        collection: 'descriptions' },
  { file: 'sticky-posts.json',        collection: 'sticky_posts' },
  { file: 'autoresponders.json',      collection: 'autoresponders' },
  { file: 'temproles.json',           collection: 'temp_roles' },
];

async function migrate() {
  console.log('🔌 Connecting to MongoDB...');
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db('hsc_bot');
  console.log('✅ Connected!\n');

  let migrated = 0;
  let skipped  = 0;

  for (const { file, collection } of FILES_TO_MIGRATE) {
    const filePath = dataPath(file);
    if (!fs.existsSync(filePath)) {
      console.log(`⏭️  Skipping ${file} — file not found`);
      skipped++;
      continue;
    }

    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const value = JSON.parse(raw);

      await db.collection(collection).replaceOne(
        { _id: 'data' },
        { _id: 'data', value },
        { upsert: true }
      );

      console.log(`✅ Migrated ${file} → ${collection}`);
      migrated++;
    } catch (err) {
      console.error(`❌ Failed to migrate ${file}:`, err.message);
    }
  }

  console.log(`\n🎉 Done! ${migrated} migrated, ${skipped} skipped.`);
  console.log('You can now deploy to Render — your data is in MongoDB.');
  await client.close();
}

migrate().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
