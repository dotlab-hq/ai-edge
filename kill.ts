import { RedisClient } from "bun";

const redis = new RedisClient(
  Bun.env.REDIS_URL || "redis://localhost:6379"
);

try {
  console.log("Flushing DB...");
  await redis.send("FLUSHDB", []);

  console.log("Killing normal clients...");
  const killed = await redis.send("CLIENT", [
    "KILL",
    "TYPE",
    "normal",
    "SKIPME",
    "yes",
  ]);

  console.log("Killed:", killed);

  const clients = await redis.send("CLIENT", ["LIST"]);
  console.log(clients);
} catch (err) {
  console.error(err);
} finally {
  redis.close();
}