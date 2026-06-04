import { RedisClient } from "bun";

const redis = new RedisClient(
  "redis://default:ZgiqgiHZRdWJwA5nRdUIlprMjl6JjGCt@redis-10736.c264.ap-south-1-1.ec2.cloud.redislabs.com:10736"
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