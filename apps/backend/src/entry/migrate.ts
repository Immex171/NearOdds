import { migrate } from "../db/index.js";
import { boot } from "./common.js";
const { db } = boot();
console.log("applied:", await migrate(db));
await db.end();
