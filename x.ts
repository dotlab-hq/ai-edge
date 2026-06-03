import { redis } from "bun";

process.env.REDIS_URL =
  "redis://default:ZgiqgiHZRdWJwA5nRdUIlprMjl6JjGCt@redis-10736.c264.ap-south-1-1.ec2.cloud.redislabs.com:10736";

await redis.send("FLUSHDB", []);